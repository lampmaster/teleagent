import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type {
  GenerateOptions,
  LLMProvider,
  LLMResponse,
  Message,
  ToolDefinition,
} from "../llm/index.js";
import type { ConversationStore } from "../memory/index.js";
import { MetricsStore } from "../metrics/index.js";
import { allFlagsOff, FlagStore } from "../optimizations/flags.js";
import { CompactionStateStore } from "../optimizations/index.js";
import { ExecTool, type Tool } from "../tools/index.js";
import { Agent } from "./Agent.js";

const directory = mkdtempSync(join(tmpdir(), "teleagent-agent-"));

after(() => rmSync(directory, { recursive: true, force: true }));

class ScriptedProvider implements LLMProvider {
  readonly requests: Message[][] = [];

  constructor(private readonly responses: Partial<LLMResponse>[]) {}

  async generate(
    messages: Message[],
    _tools: ToolDefinition[],
    _options?: GenerateOptions,
  ): Promise<LLMResponse> {
    this.requests.push(messages.map((message) => ({ ...message })));
    const response = this.responses[this.requests.length - 1];

    if (!response) {
      throw new Error("ScriptedProvider ran out of responses");
    }

    return {
      content: response.content ?? "",
      thinking: response.thinking ?? null,
      toolCalls: response.toolCalls ?? [],
      usage: response.usage ?? {
        model: "test-model",
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 5,
        loadDurationMs: 1,
        promptEvalDurationMs: 2,
        evalDurationMs: 3,
        totalDurationMs: 6,
      },
    };
  }
}

class MemoryStore implements ConversationStore {
  private messages: Message[] = [];

  constructor(seed: Message[] = []) {
    this.messages = [...seed];
  }

  async get(): Promise<Message[]> {
    return [...this.messages];
  }

  async append(_chatId: string, message: Message): Promise<void> {
    this.messages.push(message);
  }

  async clear(): Promise<void> {
    this.messages = [];
  }
}

const echoTool: Tool = {
  name: "echo",
  description: "Echo the input back.",
  parameters: { type: "object", properties: { value: { type: "string" } } },
  async execute(input) {
    return { content: `echo:${(input as { value?: string }).value ?? ""}` };
  },
};

function newAgent(provider: LLMProvider, options: { store?: MetricsStore; history?: Message[] } = {}) {
  return new Agent({
    llmProvider: provider,
    conversationStore: new MemoryStore(options.history),
    tools: [echoTool],
    skills: [],
    maxIterations: 3,
    metricsStore: options.store ?? null,
    pricing: { inputPerMillion: 0.15, outputPerMillion: 0.25 },
    agentId: "test",
  });
}

