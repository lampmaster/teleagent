export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string;
  /** Present on assistant messages that requested tool execution. */
  toolCalls?: ToolCall[];
  /** Present on tool messages: the tool that produced the content. */
  toolName?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool input. */
  parameters: Record<string, unknown>;
}

/**
 * Usage reported by the provider for a single call. Every field is null when
 * the provider does not report it, so that "unknown" is never stored as zero.
 */
export interface LLMUsage {
  model: string;
  /** Ollama `prompt_eval_count`. */
  inputTokens: number | null;
  /** Ollama `eval_count`; includes thinking tokens. */
  outputTokens: number | null;
  /** Ollama `prompt_eval_cached_count`: a subset of `inputTokens`. */
  cachedTokens: number | null;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  totalDurationMs: number | null;
}

export interface LLMResponse {
  content: string;
  /** Reasoning text when the model emits it separately, otherwise null. */
  thinking: string | null;
  toolCalls: ToolCall[];
  usage: LLMUsage;
}

export interface GenerateOptions {
  /** Ollama `think`; leave undefined to use the model default. */
  think?: boolean;
  /** Ollama sampling options (temperature, top_p, seed, …) for this call. */
  sampling?: Record<string, unknown>;
}

export interface LLMProvider {
  generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: GenerateOptions,
  ): Promise<LLMResponse>;
}
