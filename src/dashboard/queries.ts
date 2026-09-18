import type { MetricsStore } from "../metrics/index.js";

export interface Overview {
  totalSessions: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  maxIterationRuns: number;
  stalledRuns: number;
  timeoutRuns: number;
  runningRuns: number;
  /** Over runs with a known verification result only. */
  successRate: number | null;
  verifiedRuns: number;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCachedTokens: number | null;
  totalReasoningTokens: number | null;
  totalCost: number;
  avgTokensPerRun: number | null;
  avgCostPerRun: number | null;
  avgTurnsPerRun: number | null;
  avgToolCallsPerRun: number | null;
  avgLlmLatencyMs: number | null;
  avgRunDurationMs: number | null;
  contextTokensSent: number | null;
  repeatedContextTokens: number | null;
  repeatedContextShare: number | null;
  toolOutputTokens: number | null;
}

export interface ToolUsage {
  toolName: string;
  calls: number;
  outputTokens: number | null;
  outputBytes: number | null;
  avgOutputTokens: number | null;
  maxOutputTokens: number | null;
  avgDurationMs: number | null;
  errors: number;
}

export interface SessionSummary {
  sessionId: string;
  agentId: string;
  lastActivityAt: number;
  runs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  cost: number;
}

export interface RunSummary {
  runId: string;
  sessionId: string;
  startedAt: number;
  userMessage: string;
  status: string;
  success: number | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCost: number | null;
  totalDurationMs: number | null;
  turns: number | null;
  toolCallCount: number | null;
  benchmarkScenario: string | null;
  benchmarkConfig: string | null;
}

export function overview(store: MetricsStore): Overview {
  const runs = store.queryOne<{
    total: number;
    completed: number;
    failed: number;
    maxIterations: number;
    stalled: number;
    timeouts: number;
    running: number;
    verified: number;
    succeeded: number;
    input: number | null;
    output: number | null;
    cached: number | null;
    reasoning: number | null;
    cost: number | null;
    repeated: number | null;
    toolOutput: number | null;
    avgTurns: number | null;
    avgToolCalls: number | null;
    avgDuration: number | null;
  }>(`
    SELECT COUNT(*)                                              AS total,
           SUM(status = 'completed')                             AS completed,
           SUM(status = 'error')                                 AS failed,
           SUM(status = 'max_iterations')                        AS maxIterations,
           SUM(status = 'stalled')                               AS stalled,
           SUM(status = 'timeout')                               AS timeouts,
           SUM(status = 'running')                               AS running,
           SUM(success IS NOT NULL)                              AS verified,
           SUM(success = 1)                                      AS succeeded,
           SUM(total_input_tokens)                               AS input,
           SUM(total_output_tokens)                              AS output,
           SUM(total_cached_tokens)                              AS cached,
           SUM(total_reasoning_tokens)                           AS reasoning,
           SUM(total_cost)                                       AS cost,
           SUM(repeated_context_tokens)                          AS repeated,
           SUM(tool_output_tokens)                               AS toolOutput,
           AVG(turns)                                            AS avgTurns,
           AVG(tool_call_count)                                  AS avgToolCalls,
           AVG(total_duration_ms)                                AS avgDuration
    FROM runs
  `);

  const sessions = store.queryOne<{ total: number }>(
    "SELECT COUNT(*) AS total FROM sessions",
  );

  const calls = store.queryOne<{
    avgLatency: number | null;
    contextTokens: number | null;
  }>(`
    SELECT AVG(latency_ms) AS avgLatency, SUM(context_tokens_estimated) AS contextTokens
    FROM llm_calls
  `);

  const total = runs?.total ?? 0;
  const verified = runs?.verified ?? 0;
  const tokenTotal = addNullable(runs?.input ?? null, runs?.output ?? null);
  const contextTokens = calls?.contextTokens ?? null;
  const repeated = runs?.repeated ?? null;

  return {
    totalSessions: sessions?.total ?? 0,
    totalRuns: total,
    completedRuns: runs?.completed ?? 0,
    failedRuns: runs?.failed ?? 0,
    maxIterationRuns: runs?.maxIterations ?? 0,
    stalledRuns: runs?.stalled ?? 0,
    timeoutRuns: runs?.timeouts ?? 0,
    runningRuns: runs?.running ?? 0,
    verifiedRuns: verified,
    successRate: verified > 0 ? (runs?.succeeded ?? 0) / verified : null,
    totalInputTokens: runs?.input ?? null,
    totalOutputTokens: runs?.output ?? null,
    totalCachedTokens: runs?.cached ?? null,
    totalReasoningTokens: runs?.reasoning ?? null,
    totalCost: runs?.cost ?? 0,
    avgTokensPerRun: total > 0 && tokenTotal !== null ? tokenTotal / total : null,
    avgCostPerRun: total > 0 ? (runs?.cost ?? 0) / total : null,
    avgTurnsPerRun: runs?.avgTurns ?? null,
    avgToolCallsPerRun: runs?.avgToolCalls ?? null,
    avgLlmLatencyMs: calls?.avgLatency ?? null,
    avgRunDurationMs: runs?.avgDuration ?? null,
    contextTokensSent: contextTokens,
    repeatedContextTokens: repeated,
    repeatedContextShare:
      contextTokens && contextTokens > 0 && repeated !== null
        ? repeated / contextTokens
        : null,
    toolOutputTokens: runs?.toolOutput ?? null,
  };
}