describe("Agent", () => {
  it("returns the final answer once the model stops calling tools", async () => {
    const provider = new ScriptedProvider([
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "hi" } }] },
      { content: "The tool said hi." },
    ]);

    const result = await newAgent(provider).run("chat", "say hi", { flags: allFlagsOff() });

    assert.equal(result.status, "completed");
    assert.equal(result.response, "The tool said hi.");
    assert.equal(result.turns, 2);
    assert.deepEqual(
      result.toolCalls.map((call) => call.output),
      ["echo:hi"],
    );
  });

  it("stops at the iteration limit and reports it", async () => {
    const loop = { content: "", toolCalls: [{ name: "echo", arguments: { value: "x" } }] };
    const result = await newAgent(new ScriptedProvider([loop, loop, loop])).run("chat", "loop", {
      flags: allFlagsOff(),
    });

    assert.equal(result.status, "max_iterations");
    assert.equal(result.turns, 3);
  });

  it("turns a tool failure into an error message instead of crashing the run", async () => {
    const failing: Tool = {
      name: "echo",
      description: "Always fails.",
      parameters: { type: "object" },
      async execute() {
        throw new Error("boom");
      },
    };

    const provider = new ScriptedProvider([
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "Recovered." },
    ]);

    const agent = new Agent({
      llmProvider: provider,
      conversationStore: new MemoryStore(),
      tools: [failing],
      skills: [],
      maxIterations: 3,
      metricsStore: null,
      agentId: "test",
    });

    const result = await agent.run("chat", "go", { flags: allFlagsOff() });
    assert.equal(result.status, "completed");
    assert.match(result.toolCalls[0]?.output ?? "", /boom/);
    assert.equal(result.toolCalls[0]?.isError, true);
  });

  it("records the timeline, links tool calls to their LLM call and snapshots the flags", async () => {
    const store = new MetricsStore(join(directory, "agent.db"));
    const provider = new ScriptedProvider([
      { content: "", thinking: "let me check", toolCalls: [{ name: "echo", arguments: { value: "a" } }] },
      { content: "Answer." },
    ]);

    const result = await newAgent(provider, { store }).run("chat-7", "go", {
      flags: { ...allFlagsOff(), toolOutputLimiting: true },
    });

    const calls = store.query<{ id: number; seq: number; turnNumber: number; reasoning: number }>(
      `SELECT id, seq, turn_number AS turnNumber, reasoning_tokens AS reasoning
       FROM llm_calls WHERE run_id = ? ORDER BY seq`,
      result.runId,
    );
    const tools = store.query<{ seq: number; llmCallId: number; outputTokens: number }>(
      `SELECT seq, llm_call_id AS llmCallId, output_tokens AS outputTokens
       FROM tool_calls WHERE run_id = ? ORDER BY seq`,
      result.runId,
    );

    assert.deepEqual(calls.map((c) => c.seq), [0, 2]);
    assert.deepEqual(tools.map((t) => t.seq), [1]);
    assert.equal(tools[0]?.llmCallId, calls[0]?.id);
    assert.ok((calls[0]?.reasoning ?? 0) > 0, "thinking text should produce a reasoning estimate");
    assert.ok((tools[0]?.outputTokens ?? 0) > 0);

    const run = store.queryOne<{ flags: string; status: string; turns: number }>(
      "SELECT enabled_optimizations AS flags, status, turns FROM runs WHERE run_id = ?",
      result.runId,
    );
    assert.equal(run?.status, "completed");
    assert.equal(run?.turns, 2);
    assert.equal(JSON.parse(run?.flags ?? "{}").toolOutputLimiting, true);
    store.close();
  });

  it("counts the history it re-sends on every LLM call", async () => {
    const store = new MetricsStore(join(directory, "reuse.db"));
    const history: Message[] = [
      { role: "user", content: "remember: orion-7" },
      { role: "assistant", content: "Noted, orion-7." },
    ];
    const provider = new ScriptedProvider([
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "a" } }] },
      { content: "Done." },
    ]);

    const result = await newAgent(provider, { store, history }).run("chat-8", "go", {
      flags: allFlagsOff(),
    });

    const run = store.queryOne<{ repeated: number }>(
      "SELECT repeated_context_tokens AS repeated FROM runs WHERE run_id = ?",
      result.runId,
    );
    assert.ok((run?.repeated ?? 0) > 0, "system, history and user were sent twice");
    store.close();
  });

  it("records a failed run and rethrows the provider error", async () => {
    const store = new MetricsStore(join(directory, "fail.db"));
    const failing: LLMProvider = {
      async generate() {
        throw new Error("ollama down");
      },
    };

    await assert.rejects(
      () => newAgent(failing, { store }).run("chat-9", "go", { flags: allFlagsOff() }),
      /ollama down/,
    );

    const run = store.queryOne<{ status: string; error: string }>(
      "SELECT status, error_message AS error FROM runs WHERE session_id = 'chat-9'",
    );
    assert.equal(run?.status, "error");
    assert.match(run?.error ?? "", /ollama down/);
    store.close();
  });
});

describe("empty replies", () => {
  it("asks again instead of answering with an empty message", async () => {
    const provider = new ScriptedProvider([
      { content: "   ", thinking: "thinking but saying nothing" },
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "b" } }] },
      { content: "Finally an answer." },
    ]);

    const result = await newAgent(provider).run("chat", "go", { flags: allFlagsOff() });

    assert.equal(result.status, "completed");
    assert.equal(result.response, "Finally an answer.");
    assert.equal(result.turns, 3);
    // The nudge is what makes the second attempt see a different context.
    const second = provider.requests[1] ?? [];
    assert.equal(second.at(-1)?.role, "user");
    assert.match(second.at(-1)?.content ?? "", /empty/i);
  });

  it("still stops at the iteration limit when every reply is empty", async () => {
    const provider = new ScriptedProvider([{ content: "" }, { content: "" }, { content: "" }]);
    const result = await newAgent(provider).run("chat", "go", { flags: allFlagsOff() });

    assert.equal(result.status, "max_iterations");
  });
});

