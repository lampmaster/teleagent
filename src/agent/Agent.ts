import type {
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from "../llm/index.js";
import type { ConversationStore } from "../memory/index.js";
import {
  RunRecorder,
  type ContextRef,
  type MetricsStore,
  type Pricing,
  type RunStatus,
} from "../metrics/index.js";
import { DEFAULT_PRICING } from "../metrics/index.js";
import {
  allFlagsOff,
  CompactionStateStore,
  currentCut,
  deduplicateToolOutput,
  DEFAULT_COMPACTION_HIGH_TOKENS,
  DEFAULT_COMPACTION_LOW_TOKENS,
  fingerprint,
  limitToolOutput,
  planCut,
  renderHistory,
  type CompactionThresholds,
  type FeatureFlags,
  type FlagSource,
  type SeenToolResult,
} from "../optimizations/index.js";
import type { SkillMetadata } from "../skills/SkillLoader.js";
import type { Tool } from "../tools/index.js";
import { messageText, type ContextEntry } from "./context.js";

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

/**
 * Qwen3 sometimes ends a turn straight after its thinking block, emitting no
 * text and no tool call. That is not an answer, so the loop asks again instead
 * of replying with an empty message.
 */
const EMPTY_REPLY_NUDGE: Message = {
  role: "user",
  content:
    "Your last reply was empty. Call a tool if you still need data, otherwise answer now in plain text.",
};

/**
 * Audit finding, measured over the 60 baseline runs by longest streak of empty
 * replies: streaks of 0-3 recovered 36 times out of 46, a streak of 5 recovered
 * once out of three, and streaks of 6 or 7 never recovered (0 of 10). Stopping
 * at five keeps almost all of the saving while giving up on one run in sixty
 * that would still have succeeded.
 */
const MAX_CONSECUTIVE_EMPTY_REPLIES = 5;

const STALLED_RESPONSE =
  "I could not make progress on that request. Please rephrase it or narrow it down.";

const LOG_PREVIEW_CHARS = 200;

export interface AgentOptions {
  llmProvider: LLMProvider;
  conversationStore: ConversationStore;
  tools: Tool[];
  skills: SkillMetadata[];
  maxIterations?: number;
  /** Log the loop, tool calls and tool results to the console. */
  debug?: boolean;
  /** Metrics destination; null disables persistence but not the measuring. */
  metricsStore?: MetricsStore | null;
  /** Read at the start of every run, so a toggle applies to new runs only. */
  flags?: FlagSource;
  pricing?: Pricing;
  agentId?: string;
  /** Where `contextCompaction` keeps its cut points; in memory when omitted. */
  compactionStore?: CompactionStateStore;
  compactionThresholds?: CompactionThresholds;
}

export interface RunOptions {
  /** Tags the run as part of a benchmark instead of a Telegram conversation. */
  benchmark?: { scenario: string; config: string; repetition: number };
  generateOptions?: GenerateOptions;
  /** Overrides the flag store for this run; used by the benchmark runner. */
  flags?: FeatureFlags;
}

export interface ExecutedToolCall {
  name: string;
  arguments: Record<string, unknown>;
  output: string;
  isError: boolean;
}

export interface AgentRunResult {
  response: string;
  runId: string;
  status: RunStatus;
  turns: number;
  toolCalls: ExecutedToolCall[];
  error?: unknown;
}

export class Agent {
  private readonly llmProvider: LLMProvider;
  private readonly conversationStore: ConversationStore;
  private readonly tools: Map<string, Tool>;
  private readonly toolList: Tool[];
  private readonly skills: SkillMetadata[];
  private readonly maxIterations: number;
  private readonly debug: boolean;
  private readonly metricsStore: MetricsStore | null;
  private readonly flagSource: FlagSource | null;
  private readonly pricing: Pricing;
  private readonly agentId: string;
  private readonly compactionStore: CompactionStateStore;
  private readonly compactionThresholds: CompactionThresholds;

  constructor(options: AgentOptions) {
    this.llmProvider = options.llmProvider;
    this.conversationStore = options.conversationStore;
    this.toolList = options.tools;
    this.tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.skills = options.skills;
    this.maxIterations = options.maxIterations ?? DEFAULT_MAX_AGENT_ITERATIONS;
    this.debug = options.debug ?? false;
    this.metricsStore = options.metricsStore ?? null;
    this.flagSource = options.flags ?? null;
    this.pricing = options.pricing ?? DEFAULT_PRICING;
    this.agentId = options.agentId ?? "teleagent";
    this.compactionStore = options.compactionStore ?? new CompactionStateStore();
    this.compactionThresholds = options.compactionThresholds ?? {
      high: DEFAULT_COMPACTION_HIGH_TOKENS,
      low: DEFAULT_COMPACTION_LOW_TOKENS,
    };
  }

  async run(
    sessionId: string,
    userMessage: string,
    options: RunOptions = {},
  ): Promise<AgentRunResult> {
    const flags = options.flags ?? this.flagSource?.read() ?? allFlagsOff();

    const recorder = new RunRecorder({
      store: this.metricsStore,
      agentId: this.agentId,
      pricing: this.pricing,
      enabledOptimizations: { ...flags },
      benchmark: options.benchmark,
    });
    recorder.begin(sessionId, userMessage);

    try {
      return await this.loop(sessionId, userMessage, flags, recorder, options);
    } catch (error) {
      recorder.finish(
        {
          status: statusForError(error),
          finalResponse: null,
          errorMessage: describeError(error),
        },
        null,
        null,
      );
      throw error;
    }
  }

  private async loop(
    sessionId: string,
    userMessage: string,
    flags: FeatureFlags,
    recorder: RunRecorder,
    options: RunOptions,
  ): Promise<AgentRunResult> {
    const history = await this.conversationStore.get(sessionId);
    const userMessageEntry: Message = { role: "user", content: userMessage };

    // Compaction is decided once, here. From this point on the context only
    // grows by appending, so the prefix every LLM call sends stays cacheable.
    const historyEntries = flags.contextCompaction
      ? this.compactedHistory(sessionId, history)
      : history.map((message, index) => ({ ref: `hist:${index}`, message }));

    // Execution context of the current request: history plus everything produced by the loop.
    const context: ContextEntry[] = [
      { ref: "system", message: this.systemMessage(flags) },
      ...historyEntries,
      { ref: "user", message: userMessageEntry },
    ];
    const produced: Message[] = [userMessageEntry];
    const executed: ExecutedToolCall[] = [];
    const toolDefinitions = this.toolDefinitions(flags);
    const seenToolResults: SeenToolResult[] = [];
    let consecutiveEmptyReplies = 0;

    const startedAt = Date.now();
    this.log(
      sessionId,
      `user: ${preview(userMessage)} (history: ${history.length} messages)`,
    );

    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const turnNumber = iteration + 1;
      this.log(sessionId, `iteration ${turnNumber}/${this.maxIterations}`);

      const contextRefs: ContextRef[] = context.map((entry) => [
        entry.ref,
        recorder.tokensFor(entry.ref, messageText(entry.message)),
      ]);

      const callStartedAt = Date.now();
      let response: LLMResponse;

      try {
        response = await this.llmProvider.generate(
          context.map((entry) => entry.message),
          toolDefinitions,
          options.generateOptions,
        );
      } catch (error) {
        recorder.recordLlmCall({
          turnNumber,
          startedAt: callStartedAt,
          latencyMs: Date.now() - callStartedAt,
          usage: emptyUsage(),
          content: "",
          thinking: null,
          toolCallsRequested: 0,
          contextRefs,
          error,
        });
        throw error;
      }

      const llmCallId = recorder.recordLlmCall({
        turnNumber,
        startedAt: callStartedAt,
        latencyMs: Date.now() - callStartedAt,
        usage: response.usage,
        content: response.content,
        thinking: response.thinking,
        toolCallsRequested: response.toolCalls.length,
        contextRefs,
      });

      const content = response.content.trim();

      if (response.toolCalls.length === 0 && content.length === 0) {
        consecutiveEmptyReplies += 1;

        if (flags.earlyStop && consecutiveEmptyReplies >= MAX_CONSECUTIVE_EMPTY_REPLIES) {
          this.log(
            sessionId,
            `stopped: ${consecutiveEmptyReplies} empty replies in a row (${elapsedSeconds(startedAt)}s)`,
          );
          produced.push({ role: "assistant", content: STALLED_RESPONSE });
          await this.persist(sessionId, produced);
          recorder.finish(
            { status: "stalled", finalResponse: STALLED_RESPONSE, errorMessage: null },
            null,
            null,
          );

          return {
            response: STALLED_RESPONSE,
            runId: recorder.runId,
            status: "stalled",
            turns: turnNumber,
            toolCalls: executed,
          };
        }

        this.log(sessionId, `empty reply on turn ${turnNumber}, asking again`);
        context.push({ ref: `nudge:${turnNumber}`, message: EMPTY_REPLY_NUDGE });
        continue;
      }

      consecutiveEmptyReplies = 0;

      const assistantMessage: Message = {
        role: "assistant",
        content: response.content,
      };

      if (response.toolCalls.length > 0) {
        assistantMessage.toolCalls = response.toolCalls;
      }

      context.push({ ref: `assistant:${turnNumber}`, message: assistantMessage });
      produced.push(assistantMessage);

      if (response.toolCalls.length === 0) {
        this.log(
          sessionId,
          `final after ${turnNumber} iterations (${elapsedSeconds(startedAt)}s): ${preview(content)}`,
        );
        await this.persist(sessionId, produced);
        recorder.finish(
          { status: "completed", finalResponse: content, errorMessage: null },
          null,
          null,
        );

        return {
          response: content,
          runId: recorder.runId,
          status: "completed",
          turns: turnNumber,
          toolCalls: executed,
        };
      }

      for (const [index, toolCall] of response.toolCalls.entries()) {
        this.log(
          sessionId,
          `→ ${toolCall.name} ${JSON.stringify(toolCall.arguments)}`,
        );

        const toolStartedAt = Date.now();
        const outcome = await this.executeTool(toolCall);
        const durationMs = Date.now() - toolStartedAt;
        this.log(sessionId, `← ${toolCall.name}: ${preview(outcome.content)}`);

        const toolContent = this.shapeToolOutput(
          outcome.content,
          flags,
          seenToolResults,
          toolCall.name,
          turnNumber,
        );

        recorder.recordToolCall({
          llmCallId,
          turnNumber,
          startedAt: toolStartedAt,
          durationMs,
          toolName: toolCall.name,
          args: toolCall.arguments,
          rawOutput: outcome.content,
          output: toolContent,
          isError: outcome.isError,
        });

        executed.push({
          name: toolCall.name,
          arguments: toolCall.arguments,
          output: toolContent,
          isError: outcome.isError,
        });

        const toolMessage: Message = {
          role: "tool",
          toolName: toolCall.name,
          content: toolContent,
        };

        context.push({ ref: `tool:${turnNumber}:${index}`, message: toolMessage });
        produced.push(toolMessage);
      }
    }

    this.log(
      sessionId,
      `stopped: reached the maximum of ${this.maxIterations} iterations (${elapsedSeconds(startedAt)}s)`,
    );
    produced.push({ role: "assistant", content: MAX_ITERATIONS_RESPONSE });
    await this.persist(sessionId, produced);
    recorder.finish(
      {
        status: "max_iterations",
        finalResponse: MAX_ITERATIONS_RESPONSE,
        errorMessage: null,
      },
      null,
      null,
    );

    return {
      response: MAX_ITERATIONS_RESPONSE,
      runId: recorder.runId,
      status: "max_iterations",
      turns: this.maxIterations,
      toolCalls: executed,
    };
  }

  /**
   * Applies the output-side optimizations in a fixed order: a repeat becomes a
   * pointer, otherwise a large result is capped. Both record the untouched
   * output as `rawOutput`, so the dashboard shows what was saved.
   */
  private shapeToolOutput(
    output: string,
    flags: FeatureFlags,
    seen: SeenToolResult[],
    toolName: string,
    turnNumber: number,
  ): string {
    if (flags.contextDeduplication) {
      const pointer = deduplicateToolOutput(output, seen);
      seen.push({ toolName, turnNumber, content: output });

      if (pointer !== null) {
        return pointer;
      }
    }

    return flags.toolOutputLimiting ? limitToolOutput(output) : output;
  }

  /**
   * Moves the stored cut only when the history has outgrown the threshold, and
   * records it, so the runs in between send an identical prefix.
   */
  private compactedHistory(sessionId: string, history: Message[]): ContextEntry[] {
    const stored = this.compactionStore.get(sessionId);
    const cut = currentCut(history, stored);
    // A stale state (history cleared or replaced) carries no size either.
    const lastTokensAfter = cut > 0 ? (stored?.tokensAfter ?? 0) : 0;
    const plan = planCut(history, cut, this.compactionThresholds, lastTokensAfter);

    if (plan.cut !== cut) {
      this.compactionStore.set(sessionId, {
        cut: plan.cut,
        fingerprint: fingerprint(history.slice(0, plan.cut)),
        tokensAfter: plan.tokens,
      });
      this.log(
        sessionId,
        `compacted history: first ${plan.cut} of ${history.length} messages summarized, ~${plan.tokens} tokens left`,
      );
    } else if (stored && cut === 0) {
      // The stored state no longer matches this history; drop it.
      this.compactionStore.set(sessionId, { cut: 0, fingerprint: "", tokensAfter: 0 });
    }

    return renderHistory(history, plan.cut, this.compactionThresholds);
  }

  private toolDefinitions(flags: FeatureFlags): ToolDefinition[] {
    return this.toolList.map((tool) => {
      const variant = tool.definition?.(flags);

      return {
        name: tool.name,
        description: variant?.description ?? tool.description,
        parameters: variant?.parameters ?? tool.parameters,
      };
    });
  }

  private systemMessage(flags: FeatureFlags): Message {
    return { role: "system", content: buildSystemPrompt(this.skills, flags) };
  }

  private async executeTool(
    toolCall: ToolCall,
  ): Promise<{ content: string; isError: boolean }> {
    const tool = this.tools.get(toolCall.name);

    if (!tool) {
      const known = [...this.tools.keys()].join(", ");
      return {
        content: `Error: unknown tool "${toolCall.name}". Available tools: ${known}`,
        isError: true,
      };
    }

    try {
      const result = await tool.execute(toolCall.arguments);

      return result.isError
        ? { content: `Error: ${result.content}`, isError: true }
        : { content: result.content, isError: false };
    } catch (error) {
      return {
        content: `Error: tool "${toolCall.name}" failed: ${describeError(error)}`,
        isError: true,
      };
    }
  }

  private log(sessionId: string, message: string): void {
    if (this.debug) {
      console.log(`[agent ${sessionId}] ${message}`);
    }
  }

  private async persist(sessionId: string, messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.conversationStore.append(sessionId, message);
    }
  }
}

function emptyUsage() {
  return {
    model: "",
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    loadDurationMs: null,
    promptEvalDurationMs: null,
    evalDurationMs: null,
    totalDurationMs: null,
  };
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Timeouts are tracked separately from other failures. */
function statusForError(error: unknown): RunStatus {
  const name = error instanceof Error ? error.name : "";

  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "error";
}

function buildSystemPrompt(skills: SkillMetadata[], _flags: FeatureFlags): string {
  if (skills.length === 0) {
    return BASE_INSTRUCTIONS;
  }

  const list = skills
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");

  return `${BASE_INSTRUCTIONS}\n\nAvailable skills (not tools themselves — read one by calling load_skill with its name):\n\n${list}`;
}