export function toolUsage(store: MetricsStore): ToolUsage[] {
  return store.query<ToolUsage>(`
    SELECT tool_name              AS toolName,
           COUNT(*)               AS calls,
           SUM(output_tokens)     AS outputTokens,
           SUM(output_size_bytes) AS outputBytes,
           AVG(output_tokens)     AS avgOutputTokens,
           MAX(output_tokens)     AS maxOutputTokens,
           AVG(duration_ms)       AS avgDurationMs,
           SUM(status = 'error')  AS errors
    FROM tool_calls
    GROUP BY tool_name
    ORDER BY outputTokens DESC
  `);
}

export function sessions(store: MetricsStore, limit = 100): SessionSummary[] {
  return store.query<SessionSummary>(
    `
    SELECT s.session_id                        AS sessionId,
           s.agent_id                          AS agentId,
           s.last_activity_at                  AS lastActivityAt,
           COUNT(r.run_id)                     AS runs,
           SUM(r.total_input_tokens)           AS inputTokens,
           SUM(r.total_output_tokens)          AS outputTokens,
           COALESCE(SUM(r.total_cost), 0)      AS cost
    FROM sessions s
    LEFT JOIN runs r ON r.session_id = s.session_id
    GROUP BY s.session_id
    ORDER BY s.last_activity_at DESC
    LIMIT ?
  `,
    limit,
  );
}

export function sessionRuns(store: MetricsStore, sessionId: string): RunSummary[] {
  return store.query<RunSummary>(
    `
    SELECT run_id AS runId, session_id AS sessionId, started_at AS startedAt,
           user_message AS userMessage, status, success,
           total_input_tokens AS totalInputTokens, total_output_tokens AS totalOutputTokens,
           total_cost AS totalCost, total_duration_ms AS totalDurationMs,
           turns, tool_call_count AS toolCallCount,
           benchmark_scenario AS benchmarkScenario, benchmark_config AS benchmarkConfig
    FROM runs WHERE session_id = ? ORDER BY started_at DESC
  `,
    sessionId,
  );
}

interface LlmCallRow {
  id: number;
  seq: number;
  turnNumber: number;
  timestamp: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  reasoningTokensEstimated: number;
  latencyMs: number | null;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  estimatedCost: number | null;
  contextMessageCount: number | null;
  contextTokensEstimated: number | null;
  contextRefs: string | null;
  responsePreview: string | null;
  thinkingPreview: string | null;
  toolCallsRequested: number | null;
  status: string;
  errorMessage: string | null;
}

interface ToolCallRow {
  id: number;
  llmCallId: number | null;
  seq: number;
  turnNumber: number;
  timestamp: number;
  toolName: string;
  arguments: string | null;
  inputSizeBytes: number | null;
  outputSizeBytes: number | null;
  outputTokens: number | null;
  rawOutputSizeBytes: number | null;
  rawOutputTokens: number | null;
  durationMs: number | null;
  status: string;
  outputPreview: string | null;
}

export function runDetails(store: MetricsStore, runId: string) {
  const run = store.queryOne<Record<string, unknown>>(
    `
    SELECT run_id AS runId, session_id AS sessionId, agent_id AS agentId,
           started_at AS startedAt, finished_at AS finishedAt,
           user_message AS userMessage, final_response AS finalResponse,
           status, success, success_detail AS successDetail,
           total_input_tokens AS totalInputTokens, total_output_tokens AS totalOutputTokens,
           total_cached_tokens AS totalCachedTokens,
           total_reasoning_tokens AS totalReasoningTokens,
           total_cost AS totalCost, total_duration_ms AS totalDurationMs,
           turns, tool_call_count AS toolCallCount,
           repeated_context_tokens AS repeatedContextTokens,
           tool_output_tokens AS toolOutputTokens,
           enabled_optimizations AS enabledOptimizations,
           benchmark_scenario AS benchmarkScenario, benchmark_config AS benchmarkConfig,
           benchmark_repetition AS benchmarkRepetition, error_message AS errorMessage
    FROM runs WHERE run_id = ?
  `,
    runId,
  );

  if (!run) {
    return null;
  }

  const llmCalls = store.query<LlmCallRow>(
    `
    SELECT id, seq, turn_number AS turnNumber, timestamp, model,
           input_tokens AS inputTokens, output_tokens AS outputTokens,
           cached_tokens AS cachedTokens, reasoning_tokens AS reasoningTokens,
           reasoning_tokens_estimated AS reasoningTokensEstimated,
           latency_ms AS latencyMs, load_duration_ms AS loadDurationMs,
           prompt_eval_duration_ms AS promptEvalDurationMs,
           eval_duration_ms AS evalDurationMs, estimated_cost AS estimatedCost,
           context_message_count AS contextMessageCount,
           context_tokens_estimated AS contextTokensEstimated,
           context_refs AS contextRefs, response_preview AS responsePreview,
           thinking_preview AS thinkingPreview,
           tool_calls_requested AS toolCallsRequested, status, error_message AS errorMessage
    FROM llm_calls WHERE run_id = ? ORDER BY seq
  `,
    runId,
  );

  const toolCalls = store.query<ToolCallRow>(
    `
    SELECT id, llm_call_id AS llmCallId, seq, turn_number AS turnNumber, timestamp,
           tool_name AS toolName, arguments, input_size_bytes AS inputSizeBytes,
           output_size_bytes AS outputSizeBytes, output_tokens AS outputTokens,
           raw_output_size_bytes AS rawOutputSizeBytes, raw_output_tokens AS rawOutputTokens,
           duration_ms AS durationMs, status, output_preview AS outputPreview
    FROM tool_calls WHERE run_id = ? ORDER BY seq
  `,
    runId,
  );

  return {
    run,
    timeline: buildTimeline(llmCalls, toolCalls),
    contextReuse: analyzeContextReuse(llmCalls, toolCalls),
  };
}

