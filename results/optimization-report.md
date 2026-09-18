# Token audit and optimization of the teleagent agent

Measured on Ollama 0.34.1 with `qwen3:1.7b`, everything executed inside the
project's Docker Compose setup. Every number in this report comes from the
SQLite metrics database the agent writes; nothing is estimated by hand.

## Summary

| Target | Result |
| --- | --- |
| Cost reduction ≥ 30% | **Not met — 24.1%** with quality preserved |
| Success rate drop ≤ 2 pp | **Met — 0.0 pp** (33/60 against 33/60) |

Against a control measured under identical conditions, all five optimizations
together cut cost by **24.1%** (input tokens −39%, tool output tokens
−89%) while ending on exactly the control's success rate.

An earlier build of the same combination showed **32.5%** — but at **−10
percentage points** of success. That saving was partly an artifact of two
defects: a compaction step that deleted facts the user had stated, and an
early-stop threshold set one too low. Fixing them restored quality completely
and gave back a third of the saving. The 30% target was therefore reachable only
by degrading the agent, which is why it is reported as not met.

The single most valuable optimization is `toolOutputLimiting`: **19.5% of total
cost, 85% of tool output tokens removed, and not one run lost out of sixty.**

`contextCompaction` was redesigned after the measurements, once it became clear
that compacting on every LLM call defeats a provider's prompt cache: it now
compacts only at the start of a run, once history passes 20,000 tokens. That
final design is unit-tested but not benchmarked (section 5B).

Two results worth reading even if nothing else: `batchIndependentTools` was
measured as **12% more expensive** than doing nothing, and the largest lever on
this agent's success rate is not a token optimization at all — it is one
paragraph of its system prompt (section 4.7).

---

## 1. The architecture before the change

`teleagent` is a Telegram bot wrapping a small agent loop:

- **`Agent.run()`** builds a context of `system prompt + stored history + user
  message`, calls the model, executes any tool calls it asks for, appends the
  results and calls again, up to `maxIterations` (7).
- **`OllamaProvider`** posts to `/api/chat` with `stream: false`.
- **Tools:** `exec` (runs a shell command, returns `{stdout, stderr, exitCode}`
  as JSON, truncated at 8,000 characters) and `load_skill` (reads a Markdown
  procedure from `skills/`).
- **History** is a single JSON file, `data/conversations.json`, appended to
  after every run.

Nothing measured token usage, and nothing could be turned on or off.

### What was added

- An **observability layer** writing to SQLite: `sessions` → `runs` →
  `llm_calls` / `tool_calls`. LLM and tool calls share one `seq` counter per
  run, which is what the execution map is rebuilt from.
- A **dashboard** (plain `node:http` + vanilla JS, no framework) with an
  overview, per-tool token statistics, per-run execution maps, and working
  optimization switches.
- A **benchmark runner** that drives the same `Agent` directly, with fixed
  `exec` results, writing to its own database and history file.
- Five **optimizations**, each behind an independent feature flag.

The agent's own structure, the JSON history store and the Telegram entrypoint
were kept as they were.

### One correctness fix made before any measurement

`qwen3:1.7b` regularly ends a turn after its thinking block having emitted
**no text and no tool call**. The original loop treated that as the final
answer and replied with an empty message, so roughly half of all runs ended
immediately with nothing. Measuring that would have been meaningless, so the
loop now asks again instead of accepting an empty answer.

This changes the agent for **every** configuration, baseline included, and it
is not one of the optimizations. It is also why "turns" can exceed "tool
calls" by a wide margin throughout this report.

---

## 2. Benchmark methodology

- **20 scenarios**, four of each of five kinds: simple requests, multi-tool
  requests, large tool outputs, long histories, repeated data.
- **3 repetitions** per scenario per configuration.
- **The model is real.** Only the `exec` results are fixtures, so a run is
  reproducible without depending on the weather or the machine's process list.
  The fixtures are generated from a fixed seed; the same command always returns
  the same bytes.
- **Sampling is fixed and shared:** `temperature 0.6, top_p 0.95, top_k 20`,
  with the seed derived from the scenario id and repetition number, so every
  configuration meets the same scenario under the same generation conditions.
- **History is isolated per run**: each run gets its own session id, cleared and
  re-seeded from the scenario before it starts.
