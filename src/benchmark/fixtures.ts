import type { CommandRunner, ExecOutcome } from "../tools/index.js";

export interface Fixture {
  pattern: RegExp;
  outcome: ExecOutcome;
}

const ok = (stdout: string): ExecOutcome => ({ stdout, stderr: "", exitCode: 0 });

/** Deterministic pseudo-random source, so every benchmark run sees identical logs. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

const SERVICES = ["worker-03", "api-gw", "billing-api", "scheduler", "cache-warm"] as const;
const ACTIONS = [
  "processed batch",
  "flushed buffer",
  "renewed lease",
  "committed offset",
  "compacted segment",
] as const;

function appLog(lines: number, seed: number, injected: Map<number, string>): string {
  const random = lcg(seed);
  const rows: string[] = [];

  for (let index = 0; index < lines; index += 1) {
    const injectedRow = injected.get(index);

    if (injectedRow) {
      rows.push(injectedRow);
      continue;
    }

    const minute = String(Math.floor(index / 60) % 24).padStart(2, "0");
    const second = String(index % 60).padStart(2, "0");
    const id = String(Math.floor(random() * 9000) + 1000);
    const took = Math.floor(random() * 400) + 20;

    rows.push(
      `2026-09-17T09:${minute}:${second}Z INFO  ${pick(random, SERVICES)} ${pick(random, ACTIONS)} ${id} in ${took}ms`,
    );
  }

  return `${rows.join("\n")}\n`;
}

const APP_LOG = appLog(
  104,
  20_260_917,
  new Map([
    [12, "2026-09-17T09:00:12Z WARN  cache-warm retrying upstream fetch (attempt 2)"],
    [
      57,
      "2026-09-17T09:00:57Z ERROR db-pool CRITICAL connection pool exhausted, code=E7731, waiters=64",
    ],
    [58, "2026-09-17T09:00:58Z ERROR db-pool giving up after 30s, code=E7731"],
    [91, "2026-09-17T09:01:31Z WARN  scheduler skipped tick, lag 4200ms"],
  ]),
);

const DEPLOY_LOG = appLog(
  110,
  777_001,
  new Map([
    [30, "2026-09-17T11:04:30Z INFO  deploy starting rollout revision r-4412"],
    [
      71,
      "2026-09-17T11:05:11Z ERROR deploy service billing-api failed to start: exit status 2",
    ],
    [72, "2026-09-17T11:05:12Z ERROR deploy rollback of billing-api scheduled"],
    [99, "2026-09-17T11:05:39Z INFO  deploy rollout of api-gw completed"],
  ]),
);

function configDump(): string {
  const random = lcg(4_242);
  const rows = [
    "# /etc/app/config.dump — effective configuration",
    "max_connections = 512",
    "cache_size = 4096MB",
    "listen_address = 0.0.0.0",
  ];

  for (let index = 0; index < 300; index += 1) {
    rows.push(
      `tuning.param_${String(index).padStart(3, "0")} = ${Math.floor(random() * 100_000)}`,
    );
  }

  rows.push("statement_timeout = 30s", "log_level = info");

  return `${rows.join("\n")}\n`;
}

const CONFIG_DUMP = configDump();

const PS_TOP = [
  "  PID COMMAND            %MEM",
  " 4821 postgres           18.7",
  " 1904 node               11.2",
  " 2277 chrome              8.4",
  " 3310 ollama              6.9",
  " 1044 systemd             1.1",
].join("\n");

function psFull(): string {
  const random = lcg(31_337);
  const rows = [
    "USER       PID   %MEM  RSS      COMMAND",
    "pgsvc     4821   18.7  3064120  postgres: main writer process",
    "appuser   1904   11.2  1834992  node /srv/app/dist/server.js",
    "desktop   2277    8.4  1376404  chrome --type=renderer",
    "ollama    3310    6.9  1129884  ollama runner --model qwen3",
  ];

  for (let index = 0; index < 88; index += 1) {
    const pid = 5000 + index * 7;
    const mem = (random() * 1.4).toFixed(1);
    rows.push(
      `svc${String(index % 9)}      ${pid}    ${mem}  ${Math.floor(random() * 90_000) + 4000}    /usr/lib/helper-${String(index).padStart(2, "0")} --daemon`,
    );
  }

  return `${rows.join("\n")}\n`;
}

const PS_FULL = psFull();

const WEATHER = [
  "Weather report: Berlin",
  "",
  "     \\   /     Light rain",
  "      .-.      +14(12) °C",
  "   ― (   ) ―   ↙ 17 km/h",
  "      `-’      8 km",
  "     /   \\     1.2 mm",
].join("\n");

/** Shared, deterministic replacements for the commands the scenarios provoke. */
export const BASE_FIXTURES: Fixture[] = [
  { pattern: /\bwttr\.in\b|\bweather\b/i, outcome: ok(`${WEATHER}\n`) },
  { pattern: /app\.log\b/, outcome: ok(APP_LOG) },
  { pattern: /deploy\.log\b/, outcome: ok(DEPLOY_LOG) },
  { pattern: /config\.dump\b/, outcome: ok(CONFIG_DUMP) },
  { pattern: /\bps\b[^|]*\b(aux|-ef|u\b|USER)/i, outcome: ok(PS_FULL) },
  { pattern: /\bps\b|\btop\b/, outcome: ok(`${PS_TOP}\n`) },
  {
    pattern: /\bdf\b/,
    outcome: ok(
      [
        "Filesystem      Size  Used Avail Use% Mounted on",
        "/dev/sda1       228G  135G   82G  62% /",
        "tmpfs            16G  1.1G   15G   7% /dev/shm",
        "",
      ].join("\n"),
    ),
  },
  {
    pattern: /\bfree\b/,
    outcome: ok(
      [
        "               total        used        free      shared",
        "Mem:           15998        9214        2140         612",
        "Swap:           4095         128        3967           0",
        "",
      ].join("\n"),
    ),
  },
  { pattern: /\buname\b/, outcome: ok("Linux benchbox-7 6.11.0-bench #1 SMP x86_64 GNU/Linux\n") },
  { pattern: /\bhostname\b|\/etc\/hostname\b/, outcome: ok("benchbox-7\n") },
  {
    pattern: /\buptime\b/,
    outcome: ok(" 21:57:45 up 9 days,  3:14,  2 users,  load average: 0.42, 0.55, 0.61\n"),
  },
  { pattern: /\bnproc\b|cpuinfo\b/, outcome: ok("8\n") },
  { pattern: /\bwhoami\b|\bid -un\b/, outcome: ok("agentuser\n") },
  { pattern: /\bdate\b|\btimedatectl\b/, outcome: ok("Wed Sep 17 21:57:45 EEST 2026\n") },
];

