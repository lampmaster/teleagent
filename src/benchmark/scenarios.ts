import type { Message } from "../llm/index.js";
import type { ExecutedToolCall } from "../agent/index.js";

export type ScenarioType =
  | "simple"
  | "multi-tool"
  | "large-output"
  | "long-history"
  | "repeated-data";

export interface Scenario {
  id: string;
  type: ScenarioType;
  /** What the scenario is meant to measure. */
  intent: string;
  /** Conversation history the run starts from; identical for every configuration. */
  history: Message[];
  userMessage: string;
  /** Every pattern must appear in the final response for the run to count as a success. */
  expect: RegExp[];
  /** Guards against an answer produced from the prompt alone. */
  requireToolCall?: boolean;
}

export interface SuccessCheck {
  success: boolean;
  detail: string;
}

export function checkSuccess(
  scenario: Scenario,
  status: string,
  response: string,
  toolCalls: ExecutedToolCall[],
): SuccessCheck {
  if (status !== "completed") {
    return { success: false, detail: `run did not complete (${status})` };
  }

  if (scenario.requireToolCall !== false && toolCalls.length === 0) {
    return { success: false, detail: "no tool call was made" };
  }

  const missing = scenario.expect.filter((pattern) => !pattern.test(response));

  return missing.length === 0
    ? { success: true, detail: "all expected facts present" }
    : { success: false, detail: `missing: ${missing.map(String).join(", ")}` };
}

function exchange(user: string, assistant: string): Message[] {
  return [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ];
}

/** Filler history that is irrelevant to the question but must still be carried. */
function filler(count: number, seed: string): Message[] {
  const messages: Message[] = [];

  for (let index = 0; index < count; index += 1) {
    messages.push(
      ...exchange(
        `${seed} note ${index + 1}: please remember that checklist item ${index + 1} is about rotating the ${index % 2 === 0 ? "staging" : "production"} credentials next quarter.`,
        `Noted. Checklist item ${index + 1} concerns rotating the ${index % 2 === 0 ? "staging" : "production"} credentials next quarter. I will keep it in mind for this conversation.`,
      ),
    );
  }

  return messages;
}

const PROJECT_MEMO: Message[] = exchange(
  "For the rest of this conversation, the internal code name of our project is orion-7. Remember it.",
  "Understood. The internal code name of the project is orion-7.",
);

const OWNER_MEMO: Message[] = exchange(
  "Also remember that the on-call owner for the database is Mira Halden.",
  "Understood. The on-call owner for the database is Mira Halden.",
);

const LOG_IN_HISTORY: Message[] = [
  {
    role: "user",
    content: "Earlier you looked at the deployment log; here is what it said.",
  },
  {
    role: "assistant",
    content:
      "Yes. The rollout of revision r-4412 reported that service billing-api failed to start with exit status 2, and a rollback was scheduled. The api-gw rollout finished successfully.",
  },
];

