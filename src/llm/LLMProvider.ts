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

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
}

export interface LLMProvider {
  generate(
    messages: Message[],
    tools: ToolDefinition[],
  ): Promise<LLMResponse>;
}