- **Success is checked deterministically**: the run must reach `completed`, must
  have called at least one tool, and its final answer must contain every
  expected fact (for example `E7731`, `benchbox-7`, `pgsvc`, `62%`). Producing a
  fluent final answer is not sufficient. Errors, timeouts, loop-limit and
  early-stop outcomes are counted separately.

### Cost model

Tokens are billed at **$0.15 per 1M input tokens** and **$0.25 per 1M output
tokens**. The rates live in configuration (`COST_INPUT_PER_MTOK`,
`COST_OUTPUT_PER_MTOK`), so pointing the agent at a different provider means
changing two numbers and nothing else.

Cost is computed from the token counts Ollama actually reports, so the figures
below are the price these runs carry at those rates. Cached and reasoning
tokens are reported separately and never charged twice: Ollama returns them as
subsets of the input and output counts.

### Which metrics are actual, estimated, or unavailable

| Metric | Source |
| --- | --- |
| input tokens | Ollama `prompt_eval_count` — **actual** |
| output tokens | Ollama `eval_count` — **actual** (includes thinking tokens) |
| cached input tokens | Ollama `prompt_eval_cached_count` — **actual**, a subset of input |
| latency and durations | Ollama `total`/`load`/`prompt_eval`/`eval_duration` — **actual** |
| reasoning tokens | Qwen3 tokenizer over the returned `thinking` text — **estimated**, a subset of output |
| tool output tokens | Qwen3 tokenizer — **estimated** |
| context composition, re-sent tokens | Qwen3 tokenizer per message — **estimated** |
| cost | derived from the actual token counts at the configured rates |
| per-token cost attribution inside a call | **unavailable** from the API |

Ollama reports no reasoning token count, only the thinking text, so reasoning
tokens are tokenized with `@lenml/tokenizer-qwen3` and flagged as estimates.
A metric that is unavailable is stored as `NULL`, never as `0` — the timed-out
calls in this report have `NULL` token counts rather than zeros, so they lower
measured cost rather than inflating it.

---

## 3. Baseline results

All optimizations off, 20 scenarios × 3 repetitions = **60 runs**, executed
sequentially.

| Metric | Value |
| --- | --- |
| Runs | 60 |
| Success rate | **61.7%** (37/60) |
| Outcomes | 46 completed, 12 hit the loop limit, 2 timed out, 0 errors |
| Input tokens | 223,289 |
| Output tokens | 89,972 |
| Cached input tokens (actual) | 124,120 — 55.6% of input |
| Reasoning tokens (estimated) | 78,687 — 87.5% of output |
| Cost | **$0.05599** total, **$0.000933 per run** |
| Turns per run | 4.02 |
| Tool calls per run | 1.58 |
| LLM calls | 241, average latency 6,210 ms |
| Average run duration | 25.0 s |
| Re-sent context tokens (estimated) | 51,457 — 31.3% of estimated context |
| Tool output tokens (estimated) | 89,652 |

Cost split: input $0.0335 (60%), output $0.0225 (40%).

### Per scenario type

| Type | Success | Turns | Tool calls | Input/run | Output/run | Cost/run |
| --- | --- | --- | --- | --- | --- | --- |
| 1 — simple | 6/12 | 5.08 | 1.25 | 2,743 | 1,860 | $0.000803 |
| 2 — multi-tool | 7/12 | 5.00 | 2.42 | 2,596 | 1,756 | $0.000828 |
| 3 — large output | 12/12 | 3.50 | 1.17 | 5,545 | 1,630 | $0.001239 |
| 4 — long history | 3/12 | 2.17 | 0.33 | 2,645 | 506 | $0.000480 |
| 5 — repeated data | 9/12 | 4.33 | 2.75 | 5,528 | 1,943 | $0.001315 |

---

## 4. Where the tokens actually go

This is the audit that decided which optimizations to build. None of it was
assumed in advance.

### 4.1 A handful of huge tool results dominate the input

| Tool result size | Calls | Tokens | Share of all tool output |
| --- | --- | --- | --- |
| ≥ 2,000 tokens | 21 | 86,133 | **96.1%** |
| < 500 tokens | 74 | 3,519 | 3.9% |

