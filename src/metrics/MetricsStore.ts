import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type RunStatus =
  | "running"
  | "completed"
  | "max_iterations"
  | "timeout"
  | "stalled"
  | "error";

export interface SessionRow {
  sessionId: string;
  agentId: string;
  createdAt: number;
  lastActivityAt: number;
}

export interface RunInsert {
  runId: string;
  sessionId: string;
  agentId: string;
  startedAt: number;
  userMessage: string;
  enabledOptimizations: string;
  benchmarkScenario: string | null;
  benchmarkConfig: string | null;
  benchmarkRepetition: number | null;
}

export interface RunFinish {
  runId: string;
  finishedAt: number;
  finalResponse: string | null;
  status: RunStatus;
  success: boolean | null;
  successDetail: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  totalCachedTokens: number | null;
  totalReasoningTokens: number | null;
  totalCost: number;
  totalDurationMs: number;
  turns: number;
  toolCallCount: number;
  repeatedContextTokens: number | null;
  toolOutputTokens: number | null;
  errorMessage: string | null;
}

export interface LlmCallInsert {
  runId: string;
  sessionId: string;
  agentId: string;
  seq: number;
  turnNumber: number;
  timestamp: number;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  reasoningTokensEstimated: boolean;
  latencyMs: number;
  loadDurationMs: number | null;
  promptEvalDurationMs: number | null;
  evalDurationMs: number | null;
  estimatedCost: number;
  contextMessageCount: number;
  contextTokensEstimated: number | null;
  /** `[ref, estimatedTokens]` for every message sent, in order. */
  contextRefs: string;
  responsePreview: string | null;
  thinkingPreview: string | null;
  toolCallsRequested: number;
  status: "ok" | "error";
  errorMessage: string | null;
}

export interface ToolCallInsert {
  runId: string;
  llmCallId: number | null;
  seq: number;
  turnNumber: number;
  timestamp: number;
  toolName: string;
  argumentsJson: string;
  inputSizeBytes: number;
  outputSizeBytes: number;
  outputTokens: number | null;
  rawOutputSizeBytes: number;
  rawOutputTokens: number | null;
  durationMs: number;
  status: "ok" | "error";
  outputPreview: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id                  TEXT PRIMARY KEY,
  session_id              TEXT NOT NULL REFERENCES sessions(session_id),
  agent_id                TEXT NOT NULL,
  started_at              INTEGER NOT NULL,
  finished_at             INTEGER,
  user_message            TEXT NOT NULL,
  final_response          TEXT,
  status                  TEXT NOT NULL,
  success                 INTEGER,
  success_detail          TEXT,
  total_input_tokens      INTEGER,
  total_output_tokens     INTEGER,
  total_cached_tokens     INTEGER,
  total_reasoning_tokens  INTEGER,
  total_cost              REAL,
  total_duration_ms       INTEGER,
  turns                   INTEGER,
  tool_call_count         INTEGER,
  repeated_context_tokens INTEGER,
  tool_output_tokens      INTEGER,
  enabled_optimizations   TEXT NOT NULL,
  benchmark_scenario      TEXT,
  benchmark_config        TEXT,
  benchmark_repetition    INTEGER,
  error_message           TEXT
);

