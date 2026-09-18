import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message } from "../llm/index.js";
import { estimateTokens } from "../metrics/index.js";
import {
  CompactionStateStore,
  currentCut,
  fingerprint,
  KEEP_RECENT_EXCHANGES,
  planCut,
  renderHistory,
} from "./contextCompaction.js";
import { deduplicateToolOutput } from "./contextDeduplication.js";
import { limitText, limitToolOutput, TOOL_OUTPUT_TOKEN_BUDGET } from "./toolOutputLimiting.js";

function logLines(count: number, injected: Record<number, string> = {}): string {
  return Array.from({ length: count }, (_, index) =>
    injected[index] ?? `2026-09-17T09:00:00Z INFO worker processed batch ${index} in 120ms`,
  ).join("\n");
}

describe("toolOutputLimiting", () => {
  it("leaves a small result untouched", () => {
    const small = JSON.stringify({ stdout: "Wed Sep 17 2026\n", stderr: "", exitCode: 0 });
    assert.equal(limitToolOutput(small), small);
  });

  it("brings a large result close to the token budget", () => {
    const original = estimateTokens(logLines(400)) ?? 0;
    const tokens = estimateTokens(limitText(logLines(400))) ?? 0;

    assert.ok(tokens <= TOOL_OUTPUT_TOKEN_BUDGET, `still ${tokens} tokens`);
    assert.ok(tokens < original / 5, `${tokens} vs ${original} should be far smaller`);
  });

  it("keeps the head, the tail and every diagnostic line", () => {
    const text = logLines(400, {
      0: "FIRST LINE MARKER",
      210: "2026-09-17T09:03:30Z ERROR db-pool CRITICAL pool exhausted, code=E7731",
      399: "LAST LINE MARKER",
    });
    const limited = limitText(text);

    assert.match(limited, /FIRST LINE MARKER/);
    assert.match(limited, /E7731/, "the error line must survive");
    assert.match(limited, /LAST LINE MARKER/);
    assert.match(limited, /lines .* omitted/);
  });

  it("says how to read an omitted range", () => {
    assert.match(limitText(logLines(400)), /sed -n|grep/);
  });

  it("keeps the exec JSON shape and its exit code", () => {
    const raw = JSON.stringify({ stdout: logLines(400), stderr: "", exitCode: 2 });
    const parsed = JSON.parse(limitToolOutput(raw)) as {
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    assert.equal(parsed.exitCode, 2);
    assert.ok(parsed.stdout.length < raw.length / 3);
  });

  it("does not trim a short result that happens to have many lines", () => {
    const text = "a\nb\nc\nd";
    assert.equal(limitText(text), text);
  });
});

describe("contextDeduplication", () => {
  const big = logLines(200);

  it("points a repeat at the first copy", () => {
    const pointer = deduplicateToolOutput(big, [
      { toolName: "exec", turnNumber: 2, content: big },
    ]);

    assert.ok(pointer);
    assert.match(pointer, /turn 2/);
    assert.ok(pointer.length < big.length / 10);
  });

  it("leaves a result that was not seen before", () => {
    assert.equal(deduplicateToolOutput(big, []), null);
  });

  it("ignores repeats too small to be worth replacing", () => {
    assert.equal(
      deduplicateToolOutput("ok", [{ toolName: "exec", turnNumber: 1, content: "ok" }]),
      null,
    );
  });
});

/**
 * A conversation of `turns` exchanges shaped like the real one: short user
 * requests, with the bulk in tool output (89% of the stored history in the
 * bot's actual conversation file).
 */
function session(turns: number, marker = ""): Message[] {
  const messages: Message[] = [];

  for (let turn = 0; turn < turns; turn += 1) {
    messages.push(
      { role: "user", content: turn === 1 && marker ? marker : `request number ${turn}` },
      { role: "assistant", content: "", toolCalls: [{ name: "exec", arguments: { command: `cmd-${turn}` } }] },
      { role: "tool", toolName: "exec", content: logLines(10) },
      { role: "assistant", content: `Finding ${turn}: the value was ${turn * 7}.` },
    );
  }

  return messages;
}

/** Size of the history as the planner measures it. */
function sizeAt(history: Message[], cut: number): number {
  return planCut(history, cut, { high: Number.MAX_SAFE_INTEGER, low: 0 }).tokens;
}

describe("contextCompaction", () => {
  // Proportional to the fixture: ~340 tokens per exchange, so the gap between
  // the two marks is several exchanges wide, as 20,000/10,000 is in production.
  const thresholds = { high: 6_000, low: 4_000 };

  it("leaves history alone while it is under the threshold", () => {
    const history = session(4);
    assert.equal(planCut(history, 0, thresholds).cut, 0);
    assert.deepEqual(
      renderHistory(history, 0).map((entry) => entry.message),
      history,
    );
  });

  it("once over the threshold, compacts down to the low mark in one step", () => {
    const history = session(20);
    assert.ok(sizeAt(history, 0) > thresholds.high, "the fixture must start over the threshold");

    const plan = planCut(history, 0, thresholds);

    assert.ok(plan.cut > 0);
    assert.ok(plan.tokens <= thresholds.low, `still ${plan.tokens} tokens`);
  });

  it("only cuts right before a user message, never between a tool call and its result", () => {
    const history = session(20);
    const { cut } = planCut(history, 0, thresholds);

    assert.equal(history[cut]?.role, "user");
  });

  it("keeps the most recent exchanges verbatim, however hard it is pushed", () => {
    const history = session(20);
    const { cut } = planCut(history, 0, { high: 1, low: 1 });
    const userIndexes = history
      .map((message, index) => (message.role === "user" ? index : -1))
      .filter((index) => index >= 0);

    assert.equal(cut, userIndexes.at(-KEEP_RECENT_EXCHANGES));
  });

  it("keeps every word the user said inside the summary", () => {
    const history = session(20, "Remember: the on-call owner for the database is Mira Halden.");
    const { cut } = planCut(history, 0, thresholds);
    const summary = renderHistory(history, cut)[0]?.message.content ?? "";

    assert.match(summary, /Mira Halden/);

    for (const message of history.slice(0, cut).filter((m) => m.role === "user")) {
      assert.ok(summary.includes(message.content), `lost: ${message.content}`);
    }
  });

  it("keeps the opening of the assistant's findings and shrinks tool output", () => {
    const history = session(20);
    const { cut } = planCut(history, 0, thresholds);
    const summary = renderHistory(history, cut)[0]?.message.content ?? "";

    assert.match(summary, /Finding 0: the value was 0/);
    assert.match(summary, /Tool exec returned \d+ tokens/);
    assert.ok(summary.length < JSON.stringify(history.slice(0, cut)).length / 3);
  });

  it("sends an identical prefix on later runs while the cut does not move", () => {
    const history = session(20);
    const plan = planCut(history, 0, thresholds);
    const first = renderHistory(history, plan.cut);

    // Next run: the history only grew at the end.
    const grown = [...history, ...session(1)];
    const next = planCut(grown, plan.cut, thresholds, plan.tokens);
    const second = renderHistory(grown, next.cut);

    assert.equal(next.cut, plan.cut, "a small addition must not move the cut");
    assert.deepEqual(
      second.slice(0, first.length).map((entry) => entry.message),
      first.map((entry) => entry.message),
      "the prefix must be byte-identical, or the provider's prompt cache misses",
    );
  });

  it("does not re-compact on every run when the history cannot shrink below the threshold", () => {
    // Long user messages are kept verbatim, so the user's text alone is
    // larger than the threshold and no cut can bring it underneath.
    const longRequests: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `message ${i} ` + "a long pasted paragraph of user text ".repeat(45) : "ok",
    }));
    const plan = planCut(longRequests, 0, thresholds);
    assert.ok(plan.tokens > thresholds.high, "the fixture must stay above the threshold after compacting");

    // Without the gap rule the next run would move the cut again, and the one
    // after that — invalidating the cache every time.
    const grown: Message[] = [
      ...longRequests,
      { role: "user", content: "one more short question" },
      { role: "assistant", content: "a short answer" },
    ];
    const next = planCut(grown, plan.cut, thresholds, plan.tokens);

    assert.equal(next.cut, plan.cut);
  });

  it("forgets a stored cut once the history it describes is gone", () => {
    const history = session(20);
    const plan = planCut(history, 0, thresholds);
    const state = {
      cut: plan.cut,
      fingerprint: fingerprint(history.slice(0, plan.cut)),
      tokensAfter: plan.tokens,
    };

    assert.equal(currentCut(history, state), plan.cut);
    assert.equal(currentCut(session(3), state), 0, "a cleared conversation starts fresh");
    assert.equal(currentCut(session(20, "different"), state), 0, "a different history starts fresh");
  });

  it("stores cut points in memory or on disk", () => {
    const store = new CompactionStateStore();
    store.set("chat", { cut: 8, fingerprint: "abc", tokensAfter: 900 });
    assert.deepEqual(store.get("chat"), { cut: 8, fingerprint: "abc", tokensAfter: 900 });

    store.set("chat", { cut: 0, fingerprint: "", tokensAfter: 0 });
    assert.equal(store.get("chat"), null, "a cut of zero means nothing to remember");
  });
});

