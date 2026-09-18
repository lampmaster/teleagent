import { randomUUID } from "node:crypto";
import type { LLMUsage } from "../llm/index.js";
import type { MetricsStore, RunStatus } from "./MetricsStore.js";
import { estimateCost, type Pricing } from "./pricing.js";
import { redact, redactAndClip } from "./redact.js";
import { byteLength, estimateTokens } from "./tokenizer.js";

const PREVIEW_CHARS = 2_000;
const TOOL_PREVIEW_CHARS = 4_000;
const MESSAGE_CHARS = 4_000;

/** `[ref, estimatedTokens]` — ref identifies a logical message inside a run. */
export type ContextRef = [string, number | null];

export interface RunRecorderOptions {
  store: MetricsStore | null;
  agentId: string;
  pricing: Pricing;
  enabledOptimizations: Record<string, boolean>;
  benchmark?: {
    scenario: string;
    config: string;
    repetition: number;
  };
}

export interface LlmCallRecord {
  turnNumber: number;
  startedAt: number;
  latencyMs: number;
  usage: LLMUsage;
  content: string;
  thinking: string | null;
  toolCallsRequested: number;
  contextRefs: ContextRef[];
  error?: unknown;
  /** Set when the provider reported no usage, e.g. a failed call. */
  model?: string;
}

export interface ToolCallRecord {
  llmCallId: number | null;
  turnNumber: number;
  startedAt: number;
  durationMs: number;
  toolName: string;
  args: Record<string, unknown>;
  /** Output as produced by the tool, before any optimization trims it. */
  rawOutput: string;
  /** Output as actually appended to the context. */
  output: string;
  isError: boolean;
}

export interface RunOutcome {
  status: RunStatus;
  finalResponse: string | null;
  errorMessage: string | null;
}

/**
 * Records one agent run. Every method swallows its own failures: a broken
 * metrics write must never take down the agent loop.
 */
export class RunRecorder {
  readonly runId = randomUUID();

  private readonly store: MetricsStore | null;
  private readonly agentId: string;
  private readonly pricing: Pricing;
  private readonly enabledOptimizations: Record<string, boolean>;
  private readonly benchmark: RunRecorderOptions["benchmark"];
  private readonly tokenCache = new Map<string, number | null>();
  /** How many tokens each logical message contributed, summed over all calls. */
  private readonly refUsage = new Map<string, { tokens: number | null; count: number }>();

  private sessionId = "";
  private startedAt = 0;
  private seq = 0;
  private turns = 0;
  private toolCalls = 0;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private cachedTokens: number | null = null;
  private reasoningTokens: number | null = null;
  private toolOutputTokens: number | null = null;
  private cost = 0;
  private started = false;

  constructor(options: RunRecorderOptions) {
    this.store = options.store;
    this.agentId = options.agentId;
    this.pricing = options.pricing;
    this.enabledOptimizations = options.enabledOptimizations;
    this.benchmark = options.benchmark;
  }

  begin(sessionId: string, userMessage: string): void {
    this.sessionId = sessionId;
    this.startedAt = Date.now();

    this.guard(() => {
      this.store?.touchSession(sessionId, this.agentId, this.startedAt);
      this.store?.insertRun({
        runId: this.runId,
        sessionId,
        agentId: this.agentId,
        startedAt: this.startedAt,
        userMessage: redactAndClip(userMessage, MESSAGE_CHARS),
        enabledOptimizations: JSON.stringify(this.enabledOptimizations),
        benchmarkScenario: this.benchmark?.scenario ?? null,
        benchmarkConfig: this.benchmark?.config ?? null,
        benchmarkRepetition: this.benchmark?.repetition ?? null,
      });
      this.started = true;
    });
  }

  /** Token estimate for a logical message, cached so each message is tokenized once. */
  tokensFor(ref: string, text: string): number | null {
    if (!this.tokenCache.has(ref)) {
      this.tokenCache.set(ref, estimateTokens(text));
    }

    return this.tokenCache.get(ref) ?? null;
  }

