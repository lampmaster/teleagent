import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { messageText, type ContextEntry } from "../agent/context.js";
import type { Message } from "../llm/index.js";
import { estimateTokens } from "../metrics/index.js";

/**
 * Threshold compaction, the way long-running coding agents do it: history is
 * left alone while it grows, and only once it passes `high` is its oldest part
 * folded into a summary, in one step, down to `low`.
 *
 * Two properties matter more than the saving itself:
 *
 * - It happens only at the start of a run, never between the LLM calls of a
 *   run, so inside a run the context grows strictly by appending.
 * - The cut point is stored. Between compactions every run sends exactly the
 *   same prefix, so a provider's prompt cache keeps hitting. Recomputing the
 *   cut each run would move it with every new message and defeat the cache.
 *
 * The gap between `high` and `low` is what makes compactions rare: stopping
 * just under `high` would cross it again on the next message. And because a
 * history full of long user messages may not compress below `high` at all,
 * the next compaction also waits for at least `high - low` new tokens since
 * the last one — otherwise such a session would re-compact, and lose the
 * cache, on every single run.
 */
export const DEFAULT_COMPACTION_HIGH_TOKENS = 20_000;
export const DEFAULT_COMPACTION_LOW_TOKENS = 10_000;

/** The most recent user requests, with everything after them, stay verbatim. */
export const KEEP_RECENT_EXCHANGES = 3;

/**
 * A user message longer than this is treated as pasted data (a log, a
 * document) rather than an instruction, and only its opening is kept in the
 * summary. Instructions, constraints and questions are far shorter, so they
 * stay verbatim. This is plain truncation, so anything in the middle or end of
 * a long paste is lost.
 *
 * TODO: once model routing exists, have a cheaper model write the summary
 * instead of truncating, so a long paste keeps its meaning. An LLM summary is
 * not reproducible from the history the way this one is, so its text will have
 * to be stored in CompactionState, or the prefix — and the prompt cache — will
 * change on every run.
 */
export const DEFAULT_USER_MESSAGE_MAX_CHARS = 2_000;
export const DEFAULT_USER_MESSAGE_KEEP_CHARS = 1_000;

const TOOL_PREVIEW_CHARS = 60;
const ASSISTANT_PREVIEW_CHARS = 240;

export interface CompactionThresholds {
  high: number;
  low: number;
  /** User messages above this length are shortened in the summary. */
  userMessageMaxChars?: number;
  /** How much of such a message is kept. */
  userMessageKeepChars?: number;
}

export interface CompactionState {
  /** History messages `[0, cut)` are represented by the summary. */
  cut: number;
  /** Hash of those messages; a mismatch means the history was replaced. */
  fingerprint: string;
  /** Size of the rendered history right after this compaction. */
  tokensAfter: number;
}

export interface CompactionPlan {
  cut: number;
  /** Size of the rendered history at `cut`. */
  tokens: number;
}

export function fingerprint(messages: Message[]): string {
  return createHash("sha1").update(JSON.stringify(messages)).digest("hex");
}

/**
 * The stored cut if it still describes this history, otherwise 0. Clearing a
 * conversation with /new, or a benchmark re-seeding a session, invalidates the
 * state on its own, without anyone having to remember to reset it.
 */
export function currentCut(history: Message[], state: CompactionState | null): number {
  if (!state || state.cut <= 0 || state.cut > history.length) {
    return 0;
  }

  return fingerprint(history.slice(0, state.cut)) === state.fingerprint ? state.cut : 0;
}

/**
 * Where to cut this history, starting from the current cut. The cut stays put
 * while the rendered history is under the trigger; otherwise it moves to the
 * first user-message boundary that brings the history down to `low`, or as far
 * as the recent exchanges allow. Cuts only ever land right before a user
 * message, so a tool call is never separated from its result.
 *
 * `lastTokensAfter` is the size right after the previous compaction. The
 * trigger is `high`, or that size plus `high - low`, whichever is larger.
 */
export function planCut(
  history: Message[],
  cut: number,
  thresholds: CompactionThresholds,
  lastTokensAfter = 0,
): CompactionPlan {
  const costs = messageCosts(history, thresholds);
  const current = renderedTokens(costs, cut);
  const trigger = Math.max(
    thresholds.high,
    lastTokensAfter + (thresholds.high - thresholds.low),
  );

  if (current <= trigger) {
    return { cut, tokens: current };
  }

  const userIndexes = history
    .map((message, index) => (message.role === "user" ? index : -1))
    .filter((index) => index >= 0);
  // The last KEEP_RECENT_EXCHANGES user messages, and everything after them,
  // stay verbatim; the earliest of them is still a valid place to cut.
  const boundaries = userIndexes
    .slice(0, Math.max(0, userIndexes.length - KEEP_RECENT_EXCHANGES + 1))
    .filter((index) => index > cut);

  let next = cut;

  for (const boundary of boundaries) {
    next = boundary;

    if (renderedTokens(costs, next) <= thresholds.low) {
      break;
    }
  }

  return { cut: next, tokens: renderedTokens(costs, next) };
}