describe("contextCompaction and long user messages", () => {
  const thresholds = { high: 6_000, low: 4_000 };

  it("keeps a normal instruction whole and shortens a long paste to its opening", () => {
    const instruction = "Only use read-only commands, and report sizes in megabytes. ".repeat(20);
    const paste = "PASTED-LOG-START " + "2026-09-17T09:00:00Z INFO worker line\n".repeat(200) + " PASTED-LOG-END";
    const history: Message[] = [
      { role: "user", content: instruction },
      { role: "assistant", content: "Understood." },
      { role: "user", content: paste },
      { role: "assistant", content: "I read the log." },
      ...session(20),
    ];

    const { cut } = planCut(history, 0, thresholds);
    const summary = renderHistory(history, cut, thresholds)[0]?.message.content ?? "";

    assert.ok(instruction.length < 2_000, "the instruction must count as short");
    assert.ok(summary.includes(instruction), "a normal-length message is kept verbatim");
    assert.match(summary, /PASTED-LOG-START/, "the opening of a paste is kept");
    assert.doesNotMatch(summary, /PASTED-LOG-END/, "the rest of a paste is dropped");
    assert.match(summary, /more characters of this message omitted/);
  });

  it("uses the configured limits", () => {
    const history: Message[] = [
      { role: "user", content: "x".repeat(300) },
      { role: "assistant", content: "ok" },
      ...session(20),
    ];
    const tight = { ...thresholds, userMessageMaxChars: 100, userMessageKeepChars: 40 };
    const { cut } = planCut(history, 0, tight);
    const summary = renderHistory(history, cut, tight)[0]?.message.content ?? "";

    assert.match(summary, /User: x{40}\n\[… 260 more characters/);
  });
});
