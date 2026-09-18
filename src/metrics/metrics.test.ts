import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { MetricsStore } from "./MetricsStore.js";
import { estimateCost } from "./pricing.js";
import { redact, redactAndClip } from "./redact.js";
import { RunRecorder } from "./RunRecorder.js";
import { estimateTokens } from "./tokenizer.js";

const directory = mkdtempSync(join(tmpdir(), "teleagent-metrics-"));

after(() => rmSync(directory, { recursive: true, force: true }));

const pricing = { inputPerMillion: 0.15, outputPerMillion: 0.25 };

function usage(input: number | null, output: number | null, cached: number | null = null) {
  return {
    model: "qwen3:1.7b",
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    loadDurationMs: 10,
    promptEvalDurationMs: 20,
    evalDurationMs: 30,
    totalDurationMs: 60,
  };
}

describe("pricing", () => {
  it("charges input and output at the configured rates", () => {
    assert.equal(estimateCost(1_000_000, 1_000_000, pricing), 0.4);
  });

  it("treats a missing count as zero cost rather than failing", () => {
    assert.equal(estimateCost(null, 200, pricing), (200 / 1_000_000) * 0.25);
  });
});

describe("redact", () => {
  it("masks credential-shaped environment assignments", () => {
    assert.match(redact("TELEGRAM_BOT_TOKEN=123456:AA-bb_CCdd"), /TELEGRAM_BOT_TOKEN=\[redacted\]/);
    assert.match(redact("export API_KEY='hunter2'"), /API_KEY=\[redacted\]/);
  });

  it("masks bearer tokens and bot tokens found in free text", () => {
    assert.match(redact("Authorization: Bearer abcdefghijklmnop"), /\[redacted\]/);
    assert.match(
      redact("curl https://api.telegram.org/bot8123456789:AAH1bQ2cD3eF4gH5iJ6kL7mN8oP9qR0sT1u/getMe"),
      /\[redacted\]/,
    );
  });

  it("keeps ordinary command output untouched", () => {
    const text = "Wed Sep 17 21:57:45 EEST 2026";
    assert.equal(redact(text), text);
  });

  it("clips long values and says how much was dropped", () => {
    const clipped = redactAndClip("x".repeat(100), 10);
    assert.match(clipped, /^x{10}\n\[… 90 more characters\]$/);
  });
});

describe("tokenizer", () => {
  it("estimates Qwen3 tokens for tool output", () => {
    const tokens = estimateTokens("The quick brown fox jumps over the lazy dog.");
    assert.ok(tokens !== null && tokens > 5 && tokens < 20, `unexpected estimate: ${tokens}`);
  });

  it("returns zero for empty text", () => {
    assert.equal(estimateTokens(""), 0);
  });
});

describe("MetricsStore", () => {
  it("links sessions, runs, LLM calls and tool calls", () => {
    const store = new MetricsStore(join(directory, "link.db"));
    store.touchSession("chat-1", "test", 1000);
    store.insertRun({
      runId: "run-1",
      sessionId: "chat-1",
      agentId: "test",
      startedAt: 1000,
      userMessage: "hi",
      enabledOptimizations: "{}",
      benchmarkScenario: null,
      benchmarkConfig: null,
      benchmarkRepetition: null,
    });

    const llmCallId = store.insertLlmCall({
      runId: "run-1",
      sessionId: "chat-1",
      agentId: "test",
      seq: 0,
      turnNumber: 1,
      timestamp: 1001,
      model: "qwen3:1.7b",
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 0,
      reasoningTokens: 40,
      reasoningTokensEstimated: true,
      latencyMs: 500,
      loadDurationMs: null,
      promptEvalDurationMs: null,
      evalDurationMs: null,
      estimatedCost: 0.1,
      contextMessageCount: 2,
      contextTokensEstimated: 90,
      contextRefs: JSON.stringify([["system", 40], ["user", 50]]),
      responsePreview: "ok",
      thinkingPreview: null,
      toolCallsRequested: 1,
      status: "ok",
      errorMessage: null,
    });

    store.insertToolCall({
      runId: "run-1",
      llmCallId,
      seq: 1,
      turnNumber: 1,
      timestamp: 1002,
      toolName: "exec",
      argumentsJson: '{"command":"date"}',
      inputSizeBytes: 18,
      outputSizeBytes: 30,
      outputTokens: 12,
      rawOutputSizeBytes: 30,
      rawOutputTokens: 12,
      durationMs: 5,
      status: "ok",
      outputPreview: "…",
    });

    const rows = store.query<{ llmCallId: number }>(
      "SELECT llm_call_id AS llmCallId FROM tool_calls WHERE run_id = ?",
      "run-1",
    );
    assert.equal(rows[0]?.llmCallId, llmCallId);

    store.setRunSuccess("run-1", true, "checked");
    const run = store.queryOne<{ success: number; detail: string }>(
      "SELECT success, success_detail AS detail FROM runs WHERE run_id = ?",
      "run-1",
    );
    assert.equal(run?.success, 1);
    assert.equal(run?.detail, "checked");
    store.close();
  });

  it("closes out runs abandoned by a crashed process", () => {
    const store = new MetricsStore(join(directory, "stale.db"));
    store.touchSession("s", "test", 1);
    store.insertRun({
      runId: "r",
      sessionId: "s",
      agentId: "test",
      startedAt: 1,
      userMessage: "m",
      enabledOptimizations: "{}",
      benchmarkScenario: null,
      benchmarkConfig: null,
      benchmarkRepetition: null,
    });
    store.failStaleRuns();

    const status = store.queryOne<{ status: string }>(
      "SELECT status FROM runs WHERE run_id = 'r'",
    );
    assert.equal(status?.status, "error");
    store.close();
  });
});

