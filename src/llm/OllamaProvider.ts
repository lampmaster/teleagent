import type {
  LLMProvider,
  LLMResponse,
  Message,
  ToolCall,
  ToolDefinition,
} from "./LLMProvider.js";

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
}

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role: string;
  content?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  message?: OllamaMessage;
  error?: string;
}

export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toOllamaMessage),
        tools: tools.length > 0 ? tools.map(toOllamaTool) : undefined,
        stream: false,
      }),
    });

    if (!response.ok) {
      const details = await response.text().catch(() => "");
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText} ${details}`.trim(),
      );
    }

    const data = (await response.json()) as OllamaChatResponse;

    if (data.error) {
      throw new Error(`Ollama returned an error: ${data.error}`);
    }

    if (!data.message) {
      throw new Error("Ollama returned an invalid response: missing message");
    }

    return {
      content: data.message.content ?? "",
      toolCalls: parseToolCalls(data.message.tool_calls),
    };
  }
}

function toOllamaMessage(message: Message): OllamaMessage {
  return {
    role: message.role,
    content: message.content,
    tool_calls: message.toolCalls?.map((call) => ({
      function: { name: call.name, arguments: call.arguments },
    })),
    tool_name: message.toolName,
  };
}

function toOllamaTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseToolCalls(toolCalls: OllamaToolCall[] | undefined): ToolCall[] {
  if (!Array.isArray(toolCalls)) {
    return [];
  }

  const parsed: ToolCall[] = [];

  for (const call of toolCalls) {
    const name = call.function?.name;

    if (typeof name !== "string" || name.length === 0) {
      continue;
    }

    parsed.push({ name, arguments: parseArguments(call.function?.arguments) });
  }

  return parsed;
}

// Ollama usually returns arguments as an object, but some models emit a JSON string.
function parseArguments(rawArguments: unknown): Record<string, unknown> {
  if (typeof rawArguments === "string") {
    try {
      return parseArguments(JSON.parse(rawArguments));
    } catch {
      return {};
    }
  }

  if (rawArguments !== null && typeof rawArguments === "object") {
    return rawArguments as Record<string, unknown>;
  }

  return {};
}