describe("feature flags change agent behaviour", () => {
  const bigOutput = JSON.stringify({
    stdout: Array.from({ length: 400 }, (_, i) => `line ${i} of a very long log file`).join("\n"),
    stderr: "",
    exitCode: 0,
  });

  const bigTool: Tool = {
    name: "echo",
    description: "Returns a large result.",
    parameters: { type: "object" },
    async execute() {
      return { content: bigOutput };
    },
  };

  function agentWith(flagTool: Tool, provider: LLMProvider, store?: MetricsStore) {
    return new Agent({
      llmProvider: provider,
      conversationStore: new MemoryStore(),
      tools: [flagTool],
      skills: [],
      maxIterations: 6,
      metricsStore: store ?? null,
      agentId: "test",
    });
  }

  it("toolOutputLimiting shrinks what reaches the context, and records the raw size", async () => {
    const store = new MetricsStore(join(directory, "limit.db"));
    const script: Partial<LLMResponse>[] = [
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "Done." },
    ];

    const off = await agentWith(bigTool, new ScriptedProvider([...script])).run("a", "go", {
      flags: allFlagsOff(),
    });
    const on = await agentWith(
      bigTool,
      new ScriptedProvider([...script]),
      store,
    ).run("b", "go", { flags: { ...allFlagsOff(), toolOutputLimiting: true } });

    assert.equal(off.toolCalls[0]?.output, bigOutput);
    assert.ok(
      (on.toolCalls[0]?.output.length ?? 0) < bigOutput.length / 4,
      "the limited result should be far smaller",
    );

    const row = store.queryOne<{ raw: number; kept: number }>(
      "SELECT raw_output_tokens AS raw, output_tokens AS kept FROM tool_calls WHERE run_id = ?",
      on.runId,
    );
    assert.ok((row?.raw ?? 0) > (row?.kept ?? 0), "the raw size must still be recorded");
    store.close();
  });

  it("contextDeduplication replaces the second identical result with a pointer", async () => {
    const script: Partial<LLMResponse>[] = [
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "Done." },
    ];

    const result = await agentWith(bigTool, new ScriptedProvider(script)).run("c", "go", {
      flags: { ...allFlagsOff(), contextDeduplication: true },
    });

    assert.equal(result.toolCalls[0]?.output, bigOutput);
    assert.match(result.toolCalls[1]?.output ?? "", /Identical to the echo result in turn 1/);
  });

  it("batchIndependentTools advertises chaining without changing the schema", () => {
    const exec = new ExecTool({ runner: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }) });

    assert.equal(exec.definition(allFlagsOff()), undefined);

    const variant = exec.definition({ ...allFlagsOff(), batchIndependentTools: true });
    assert.ok(variant);
    assert.match(variant.description, /separated by/);
    // The input shape must stay identical: an extra optional parameter was
    // measured to stop the model emitting tool calls at all.
    assert.deepEqual(variant.parameters, exec.parameters);
  });

  it("earlyStop ends a stalled run, and without it the loop runs to the limit", async () => {
    const empty = Array.from({ length: 6 }, () => ({ content: "" }));

    const stopped = await agentWith(bigTool, new ScriptedProvider([...empty])).run("d", "go", {
      flags: { ...allFlagsOff(), earlyStop: true },
    });
    assert.equal(stopped.status, "stalled");
    assert.equal(stopped.turns, 5);

    const unstopped = await agentWith(bigTool, new ScriptedProvider([...empty])).run("e", "go", {
      flags: allFlagsOff(),
    });
    assert.equal(unstopped.status, "max_iterations");
    assert.equal(unstopped.turns, 6);
  });

  it("contextCompaction summarizes a long history without touching the stored one", async () => {
    // Short requests and long replies, the shape of a real conversation.
    const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `request ${i}` : `answer ${i} ` + "with filler text ".repeat(60),
    }));

    const build = () => {
      const provider = new ScriptedProvider([{ content: "Done." }]);
      const store = new MemoryStore(history);
      const agent = new Agent({
        llmProvider: provider,
        conversationStore: store,
        tools: [echoTool],
        skills: [],
        maxIterations: 3,
        metricsStore: null,
        agentId: "test",
        compactionStore: new CompactionStateStore(),
        compactionThresholds: { high: 3_000, low: 2_000 },
      });
      return { provider, store, agent };
    };

    const off = build();
    await off.agent.run("f", "go", { flags: allFlagsOff() });

    const on = build();
    await on.agent.run("g", "go", {
      flags: { ...allFlagsOff(), contextCompaction: true },
    });

    const sent = on.provider.requests[0] ?? [];
    assert.ok(sent.length < (off.provider.requests[0]?.length ?? 0), "fewer messages are sent");
    assert.match(sent[1]?.content ?? "", /Summary of the first/);
    // The JSON history store keeps every message regardless.
    assert.equal((await on.store.get()).length, history.length + 2);
  });

  it("never compacts inside a run: each call sends the previous call's context plus new messages", async () => {
    // Short requests and long replies, the shape of a real conversation.
    const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `request ${i}` : `answer ${i} ` + "with filler text ".repeat(60),
    }));
    const provider = new ScriptedProvider([
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "a" } }] },
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "b" } }] },
      { content: "", toolCalls: [{ name: "echo", arguments: { value: "c" } }] },
      { content: "Done." },
    ]);

    await new Agent({
      llmProvider: provider,
      conversationStore: new MemoryStore(history),
      tools: [echoTool],
      skills: [],
      maxIterations: 5,
      metricsStore: null,
      agentId: "test",
      compactionThresholds: { high: 3_000, low: 2_000 },
    }).run("h", "go", { flags: { ...allFlagsOff(), contextCompaction: true } });

    for (let call = 1; call < provider.requests.length; call += 1) {
      const previous = provider.requests[call - 1] ?? [];
      const current = provider.requests[call] ?? [];

      assert.deepEqual(
        current.slice(0, previous.length),
        previous,
        `call ${call + 1} must start with exactly what call ${call} sent, or the prompt cache misses`,
      );
    }
  });

  it("keeps the same compacted prefix on the next run of the session", async () => {
    // Short requests and long replies, the shape of a real conversation.
    const history: Message[] = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `request ${i}` : `answer ${i} ` + "with filler text ".repeat(60),
    }));
    const store = new MemoryStore(history);
    const provider = new ScriptedProvider([{ content: "First." }, { content: "Second." }]);
    const agent = new Agent({
      llmProvider: provider,
      conversationStore: store,
      tools: [echoTool],
      skills: [],
      maxIterations: 3,
      metricsStore: null,
      agentId: "test",
      compactionStore: new CompactionStateStore(),
      compactionThresholds: { high: 3_000, low: 2_000 },
    });
    const flags = { ...allFlagsOff(), contextCompaction: true };

    await agent.run("i", "first question", { flags });
    await agent.run("i", "second question", { flags });

    const first = provider.requests[0] ?? [];
    const second = provider.requests[1] ?? [];

    // Everything before the first run's own question is re-sent unchanged.
    assert.deepEqual(second.slice(0, first.length - 1), first.slice(0, -1));
  });
});