21 of 95 tool calls produce 96% of all tool output tokens. The worst single
result is 4,531 tokens; `exec` averages 989 tokens per call against
`load_skill`'s 126. Estimated tool output (89,652) is about **40% of all input
tokens**, and every result is re-sent on each later turn of the same run.

### 4.2 Stuck runs are pure waste

Grouping the 60 baseline runs by their longest streak of consecutive empty
replies:

| Longest streak | Runs | Passed |
| --- | --- | --- |
| 0 | 19 | 13 |
| 1 | 12 | 10 |
| 2 | 10 | 9 |
| 3 | 5 | 4 |
| 4 | 1 | 0 |
| 5 | 3 | 1 |
| 6 | 2 | 0 |
| 7 | 8 | 0 |

Runs that reach four or more empty replies in a row produced **1 success out of
14** while consuming $0.0156 — **28% of the entire baseline cost**. After a
streak of six, recovery never happened (0 of 10).

### 4.3 A third of the context is text already paid for

51,457 of 164,473 estimated context tokens — **31.3%** — are messages sent more
than once, 858 tokens per run on average.

An important detail the run-level view shows: for single-tool scenarios the
re-sent portion is dominated by the **system prompt**, not by tool output,
because the loop usually ends on the turn right after the tool result arrives.
Re-sending large tool results only becomes the dominant cost in the multi-tool
and repeated-data scenarios.

### 4.4 Tool schemas are re-sent on every call

Ollama reports 223,289 input tokens while the messages themselves estimate to
164,473. The 58,816-token difference — **26% of all input** — is the two tool
JSON schemas plus the chat template, re-sent on all 241 calls at roughly 244
tokens each.

### 4.5 Duplicate tool results

11 of the 42 tool-using runs fetched the same data twice. The worst run carried
8,098 duplicated tokens, another 3,954.

### 4.6 Turn count drives cost directly

| Turns | Runs | Passed | Cost/run |
| --- | --- | --- | --- |
| 2 | 7 | 7 | $0.000648 |
| 3 | 12 | 12 | $0.000951 |
| 4 | 9 | 9 | $0.001161 |
| 5 | 8 | 8 | $0.001294 |
| 7 | 6 | 1 | $0.001243 |

### 4.7 What actually makes runs fail is the model, not the machine

Of the 23 baseline failures, 21 are model behaviour and 2 are request timeouts:

| Outcome | Runs |
| --- | --- |
| passed | 37 |
| burned the 7-turn limit | 12 |
| answered without calling a tool | 8 |
| request timeout | 2 |
| called tools but the answer lacked the fact | 1 |

239 of the 241 LLM calls completed in 3,751 ms on average (max 12,286 ms); only
two hung until the 300-second timeout. The host is not the constraint — an
M2 Max with 64 GB, running a 1.7B model entirely in VRAM.

The dominant failure has a specific, reproducible cause. Probing Ollama directly
with an idle GPU, sequentially, eight times per variant:

| System prompt | Emitted a tool call |
| --- | --- |
| full (with the skills paragraph and list) | 4/8 |
| same, without the skills paragraph | **8/8** |
| full, with `think: false` | 0/8 |

The skills paragraph is what makes `qwen3:1.7b` end a turn having produced only
thinking. It is the single largest lever on success rate in this system — and
it is deliberately left alone, because removing it would disable the skills
feature. A larger tool-calling model would very likely not show this at all.

### 4.8 Thinking dominates the output side

87.5% of output tokens are thinking tokens. Disabling thinking was measured as
a candidate and rejected: with `think: false` the model stopped emitting tool
calls in 8 of 8 probes, so it cannot be used here.

---

## 5. The optimizations

Five, each behind an independent feature flag, all defaulting to off. The flags
work identically in the Telegram bot and in the benchmark runner, the dashboard
can toggle them at runtime, and every run stores the snapshot it ran with, so
changing a flag never rewrites history.

### A. `toolOutputLimiting`

*Targets finding 4.1: 21 calls producing 96% of tool output tokens.*

Caps a tool result at ~600 estimated tokens. It is not a blind truncation: the
budget is spent on **diagnostic lines first** (anything matching error, failure,
critical, warning, exception, timeout…), then the head, then the tail. Omitted
stretches are marked, and a closing note tells the model how to fetch a specific
range with `sed -n 'START,ENDp'` or `grep`. An `exec` result keeps its JSON
shape so the exit code stays visible. The untouched output is still recorded as
`raw_output_tokens`, which is what makes the saving visible in the dashboard.