export const SCENARIOS: Scenario[] = [
  // --- Type 1: simple requests ------------------------------------------------
  {
    id: "simple-date",
    type: "simple",
    intent: "Baseline cost of a single-fact request.",
    history: [],
    userMessage: "What is the current system date? Report the month, day and year.",
    expect: [/\bsep(tember)?\b/i, /\b17\b/, /\b2026\b/],
  },
  {
    id: "simple-hostname",
    type: "simple",
    intent: "Baseline cost of a single-fact request with a distinctive answer.",
    history: [],
    userMessage: "What is the hostname of this machine?",
    expect: [/benchbox-7/i],
  },
  {
    id: "simple-uptime",
    type: "simple",
    intent: "Baseline cost when the answer must be read out of command output.",
    history: [],
    userMessage: "How many days has this machine been up? Answer with the number of days.",
    expect: [/\b9\b/],
  },
  {
    id: "simple-kernel",
    type: "simple",
    intent: "Baseline cost when the answer is an exact version string.",
    history: [],
    userMessage: "Which kernel version is this machine running? Report the exact version string.",
    expect: [/6\.11\.0-bench/],
  },

  // --- Type 2: several tools --------------------------------------------------
  {
    id: "multi-date-weather",
    type: "multi-tool",
    intent: "Two independent facts: measures turns and tool calls.",
    history: [],
    userMessage:
      "Tell me two things: the current system date, and the weather in Berlin from wttr.in.",
    expect: [/\b2026\b/, /\b14\b/],
  },
  {
    id: "multi-system-triple",
    type: "multi-tool",
    intent: "Three independent facts in one request.",
    history: [],
    userMessage:
      "Report three things about this machine: its hostname, its number of CPU cores, and the current date.",
    expect: [/benchbox-7/i, /\b8\b/, /\b2026\b/],
  },
  {
    id: "multi-proc-disk",
    type: "multi-tool",
    intent: "Two facts that each need a different command and some reading.",
    history: [],
    userMessage:
      "Which process is using the most memory right now, and how full is the root filesystem?",
    expect: [/postgres/i, /62\s*%/],
  },
  {
    id: "multi-start-day",
    type: "multi-tool",
    intent: "Skill-driven multi-step routine: load_skill plus three exec calls.",
    history: [],
    userMessage: "Run the start-day routine and report its results.",
    expect: [/\b14\b/, /postgres/i, /\b2026\b/],
  },

  // --- Type 3: large tool outputs ---------------------------------------------
  {
    id: "large-log-error-code",
    type: "large-output",
    intent: "A ~7 KB log where only one error code matters.",
    history: [],
    userMessage:
      "Read /var/log/app.log and tell me the error code of the critical database failure.",
    expect: [/E7731/i],
  },
  {
    id: "large-deploy-failure",
    type: "large-output",
    intent: "A ~7 KB log where only the failing service name matters.",
    history: [],
    userMessage:
      "Read /var/log/deploy.log and tell me which service failed to start during the rollout.",
    expect: [/billing-api/i],
  },
  {
    id: "large-config-value",
    type: "large-output",
    intent: "A ~7 KB configuration dump where one setting matters.",
    history: [],
    userMessage:
      "Read /etc/app/config.dump and tell me the configured value of max_connections.",
    expect: [/\b512\b/],
  },
  {
    id: "large-process-owner",
    type: "large-output",
    intent: "A ~5 KB process table where one row matters.",
    history: [],
    userMessage:
      "Run a full process listing with `ps aux` and tell me which user owns the process using the most memory.",
    expect: [/pgsvc/i],
  },

  // --- Type 4: long history ---------------------------------------------------
  {
    id: "history-short-recall",
    type: "long-history",
    intent: "Short history (10 messages) plus a fresh tool call.",
    history: [...PROJECT_MEMO, ...filler(4, "Sprint")],
    userMessage:
      "Remind me the internal code name of our project, and also tell me the current system date.",
    expect: [/orion-7/i, /\b2026\b/],
  },
  {
    id: "history-medium-recall",
    type: "long-history",
    intent: "Medium history (22 messages) plus a fresh tool call.",
    history: [...PROJECT_MEMO, ...filler(10, "Planning")],
    userMessage:
      "What is the internal code name of our project, and what is this machine's hostname?",
    expect: [/orion-7/i, /benchbox-7/i],
  },
  {
    id: "history-long-recall",
    type: "long-history",
    intent: "Long history (38 messages) plus a fresh tool call.",
    history: [...PROJECT_MEMO, ...OWNER_MEMO, ...filler(17, "Backlog")],
    userMessage:
      "Who is the on-call owner for the database, and how many CPU cores does this machine have?",
    expect: [/mira/i, /\b8\b/],
  },
  {
    id: "history-with-tool-data",
    type: "long-history",
    intent: "History that already contains a large tool result plus filler.",
    history: [...PROJECT_MEMO, ...LOG_IN_HISTORY, ...filler(12, "Retro")],
    userMessage:
      "According to the deployment log we discussed, which service failed to start? Also report the current date.",
    expect: [/billing-api/i, /\b2026\b/],
  },

  // --- Type 5: repeated data --------------------------------------------------
  {
    id: "repeat-log-twice",
    type: "repeated-data",
    intent: "The same ~7 KB log is needed twice in one run.",
    history: [],
    userMessage:
      "Read /var/log/app.log and report the critical error code. Then read /var/log/app.log a second time and confirm the same error code is still there.",
    expect: [/E7731/i],
  },
  {
    id: "repeat-config-two-values",
    type: "repeated-data",
    intent: "Two values from the same large file, usually read twice.",
    history: [],
    userMessage:
      "From /etc/app/config.dump report the value of max_connections. Then, reading /etc/app/config.dump again, report the value of cache_size.",
    expect: [/\b512\b/, /4096/],
  },
  {
    id: "repeat-weather-confirm",
    type: "repeated-data",
    intent: "The same small tool result requested twice across turns.",
    history: [],
    userMessage:
      "Get the Berlin weather from wttr.in and report the temperature. Then fetch it again and confirm the temperature is unchanged.",
    expect: [/\b14\b/],
  },
  {
    id: "repeat-process-recheck",
    type: "repeated-data",
    intent: "A process listing requested twice plus a second, different command.",
    history: [],
    userMessage:
      "Check which process uses the most memory, then check the root filesystem usage, then re-check the process list and confirm the top process has not changed.",
    expect: [/postgres/i, /62\s*%/],
  },
];

export const SCENARIOS_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));
