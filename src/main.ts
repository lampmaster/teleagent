import { Bot } from "grammy";
import { Agent } from "./agent/index.js";
import { config } from "./config.js";
import { OllamaProvider, type LLMProvider } from "./llm/index.js";
import {
  JsonConversationStore,
  type ConversationStore,
} from "./memory/index.js";
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

const skillLoader = new SkillLoader(config.skillsDirectory);
const skills = await skillLoader.list();

const tools: Tool[] = [new ExecTool(), new LoadSkillTool(skillLoader)];

const agent = new Agent({
  llmProvider,
  conversationStore,
  tools,
  skills,
  debug: config.debug,
});

const bot = new Bot(config.telegramBotToken);

bot.use(async (ctx, next) => {
  if (ctx.from?.id === config.allowedUserId) {
    await next();
  }
});

bot.command("new", async (ctx) => {
  await conversationStore.clear(String(ctx.chat.id));
  await ctx.reply("Started a new conversation.");
});

bot.on("message:text", async (ctx) => {
  try {
    const response = await agent.run(String(ctx.chat.id), ctx.message.text);
    await ctx.reply(response.slice(0, TELEGRAM_MESSAGE_LIMIT));
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
