// Web search for the agent's `exec` tool, so a small model only has to fill in
// a query instead of writing curl flags and HTML parsing itself.
//
//   node skills/web-search.mjs "cyprus news today"   -> top results as text
//   node skills/web-search.mjs --read https://...    -> a page as plain text

const TIMEOUT_MS = 15_000;
const MAX_RESULTS = 5;
const MAX_PAGE_CHARS = 4_000;
const HEADERS = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) teleagent" };

const ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'", "&nbsp;": " " };

function decode(text) {
  return text.replace(/&(amp|lt|gt|quot|nbsp|#x27|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function stripTags(html) {
  return decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

async function get(url) {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}`);
  }

  return response.text();
}

async function search(query) {
  const html = await get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
  const pattern =
    /class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const results = [...html.matchAll(pattern)].slice(0, MAX_RESULTS);

  if (results.length === 0) {
    console.log(`No results for "${query}". The search engine may be rate-limiting; try again later or rephrase.`);
    return;
  }

  console.log(`Search results for "${query}":`);

  for (const [, href, title, snippet] of results) {
    // Result links are DuckDuckGo redirects; the real address is in `uddg`.
    const target = href.match(/uddg=([^&]+)/);
    const url = target ? decodeURIComponent(target[1]) : href;
    console.log(`\n- ${stripTags(title)}\n  ${url}\n  ${stripTags(snippet)}`);
  }
}

async function read(url) {
  const html = await get(url);
  // Source line breaks mean nothing; block ends are what separate paragraphs.
  const text = html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr)>|<br\s*\/?>/gi, "\n")
    .split("\n")
    .map(stripTags)
    .filter((line) => line.length > 0)
    .join("\n");

  console.log(text.length > MAX_PAGE_CHARS ? `${text.slice(0, MAX_PAGE_CHARS)}\n[… page truncated]` : text);
}

const [first, second] = process.argv.slice(2);

try {
  if (first === "--read" && second) {
    await read(second);
  } else if (first && first !== "--read") {
    await search(process.argv.slice(2).join(" "));
  } else {
    console.log('Usage: node skills/web-search.mjs "query"  |  node skills/web-search.mjs --read URL');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`web-search failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
