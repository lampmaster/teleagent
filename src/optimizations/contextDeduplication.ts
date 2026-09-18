import { estimateTokens } from "../metrics/index.js";

/**
 * Audit finding: 11 of the 42 tool-using baseline runs asked for the same data
 * twice, and the worst one carried 8,098 duplicated tokens. A repeat is
 * replaced with a pointer to the first copy, which the model can still read.
 */
export const DEDUPLICATION_MIN_TOKENS = 200;

export interface SeenToolResult {
  toolName: string;
  turnNumber: number;
  content: string;
}

/**
 * Returns the replacement text for a repeated tool result, or null when the
 * result is new or too small to be worth replacing.
 */
export function deduplicateToolOutput(
  content: string,
  seen: SeenToolResult[],
  minTokens = DEDUPLICATION_MIN_TOKENS,
): string | null {
  const tokens = estimateTokens(content);

  if (tokens === null || tokens < minTokens) {
    return null;
  }

  const original = seen.find((candidate) => candidate.content === content);

  if (!original) {
    return null;
  }

  return (
    `[Identical to the ${original.toolName} result in turn ${original.turnNumber} above ` +
    `(${tokens} tokens). The data has not changed; use that result.]`
  );
}