CREATE TABLE IF NOT EXISTS llm_calls (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id                     TEXT NOT NULL REFERENCES runs(run_id),
  session_id                 TEXT NOT NULL,
  agent_id                   TEXT NOT NULL,
  seq                        INTEGER NOT NULL,
  turn_number                INTEGER NOT NULL,
  timestamp                  INTEGER NOT NULL,
  model                      TEXT NOT NULL,
  input_tokens               INTEGER,
  output_tokens              INTEGER,
  cached_tokens              INTEGER,
  reasoning_tokens           INTEGER,
  reasoning_tokens_estimated INTEGER NOT NULL,
  latency_ms                 INTEGER,
  load_duration_ms           INTEGER,
  prompt_eval_duration_ms    INTEGER,
  eval_duration_ms           INTEGER,
  estimated_cost             REAL,
  context_message_count      INTEGER,
  context_tokens_estimated   INTEGER,
  context_refs               TEXT,
  response_preview           TEXT,
  thinking_preview           TEXT,
  tool_calls_requested       INTEGER,
  status                     TEXT NOT NULL,
  error_message              TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id               TEXT NOT NULL REFERENCES runs(run_id),
  llm_call_id          INTEGER REFERENCES llm_calls(id),
  seq                  INTEGER NOT NULL,
  turn_number          INTEGER NOT NULL,
  timestamp            INTEGER NOT NULL,
  tool_name            TEXT NOT NULL,
  arguments            TEXT,
  input_size_bytes     INTEGER,
  output_size_bytes    INTEGER,
  output_tokens        INTEGER,
  raw_output_size_bytes INTEGER,
  raw_output_tokens    INTEGER,
  duration_ms          INTEGER,
  status               TEXT NOT NULL,
  output_preview       TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_runs_benchmark ON runs(benchmark_config, benchmark_scenario);
CREATE INDEX IF NOT EXISTS idx_llm_calls_run ON llm_calls(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id, seq);
`;

/**
 * Synchronous SQLite storage for the observability data. Writes are small and
 * happen between LLM calls that take seconds, so the synchronous driver keeps
 * the code simple without measurably blocking the agent.
 */
export class MetricsStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // WAL lets the dashboard read while the agent writes.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Folds the write-ahead log back into the database file. Other processes —
   * the dashboard, the report generator — read the file directly, and on a
   * Docker bind mount they cannot rely on the WAL index being visible to them.
   */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  query<T>(sql: string, ...params: unknown[]): T[] {
    return this.prepare(sql).all(...(params as never[])) as T[];
  }

  queryOne<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.prepare(sql).get(...(params as never[])) as T | undefined;
  }

  touchSession(sessionId: string, agentId: string, timestamp: number): void {
    this.prepare(
      `INSERT INTO sessions (session_id, agent_id, created_at, last_activity_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_activity_at = excluded.last_activity_at`,
    ).run(sessionId, agentId, timestamp, timestamp);
  }

  insertRun(run: RunInsert): void {
    this.prepare(
      `INSERT INTO runs (run_id, session_id, agent_id, started_at, user_message,
                         status, enabled_optimizations, benchmark_scenario,
                         benchmark_config, benchmark_repetition)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
    ).run(
      run.runId,
      run.sessionId,
      run.agentId,
      run.startedAt,
      run.userMessage,
      run.enabledOptimizations,
      run.benchmarkScenario,
      run.benchmarkConfig,
      run.benchmarkRepetition,
    );
  }

  finishRun(run: RunFinish): void {
    this.prepare(
      `UPDATE runs SET finished_at = ?, final_response = ?, status = ?, success = ?,
                       success_detail = ?, total_input_tokens = ?, total_output_tokens = ?,
                       total_cached_tokens = ?, total_reasoning_tokens = ?, total_cost = ?,
                       total_duration_ms = ?, turns = ?, tool_call_count = ?,
                       repeated_context_tokens = ?, tool_output_tokens = ?, error_message = ?
       WHERE run_id = ?`,
    ).run(
      run.finishedAt,
      run.finalResponse,
      run.status,
      run.success === null ? null : run.success ? 1 : 0,
      run.successDetail,
      run.totalInputTokens,
      run.totalOutputTokens,
      run.totalCachedTokens,
      run.totalReasoningTokens,
      run.totalCost,
      run.totalDurationMs,
      run.turns,
      run.toolCallCount,
      run.repeatedContextTokens,
      run.toolOutputTokens,
      run.errorMessage,
      run.runId,
    );
  }

  /** Returns the row id so tool calls can point back at the call that requested them. */
  insertLlmCall(call: LlmCallInsert): number {
    const result = this.prepare(
      `INSERT INTO llm_calls (run_id, session_id, agent_id, seq, turn_number, timestamp, model,
                              input_tokens, output_tokens, cached_tokens, reasoning_tokens,
                              reasoning_tokens_estimated, latency_ms, load_duration_ms,
                              prompt_eval_duration_ms, eval_duration_ms, estimated_cost,
                              context_message_count, context_tokens_estimated, context_refs,
                              response_preview, thinking_preview, tool_calls_requested,
                              status, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.runId,
      call.sessionId,
      call.agentId,
      call.seq,
      call.turnNumber,
      call.timestamp,
      call.model,
      call.inputTokens,
      call.outputTokens,
      call.cachedTokens,
      call.reasoningTokens,
      call.reasoningTokensEstimated ? 1 : 0,
      call.latencyMs,
      call.loadDurationMs,
      call.promptEvalDurationMs,
      call.evalDurationMs,
      call.estimatedCost,
      call.contextMessageCount,
      call.contextTokensEstimated,
      call.contextRefs,
      call.responsePreview,
      call.thinkingPreview,
      call.toolCallsRequested,
      call.status,
      call.errorMessage,
    );

    return Number(result.lastInsertRowid);
  }

  insertToolCall(call: ToolCallInsert): void {
    this.prepare(
      `INSERT INTO tool_calls (run_id, llm_call_id, seq, turn_number, timestamp, tool_name,
                               arguments, input_size_bytes, output_size_bytes, output_tokens,
                               raw_output_size_bytes, raw_output_tokens, duration_ms, status,
                               output_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      call.runId,
      call.llmCallId,
      call.seq,
      call.turnNumber,
      call.timestamp,
      call.toolName,
      call.argumentsJson,
      call.inputSizeBytes,
      call.outputSizeBytes,
      call.outputTokens,
      call.rawOutputSizeBytes,
      call.rawOutputTokens,
      call.durationMs,
      call.status,
      call.outputPreview,
    );
  }

  /** The benchmark verifies a run after the agent has already closed it out. */
  setRunSuccess(runId: string, success: boolean, detail: string): void {
    this.prepare("UPDATE runs SET success = ?, success_detail = ? WHERE run_id = ?").run(
      success ? 1 : 0,
      detail,
      runId,
    );
  }

  /** Marks runs left behind by a crash so they do not count as "running" forever. */
  failStaleRuns(): void {
    this.prepare(
      `UPDATE runs SET status = 'error', error_message = 'process exited before the run finished'
       WHERE status = 'running'`,
    ).run();
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);

    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }

    return statement;
  }
}