A first version spent the budget on head and tail first and pushed the error
lines out. That is the opposite of useful for a log, and the unit tests now pin
the ordering.

### B. `contextCompaction`

*Targets finding 4.3: 31% of context re-sent, and the history growth of a long
conversation.*

This optimization went through three designs. The final one is described
first; the history is below it, because the measurements in sections 7 and 8
belong to the earlier ones.

**Final design — threshold compaction at the run boundary.** Modelled on how
long-running coding agents manage their context:

- History is left untouched while it grows. Only when it passes **20,000
  tokens** is its oldest part folded into a single summary — in one step, down
  to **10,000**. Both marks are configurable (`COMPACTION_HIGH_TOKENS`,
  `COMPACTION_LOW_TOKENS`).
- It happens **only at the start of a run**, never between the LLM calls of a
  run. Inside a run the context grows strictly by appending.
- The cut point is **stored** (`compaction-state.json`, keyed by session and
  guarded by a hash of the messages it covers, so `/new` invalidates it on its
  own). Between two compactions every run sends a byte-identical prefix.
- The summary keeps **user messages verbatim** (goals, constraints, decisions)
  unless they are longer than 2,000 characters — a pasted log or document —
  in which case their first 1,000 characters are kept (both configurable). It
  keeps the opening of each assistant reply (findings) and one line per tool
  call with its size, so the model knows the data existed. All of this is
  plain code, with no LLM call: the same history always produces the same
  summary, which is what keeps the prefix cacheable. The three most
  recent exchanges stay fully verbatim. Cuts only land right before a user
  message, so a tool call is never separated from its result.
- A second guard: after a compaction, the next one waits for at least 10,000
  new tokens, even if the history is still above the mark. A session of long
  pasted user messages may not compress below 20,000 at all, and without this
  it would re-compact — and lose the cache — on every run.

On a realistic fixture (short requests, bulky tool output) one compaction took
a 20-exchange history from **40,903 to 8,538 tokens (−79%)**.

**Why the design changed: prompt caching.** The earlier designs compacted on
every LLM call. Any rewrite in the middle of the context changes everything
after it, so a provider's prefix cache misses from that point on. Providers
bill cached input at a fraction of the normal rate, so on a real API a
compaction that breaks the cache every turn can cost more than it saves. The
measured cache hit rate did not drop much in this benchmark (55.7% against
56.6%) only because the part of the old design that rewrote the middle of the
context almost never fired here — not because the design was sound.

The run-boundary design is covered by 12 unit tests, including one that
asserts every LLM call inside a run starts with exactly what the previous call
sent, and one that asserts the next run of the session re-sends the same
compacted prefix.

**It was not benchmarked, and in this benchmark it could not do anything.** No
scenario comes near 20,000 tokens of history, so the flag is a no-op on all of
them by construction. Its value is in long real conversations — which, as
section 10 explains, the benchmark does not model.

**The earlier designs, for the record.** Both compacted on every LLM call.
The first dropped the whole middle of the carried-over history, including user
messages, and measurably broke the long-history scenarios: the fact the
question asked about had been stated by the user mid-conversation (3/12 → 1/12
on those scenarios). The second kept user messages and fixed that. The first
also collapsed retry nudges, which made the context after the third empty
reply identical to the context after the first; with a fixed seed the model
then repeated the same empty reply until the iteration limit.

### C. `batchIndependentTools`

*Targets finding 4.6: turn count drives cost, and the multi-fact scenarios spend
5.0 turns on 2.4 tool calls.*

Changes only the tool's **description**, telling the model it may ask for
several independent facts in one command separated by `;`, and never to chain a
command that needs another's output. `sh` already does this, so the input schema
is untouched.

A first version added a `commands: string[]` parameter to the JSON schema
instead. That extra optional parameter measurably stopped `qwen3:1.7b` emitting
tool calls at all — 1 success in 4 against 4 in 4 for the other optimizations
combined. The schema is now byte-identical with the flag on or off.

### D. `contextDeduplication`

*Targets finding 4.5: 11 of 42 tool-using runs fetched the same data twice.*

When a tool result of 200+ tokens is byte-identical to one already produced in
the same run, it is replaced by a one-line pointer naming the turn that holds
the original.

