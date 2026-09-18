import { DEFAULT_PRICING, type Pricing } from "./metrics/pricing.js";
import {
  DEFAULT_COMPACTION_HIGH_TOKENS,
  DEFAULT_COMPACTION_LOW_TOKENS,
  DEFAULT_USER_MESSAGE_KEEP_CHARS,
  DEFAULT_USER_MESSAGE_MAX_CHARS,
  type CompactionThresholds,
} from "./optimizations/contextCompaction.js";

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalIntEnv(name: string): number | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer: ${value}`);
  }

  return parsed;
}

function intEnv(name: string, fallback: number): number {
  return optionalIntEnv(name) ?? fallback;
}

function floatEnv(name: string, fallback: number): number {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a number: ${value}`);
  }

  return parsed;
}

const dataDirectory = process.env.DATA_DIR ?? "data";

function compactionThresholds(): CompactionThresholds {
  const high = intEnv("COMPACTION_HIGH_TOKENS", DEFAULT_COMPACTION_HIGH_TOKENS);
  const low = intEnv("COMPACTION_LOW_TOKENS", DEFAULT_COMPACTION_LOW_TOKENS);

  if (low <= 0 || low >= high) {
    throw new Error(
      `COMPACTION_LOW_TOKENS (${low}) must be positive and below COMPACTION_HIGH_TOKENS (${high})`,
    );
  }

  const userMessageMaxChars = intEnv(
    "COMPACTION_USER_MESSAGE_MAX_CHARS",
    DEFAULT_USER_MESSAGE_MAX_CHARS,
  );
  const userMessageKeepChars = intEnv(
    "COMPACTION_USER_MESSAGE_KEEP_CHARS",
    DEFAULT_USER_MESSAGE_KEEP_CHARS,
  );

  if (userMessageKeepChars <= 0 || userMessageKeepChars >= userMessageMaxChars) {
    throw new Error(
      `COMPACTION_USER_MESSAGE_KEEP_CHARS (${userMessageKeepChars}) must be positive and below ` +
        `COMPACTION_USER_MESSAGE_MAX_CHARS (${userMessageMaxChars})`,
    );
  }

  return { high, low, userMessageMaxChars, userMessageKeepChars };
}

export const pricing: Pricing = {
  inputPerMillion: floatEnv("COST_INPUT_PER_MTOK", DEFAULT_PRICING.inputPerMillion),
  outputPerMillion: floatEnv("COST_OUTPUT_PER_MTOK", DEFAULT_PRICING.outputPerMillion),
};

export const config = {
  ollamaBaseUrl: requireEnv("OLLAMA_BASE_URL"),
  ollamaModel: requireEnv("OLLAMA_MODEL"),
  dataDirectory,
  conversationsFile:
    process.env.CONVERSATIONS_FILE ?? `${dataDirectory}/conversations.json`,
  metricsDatabase: process.env.METRICS_DB ?? `${dataDirectory}/metrics.db`,
  featureFlagsFile:
    process.env.FEATURE_FLAGS_FILE ?? `${dataDirectory}/feature-flags.json`,
  compactionStateFile:
    process.env.COMPACTION_STATE_FILE ?? `${dataDirectory}/compaction-state.json`,
  compactionThresholds: compactionThresholds(),
  skillsDirectory: process.env.SKILLS_DIR ?? "skills",
  maxIterations: intEnv("AGENT_MAX_ITERATIONS", 7),
  pricing,
  debug: process.env.AGENT_DEBUG === "1",
} as const;

/** Only needed by the Telegram entrypoint; the benchmark and dashboard do not use it. */
export const telegramConfig = {
  botToken: () => requireEnv("TELEGRAM_BOT_TOKEN"),
  allowedUserId: optionalIntEnv("TELEGRAM_ALLOWED_USER_ID"),
};

export const dashboardConfig = {
  port: intEnv("DASHBOARD_PORT", 8787),
  host: process.env.DASHBOARD_HOST ?? "0.0.0.0",
  /** Optional read-only second dataset so benchmark runs can be inspected too. */
  benchmarkDatabase: process.env.BENCHMARK_METRICS_DB ?? null,
};