export interface TimelineNode {
  kind: "llm" | "tool";
  seq: number;
  data: Record<string, unknown>;
}

function buildTimeline(
  llmCalls: LlmCallRow[],
  toolCalls: ToolCallRow[],
): TimelineNode[] {
  const seen = new Map<string, number>();
  const nodes: TimelineNode[] = [];

  for (const call of llmCalls) {
    const refs = parseRefs(call.contextRefs);
    let repeated = 0;
    let fresh = 0;

    for (const [ref, tokens] of refs) {
      if (seen.has(ref)) {
        repeated += tokens ?? 0;
      } else {
        fresh += tokens ?? 0;
        seen.set(ref, call.seq);
      }
    }

    nodes.push({
      kind: "llm",
      seq: call.seq,
      data: {
        ...call,
        reasoningTokensEstimated: call.reasoningTokensEstimated === 1,
        contextRefs: refs.map(([ref, tokens]) => ({
          ref,
          tokens,
          firstSeenAtSeq: seen.get(ref) ?? call.seq,
          repeated: (seen.get(ref) ?? call.seq) !== call.seq,
        })),
        // Estimated from the context composition; never mixed with Ollama's counts.
        repeatedContextTokensEstimated: repeated,
        freshContextTokensEstimated: fresh,
      },
    });
  }

  for (const call of toolCalls) {
    nodes.push({ kind: "tool", seq: call.seq, data: { ...call } });
  }

  return nodes.sort((a, b) => a.seq - b.seq);
}

export interface ContextReuseEntry {
  ref: string;
  label: string;
  tokens: number | null;
  occurrences: number;
  repeatedTokens: number;
}

function analyzeContextReuse(
  llmCalls: LlmCallRow[],
  toolCalls: ToolCallRow[],
): ContextReuseEntry[] {
  const byRef = new Map<string, { tokens: number | null; occurrences: number }>();

  for (const call of llmCalls) {
    for (const [ref, tokens] of parseRefs(call.contextRefs)) {
      const existing = byRef.get(ref);

      if (existing) {
        existing.occurrences += 1;
      } else {
        byRef.set(ref, { tokens, occurrences: 1 });
      }
    }
  }

  const toolLabels = new Map<string, string>();

  for (const call of toolCalls) {
    toolLabels.set(`turn${call.turnNumber}`, call.toolName);
  }

  return [...byRef.entries()]
    .map(([ref, { tokens, occurrences }]) => ({
      ref,
      label: labelForRef(ref, toolLabels),
      tokens,
      occurrences,
      repeatedTokens: (tokens ?? 0) * Math.max(0, occurrences - 1),
    }))
    .sort((a, b) => b.repeatedTokens - a.repeatedTokens);
}

function labelForRef(ref: string, toolLabels: Map<string, string>): string {
  if (ref === "system") return "System prompt";
  if (ref === "user") return "User message";
  if (ref.startsWith("hist:")) return `History message ${ref.slice(5)}`;
  if (ref.startsWith("compacted:")) return `Compacted summary of the first ${ref.slice(10)} messages`;
  if (ref.startsWith("assistant:")) return `Assistant turn ${ref.slice(10)}`;

  if (ref.startsWith("tool:")) {
    const [turn] = ref.slice(5).split(":");
    const name = toolLabels.get(`turn${turn}`) ?? "tool";
    return `${name} result (turn ${turn})`;
  }

  return ref;
}

function parseRefs(raw: string | null): Array<[string, number | null]> {
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw) as Array<[string, number | null]>;
  } catch {
    return [];
  }
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
