/**
 * Per-token rates of the API the agent bills against. They default to the
 * values used for these measurements and are overridable via
 * COST_INPUT_PER_MTOK / COST_OUTPUT_PER_MTOK, so pointing the agent at a
 * different provider only means changing the two rates.
 */
export interface Pricing {
  /** USD per 1M input (prompt) tokens. */
  inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  outputPerMillion: number;
}

export const DEFAULT_PRICING: Pricing = {
  inputPerMillion: 0.15,
  outputPerMillion: 0.25,
};

/**
 * Cached and reasoning tokens are deliberately absent: Ollama reports cached
 * tokens as a subset of `prompt_eval_count` and thinking tokens as part of
 * `eval_count`, so charging for them again would double count.
 */
export function estimateCost(
  inputTokens: number | null,
  outputTokens: number | null,
  pricing: Pricing,
): number {
  const input = ((inputTokens ?? 0) / 1_000_000) * pricing.inputPerMillion;
  const output = ((outputTokens ?? 0) / 1_000_000) * pricing.outputPerMillion;

  return input + output;
}
