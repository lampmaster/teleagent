import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { MetricsStore } from "./metrics/index.js";
import {
  allFlagsOff,
  allFlagsOn,
  FLAG_NAMES,
  type FeatureFlags,
} from "./optimizations/flags.js";
import { renderTables } from "./benchmark/report.js";
import { runBenchmark, type BenchmarkConfiguration } from "./benchmark/runner.js";
import { SCENARIOS } from "./benchmark/scenarios.js";

const benchmarkDataDirectory = process.env.BENCHMARK_DATA_DIR ?? "benchmark-data";
const metricsDatabase =
  process.env.BENCHMARK_METRICS_DB ?? `${benchmarkDataDirectory}/benchmark.db`;
const conversationsFile =
  process.env.BENCHMARK_CONVERSATIONS_FILE ??
  `${benchmarkDataDirectory}/conversations.json`;
const compactionStateFile = `${benchmarkDataDirectory}/compaction-state.json`;

const args = parseArgs(process.argv.slice(2));

if (args.has("help")) {
  console.log(
    [
      "Usage: node dist/benchmark.js [options]",
      "",
      `  --configs <list>      Comma-separated: baseline, all, ${FLAG_NAMES.join(", ")},`,
      "                        or a + separated combination, e.g. earlyStop+toolOutputLimiting.",
      "                        A -label suffix stores a re-measurement separately, e.g. earlyStop-v2.",
      "                        Default: baseline",
      "  --scenarios <list>    Comma-separated scenario ids. Default: all 20",
      "  --repetitions <n>     Runs per scenario per configuration. Default: 3",
      "  --concurrency <n>     Runs executed at once. Default: 1.",
      "                        Above 1, wall-clock timings are no longer comparable.",
      "  --report <path>       Write the measured tables to this Markdown file and exit",
      "  --report-baseline <c>  Configuration the report compares against. Default: baseline",
      "  --debug               Log the agent loop",
    ].join("\n"),
  );
  process.exit(0);
}

const reportPath = args.get("report");

if (reportPath) {
  const store = new MetricsStore(metricsDatabase);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(
    reportPath,
    renderTables(store, args.get("report-baseline") ?? "baseline"),
    "utf8",
  );
  store.close();
  console.log(`Wrote ${reportPath}`);
  process.exit(0);
}

const configurations = parseConfigurations(args.get("configs") ?? "baseline");
const scenarios = parseScenarios(args.get("scenarios"));
const repetitions = Number(args.get("repetitions") ?? "3");
const concurrency = Number(args.get("concurrency") ?? "1");

if (!Number.isInteger(repetitions) || repetitions < 1) {
  throw new Error("--repetitions must be a positive integer");
}

if (!Number.isInteger(concurrency) || concurrency < 1) {
  throw new Error("--concurrency must be a positive integer");
}

console.log(
  `Benchmark: ${configurations.length} configuration(s) x ${scenarios.length} scenario(s) x ` +
    `${repetitions} repetition(s) = ${configurations.length * scenarios.length * repetitions} runs`,
);
console.log(`Model: ${config.ollamaModel} at ${config.ollamaBaseUrl}`);
console.log(`Metrics: ${metricsDatabase}`);
console.log(
  concurrency > 1
    ? `Concurrency: ${concurrency} (wall-clock latency and duration are not comparable to a sequential run)`
    : "Concurrency: 1",
);
console.log(
  `Configurations: ${configurations
    .map((c) => `${c.name} [${FLAG_NAMES.filter((f) => c.flags[f]).join(", ") || "none"}]`)
    .join("; ")}\n`,
);

await runBenchmark({
  ollamaBaseUrl: config.ollamaBaseUrl,
  ollamaModel: config.ollamaModel,
  metricsDatabase,
  conversationsFile,
  compactionStateFile,
  compactionThresholds: config.compactionThresholds,
  skillsDirectory: config.skillsDirectory,
  maxIterations: config.maxIterations,
  pricing: config.pricing,
  configurations,
  scenarios,
  repetitions,
  requestTimeoutMs: Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 300_000),
  concurrency,
  debug: args.has("debug") || config.debug,
});

function parseArgs(argv: string[]): Map<string, string> {
  const parsed = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token?.startsWith("--")) {
      continue;
    }

    const name = token.slice(2);
    const next = argv[index + 1];

    if (next && !next.startsWith("--")) {
      parsed.set(name, next);
      index += 1;
    } else {
      parsed.set(name, "true");
    }
  }

  return parsed;
}

/**
 * A configuration name is a flag spec with an optional `-label` suffix. The
 * suffix stores a re-measurement as its own series instead of mixing it with
 * the earlier one, e.g. `earlyStop-v2` or `baseline-c2`.
 */
function parseConfigurations(spec: string): BenchmarkConfiguration[] {
  return spec.split(",").map((raw) => {
    const name = raw.trim();
    const flagSpec = name.split("-")[0] ?? name;

    return { name, flags: flagsFor(flagSpec, name) };
  });
}

function flagsFor(spec: string, name: string): FeatureFlags {
  if (spec === "baseline") {
    return allFlagsOff();
  }

  if (spec === "all") {
    return allFlagsOn();
  }

  const flags = allFlagsOff();
  const parts = spec.split("+").map((value) => value.trim());

  for (const part of parts) {
    if (!(FLAG_NAMES as string[]).includes(part)) {
      throw new Error(
        `Unknown flag "${part}" in configuration "${name}". Known: baseline, all, ` +
          `${FLAG_NAMES.join(", ")}, a + separated combination, and an optional -label suffix`,
      );
    }

    flags[part as keyof FeatureFlags] = true;
  }

  return flags;
}

function parseScenarios(spec: string | undefined) {
  if (!spec) {
    return SCENARIOS;
  }

  const wanted = new Set(spec.split(",").map((value) => value.trim()));
  const selected = SCENARIOS.filter((scenario) => wanted.has(scenario.id));

  for (const id of wanted) {
    if (!selected.some((scenario) => scenario.id === id)) {
      throw new Error(`Unknown scenario id: ${id}`);
    }
  }

  return selected;
}