/** History as it is sent: one summary for `[0, cut)`, the rest verbatim. */
export function renderHistory(
  history: Message[],
  cut: number,
  thresholds: Partial<CompactionThresholds> = {},
): ContextEntry[] {
  const entries: ContextEntry[] = [];

  if (cut > 0) {
    // The ref changes only when the cut does, so re-sent-context accounting
    // sees the same summary across runs as one repeated message.
    entries.push({
      ref: `compacted:${cut}`,
      message: summarize(history.slice(0, cut), thresholds),
    });
  }

  for (let index = cut; index < history.length; index += 1) {
    entries.push({ ref: `hist:${index}`, message: history[index] as Message });
  }

  return entries;
}

function summaryHeader(count: number): string {
  return (
    `[Summary of the first ${count} messages of this conversation, compacted to save context. ` +
    "What the user said is kept word for word, except long pasted text, which keeps its opening; " +
    "assistant replies and tool output are shortened.]"
  );
}

/**
 * Goals, constraints and decisions arrive in user messages, so those are kept
 * whole. Findings live in the assistant's replies, which keep their opening.
 * Tool output keeps its size and first characters, enough to know it existed
 * and to ask for it again.
 */
function summaryLine(
  message: Message,
  thresholds: Partial<CompactionThresholds>,
): string | null {
  switch (message.role) {
    case "user":
      return `User: ${shortenUserMessage(message.content, thresholds)}`;
    case "tool": {
      const tokens = estimateTokens(message.content) ?? Math.ceil(message.content.length / 4);
      return `Tool ${message.toolName ?? "tool"} returned ${tokens} tokens, starting: ${clip(message.content, TOOL_PREVIEW_CHARS)}`;
    }
    case "assistant": {
      if (message.toolCalls && message.toolCalls.length > 0) {
        const calls = message.toolCalls
          .map((call) => `${call.name} ${JSON.stringify(call.arguments)}`)
          .join("; ");
        return `Assistant called: ${calls}`;
      }

      return message.content.trim() ? `Assistant: ${clip(message.content, ASSISTANT_PREVIEW_CHARS)}` : null;
    }
    default:
      return null;
  }
}

function shortenUserMessage(
  content: string,
  thresholds: Partial<CompactionThresholds>,
): string {
  const max = thresholds.userMessageMaxChars ?? DEFAULT_USER_MESSAGE_MAX_CHARS;
  const keep = thresholds.userMessageKeepChars ?? DEFAULT_USER_MESSAGE_KEEP_CHARS;

  if (content.length <= max) {
    return content;
  }

  return `${content.slice(0, keep)}\n[… ${content.length - keep} more characters of this message omitted]`;
}

function summarize(messages: Message[], thresholds: Partial<CompactionThresholds>): Message {
  const lines = [summaryHeader(messages.length)];

  for (const message of messages) {
    const line = summaryLine(message, thresholds);

    if (line !== null) {
      lines.push(line);
    }
  }

  return { role: "user", content: lines.join("\n") };
}

interface MessageCosts {
  raw: number[];
  summary: number[];
  header: number;
}

/**
 * Each message is tokenized once, both as sent verbatim and as its summary
 * line, so evaluating every candidate cut stays linear in the history length.
 */
function messageCosts(
  history: Message[],
  thresholds: Partial<CompactionThresholds>,
): MessageCosts {
  const count = (text: string) => estimateTokens(text) ?? Math.ceil(text.length / 4);

  return {
    raw: history.map((message) => count(messageText(message))),
    summary: history.map((message) => {
      const line = summaryLine(message, thresholds);
      return line === null ? 0 : count(line);
    }),
    header: count(summaryHeader(history.length)),
  };
}

function renderedTokens(costs: MessageCosts, cut: number): number {
  let total = cut > 0 ? costs.header : 0;

  for (let index = 0; index < costs.raw.length; index += 1) {
    total += index < cut ? (costs.summary[index] ?? 0) : (costs.raw[index] ?? 0);
  }

  return total;
}

function clip(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > maxChars ? `${singleLine.slice(0, maxChars)}…` : singleLine;
}

/**
 * Cut points per session. With a file path it survives restarts; without one it
 * lives in memory, which is what the tests use. A failed write is logged and
 * the agent carries on: the worst outcome is one extra compaction later.
 */
export class CompactionStateStore {
  private readonly filePath: string | null;
  private states: Record<string, CompactionState> | null = null;

  constructor(filePath: string | null = null) {
    this.filePath = filePath;
  }

  get(sessionId: string): CompactionState | null {
    return this.load()[sessionId] ?? null;
  }

  set(sessionId: string, state: CompactionState): void {
    const states = this.load();

    if (state.cut === 0) {
      delete states[sessionId];
    } else {
      states[sessionId] = state;
    }

    if (!this.filePath) {
      return;
    }

    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      writeFileSync(this.filePath, `${JSON.stringify(states, null, 2)}\n`, "utf8");
    } catch (error) {
      console.error(`Failed to persist compaction state to ${this.filePath}`, error);
    }
  }

  private load(): Record<string, CompactionState> {
    if (this.states) {
      return this.states;
    }

    this.states = {};

    if (!this.filePath) {
      return this.states;
    }

    try {
      this.states = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, CompactionState>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to read compaction state from ${this.filePath}, starting empty`, error);
      }
    }

    return this.states;
  }
}