### E. `earlyStop`

*Targets finding 4.2: 14 runs, 1 success, 28% of cost.*

Ends a run after five empty replies in a row with status `stalled` and an
honest message, instead of burning the remaining iteration budget.

The threshold was first set to four from the count of *total* empty replies per
run, which is not the same statistic as *consecutive* ones. Recomputed against
consecutive streaks (the table in 4.2), a threshold of five keeps nearly all the
saving while giving up on one run in sixty that would still have recovered.

---

## 6. A control run, and what it revealed about the measurements

The baseline was measured sequentially. The optimized configurations were then
measured with two runs in flight at once, to save wall-clock time. That turned
out to be a mistake worth documenting, because it affects how every number in
this report should be read.

A second baseline, `baseline-c2` — **identical configuration, all flags off** —
was measured under exactly the conditions the optimized runs used:

| | `baseline` (sequential) | `baseline-c2` (2 at a time) |
| --- | --- | --- |
| Success rate | 61.7% (37/60) | 55.0% (33/60) |
| Cost | $0.05599 | $0.05152 |
| Timeouts | 2 | 5 |
| Wall clock | 25.0 min | 30.6 min |
| Seconds per run | 25.0 | 56.6 |

Three things follow.

**Running two at a time bought nothing.** 0.417 min per run sequentially against
0.510 min per run in parallel. One GPU serializes the work regardless; the
parallelism only added contention and timeouts.

**The measurement noise floor is large.** The same configuration measured twice
differs by **8.0% in cost and 6.7 percentage points in success rate**. Anything
smaller than that is indistinguishable from chance at this sample size.

**Timeouts move cost as well as success.** A timed-out call records `NULL`
tokens, so a run that dies early contributes almost no cost. More timeouts
therefore *lower* measured cost while also lowering success — the noise pushes
both metrics in the same direction, which is exactly the direction that
flatters an optimization.

All comparisons below are therefore made against **`baseline-c2`**, the control
measured under the same conditions as the optimized runs. The sequential
`baseline` is reported as the measurement of the original architecture.

---

## 7. Results: each optimization on its own

20 scenarios × 3 repetitions = 60 runs per configuration, compared against
`baseline-c2`. Savings are computed as
`(baseline cost − optimized cost) / baseline cost`.

| Configuration | Cost | Savings | Input tokens | Output tokens | Success | Δ pp |
| --- | --- | --- | --- | --- | --- | --- |
| `baseline-c2` (control) | $0.05152 | — | 205,255 | 82,928 | 55.0% (33/60) | — |
| `toolOutputLimiting` | $0.04149 | **19.5%** | 138,440 | 82,892 | 55.0% (33/60) | **0.0** |
| `earlyStop` | $0.04493 | **12.8%** | 183,052 | 69,905 | 53.3% (32/60) | −1.7 |
| `contextDeduplication` | $0.04871 | **5.5%** | 186,825 | 82,729 | 55.0% (33/60) | **0.0** |
| `contextCompaction` † | $0.05193 | −0.8% | 199,949 | 87,733 | 51.7% (31/60) | −3.3 |
| `batchIndependentTools` | $0.05771 | **−12.0%** | 223,301 | 96,873 | 55.0% (33/60) | 0.0 |
| `all` † | $0.03479 | 32.5% | 107,964 | 74,395 | 45.0% (27/60) | −10.0 |
| **`all-v2`** (both defects fixed) | $0.03912 | **24.1%** | 125,542 | 81,140 | **55.0% (33/60)** | **0.0** |

† measured before the two defects described in section 5 were fixed. For
`contextCompaction` this is the first, per-call design, which has since been
replaced entirely (section 5B); none of the compaction figures in this report
describe the design that ships.

### Loop behaviour

