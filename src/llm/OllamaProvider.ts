import type {
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  LLMUsage,
  Message,
  ToolCall,
  ToolDefinition,
} from "./LLMProvider.js";

export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

export interface OllamaProviderOptions {
  baseUrl: string;
  model: string;
  /** Sampling options passed through to Ollama, e.g. temperature and seed. */
  generationOptions?: Record<string, unknown>;
  /** Guards against a hung generation blocking the loop forever. */
  requestTimeoutMs?: number;
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
  thinking?: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

interface OllamaChatResponse {
  model?: string;
  message?: OllamaMessage;
  error?: string;
  prompt_eval_count?: number;
  prompt_eval_cached_count?: number;
  eval_count?: number;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
}

export class OllamaProvider implements LLMProvider {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly generationOptions?: Record<string, unknown>;
  private readonly requestTimeoutMs: number;

  constructor(options: OllamaProviderOptions) {
    this.baseUrl = options.baseUrl;
    this.model = options.model;
    this.generationOptions = options.generationOptions;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
    options: GenerateOptions = {},
  ): Promise<LLMResponse> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: messages.map(toOllamaMessage),
        tools: tools.length > 0 ? tools.map(toOllamaTool) : undefined,
        think: options.think,
        options:
          this.generationOptions || options.sampling
            ? { ...this.generationOptions, ...options.sampling }
            : undefined,
        stream: false,
      }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
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
      thinking: data.message.thinking ?? null,
      toolCalls: parseToolCalls(data.message.tool_calls),
      usage: toUsage(data, this.model),
    };
  }
}

function toUsage(data: OllamaChatResponse, fallbackModel: string): LLMUsage {
  return {
    model: data.model ?? fallbackModel,
    inputTokens: numberOrNull(data.prompt_eval_count),
    outputTokens: numberOrNull(data.eval_count),
    cachedTokens: numberOrNull(data.prompt_eval_cached_count),
    loadDurationMs: nanosToMs(data.load_duration),
    promptEvalDurationMs: nanosToMs(data.prompt_eval_duration),
    evalDurationMs: nanosToMs(data.eval_duration),
    totalDurationMs: nanosToMs(data.total_duration),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nanosToMs(value: unknown): number | null {
  const nanos = numberOrNull(value);
  return nanos === null ? null : Math.round(nanos / 1_000_000);
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
