import { rm } from "node:fs/promises";
import { Agent } from "../agent/index.js";
import { OllamaProvider } from "../llm/index.js";
import { JsonConversationStore } from "../memory/index.js";
import { MetricsStore, type Pricing } from "../metrics/index.js";
import {
  CompactionStateStore,
  type CompactionThresholds,
} from "../optimizations/contextCompaction.js";
import type { FeatureFlags } from "../optimizations/flags.js";
import { SkillLoader } from "../skills/SkillLoader.js";
import { ExecTool, LoadSkillTool, type Tool } from "../tools/index.js";
import { scriptedRunner } from "./fixtures.js";
import { checkSuccess, type Scenario } from "./scenarios.js";

export interface BenchmarkConfiguration {
  name: string;
  flags: FeatureFlags;
}

export interface BenchmarkOptions {
  ollamaBaseUrl: string;
  ollamaModel: string;
  metricsDatabase: string;
  conversationsFile: string;
  compactionStateFile: string;
  compactionThresholds: CompactionThresholds;
  skillsDirectory: string;
  maxIterations: number;
  pricing: Pricing;
  configurations: BenchmarkConfiguration[];
  scenarios: Scenario[];
  repetitions: number;
  requestTimeoutMs: number;
  /** Runs executed at the same time. Above 1, wall-clock timings stop being comparable. */
  concurrency: number;
  debug: boolean;
}

interface Task {
  configuration: BenchmarkConfiguration;
  scenario: Scenario;
  repetition: number;
}

/**
 * Sampling settings are identical for every configuration, and the seed is
 * derived from the scenario and repetition, so configurations are compared
 * under the same generation conditions.
 */
function generationOptions(scenarioId: string, repetition: number) {
  return {
    sampling: {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      seed: seedFor(scenarioId, repetition),
    },
  };
}

function seedFor(scenarioId: string, repetition: number): number {
  let hash = 2_166_136_261;

  for (const char of scenarioId) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 16_777_619);
  }

  return Math.abs((hash >>> 0) % 1_000_000) + repetition * 7919;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  // A fresh conversation file per benchmark process keeps runs isolated from
  // each other and from the bot's real history.
  await rm(options.conversationsFile, { force: true });
  await rm(options.compactionStateFile, { force: true });

  const metricsStore = new MetricsStore(options.metricsDatabase);
  metricsStore.failStaleRuns();

  const conversationStore = new JsonConversationStore(options.conversationsFile);
  const skillLoader = new SkillLoader(options.skillsDirectory);
  const skills = await skillLoader.list();

  const tools: Tool[] = [
    new ExecTool({ runner: scriptedRunner() }),
    new LoadSkillTool(skillLoader),
  ];

  const llmProvider = new OllamaProvider({
    baseUrl: options.ollamaBaseUrl,
    model: options.ollamaModel,
    requestTimeoutMs: options.requestTimeoutMs,
  });

  const agent = new Agent({
    llmProvider,
    conversationStore,
    tools,
    skills,
    maxIterations: options.maxIterations,
    debug: options.debug,
    metricsStore,
    pricing: options.pricing,
    agentId: "benchmark",
    compactionStore: new CompactionStateStore(options.compactionStateFile),
    compactionThresholds: options.compactionThresholds,
  });

  const tasks: Task[] = [];

  for (const configuration of options.configurations) {
    for (const scenario of options.scenarios) {
      for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
        tasks.push({ configuration, scenario, repetition });
      }
    }
  }

  const startedAt = Date.now();
  let nextTask = 0;
  let done = 0;

  const runOne = async (task: Task): Promise<void> => {
    const { configuration, scenario, repetition } = task;
    const sessionId = `${configuration.name}/${scenario.id}/${repetition}`;

    try {
      // Every run starts from exactly the scenario's recorded history.
      await conversationStore.clear(sessionId);

      for (const message of scenario.history) {
        await conversationStore.append(sessionId, message);
      }

      const result = await agent.run(sessionId, scenario.userMessage, {
        benchmark: { scenario: scenario.id, config: configuration.name, repetition },
        flags: configuration.flags,
        generateOptions: generationOptions(scenario.id, repetition),
      });

      const check = checkSuccess(scenario, result.status, result.response, result.toolCalls);
      metricsStore.setRunSuccess(result.runId, check.success, check.detail);
      metricsStore.checkpoint();

      done += 1;
      report(done, tasks.length, startedAt, task, {
        status: result.status,
        success: check.success,
        detail: check.detail,
      });
    } catch (error) {
      done += 1;
      report(done, tasks.length, startedAt, task, {
        status: "error",
        success: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const worker = async (): Promise<void> => {
    while (true) {
      const task = tasks[nextTask];
      nextTask += 1;

      if (!task) {
        return;
      }

      await runOne(task);
    }
  };

  const workers = Math.max(1, Math.min(options.concurrency, tasks.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));

  metricsStore.checkpoint();
  metricsStore.close();
  console.log(`\nBenchmark finished in ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

function report(
  done: number,
  total: number,
  startedAt: number,
  task: Task,
  result: { status: string; success: boolean; detail: string },
): void {
  const elapsed = (Date.now() - startedAt) / 1000;
  const eta = done > 0 ? (elapsed / done) * (total - done) : 0;
  const mark = result.success ? "PASS" : "FAIL";

  console.log(
    `[${String(done).padStart(3)}/${total}] ${mark} ${task.configuration.name} ` +
      `${task.scenario.id} #${task.repetition} (${result.status})` +
      `${result.success ? "" : ` - ${result.detail}`} ` +
      `| elapsed ${(elapsed / 60).toFixed(1)}m, eta ${(eta / 60).toFixed(1)}m`,
  );
}
