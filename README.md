# teleagent

A Telegram bot that runs a small autonomous agent on top of a local
[Ollama](https://ollama.com) instance. The agent can run shell commands
(`exec` tool), load reusable Skills (Markdown files in `skills/`), and
remembers conversations across restarts (`data/conversations.json`).

It also records what every run costs — LLM calls, tool calls, tokens and
context reuse — into a SQLite database, and serves a dashboard over that data
with switches for the token-saving optimizations.

> **Note:** `exec` gives the model shell access under the account running
> the bot. Set `TELEGRAM_ALLOWED_USER_ID` to restrict it to yourself and/or
> run it in Docker.

## Setup

- Docker with Compose, and npm to run the scripts (recommended), or Node.js 22+
  to run locally
- A local Ollama instance (default `http://localhost:11434`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A model with tool-calling support (the measurements here use `qwen3:1.7b`)

```bash
cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN, OLLAMA_BASE_URL, OLLAMA_MODEL
```

## Running

**Run it in Docker.** The agent's `exec` tool runs any shell command the model
decides on. In Docker those commands are confined to a container with a
read-only filesystem, no Linux capabilities, no privilege escalation and a
memory and process limit. Run locally, they execute with your own user's full
access to your machine. On a computer you care about, use Docker.

Docker only needs Docker and npm on the host; `npm install` is not required,
because every `docker` script builds and runs inside the container.

```bash
npm run start:docker   # build the image, start the bot and the dashboard
```

The dashboard is then on <http://localhost:8787>. The first start takes a
couple of minutes to build the image; later starts take seconds.

## Commands

### Docker (recommended)

| Command | What it does |
| --- | --- |
| `npm run start:docker` | Build the image and start the bot and the dashboard in the background |
| `npm run logs:docker` | Follow the bot's and the dashboard's logs |
| `npm run debug:docker` | Restart the bot with agent-loop logging (iterations, tool calls, results) and follow its logs |
| `npm run stop:docker` | Stop everything |
| `npm run bench:docker` | Run the benchmark; pass options after `--`, e.g. `npm run bench:docker -- --configs baseline` |
| `npm run test:docker` | Build the image and run the unit tests inside it |

Run `npm run start:docker` again to leave debug mode.

### Local

Runs directly on your machine, without the sandbox described above. Needs
Node.js 22+ and `npm install` first.

| Command | What it does |
| --- | --- |
| `npm run build:local` | Compile TypeScript to `dist/` |
| `npm run start:local` | Start the bot |
| `npm run debug:local` | Start the bot with agent-loop logging |
| `npm run dashboard:local` | Start the dashboard |
| `npm run bench:local` | Run the benchmark |
| `npm run test:local` | Compile and run the unit tests |

In Telegram: send any text message; `/new` starts a fresh conversation.

## Dashboard

<http://localhost:8787> shows, for the selected dataset (bot or benchmark):

- an **Overview** with run counts, success rate, token and cost totals,
  per-run averages, latency, and how much of the context is re-sent;
- **token consumption per tool**, so it is visible which tool floods the context;
- **optimization switches**, which apply to new runs and are snapshotted per run;
- **sessions → runs → run details**, where each run shows an execution map
  (`user message → LLM call → tool → LLM call → …`) with expandable nodes,
  per-call token/cost/latency figures, and which context messages were re-sent.

## Metrics

Metrics land in SQLite (`data/metrics.db`) in four linked tables: `sessions`,
`runs`, `llm_calls` and `tool_calls`. LLM and tool calls share one `seq`
counter per run, which is what the execution map is rebuilt from.

Which numbers are measured and which are estimated:

| Metric | Source |
| --- | --- |
| input tokens | Ollama `prompt_eval_count` — actual |
| output tokens | Ollama `eval_count` — actual (includes thinking) |
| cached input tokens | Ollama `prompt_eval_cached_count` — actual, subset of input |
| durations | Ollama `total/load/prompt_eval/eval_duration` — actual |
| reasoning tokens | Qwen3 tokenizer over the `thinking` text — **estimated**, subset of output |
| tool output tokens | Qwen3 tokenizer — **estimated** |
| context composition and re-sent tokens | Qwen3 tokenizer per message — **estimated** |

A metric that is unavailable is stored as `NULL`, never as `0`. Cost is billed
at `$0.15 / 1M` input and `$0.25 / 1M` output tokens, configurable via
`COST_INPUT_PER_MTOK` and `COST_OUTPUT_PER_MTOK` — switching providers means
changing those two rates. Cached and reasoning tokens are reported separately
and are never charged twice, since Ollama reports them as subsets of the input
and output counts.

Credential-shaped strings are masked before anything is written, and stored
previews are capped so one huge tool result cannot bloat the database.

## Context compaction

With `contextCompaction` on, a conversation's history is left alone until it
passes `COMPACTION_HIGH_TOKENS` (default 20,000); then, at the start of the next
request, its oldest part is folded into one summary, down to
`COMPACTION_LOW_TOKENS` (default 10,000). User messages are kept verbatim,
except ones longer than `COMPACTION_USER_MESSAGE_MAX_CHARS` (2,000), which keep
their first `COMPACTION_USER_MESSAGE_KEEP_CHARS` (1,000) characters. It
never compacts between the LLM calls of a request, and the cut point is stored
in `data/compaction-state.json`, so the prefix stays identical between
compactions and a provider's prompt cache keeps hitting. The full history in
`data/conversations.json` is never modified.

## Benchmark

The benchmark drives the same agent loop directly — no Telegram — against the
real model, with `exec` results replaced by fixed fixtures so runs are
reproducible. It writes to `./benchmark-data`, never to the bot's data.

```bash
npm run bench:docker -- --configs baseline --repetitions 3
npm run bench:docker -- --configs all --repetitions 3
npm run bench:docker -- --report /app/results/tables.md
npm run bench:docker -- --help
```

20 scenarios cover five kinds of load: simple requests, multi-tool requests,
large tool outputs, long histories and repeated data. Each has deterministic
success criteria, and the results are in [`results/`](results/).
