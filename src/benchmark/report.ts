import { MetricsStore } from "../metrics/index.js";
import { SCENARIOS_BY_ID } from "./scenarios.js";

interface ConfigAggregate {
  config: string;
  runs: number;
  successes: number;
  completed: number;
  maxIterations: number;
  timeouts: number;
  stalled: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number | null;
  reasoningTokens: number | null;
  repeatedContextTokens: number | null;
  toolOutputTokens: number | null;
  cost: number;
  turns: number;
  toolCalls: number;
  durationMs: number;
}

export function aggregateByConfig(store: MetricsStore): ConfigAggregate[] {
  return store.query<ConfigAggregate>(`
    SELECT benchmark_config                AS config,
           COUNT(*)                        AS runs,
           COALESCE(SUM(success = 1), 0)   AS successes,
           COALESCE(SUM(status = 'completed'), 0)      AS completed,
           COALESCE(SUM(status = 'max_iterations'), 0) AS maxIterations,
           COALESCE(SUM(status = 'timeout'), 0)        AS timeouts,
           COALESCE(SUM(status = 'stalled'), 0)        AS stalled,
           COALESCE(SUM(status = 'error'), 0)          AS errors,
           COALESCE(SUM(total_input_tokens), 0)        AS inputTokens,
           COALESCE(SUM(total_output_tokens), 0)       AS outputTokens,
           SUM(total_cached_tokens)                    AS cachedTokens,
           SUM(total_reasoning_tokens)                 AS reasoningTokens,
           SUM(repeated_context_tokens)                AS repeatedContextTokens,
           SUM(tool_output_tokens)                     AS toolOutputTokens,
           COALESCE(SUM(total_cost), 0)                AS cost,
           COALESCE(SUM(turns), 0)                     AS turns,
           COALESCE(SUM(tool_call_count), 0)           AS toolCalls,
           COALESCE(SUM(total_duration_ms), 0)         AS durationMs
    FROM runs
    WHERE benchmark_config IS NOT NULL
    GROUP BY benchmark_config
  `);
}

export interface ScenarioAggregate {
  config: string;
  scenario: string;
  runs: number;
  successes: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  turns: number;
  toolCalls: number;
}

export function aggregateByScenario(store: MetricsStore): ScenarioAggregate[] {
  return store.query<ScenarioAggregate>(`
    SELECT benchmark_config AS config, benchmark_scenario AS scenario,
           COUNT(*) AS runs, COALESCE(SUM(success = 1), 0) AS successes,
           COALESCE(SUM(total_input_tokens), 0)  AS inputTokens,
           COALESCE(SUM(total_output_tokens), 0) AS outputTokens,
           COALESCE(SUM(total_cost), 0)          AS cost,
           COALESCE(SUM(turns), 0)               AS turns,
           COALESCE(SUM(tool_call_count), 0)     AS toolCalls
    FROM runs
    WHERE benchmark_config IS NOT NULL
    GROUP BY benchmark_config, benchmark_scenario
  `);
}

export interface TypeAggregate extends ScenarioAggregate {
  type: string;
}

export function aggregateByType(store: MetricsStore): TypeAggregate[] {
  const merged = new Map<string, TypeAggregate>();

  for (const row of aggregateByScenario(store)) {
    const type = SCENARIOS_BY_ID.get(row.scenario)?.type ?? "unknown";
    const key = `${row.config}::${type}`;
    const existing = merged.get(key);

    if (existing) {
      existing.runs += row.runs;
      existing.successes += row.successes;
      existing.inputTokens += row.inputTokens;
      existing.outputTokens += row.outputTokens;
      existing.cost += row.cost;
      existing.turns += row.turns;
      existing.toolCalls += row.toolCalls;
    } else {
      merged.set(key, { ...row, type, scenario: type });
    }
  }

  return [...merged.values()];
}

export function toolTokensByConfig(store: MetricsStore) {
  return store.query<{
    config: string;
    toolName: string;
    calls: number;
    outputTokens: number | null;
    rawOutputTokens: number | null;
  }>(`
    SELECT r.benchmark_config AS config, t.tool_name AS toolName, COUNT(*) AS calls,
           SUM(t.output_tokens) AS outputTokens, SUM(t.raw_output_tokens) AS rawOutputTokens
    FROM tool_calls t JOIN runs r ON r.run_id = t.run_id
    WHERE r.benchmark_config IS NOT NULL
    GROUP BY r.benchmark_config, t.tool_name
    ORDER BY outputTokens DESC
  `);
}

export function contextGrowthByTurn(store: MetricsStore, config: string) {
  return store.query<{
    turnNumber: number;
    calls: number;
    avgInputTokens: number | null;
    avgContextTokens: number | null;
    avgOutputTokens: number | null;
    avgCachedTokens: number | null;
  }>(
    `
    SELECT c.turn_number AS turnNumber, COUNT(*) AS calls,
           AVG(c.input_tokens) AS avgInputTokens,
           AVG(c.context_tokens_estimated) AS avgContextTokens,
           AVG(c.output_tokens) AS avgOutputTokens,
           AVG(c.cached_tokens) AS avgCachedTokens
    FROM llm_calls c JOIN runs r ON r.run_id = c.run_id
    WHERE r.benchmark_config = ?
    GROUP BY c.turn_number ORDER BY c.turn_number
  `,
    config,
  );
}

const n = (value: number | null | undefined, digits = 0) =>
  value === null || value === undefined
    ? "n/a"
    : value.toLocaleString("en-US", {
        maximumFractionDigits: digits,
        minimumFractionDigits: digits,
      });