| Configuration | Turns/run | Tool calls/run | Tool output tokens | Re-sent context | completed / loop-limit / stalled / timeout |
| --- | --- | --- | --- | --- | --- |
| `baseline-c2` | 3.90 | 1.52 | 77,166 | 49,339 | 43 / 12 / 0 / 5 |
| `toolOutputLimiting` | 3.87 | 1.52 | **11,303** | 48,909 | 43 / 12 / 0 / 5 |
| `earlyStop` | **3.23** | 1.20 | 76,404 | **37,876** | 41 / 0 / 14 / 5 |
| `contextDeduplication` | 3.87 | 1.52 | 59,674 | 48,909 | 43 / 12 / 0 / 5 |
| `contextCompaction` † | 4.00 | 1.60 | 77,323 | 46,608 | 44 / 12 / 0 / 4 |
| `batchIndependentTools` | 4.35 | **1.02** | 63,413 | 69,002 | 44 / 14 / 0 / 2 |
| `all` † | **3.10** | 0.85 | **8,211** | **30,253** | 39 / 0 / 19 / 2 |

### What each one actually did

**`toolOutputLimiting` — the one that works.** Tool output tokens fell from
77,166 to 11,303, **85.4% removed**, which pulled total input tokens down 33%.
Success rate was unchanged — not one run out of sixty was lost. It is the
largest single lever and the safest.

**`earlyStop` — cheap, small cost to quality.** All 12 loop-limit runs became
`stalled` runs plus two more, ending 14 runs early instead of letting them burn
the iteration budget. Turns per run fell from 3.90 to 3.23 and output tokens by
16%. One run out of sixty was lost — within noise, and consistent with the
in-sample prediction of section 4.2.

**`contextDeduplication` — works, but the opportunity is small.** Tool output
tokens fell 23%, worth 5.5% of cost, with no success lost. Only a minority of
runs fetch the same data twice, which caps what it can do.

**`batchIndependentTools` — a negative result.** It did what it was designed to
do at the tool level: tool calls per run fell from 1.52 to 1.02. But turns per
run *rose* from 3.90 to 4.35 and cost rose 12%. Asking a 1.7B model to reason
about which commands are independent makes it think longer, and in the many
scenarios that need only one command the instruction is pure overhead. It is
kept, implemented and flag-gated, but it should stay off.

**`contextCompaction` — not measured in its final form.** The figure above is
from the first, per-call design, which dropped user messages and cost it the
type-4 scenarios. That design was replaced by the run-boundary one in section
5B, which is unit-tested but not benchmarked — and which, at a 20,000-token
threshold, would not trigger on any scenario in this benchmark.

### Cost per run and successes, by scenario type

| Scenario type | `baseline-c2` | `toolOutputLimiting` | `earlyStop` | `contextDeduplication` | `all` † |
| --- | --- | --- | --- | --- | --- |
| 1 simple | $0.000684 (6/12) | $0.000674 (6/12) | $0.000605 (6/12) | $0.000667 (6/12) | $0.000524 (6/12) |
| 2 multi-tool | $0.000808 (6/12) | $0.000809 (6/12) | $0.000558 (5/12) | $0.000809 (6/12) | $0.000572 (7/12) |
| 3 large output | $0.001021 (10/12) | **$0.000593 (10/12)** | $0.001021 (10/12) | $0.001021 (10/12) | $0.000579 (7/12) |
| 4 long history | $0.000480 (3/12) | $0.000480 (3/12) | $0.000458 (3/12) | $0.000480 (3/12) | $0.000451 (0/12) † |
| 5 repeated data | $0.001301 (8/12) | **$0.000902 (8/12)** | $0.001103 (8/12) | $0.001082 (8/12) | $0.000774 (7/12) |

This is the clearest evidence in the report. `toolOutputLimiting` **halves the
cost of the large-output scenarios (−42%) and cuts the repeated-data scenarios
by 31%, with exactly the same number of successes in both**, and leaves the
three scenario types it does not target completely untouched. That is what a
correctly targeted optimization looks like.

The `all` column shows the mirror image: its type-4 successes collapse from 3
to 0, which is the compaction defect, not a property of combining flags.

---

## 8. Results: all optimizations together

Two complete measurements exist for the combination. `all` was measured before
the two defects of section 5 were fixed; `all-v2` after. Both contain one of the
earlier, per-call compaction designs (`all-v2` the second one, which keeps user
messages), not the final run-boundary design. Since the final design is a no-op
on every scenario here, `all-v2` is the closest available measurement of the
shipped combination, but it is not an exact one. Both are shown, because
the difference between them is the most instructive result in this report.

