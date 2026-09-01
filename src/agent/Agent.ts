import type {
  LLMProvider,
  Message,
  ToolCall,
  ToolDefinition,
} from "../llm/index.js";
import type { ConversationStore } from "../memory/index.js";
import type { SkillMetadata } from "../skills/SkillLoader.js";
import type { Tool } from "../tools/index.js";

export const DEFAULT_MAX_AGENT_ITERATIONS = 7;

const BASE_INSTRUCTIONS = [
  "You are an autonomous assistant reachable through a Telegram chat.",
  "",
  "You have tools that run on the user's local machine. Whenever a task needs real data from the machine or the network, call the tools yourself and report the results.",
  "Never tell the user to run a command themselves, and never invent tool output.",
  "",
  "A skill is a reusable procedure. When a request matches an available skill, call load_skill to read its instructions, then follow them step by step using the other tools.",
  "",
  "Keep calling tools until you can answer. When the task is done, reply with a normal message and no tool calls.",
  "Answer in plain text: Telegram shows the reply without Markdown rendering.",
].join("\n");

const MAX_ITERATIONS_RESPONSE =
  "I stopped after reaching the maximum number of steps for one request. Please narrow the task down or ask me to continue.";

const LOG_PREVIEW_CHARS = 200;

export interface AgentOptions {
  llmProvider: LLMProvider;
  conversationStore: ConversationStore;
  tools: Tool[];
  skills: SkillMetadata[];
  maxIterations?: number;
  /** Log the loop, tool calls and tool results to the console. */
  debug?: boolean;
}

export class Agent {
  private readonly llmProvider: LLMProvider;
  private readonly conversationStore: ConversationStore;
  private readonly tools: Map<string, Tool>;
  private readonly toolDefinitions: ToolDefinition[];
  private readonly systemMessage: Message;
  private readonly maxIterations: number;
  private readonly debug: boolean;

  constructor(options: AgentOptions) {
    this.llmProvider = options.llmProvider;
    this.conversationStore = options.conversationStore;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.toolDefinitions = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    this.systemMessage = {
      role: "system",
      content: buildSystemPrompt(options.skills),
    };
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_AGENT_ITERATIONS;
    this.debug = options.debug ?? false;
  }

  async run(chatId: string, userMessage: string): Promise<string> {
    const history = await this.conversationStore.get(chatId);
    const userMessageEntry: Message = { role: "user", content: userMessage };

    // Execution context of the current request: history plus everything produced by the loop.
    const context: Message[] = [
      this.systemMessage,
      ...history,
      userMessageEntry,
    ];
    const produced: Message[] = [userMessageEntry];

    const startedAt = Date.now();
    this.log(
      chatId,
      `user: ${preview(userMessage)} (history: ${history.length} messages)`,
    );

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      this.log(chatId, `iteration ${iteration + 1}/${this.maxIterations}`);

      const response = await this.llmProvider.generate(
        context,
        this.toolDefinitions,
      );

      const assistantMessage: Message = {
        role: "assistant",
        content: response.content,
      };

      if (response.toolCalls.length > 0) {
        assistantMessage.toolCalls = response.toolCalls;
      }

      context.push(assistantMessage);
      produced.push(assistantMessage);

      if (response.toolCalls.length === 0) {
        const content = response.content.trim();
        this.log(
          chatId,
          `final after ${iteration + 1} iterations (${elapsedSeconds(startedAt)}s): ${preview(content)}`,
        );
        await this.persist(chatId, produced);
        return content || "I could not produce a response for that request.";
      }

      for (const toolCall of response.toolCalls) {
        this.log(
          chatId,
          `→ ${toolCall.name} ${JSON.stringify(toolCall.arguments)}`,
        );

        const content = await this.executeTool(toolCall);
        this.log(chatId, `← ${toolCall.name}: ${preview(content)}`);

        const toolMessage: Message = {
          role: "tool",
          toolName: toolCall.name,
          content,
        };

        context.push(toolMessage);
        produced.push(toolMessage);
      }
    }

    this.log(
      chatId,
      `stopped: reached the maximum of ${this.maxIterations} iterations (${elapsedSeconds(startedAt)}s)`,
    );
    produced.push({ role: "assistant", content: MAX_ITERATIONS_RESPONSE });
    await this.persist(chatId, produced);
    return MAX_ITERATIONS_RESPONSE;
  }

  private async executeTool(toolCall: ToolCall): Promise<string> {
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      const known = [...this.tools.keys()].join(", ");
      return `Error: unknown tool "${toolCall.name}". Available tools: ${known}`;
    }

    try {
      const result = await tool.execute(toolCall.arguments);
      return result.isError ? `Error: ${result.content}` : result.content;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return `Error: tool "${toolCall.name}" failed: ${reason}`;
    }
  }

  private log(chatId: string, message: string): void {
    if (this.debug) {
      console.log(`[agent ${chatId}] ${message}`);
    }
  }

  private async persist(chatId: string, messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.conversationStore.append(chatId, message);
    }
  }
}

function preview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();

  return singleLine.length > LOG_PREVIEW_CHARS
    ? `${singleLine.slice(0, LOG_PREVIEW_CHARS)}…`
    : singleLine;
}

function elapsedSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function buildSystemPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return BASE_INSTRUCTIONS;
  }

  const list = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `${BASE_INSTRUCTIONS}\n\nAvailable skills (not tools themselves — read one by calling load_skill with its name):\n\n${list}`;
}
