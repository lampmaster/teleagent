import { estimateTokens } from "../metrics/index.js";

/**
 * Audit finding: 21 exec results of 2000+ tokens produced 96% of all tool
 * output tokens, and every one of them was re-sent on each later turn. This
 * caps a result while keeping the parts that carry the answer.
 */
export const TOOL_OUTPUT_TOKEN_BUDGET = 600;

const HEAD_LINES = 12;
const TAIL_LINES = 6;
/** Diagnostics are reserved for first: they are what a large log is read for. */
const DIAGNOSTIC_BUDGET_SHARE = 0.45;
/** The gap markers and the closing note also cost tokens, so they get a share. */
const OVERHEAD_ALLOWANCE = 130;
const DIAGNOSTIC =
  /\b(error|errors|fail|failed|failure|critical|fatal|panic|exception|warn|warning|denied|refused|timeout|traceback)\b/i;

interface ExecShape {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function isExecShape(value: unknown): value is ExecShape {
  const shape = value as ExecShape | null;

  return (
    typeof shape === "object" &&
    shape !== null &&
    typeof shape.stdout === "string" &&
    typeof shape.stderr === "string" &&
    typeof shape.exitCode === "number"
  );
}

function lineCost(line: string): number {
  return estimateTokens(line) ?? Math.ceil(line.length / 4);
}

/**
 * Keeps diagnostics, then the head, then the tail, emitting them in the
 * original order and stating what was dropped so the model can ask for a
 * specific range instead of re-reading everything.
 */
export function limitText(
  text: string,
  budgetTokens = TOOL_OUTPUT_TOKEN_BUDGET,
): string {
  const estimate = estimateTokens(text);

  if (estimate === null || estimate <= budgetTokens) {
    return text;
  }

  const lines = text.split("\n");

  if (lines.length <= HEAD_LINES + TAIL_LINES) {
    return text;
  }

  const keep = new Set<number>();
  const contentBudget = Math.max(60, budgetTokens - OVERHEAD_ALLOWANCE);
  let used = 0;

  const take = (index: number, limit: number): void => {
    if (keep.has(index)) {
      return;
    }

    const cost = lineCost(lines[index] ?? "");

    if (used + cost > limit) {
      return;
    }

    keep.add(index);
    used += cost;
  };

  for (const [index, line] of lines.entries()) {
    if (DIAGNOSTIC.test(line)) {
      take(index, contentBudget * DIAGNOSTIC_BUDGET_SHARE);
    }
  }

  for (let index = 0; index < HEAD_LINES && index < lines.length; index += 1) {
    take(index, contentBudget);
  }

  for (let index = lines.length - 1; index >= Math.max(0, lines.length - TAIL_LINES); index -= 1) {
    take(index, contentBudget);
  }

  const ordered = [...keep].sort((a, b) => a - b);
  const output: string[] = [];
  let previous = -1;

  for (const index of ordered) {
    if (index > previous + 1) {
      output.push(`[... lines ${previous + 2}-${index} omitted ...]`);
    }

    output.push(lines[index] ?? "");
    previous = index;
  }

  if (previous < lines.length - 1) {
    output.push(`[... lines ${previous + 2}-${lines.length} omitted ...]`);
  }

  output.push(
    `[Output limited: showing ${ordered.length} of ${lines.length} lines, ` +
      `${lines.length - ordered.length} omitted. Kept every line mentioning an error or warning, ` +
      `plus the start and the end. To read an omitted range, run the same command piped through ` +
      `\`sed -n 'START,ENDp'\` or \`grep\`.]`,
  );

  return output.join("\n");
}

/**
 * Applies the limit to a tool result. An exec result keeps its JSON shape so
 * the model still sees the exit code; anything else is trimmed as plain text.
 */
export function limitToolOutput(
  content: string,
  budgetTokens = TOOL_OUTPUT_TOKEN_BUDGET,
): string {
  const estimate = estimateTokens(content);

  if (estimate === null || estimate <= budgetTokens) {
    return content;
  }

  try {
    const parsed: unknown = JSON.parse(content);

    if (isExecShape(parsed)) {
      return JSON.stringify({
        stdout: limitText(parsed.stdout, budgetTokens),
        stderr: limitText(parsed.stderr, budgetTokens),
        exitCode: parsed.exitCode,
      });
    }
  } catch {
    // Not JSON; fall through to plain-text trimming.
  }

  return limitText(content, budgetTokens);
}