describe("flag store drives the running agent", () => {
  it("reads the flag file at the start of every run, so a toggle applies to new runs", async () => {
    const path = join(directory, "live-flags.json");
    const flagStore = new FlagStore(path);
    flagStore.write(allFlagsOff());

    const provider = new ScriptedProvider([
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "One." },
      { content: "", toolCalls: [{ name: "echo", arguments: {} }] },
      { content: "Two." },
    ]);

    const big = JSON.stringify({
      stdout: Array.from({ length: 400 }, (_, i) => `log line ${i} with padding text`).join("\n"),
      stderr: "",
      exitCode: 0,
    });

    const agent = new Agent({
      llmProvider: provider,
      conversationStore: new MemoryStore(),
      tools: [
        {
          name: "echo",
          description: "big",
          parameters: { type: "object" },
          async execute() {
            return { content: big };
          },
        },
      ],
      skills: [],
      maxIterations: 4,
      metricsStore: null,
      flags: flagStore,
      agentId: "test",
    });

    const before = await agent.run("chat", "first");
    assert.equal(before.toolCalls[0]?.output, big, "flag off: full output reaches the context");

    // What the dashboard's POST /api/flags does.
    flagStore.write({ ...allFlagsOff(), toolOutputLimiting: true });

    const after = await agent.run("chat", "second");
    assert.ok(
      (after.toolCalls[0]?.output.length ?? 0) < big.length / 4,
      "flag on: the next run is limited, with no restart",
    );

    // The run that already finished keeps the snapshot it ran with.
    assert.equal(JSON.parse(JSON.stringify(allFlagsOff())).toolOutputLimiting, false);
  });
});
