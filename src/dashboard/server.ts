import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MetricsStore } from "../metrics/index.js";
import {
  FLAG_DESCRIPTIONS,
  FLAG_NAMES,
  FlagStore,
  type FeatureFlags,
} from "../optimizations/flags.js";
import { DASHBOARD_HTML } from "./page.js";
import { overview, runDetails, sessionRuns, sessions, toolUsage } from "./queries.js";

export interface Dataset {
  id: string;
  label: string;
  databasePath: string;
  /** Absent for read-only datasets such as the benchmark database. */
  flagStore: FlagStore | null;
}

export interface DashboardOptions {
  datasets: Dataset[];
  host: string;
  port: number;
}

const MAX_BODY_BYTES = 16_384;

export function startDashboard(options: DashboardOptions) {
  const stores = new Map<string, MetricsStore>();

  const storeFor = (dataset: Dataset): MetricsStore => {
    let store = stores.get(dataset.id);

    if (!store) {
      store = new MetricsStore(dataset.databasePath);
      stores.set(dataset.id, store);
    }

    return store;
  };

  const server = createServer((request, response) => {
    handle(request, response, options, storeFor).catch((error: unknown) => {
      send(response, 500, { error: describe(error) });
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(`Dashboard listening on http://${options.host}:${options.port}`);
  });

  return server;
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: DashboardOptions,
  storeFor: (dataset: Dataset) => MetricsStore,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/" || path === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(DASHBOARD_HTML);
    return;
  }

  if (path === "/api/datasets") {
    send(
      response,
      200,
      { datasets: options.datasets.map(({ id, label }) => ({ id, label })) },
    );
    return;
  }

  const requested = url.searchParams.get("dataset");
  const dataset =
    options.datasets.find((candidate) => candidate.id === requested) ?? options.datasets[0];

  if (!dataset) {
    send(response, 500, { error: "No datasets configured" });
    return;
  }

  const store = storeFor(dataset);

  if (path === "/api/overview") {
    send(response, 200, overview(store));
    return;
  }

  if (path === "/api/tools") {
    send(response, 200, toolUsage(store));
    return;
  }

  if (path === "/api/sessions") {
    send(response, 200, sessions(store));
    return;
  }

  const sessionRunsMatch = /^\/api\/sessions\/(.+)\/runs$/.exec(path);

  if (sessionRunsMatch?.[1]) {
    send(response, 200, sessionRuns(store, decodeURIComponent(sessionRunsMatch[1])));
    return;
  }

  const runMatch = /^\/api\/runs\/(.+)$/.exec(path);

  if (runMatch?.[1]) {
    const details = runDetails(store, decodeURIComponent(runMatch[1]));
    details ? send(response, 200, details) : send(response, 404, { error: "Unknown run" });
    return;
  }

  if (path === "/api/flags" && request.method === "GET") {
    const flags = dataset.flagStore?.read() ?? null;

    send(response, 200, {
      readOnly: dataset.flagStore === null,
      flags: FLAG_NAMES.map((name) => ({
        name,
        description: FLAG_DESCRIPTIONS[name],
        enabled: flags ? flags[name] : false,
      })),
    });
    return;
  }

  if (path === "/api/flags" && request.method === "POST") {
    if (!dataset.flagStore) {
      send(response, 400, { error: "This dataset does not own the feature flag file" });
      return;
    }

    const body = await readJson(request);
    const current = dataset.flagStore.read();
    const next: FeatureFlags = { ...current };

    for (const name of FLAG_NAMES) {
      if (typeof body[name] === "boolean") {
        next[name] = body[name];
      }
    }

    dataset.flagStore.write(next);
    send(response, 200, next);
    return;
  }

  send(response, 404, { error: "Not found" });
}

function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    size += (chunk as Buffer).length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body too large");
    }

    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