describe("RunRecorder", () => {
  it("sums usage, keeps cached and reasoning out of the cost, and counts re-sent tokens", () => {
    const store = new MetricsStore(join(directory, "recorder.db"));
    const recorder = new RunRecorder({
      store,
      agentId: "test",
      pricing,
      enabledOptimizations: { contextCompaction: false },
    });
    recorder.begin("chat-2", "hello");

    recorder.recordLlmCall({
      turnNumber: 1,
      startedAt: Date.now(),
      latencyMs: 100,
      usage: usage(100, 60, 20),
      content: "",
      thinking: "thinking about it",
      toolCallsRequested: 1,
      contextRefs: [["system", 40], ["user", 10]],
    });

    recorder.recordToolCall({
      llmCallId: 1,
      turnNumber: 1,
      startedAt: Date.now(),
      durationMs: 5,
      toolName: "exec",
      args: { command: "date" },
      rawOutput: "a".repeat(200),
      output: "a".repeat(200),
      isError: false,
    });

    recorder.recordLlmCall({
      turnNumber: 2,
      startedAt: Date.now(),
      latencyMs: 120,
      usage: usage(180, 40, 100),
      content: "done",
      thinking: null,
      toolCallsRequested: 0,
      // system and user are sent a second time; the tool result is new.
      contextRefs: [["system", 40], ["user", 10], ["tool:1:0", 55]],
    });

    recorder.finish(
      { status: "completed", finalResponse: "done", errorMessage: null },
      true,
      "ok",
    );

    const run = store.queryOne<{
      input: number;
      output: number;
      cached: number;
      cost: number;
      repeated: number;
      turns: number;
      toolCalls: number;
      success: number;
    }>(
      `SELECT total_input_tokens AS input, total_output_tokens AS output,
              total_cached_tokens AS cached, total_cost AS cost,
              repeated_context_tokens AS repeated, turns, tool_call_count AS toolCalls,
              success
       FROM runs WHERE session_id = 'chat-2'`,
    );

    assert.equal(run?.input, 280);
    assert.equal(run?.output, 100);
    assert.equal(run?.cached, 120);
    assert.equal(run?.turns, 2);
    assert.equal(run?.toolCalls, 1);
    assert.equal(run?.success, 1);
    // system (40) and user (10) were each sent twice.
    assert.equal(run?.repeated, 50);
    // Cached and reasoning tokens must not be charged on top of input/output.
    assert.equal(run?.cost, estimateCost(280, 100, pricing));
    store.close();
  });

  it("keeps working when the metrics store throws", () => {
    const broken = {
      touchSession() {
        throw new Error("disk on fire");
      },
    } as unknown as MetricsStore;

    const recorder = new RunRecorder({
      store: broken,
      agentId: "test",
      pricing,
      enabledOptimizations: {},
    });

    assert.doesNotThrow(() => recorder.begin("chat", "hello"));
    assert.doesNotThrow(() =>
      recorder.recordLlmCall({
        turnNumber: 1,
        startedAt: Date.now(),
        latencyMs: 1,
        usage: usage(1, 1),
        content: "",
        thinking: null,
        toolCallsRequested: 0,
        contextRefs: [],
      }),
    );
    assert.doesNotThrow(() =>
      recorder.finish({ status: "completed", finalResponse: "x", errorMessage: null }, null, null),
    );
  });
});