const money = (value: number | null | undefined, digits = 5) =>
  value === null || value === undefined ? "n/a" : `$${value.toFixed(digits)}`;

const pct = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(digits)}%`;

function table(header: string[], rows: string[][]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function perRun(aggregate: ConfigAggregate) {
  const divide = (value: number) => (aggregate.runs ? value / aggregate.runs : 0);

  return {
    cost: divide(aggregate.cost),
    input: divide(aggregate.inputTokens),
    output: divide(aggregate.outputTokens),
    turns: divide(aggregate.turns),
    toolCalls: divide(aggregate.toolCalls),
    duration: divide(aggregate.durationMs),
    successRate: divide(aggregate.successes),
  };
}

/** Renders the measured numbers; the written analysis lives in the results file. */
export function renderTables(store: MetricsStore, baselineName = "baseline"): string {
  const configs = aggregateByConfig(store);
  const baseline = configs.find((c) => c.config === baselineName);
  const ordered = [
    ...configs.filter((c) => c.config === baselineName),
    ...configs
      .filter((c) => c.config !== baselineName && c.config !== "all")
      .sort((a, b) => a.config.localeCompare(b.config)),
    ...configs.filter((c) => c.config === "all"),
  ];

  const baselinePerRun = baseline ? perRun(baseline) : null;

  const main = table(
    [
      "Configuration",
      "Runs",
      "Success rate",
      "Input tokens",
      "Output tokens",
      "Total cost",
      "Cost / run",
      "Cost savings",
      "Success rate delta (pp)",
    ],
    ordered.map((aggregate) => {
      const stats = perRun(aggregate);
      const savings =
        baselinePerRun && baselinePerRun.cost > 0
          ? (baselinePerRun.cost - stats.cost) / baselinePerRun.cost
          : null;
      const delta = baselinePerRun
        ? (stats.successRate - baselinePerRun.successRate) * 100
        : null;

      return [
        `\`${aggregate.config}\``,
        String(aggregate.runs),
        `${pct(stats.successRate)} (${aggregate.successes}/${aggregate.runs})`,
        n(aggregate.inputTokens),
        n(aggregate.outputTokens),
        money(aggregate.cost),
        money(stats.cost, 6),
        aggregate.config === baselineName ? "baseline" : pct(savings),
        aggregate.config === baselineName
          ? "baseline"
          : delta === null
            ? "n/a"
            : `${delta >= 0 ? "+" : ""}${delta.toFixed(1)}`,
      ];
    }),
  );

  const detail = table(
    [
      "Configuration",
      "Turns / run",
      "Tool calls / run",
      "Duration / run",
      "Cached input tokens",
      "Reasoning tokens (est.)",
      "Re-sent context tokens (est.)",
      "Tool output tokens (est.)",
      "completed / loop-limit / stalled / timeout / error",
    ],
    ordered.map((aggregate) => {
      const stats = perRun(aggregate);

      return [
        `\`${aggregate.config}\``,
        n(stats.turns, 2),
        n(stats.toolCalls, 2),
        `${(stats.duration / 1000).toFixed(1)} s`,
        n(aggregate.cachedTokens),
        n(aggregate.reasoningTokens),
        n(aggregate.repeatedContextTokens),
        n(aggregate.toolOutputTokens),
        `${aggregate.completed} / ${aggregate.maxIterations} / ${aggregate.stalled} / ${aggregate.timeouts} / ${aggregate.errors}`,
      ];
    }),
  );

  const byType = aggregateByType(store);
  const types = [...new Set(byType.map((row) => row.type))].sort();

  const typeTable = table(
    ["Scenario type", ...ordered.map((c) => `\`${c.config}\` cost / run`)],
    types.map((type) => [
      type,
      ...ordered.map((config) => {
        const row = byType.find((r) => r.config === config.config && r.type === type);
        return row && row.runs ? money(row.cost / row.runs, 6) : "n/a";
      }),
    ]),
  );

  const typeSuccess = table(
    ["Scenario type", ...ordered.map((c) => `\`${c.config}\` success`)],
    types.map((type) => [
      type,
      ...ordered.map((config) => {
        const row = byType.find((r) => r.config === config.config && r.type === type);
        return row && row.runs
          ? `${pct(row.successes / row.runs, 0)} (${row.successes}/${row.runs})`
          : "n/a";
      }),
    ]),
  );

  const tools = toolTokensByConfig(store).filter((row) => row.config === baselineName);
  const toolTable = table(
    ["Tool", "Calls", "Output tokens (est.)", "Avg per call"],
    tools.map((row) => [
      `\`${row.toolName}\``,
      String(row.calls),
      n(row.outputTokens),
      n(row.outputTokens === null ? null : row.outputTokens / row.calls),
    ]),
  );

  const growthTable = table(
    ["Turn", "LLM calls", "Avg input tokens (Ollama)", "Avg cached input", "Avg output tokens"],
    contextGrowthByTurn(store, baselineName).map((row) => [
      String(row.turnNumber),
      String(row.calls),
      n(row.avgInputTokens),
      n(row.avgCachedTokens),
      n(row.avgOutputTokens),
    ]),
  );

  return [
    "### Cost and success rate by configuration",
    "",
    main,
    "",
    "### Loop and context metrics by configuration",
    "",
    detail,
    "",
    "### Cost per run by scenario type",
    "",
    typeTable,
    "",
    "### Success rate by scenario type",
    "",
    typeSuccess,
    "",
    `### Tool output tokens (\`${baselineName}\`)`,
    "",
    toolTable,
    "",
    `### Context growth per turn (\`${baselineName}\`)`,
    "",
    growthTable,
    "",
  ].join("\n");
}
