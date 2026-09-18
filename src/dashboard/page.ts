/** The whole dashboard: one HTML document with vanilla JS, no build step. */
export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>teleagent observability</title>
<style>
  :root {
    --bg: #11131a; --panel: #181b24; --panel-2: #1f2330; --line: #2c3142;
    --text: #e6e9f2; --muted: #98a0b8; --accent: #7aa2f7; --ok: #7bd88f;
    --warn: #e0af68; --err: #f7768e; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
         font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  a { color: var(--accent); text-decoration: none; cursor: pointer; }
  a:hover { text-decoration: underline; }
  header { border-bottom: 1px solid var(--line); }
  header .inner { max-width: 1180px; margin: 0 auto; padding: 18px 24px;
                  display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; }
  h1 { font-size: 17px; margin: 0; font-weight: 600; letter-spacing: .01em; }
  main { max-width: 1180px; margin: 0 auto; padding: 20px 24px 60px; }
  section { margin-bottom: 28px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 0 0 12px; font-weight: 600; }
  .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
  .stat .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  .stat .v { font-size: 20px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .stat .s { color: var(--muted); font-size: 11px; margin-top: 2px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel);
          border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
  tr:last-child td { border-bottom: none; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .flags { display: grid; gap: 8px; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); }
  .flag { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
          padding: 10px 12px; display: flex; gap: 10px; align-items: flex-start; }
  .flag input { margin-top: 3px; }
  .flag .name { font-family: var(--mono); font-size: 12px; }
  .flag .desc { color: var(--muted); font-size: 12px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 11px;
          border: 1px solid var(--line); background: var(--panel-2); }
  .pill.ok { color: var(--ok); border-color: #2c4a35; }
  .pill.err { color: var(--err); border-color: #4a2c33; }
  .pill.warn { color: var(--warn); border-color: #4a3f2c; }
  .node { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin-bottom: 6px; }
  .node > summary { padding: 10px 12px; cursor: pointer; display: flex; gap: 10px;
                    align-items: center; flex-wrap: wrap; list-style: none; }
  .node > summary::-webkit-details-marker { display: none; }
  .node .body { padding: 0 12px 12px; border-top: 1px solid var(--line); margin-top: 2px; }
  .node .tag { font-family: var(--mono); font-size: 11px; padding: 1px 6px; border-radius: 4px; }
  .tag.llm { background: #22304d; color: #a9c2ff; }
  .tag.tool { background: #2d2a40; color: #cbb6ff; }
  .arrow { color: var(--muted); text-align: center; font-size: 12px; margin: -2px 0 4px 14px; }
  .kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 14px; margin: 10px 0; }
  .kv div { font-size: 12px; }
  .kv .k { color: var(--muted); }
  pre { font-family: var(--mono); font-size: 12px; background: var(--panel-2); color: var(--text);
        border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow: auto;
        max-height: 320px; white-space: pre-wrap; word-break: break-word; margin: 6px 0; }
  .muted { color: var(--muted); }
  .empty { color: var(--muted); padding: 14px; background: var(--panel);
           border: 1px solid var(--line); border-radius: 8px; }
  select, button { background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
                   border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 13px; }
  button { cursor: pointer; }
  .bar { height: 6px; background: var(--panel-2); border-radius: 3px; overflow: hidden; margin-top: 4px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  .crumbs { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
</style>
</head>
<body>
<header>
  <div class="inner">
    <h1>teleagent observability</h1>
    <label class="muted">dataset
      <select id="dataset"></select>
    </label>
    <span class="muted" id="status"></span>
  </div>
</header>
<main id="app"></main>
<script>
const app = document.getElementById("app");
const datasetSelect = document.getElementById("dataset");
const statusEl = document.getElementById("status");

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NA = '<span class="muted">n/a</span>';
const num = (v, digits = 0) => v === null || v === undefined
  ? NA : Number(v).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const money = (v) => v === null || v === undefined ? NA : "$" + Number(v).toFixed(4);
const pct = (v, digits = 1) => v === null || v === undefined ? NA : (v * 100).toFixed(digits) + "%";
const ms = (v) => v === null || v === undefined ? NA
  : v < 1000 ? Math.round(v) + " ms" : (v / 1000).toFixed(1) + " s";
const bytes = (v) => v === null || v === undefined ? NA
  : v < 1024 ? v + " B" : (v / 1024).toFixed(1) + " KB";
const when = (v) => v ? new Date(v).toLocaleString() : NA;
const short = (s, n = 90) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n) + "…" : s; };

let dataset = new URLSearchParams(location.search).get("dataset") || "";

async function api(path) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch("/api" + path + (dataset ? sep + "dataset=" + encodeURIComponent(dataset) : ""));
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function stat(k, v, s) {
  return '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + v +
    '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>';
}

function statusPill(status, success) {
  const cls = status === "completed" ? "ok" : status === "error" || status === "timeout" ? "err" : "warn";
  let html = '<span class="pill ' + cls + '">' + esc(status) + '</span>';
  if (success === 1) html += ' <span class="pill ok">pass</span>';
  if (success === 0) html += ' <span class="pill err">fail</span>';
  return html;
}

async function renderOverview() {
  const [o, tools, flags, sessions] = await Promise.all([
    api("/overview"), api("/tools"), api("/flags"), api("/sessions"),
  ]);

  const stats = [
    stat("Total sessions", num(o.totalSessions)),
    stat("Total runs", num(o.totalRuns),
      num(o.completedRuns) + " completed &middot; " + num(o.failedRuns) + " errored &middot; " +
      num(o.maxIterationRuns) + " hit loop limit &middot; " + num(o.stalledRuns) + " stalled &middot; " +
      num(o.timeoutRuns) + " timed out"),
    stat("Success rate", pct(o.successRate),
      o.verifiedRuns ? "over " + num(o.verifiedRuns) + " verified runs" : "no verified runs"),
    stat("Input tokens", num(o.totalInputTokens)),
    stat("Output tokens", num(o.totalOutputTokens)),
    stat("Cached input tokens", num(o.totalCachedTokens), "reported by Ollama, subset of input"),
    stat("Reasoning tokens", num(o.totalReasoningTokens), "estimated, subset of output"),
    stat("Total cost", money(o.totalCost)),
    stat("Avg tokens / run", num(o.avgTokensPerRun)),
    stat("Avg cost / run", money(o.avgCostPerRun)),
    stat("Avg turns / run", num(o.avgTurnsPerRun, 2)),
    stat("Avg tool calls / run", num(o.avgToolCallsPerRun, 2)),
    stat("Avg LLM latency", ms(o.avgLlmLatencyMs)),
    stat("Avg run duration", ms(o.avgRunDurationMs)),
  ].join("");

  const share = o.repeatedContextShare;
  const reuse = '<div class="grid">' + [
    stat("Context tokens sent", num(o.contextTokensSent), "estimated, summed over all LLM calls"),
    stat("Re-sent context tokens", num(o.repeatedContextTokens), "messages sent more than once"),
    stat("Repeated share", pct(share),
      '<div class="bar"><i style="width:' + (share ? Math.min(100, share * 100) : 0) + '%"></i></div>'),
    stat("Tool output tokens", num(o.toolOutputTokens), "estimated, entering the context once each"),
  ].join("") + "</div>";

  const toolRows = tools.length ? tools.map((t) =>
    "<tr><td>" + esc(t.toolName) + "</td><td class=num>" + num(t.calls) +
    "</td><td class=num>" + num(t.outputTokens) + "</td><td class=num>" + num(t.avgOutputTokens) +
    "</td><td class=num>" + num(t.maxOutputTokens) + "</td><td class=num>" + bytes(t.outputBytes) +
    "</td><td class=num>" + ms(t.avgDurationMs) + "</td><td class=num>" + num(t.errors) + "</td></tr>"
  ).join("") : '<tr><td colspan="8" class="muted">No tool calls recorded yet.</td></tr>';

  const flagRows = flags.flags.map((f) =>
    '<label class="flag"><input type="checkbox" data-flag="' + esc(f.name) + '"' +
    (f.enabled ? " checked" : "") + (flags.readOnly ? " disabled" : "") + '>' +
    '<span><span class="name">' + esc(f.name) + "</span><br><span class=desc>" +
    esc(f.description) + "</span></span></label>").join("");

  const sessionRows = sessions.length ? sessions.map((s) =>
    '<tr><td><a href="#/session/' + encodeURIComponent(s.sessionId) + '">' + esc(s.sessionId) +
    '</a> <span class="muted">' + esc(s.agentId) + "</span></td><td>" + when(s.lastActivityAt) +
    "</td><td class=num>" + num(s.runs) + "</td><td class=num>" + num(s.inputTokens) +
    "</td><td class=num>" + num(s.outputTokens) + "</td><td class=num>" + money(s.cost) + "</td></tr>"
  ).join("") : '<tr><td colspan="6" class="muted">No sessions yet.</td></tr>';

  app.innerHTML =
    '<section><h2>Overview</h2><div class="grid">' + stats + "</div></section>" +
    "<section><h2>Context reuse</h2>" + reuse + "</section>" +
    "<section><h2>Token consumption by tool</h2><table><thead><tr><th>Tool</th>" +
    '<th class=num>Calls</th><th class=num>Output tokens</th><th class=num>Avg</th>' +
    '<th class=num>Max</th><th class=num>Output bytes</th><th class=num>Avg duration</th>' +
    '<th class=num>Errors</th></tr></thead><tbody>' + toolRows + "</tbody></table></section>" +
    "<section><h2>Optimizations</h2>" +
    (flags.readOnly
      ? '<p class="muted">Read-only: this dataset does not own the flag file.</p>'
      : '<p class="muted">Applies to new runs. Each run stores the snapshot it ran with.</p>') +
    '<div class="flags">' + flagRows + "</div></section>" +
    "<section><h2>Sessions</h2><table><thead><tr><th>Session</th><th>Last activity</th>" +
    '<th class=num>Runs</th><th class=num>Input tokens</th><th class=num>Output tokens</th>' +
    '<th class=num>Cost</th></tr></thead><tbody>' + sessionRows + "</tbody></table></section>";

  for (const input of app.querySelectorAll("input[data-flag]")) {
    input.addEventListener("change", async () => {
      statusEl.textContent = "saving…";
      try {
        await fetch("/api/flags" + (dataset ? "?dataset=" + encodeURIComponent(dataset) : ""), {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [input.dataset.flag]: input.checked }),
        }).then((r) => { if (!r.ok) throw new Error("save failed"); });
        statusEl.textContent = "flags saved";
      } catch (e) {
        input.checked = !input.checked;
        statusEl.textContent = "could not save flags";
      }
      setTimeout(() => { statusEl.textContent = ""; }, 2500);
    });
  }
}

async function renderSession(sessionId) {
  const runs = await api("/sessions/" + encodeURIComponent(sessionId) + "/runs");
  const rows = runs.length ? runs.map((r) =>
    '<tr><td>' + when(r.startedAt) + '</td><td><a href="#/run/' + encodeURIComponent(r.runId) + '">' +
    esc(short(r.userMessage)) + "</a>" +
    (r.benchmarkScenario ? ' <span class="pill">' + esc(r.benchmarkScenario) + "</span>" : "") +
    (r.benchmarkConfig ? ' <span class="pill">' + esc(r.benchmarkConfig) + "</span>" : "") +
    "</td><td>" + statusPill(r.status, r.success) + "</td><td class=num>" + num(r.totalInputTokens) +
    "</td><td class=num>" + num(r.totalOutputTokens) + "</td><td class=num>" + money(r.totalCost) +
    "</td><td class=num>" + ms(r.totalDurationMs) + "</td><td class=num>" + num(r.turns) +
    "</td><td class=num>" + num(r.toolCallCount) + "</td></tr>"
  ).join("") : '<tr><td colspan="9" class="muted">No runs.</td></tr>';

  app.innerHTML = '<div class="crumbs"><a href="#/">Overview</a> / session ' + esc(sessionId) + "</div>" +
    "<section><h2>Runs</h2><table><thead><tr><th>Time</th><th>Request</th><th>Status</th>" +
    '<th class=num>Input</th><th class=num>Output</th><th class=num>Cost</th>' +
    '<th class=num>Duration</th><th class=num>Turns</th><th class=num>Tool calls</th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table></section>";
}

function llmNode(d) {
  const kv = [
    ["Model", esc(d.model)], ["Turn", num(d.turnNumber)],
    ["Input tokens", num(d.inputTokens)], ["Output tokens", num(d.outputTokens)],
    ["Cached input", num(d.cachedTokens)],
    ["Reasoning tokens", num(d.reasoningTokens) + (d.reasoningTokensEstimated ? ' <span class="muted">(est.)</span>' : "")],
    ["Latency", ms(d.latencyMs)], ["Cost", money(d.estimatedCost)],
    ["Model load", ms(d.loadDurationMs)], ["Prompt eval", ms(d.promptEvalDurationMs)],
    ["Generation", ms(d.evalDurationMs)], ["Context messages", num(d.contextMessageCount)],
    ["Context tokens (est.)", num(d.contextTokensEstimated)],
    ["… of which re-sent", num(d.repeatedContextTokensEstimated)],
    ["… new this call", num(d.freshContextTokensEstimated)],
    ["Tool calls requested", num(d.toolCallsRequested)],
  ].map(([k, v]) => "<div><span class=k>" + k + ":</span> " + v + "</div>").join("");

  const refs = (d.contextRefs || []).map((r) =>
    "<tr><td>" + esc(r.ref) + "</td><td class=num>" + num(r.tokens) + "</td><td>" +
    (r.repeated ? '<span class="pill warn">re-sent (first at #' + r.firstSeenAtSeq + ")</span>"
                : '<span class="pill ok">new</span>') + "</td></tr>").join("");

  return '<div class="kv">' + kv + "</div>" +
    (d.errorMessage ? "<pre>" + esc(d.errorMessage) + "</pre>" : "") +
    (d.thinkingPreview ? "<details><summary class=muted>Thinking</summary><pre>" +
      esc(d.thinkingPreview) + "</pre></details>" : "") +
    (d.responsePreview ? "<details><summary class=muted>Response</summary><pre>" +
      esc(d.responsePreview) + "</pre></details>" : "") +
    "<details><summary class=muted>Context composition (" + (d.contextRefs || []).length +
    " messages)</summary><table><thead><tr><th>Message</th><th class=num>Tokens (est.)</th>" +
    "<th>State</th></tr></thead><tbody>" + refs + "</tbody></table></details>";
}

function toolNode(d) {
  const trimmed = d.rawOutputTokens !== null && d.rawOutputTokens !== d.outputTokens;
  const kv = [
    ["Tool", esc(d.toolName)], ["Turn", num(d.turnNumber)],
    ["Duration", ms(d.durationMs)], ["Input size", bytes(d.inputSizeBytes)],
    ["Output size", bytes(d.outputSizeBytes)],
    ["Output tokens (est.)", num(d.outputTokens)],
    ["Raw output size", bytes(d.rawOutputSizeBytes)],
    ["Raw output tokens (est.)", num(d.rawOutputTokens) + (trimmed ? ' <span class="pill warn">trimmed</span>' : "")],
  ].map(([k, v]) => "<div><span class=k>" + k + ":</span> " + v + "</div>").join("");

  return '<div class="kv">' + kv + "</div>" +
    "<details open><summary class=muted>Arguments</summary><pre>" + esc(d.arguments) + "</pre></details>" +
    "<details><summary class=muted>Result (preview)</summary><pre>" + esc(d.outputPreview) + "</pre></details>";
}

async function renderRun(runId) {
  const { run, timeline, contextReuse } = await api("/runs/" + encodeURIComponent(runId));
  const flags = JSON.parse(run.enabledOptimizations || "{}");
  const enabled = Object.keys(flags).filter((k) => flags[k]);

  const head = '<div class="grid">' + [
    stat("Status", statusPill(run.status, run.success), esc(run.successDetail || "")),
    stat("Input tokens", num(run.totalInputTokens)),
    stat("Output tokens", num(run.totalOutputTokens)),
    stat("Cached input", num(run.totalCachedTokens)),
    stat("Reasoning tokens", num(run.totalReasoningTokens), "estimated"),
    stat("Cost", money(run.totalCost)),
    stat("Duration", ms(run.totalDurationMs)),
    stat("Turns", num(run.turns)),
    stat("Tool calls", num(run.toolCallCount)),
    stat("Re-sent context tokens", num(run.repeatedContextTokens), "estimated"),
    stat("Tool output tokens", num(run.toolOutputTokens), "estimated"),
  ].join("") + "</div>";

  const nodes = timeline.map((n) => {
    const d = n.data;
    const title = n.kind === "llm"
      ? '<span class="tag llm">LLM call #' + (n.seq + 1) + "</span> " +
        num(d.inputTokens) + " in / " + num(d.outputTokens) + " out &middot; " +
        ms(d.latencyMs) + " &middot; " + money(d.estimatedCost) +
        (d.toolCallsRequested ? ' <span class="pill">' + d.toolCallsRequested + " tool call(s)</span>" : ' <span class="pill ok">final</span>')
      : '<span class="tag tool">Tool: ' + esc(d.toolName) + "</span> " +
        num(d.outputTokens) + " tokens &middot; " + bytes(d.outputSizeBytes) + " &middot; " + ms(d.durationMs) +
        (d.status === "error" ? ' <span class="pill err">error</span>' : "");
    return '<div class="arrow">&darr;</div><details class="node"><summary>' + title + "</summary>" +
      '<div class="body">' + (n.kind === "llm" ? llmNode(d) : toolNode(d)) + "</div></details>";
  }).join("");

  const reuseRows = contextReuse.filter((r) => r.occurrences > 1).map((r) =>
    "<tr><td>" + esc(r.label) + ' <span class="muted">' + esc(r.ref) + "</span></td><td class=num>" +
    num(r.tokens) + "</td><td class=num>" + num(r.occurrences) + "</td><td class=num>" +
    num(r.repeatedTokens) + "</td></tr>").join("");

  app.innerHTML =
    '<div class="crumbs"><a href="#/">Overview</a> / <a href="#/session/' +
    encodeURIComponent(run.sessionId) + '">session ' + esc(run.sessionId) + "</a> / run</div>" +
    "<section><h2>User message</h2><pre>" + esc(run.userMessage) + "</pre></section>" +
    "<section><h2>Final response</h2><pre>" + esc(run.finalResponse || "(none)") + "</pre>" +
    (run.errorMessage ? "<pre>" + esc(run.errorMessage) + "</pre>" : "") + "</section>" +
    "<section><h2>Summary</h2>" + head +
    '<p class="muted" style="margin-top:10px">Optimizations enabled for this run: ' +
    (enabled.length ? enabled.map((f) => '<span class="pill ok">' + esc(f) + "</span>").join(" ") :
      '<span class="pill">none</span>') + "</p></section>" +
    '<section><h2>Execution map</h2><div class="node" style="padding:10px 12px">' +
    '<span class="tag">User message</span> ' + esc(short(run.userMessage, 120)) + "</div>" +
    nodes + '<div class="arrow">&darr;</div><div class="node" style="padding:10px 12px">' +
    '<span class="tag">Final response</span> ' + esc(short(run.finalResponse || "(none)", 120)) +
    "</div></section>" +
    (reuseRows ? "<section><h2>Re-sent context</h2><table><thead><tr><th>Message</th>" +
      '<th class=num>Tokens (est.)</th><th class=num>Sent in N calls</th>' +
      '<th class=num>Repeat cost (tokens)</th></tr></thead><tbody>' + reuseRows +
      "</tbody></table></section>" : "");
}

async function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  app.innerHTML = '<p class="muted">Loading…</p>';
  try {
    if (hash.startsWith("/session/")) await renderSession(decodeURIComponent(hash.slice(9)));
    else if (hash.startsWith("/run/")) await renderRun(decodeURIComponent(hash.slice(5)));
    else await renderOverview();
  } catch (error) {
    app.innerHTML = '<div class="empty">Failed to load: ' + esc(error.message) + "</div>";
  }
}

async function init() {
  const { datasets } = await (await fetch("/api/datasets")).json();
  datasetSelect.innerHTML = datasets.map((d) =>
    '<option value="' + esc(d.id) + '"' + (d.id === dataset ? " selected" : "") + ">" +
    esc(d.label) + "</option>").join("");
  if (!dataset && datasets.length) dataset = datasets[0].id;
  datasetSelect.value = dataset;
  datasetSelect.addEventListener("change", () => {
    dataset = datasetSelect.value;
    history.replaceState(null, "", "?dataset=" + encodeURIComponent(dataset) + location.hash);
    route();
  });
  window.addEventListener("hashchange", route);
  await route();
}

init();
</script>
</body>
</html>`;
