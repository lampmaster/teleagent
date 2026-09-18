import type { FeatureFlags } from "../optimizations/flags.js";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinitionVariant {
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool input, required by Ollama native tool calling. */
  parameters: Record<string, unknown>;
  execute(input: unknown): Promise<ToolResult>;
  /**
   * Optional per-run schema, so an optimization can change what the tool
   * advertises without changing what it accepts.
   */
  definition?(flags: FeatureFlags): ToolDefinitionVariant | undefined;
}