function matchOne(command: string, fixtures: Fixture[]): ExecOutcome {
  for (const fixture of fixtures) {
    if (fixture.pattern.test(command)) {
      return fixture.outcome;
    }
  }

  return {
    stdout: "",
    stderr: `sh: 1: ${command.trim().split(/\s+/)[0] ?? command}: not found\n`,
    exitCode: 127,
  };
}

/**
 * A command runner backed by fixtures. Unknown commands get a fixed shell-style
 * failure so an unexpected command can never make a run non-reproducible.
 *
 * `;`, `&&` and `||` are honoured the way a shell would chain them, which is
 * what `batchIndependentTools` relies on. Pipes are left alone: a fixture
 * answers the whole pipeline, as it did before this was added.
 */
export function scriptedRunner(fixtures: Fixture[] = BASE_FIXTURES): CommandRunner {
  return async (command: string): Promise<ExecOutcome> => {
    const parts = command
      .split(/\s*(?:;|&&|\|\||\n)\s*/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    if (parts.length <= 1) {
      return matchOne(command, fixtures);
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const part of parts) {
      const outcome = matchOne(part, fixtures);
      stdout += outcome.stdout;
      stderr += outcome.stderr;

      if (outcome.exitCode !== 0) {
        exitCode = outcome.exitCode;
      }
    }

    return { stdout, stderr, exitCode };
  };
}

export const FIXTURE_SIZES = {
  appLogChars: APP_LOG.length,
  deployLogChars: DEPLOY_LOG.length,
  configDumpChars: CONFIG_DUMP.length,
  psFullChars: PS_FULL.length,
};