  /** Returns the row id of the stored call so tool calls can link back to it. */
  recordLlmCall(record: LlmCallRecord): number | null {
    this.turns += 1;

    for (const [ref, tokens] of record.contextRefs) {
      const existing = this.refUsage.get(ref);

      if (existing) {
        existing.count += 1;
      } else {
        this.refUsage.set(ref, { tokens, count: 1 });
      }
    }

    if (!record.error) {
      this.inputTokens = addNullable(this.inputTokens, record.usage.inputTokens);
      this.outputTokens = addNullable(this.outputTokens, record.usage.outputTokens);
      this.cachedTokens = addNullable(this.cachedTokens, record.usage.cachedTokens);
      this.cost += estimateCost(
        record.usage.inputTokens,
        record.usage.outputTokens,
        this.pricing,
      );
    }

    // Ollama does not report a reasoning token count, only the thinking text.
    const reasoning =
      record.thinking === null ? null : estimateTokens(record.thinking);
    this.reasoningTokens = addNullable(this.reasoningTokens, reasoning);

    let id: number | null = null;

    this.guard(() => {
      if (!this.store || !this.started) {
        return;
      }

      const contextTokens = sumNullable(record.contextRefs.map(([, t]) => t));

      id = this.store.insertLlmCall({
        runId: this.runId,
        sessionId: this.sessionId,
        agentId: this.agentId,
        seq: this.seq,
        turnNumber: record.turnNumber,
        timestamp: record.startedAt,
        model: record.usage.model || record.model || "unknown",
        inputTokens: record.usage.inputTokens,
        outputTokens: record.usage.outputTokens,
        cachedTokens: record.usage.cachedTokens,
        reasoningTokens: reasoning,
        reasoningTokensEstimated: reasoning !== null,
        latencyMs: record.latencyMs,
        loadDurationMs: record.usage.loadDurationMs,
        promptEvalDurationMs: record.usage.promptEvalDurationMs,
        evalDurationMs: record.usage.evalDurationMs,
        estimatedCost: estimateCost(
          record.usage.inputTokens,
          record.usage.outputTokens,
          this.pricing,
        ),
        contextMessageCount: record.contextRefs.length,
        contextTokensEstimated: contextTokens,
        contextRefs: JSON.stringify(record.contextRefs),
        responsePreview: redactAndClip(record.content, PREVIEW_CHARS),
        thinkingPreview:
          record.thinking === null
            ? null
            : redactAndClip(record.thinking, PREVIEW_CHARS),
        toolCallsRequested: record.toolCallsRequested,
        status: record.error ? "error" : "ok",
        errorMessage: record.error ? describe(record.error) : null,
      });
    });

    this.seq += 1;

    return id;
  }

  recordToolCall(record: ToolCallRecord): void {
    this.toolCalls += 1;

    const outputTokens = estimateTokens(record.output);
    const rawOutputTokens =
      record.rawOutput === record.output ? outputTokens : estimateTokens(record.rawOutput);
    this.toolOutputTokens = addNullable(this.toolOutputTokens, outputTokens);

    this.guard(() => {
      if (!this.store || !this.started) {
        return;
      }

      const argumentsJson = redact(safeStringify(record.args));

      this.store.insertToolCall({
        runId: this.runId,
        llmCallId: record.llmCallId,
        seq: this.seq,
        turnNumber: record.turnNumber,
        timestamp: record.startedAt,
        toolName: record.toolName,
        argumentsJson: clip(argumentsJson, MESSAGE_CHARS),
        inputSizeBytes: byteLength(argumentsJson),
        outputSizeBytes: byteLength(record.output),
        outputTokens,
        rawOutputSizeBytes: byteLength(record.rawOutput),
        rawOutputTokens,
        durationMs: record.durationMs,
        status: record.isError ? "error" : "ok",
        outputPreview: redactAndClip(record.output, TOOL_PREVIEW_CHARS),
      });
    });

    this.seq += 1;
  }

  finish(outcome: RunOutcome, success: boolean | null, successDetail: string | null): void {
    this.guard(() => {
      if (!this.store || !this.started) {
        return;
      }

      this.store.finishRun({
        runId: this.runId,
        finishedAt: Date.now(),
        finalResponse:
          outcome.finalResponse === null
            ? null
            : redactAndClip(outcome.finalResponse, MESSAGE_CHARS),
        status: outcome.status,
        success,
        successDetail,
        totalInputTokens: this.inputTokens,
        totalOutputTokens: this.outputTokens,
        totalCachedTokens: this.cachedTokens,
        totalReasoningTokens: this.reasoningTokens,
        totalCost: this.cost,
        totalDurationMs: Date.now() - this.startedAt,
        turns: this.turns,
        toolCallCount: this.toolCalls,
        repeatedContextTokens: this.repeatedContextTokens(),
        toolOutputTokens: this.toolOutputTokens,
        errorMessage: outcome.errorMessage,
      });
      // The run is complete: make it visible to the dashboard straight away.
      this.store.checkpoint();
    });
  }

  /**
   * Tokens the run paid for more than once: every logical message beyond its
   * first appearance in an LLM context is re-sent verbatim.
   */
  private repeatedContextTokens(): number | null {
    let total: number | null = null;

    for (const { tokens, count } of this.refUsage.values()) {
      if (tokens === null || count < 2) {
        continue;
      }

      total = (total ?? 0) + tokens * (count - 1);
    }

    return total ?? (this.refUsage.size > 0 ? 0 : null);
  }

  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      console.error("Metrics write failed (agent continues)", error);
    }
  }
}

function addNullable(total: number | null, value: number | null): number | null {
  if (value === null) {
    return total;
  }

  return (total ?? 0) + value;
}

function sumNullable(values: Array<number | null>): number | null {
  let total: number | null = null;

  for (const value of values) {
    total = addNullable(total, value);
  }

  return total;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function clip(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
