import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * One flag per implemented optimization. Everything defaults to off so that a
 * fresh install and the baseline benchmark run the original agent.
 */
export interface FeatureFlags {
  /** Fold the oldest history into a summary once it passes a token threshold. */
  contextCompaction: boolean;
  /** Cap the tokens a single tool result may add, keeping the useful parts. */
  toolOutputLimiting: boolean;
  /** Let one exec call run several independent commands instead of one turn each. */
  batchIndependentTools: boolean;
  /** Replace a repeated identical tool result with a short pointer to the first one. */
  contextDeduplication: boolean;
  /** Give up once the model has replied with nothing several turns in a row. */
  earlyStop: boolean;
}

export const FLAG_DESCRIPTIONS: Record<keyof FeatureFlags, string> = {
  contextCompaction:
    "When history passes the token threshold, fold its oldest part into a summary at the start of a run. The prefix stays stable in between, so prompt caching keeps working.",
  toolOutputLimiting:
    "Limit tool output tokens, keeping head, errors and tail; offer a way to fetch the rest.",
  batchIndependentTools:
    "Allow one exec call to run several independent commands, cutting agent turns.",
  contextDeduplication:
    "Replace a repeated identical tool result with a pointer to its first occurrence.",
  earlyStop:
    "Stop a run after 5 empty replies in a row; the audit found such runs almost never recover.",
};

export const DEFAULT_FLAGS: FeatureFlags = {
  contextCompaction: false,
  toolOutputLimiting: false,
  batchIndependentTools: false,
  contextDeduplication: false,
  earlyStop: false,
};

export const FLAG_NAMES = Object.keys(DEFAULT_FLAGS) as Array<keyof FeatureFlags>;

export function allFlagsOff(): FeatureFlags {
  return { ...DEFAULT_FLAGS };
}

export function allFlagsOn(): FeatureFlags {
  const flags = allFlagsOff();

  for (const name of FLAG_NAMES) {
    flags[name] = true;
  }

  return flags;
}

export function onlyFlag(name: keyof FeatureFlags): FeatureFlags {
  return { ...DEFAULT_FLAGS, [name]: true };
}

export function enabledFlagNames(flags: FeatureFlags): string[] {
  return FLAG_NAMES.filter((name) => flags[name]);
}

/**
 * Flags live in a small JSON file shared by the bot and the dashboard. The bot
 * re-reads it at the start of every run, so a toggle applies to new runs only;
 * runs already recorded keep the snapshot stored with them.
 */
export class FlagStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  read(): FeatureFlags {
    try {
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, unknown>;
      return normalize(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(`Failed to read feature flags from ${this.filePath}`, error);
      }

      return allFlagsOff();
    }
  }

  write(flags: FeatureFlags): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, `${JSON.stringify(flags, null, 2)}\n`, "utf8");
  }
}

/** A store that never touches disk: used by the benchmark, which sets flags per run. */
export class StaticFlagStore {
  constructor(private flags: FeatureFlags) {}

  read(): FeatureFlags {
    return { ...this.flags };
  }

  write(flags: FeatureFlags): void {
    this.flags = { ...flags };
  }
}

export type FlagSource = Pick<FlagStore, "read">;

function normalize(raw: Record<string, unknown>): FeatureFlags {
  const flags = allFlagsOff();

  for (const name of FLAG_NAMES) {
    if (typeof raw[name] === "boolean") {
      flags[name] = raw[name];
    }
  }

  return flags;
}