| | `baseline-c2` | `all` † | `all-v2` |
| --- | --- | --- | --- |
| Cost | $0.05152 | $0.03479 | $0.03912 |
| **Savings** | — | **32.5%** | **24.1%** |
| **Success rate** | 55.0% (33/60) | **45.0% (27/60)** | **55.0% (33/60)** |
| **Δ success** | — | **−10.0 pp** | **0.0 pp** |
| Input tokens | 205,255 | 107,964 | 125,542 |
| Output tokens | 82,928 | 74,395 | 81,140 |
| Cached input (actual) | 116,215 | 92,286 | 108,744 |
| Reasoning tokens (est.) | 71,836 | 65,990 | 71,929 |
| Tool output tokens (est.) | 77,166 | 8,211 | 8,771 |
| Re-sent context (est.) | 49,339 | 30,253 | 39,320 |
| Turns per run | 3.90 | 3.10 | 3.43 |
| Tool calls per run | 1.52 | 0.85 | 1.02 |
| Outcomes (done/loop/stalled/timeout) | 43/12/0/5 | 39/0/19/2 | 44/0/14/2 |

**Fixing the two defects recovered the entire quality loss and gave back a third
of the saving.** Success went from 45.0% back to 55.0% — exactly the control's
rate, not a single run lost — while savings fell from 32.5% to 24.1%.

That is not a regression. It is the measurement of what the defects were
actually doing: the first build was "saving" money by abandoning runs early
(19 stalled instead of 14) and by dropping context the task needed. Once it
stopped breaking the task, it stopped being that cheap. The 32.5% figure was
never a real 32.5%.

### Cost per run and successes, by scenario type

| Scenario type | `baseline-c2` | `all` † | `all-v2` |
| --- | --- | --- | --- |
| 1 simple | $0.000684 (6/12) | $0.000524 (6/12) | $0.000629 (**8**/12) |
| 2 multi-tool | $0.000808 (6/12) | $0.000572 (7/12) | $0.000646 (7/12) |
| 3 large output | $0.001021 (10/12) | $0.000579 (7/12) | $0.000629 (7/12) |
| 4 long history | $0.000480 (3/12) | $0.000451 (**0**/12) | $0.000446 (2/12) |
| 5 repeated data | $0.001301 (8/12) | $0.000774 (7/12) | $0.000910 (**9**/12) |

The type-4 collapse that the compaction defect caused (3 → 0) is largely
recovered (→ 2). Type 3 stays at 7/12 against the control's 10/12, which is the
one place where the combination still looks worse than its parts —
`toolOutputLimiting` alone held 10/12 there.

---

## 9. Against the targets

| Target | Result |
| --- | --- |
| Cost reduction ≥ 30% | **Not met — 24.1%** with quality preserved |
| Success rate drop ≤ 2 pp | **Met — 0.0 pp** (33/60 against 33/60) |

The two targets were met by two different builds, and never by the same one.
`all` reached 32.5% but lost 10 percentage points of success; `all-v2` holds
success exactly level but reaches 24.1%. **The 30% target was not achieved
without degrading quality.**

Individually, three optimizations cost nothing measurable in quality:

| Configuration | Savings | Success Δ |
| --- | --- | --- |
| `toolOutputLimiting` | 19.5% | 0.0 pp (33/60 both) |
| `earlyStop` | 12.8% | −1.7 pp (32 vs 33) |
| `contextDeduplication` | 5.5% | 0.0 pp (33/60 both) |

None reaches 30% alone, and combining all five reaches only 24.1% — partly
because `batchIndependentTools`, measured on its own at **−12.0%**, is included
in the bundle and drags it down. A bundle excluding that flag has not been
measured; on the individual figures it would be expected to land nearer 30%,
but that is an extrapolation, not a measurement, and it is not claimed here as
a result.

**A caveat that applies to every "0.0 pp" in this report.** Two percentage
points is 1.2 runs out of 60, and the control run showed that repeating an
identical configuration moves the result by 6.7 pp. A 2 pp difference cannot be
distinguished from chance at this sample size. The honest statement is that no
reduction in success rate was observed for those configurations — not that none
exists.

---

## 10. Limitations and conclusions

### Limitations

**Sample size.** 60 runs per configuration cannot resolve a 2 pp difference in
success rate. The control measurement puts run-to-run variation at 6.7 pp and
8.0% of cost. Resolving 2 pp reliably would need several hundred runs per
configuration.

