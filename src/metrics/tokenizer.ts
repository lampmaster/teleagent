import { fromPreTrained } from "@lenml/tokenizer-qwen3";

type Encoder = { encode(text: string, options: { add_special_tokens: boolean }): unknown[] };

let encoder: Encoder | null = null;
let unavailable = false;

/**
 * Qwen3's own tokenizer, used for the numbers Ollama does not report: tool
 * output sizes, per-message context composition and thinking-token estimates.
 * Loading the vocabulary costs ~200ms and ~200MB, so it happens on first use.
 */
function getEncoder(): Encoder | null {
  if (encoder || unavailable) {
    return encoder;
  }

  try {
    encoder = fromPreTrained() as unknown as Encoder;
  } catch (error) {
    unavailable = true;
    console.error("Qwen3 tokenizer unavailable, token estimates disabled", error);
  }

  return encoder;
}

/**
 * Estimated token count, or null when the tokenizer could not be loaded.
 * Estimates are always reported as estimates — they are never mixed into the
 * actual `prompt_eval_count` / `eval_count` numbers Ollama returns.
 */
export function estimateTokens(text: string): number | null {
  if (text.length === 0) {
    return 0;
  }

  const tokenizer = getEncoder();

  if (!tokenizer) {
    return null;
  }

  try {
    return tokenizer.encode(text, { add_special_tokens: false }).length;
  } catch (error) {
    console.error("Token estimation failed", error);
    return null;
  }
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
