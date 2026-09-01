export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input, required by Ollama native tool calling. */
  parameters: Record<string, unknown>;
  execute(input: unknown): Promise<ToolResult>;
}
