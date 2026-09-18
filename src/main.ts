import { Bot } from "grammy";
import { Agent } from "./agent/index.js";
import { config, telegramConfig } from "./config.js";
import { OllamaProvider, type LLMProvider } from "./llm/index.js";
import {
  JsonConversationStore,
  type ConversationStore,
} from "./memory/index.js";
import { MetricsStore } from "./metrics/index.js";
import { CompactionStateStore } from "./optimizations/contextCompaction.js";
import { FlagStore } from "./optimizations/flags.js";
import { SkillLoader } from "./skills/SkillLoader.js";
import { ExecTool, LoadSkillTool, type Tool } from "./tools/index.js";

const TELEGRAM_MESSAGE_LIMIT = 4096;

const llmProvider: LLMProvider = new OllamaProvider({
  baseUrl: config.ollamaBaseUrl,
  model: config.ollamaModel,
});

const conversationStore: ConversationStore = new JsonConversationStore(
  config.conversationsFile,
);

const metricsStore = openMetricsStore();
const flagStore = new FlagStore(config.featureFlagsFile);

const skillLoader = new SkillLoader(config.skillsDirectory);
const skills = await skillLoader.list();

const tools: Tool[] = [new ExecTool(), new LoadSkillTool(skillLoader)];

const agent = new Agent({
  llmProvider,
  conversationStore,
  tools,
  skills,
  maxIterations: config.maxIterations,
  debug: config.debug,
  metricsStore,
  flags: flagStore,
  pricing: config.pricing,
  agentId: "telegram",
  compactionStore: new CompactionStateStore(config.compactionStateFile),
  compactionThresholds: config.compactionThresholds,
});

const bot = new Bot(telegramConfig.botToken());

bot.use(async (ctx, next) => {
  if (ctx.from?.id === telegramConfig.allowedUserId) {
    await next();
  }
});

bot.command("new", async (ctx) => {
  await conversationStore.clear(String(ctx.chat.id));
  await ctx.reply("Started a new conversation.");
});

bot.on("message:text", async (ctx) => {
  try {
    const result = await agent.run(String(ctx.chat.id), ctx.message.text);
    await ctx.reply(result.response.slice(0, TELEGRAM_MESSAGE_LIMIT));
  } catch (error) {
    console.error("Agent run failed", error);
    await ctx.reply("Sorry, something went wrong. Please try again later.");
  }
});

bot.catch((err) => {
  console.error("Bot error", err.error);
});

bot.start({
  onStart: () =>
    console.log(
      `Bot started with ${tools.length} tools and ${skills.length} skills`,
    ),
});

/** Metrics are best-effort: the bot still runs if the database cannot be opened. */
function openMetricsStore(): MetricsStore | null {
  try {
    const store = new MetricsStore(config.metricsDatabase);
    store.failStaleRuns();
    return store;
  } catch (error) {
    console.error(
      `Failed to open the metrics database at ${config.metricsDatabase}; running without metrics`,
      error,
    );
    return null;
  }
}