**Concurrency.** The optimized configurations were measured with two runs in
flight, the original baseline sequentially. A matched control (`baseline-c2`)
was measured to make the comparison valid, and all comparisons in sections 7-9
use it. Wall-clock latency and per-run duration are **not** comparable between
the sequential baseline and any of the parallel measurements. Token counts,
costs, turns and success rates are.

**No multi-turn sessions.** Every scenario is a single run. The long-history
scenarios seed a pre-written history and ask one question on top of it, and
that history contains only user and assistant messages. In the bot's real
conversation file, tool results make up **89%** of the stored history (9,304 of
10,401 characters), because the agent appends everything a run produces. The
benchmark therefore never exercises the accumulation of tool output across
requests — which is precisely the load that `contextCompaction` exists for, and
which also makes the re-sent-context share (31% within a run) an underestimate
of what a long conversation pays. Measuring it needs scenarios that send
several requests in sequence to the same session.

**The shipped compaction is not benchmarked.** See section 5B: it is covered by
unit tests, and by construction it would not trigger on any existing scenario.

**The compaction summary grows with the conversation.** Short user messages are
kept verbatim, so a session of many long instructions cannot be compressed below
the threshold. The minimum-growth rule stops this turning into a compaction on
every run, but such a session's context will keep growing until a `/new`.

**Long pasted text is truncated, not summarized.** Anything past the first 1,000
characters of a long user message is lost from the summary, including a
constraint that happened to be buried in it. The planned improvement, marked
as a TODO in the code, is to have a cheaper model write the summary once model
routing exists; its text would then have to be stored, since unlike the
truncation it cannot be reproduced from the history.

**Fixture realism.** `exec` results are fixtures, so a `grep` for one line
returns the whole file. This inflates the large-output scenarios relative to a
real shell. It is identical for every configuration, so comparisons hold, but
the absolute saving from `toolOutputLimiting` would be smaller against a real
shell where the model can narrow the output itself.

**Timeouts.** 29 calls across all runs hit the 300-second request timeout,
costing roughly 2.4 hours of wall clock. Lowering the timeout was considered and
rejected: three calls that eventually succeeded took between 120 and 300
seconds, so a shorter timeout would have turned successes into failures and
changed the comparison.

**One model.** Everything here is `qwen3:1.7b`. The dominant failure mode is
specific to a model this small.

### Conclusions

**The audit found the cost where it actually was.** 21 of 95 tool calls produced
96% of all tool output tokens. Capping those results removed 85% of tool output
tokens and a third of all input tokens, and cost nothing measurable in quality.
That single optimization is worth more than the other four combined.

**The 30% target was not met without degrading quality — 24.1%, not 30%.** The
32.5% that the first build showed was partly an artifact of that build
abandoning runs early and discarding context the task needed. Fixing it restored
success to the control's exact rate and cost a third of the saving. Reporting
32.5% as the achievement would have meant reporting a bug as a feature.

**A measurement is worth more than a plausible story.** Three of this report's
substantive findings — the schema change that killed tool calling, the
compaction that deleted the answer, the nudge collapse that froze the retry loop
— were invisible in code review and in unit tests, and only appeared when
something was actually run and counted.

**Not every plausible optimization helps.** `batchIndependentTools` reduced tool
calls by a third and made the agent 12% *more* expensive, because it made the
model reason longer about a decision it was not good at. It is implemented and
flag-gated, and it should stay off. It is reported here rather than dropped,
because a negative result measured is worth more than a plausible idea assumed.

**The biggest lever in this system is not a token optimization at all.** 21 of
the 23 baseline failures are the model ending a turn with only thinking, and
that behaviour traces to the skills paragraph in the system prompt (4/8 tool
calls with it, 8/8 without, on an idle GPU). Fixing that would raise success
rate far more than any of the work in this report — and it would also cut cost,
since those runs burn the full iteration budget. It was deliberately left alone
because removing it would disable the skills feature. A larger tool-calling
model would very likely not show the problem at all.

**Where the remaining cost is.** After `toolOutputLimiting`, 87% of output
tokens are thinking tokens, and 26% of input tokens are the tool schemas and
chat template re-sent on every call. Neither is addressable from inside the
agent loop: `think: false` stops the model calling tools altogether (0/8), and
the schemas are required by the API on every request.
