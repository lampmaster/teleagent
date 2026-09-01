function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalIntEnv(name: string): number | undefined {
  const value = process.env[name];

  if (!value) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer: ${value}`);
  }

  return parsed;
}

export const config = {
  telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  ollamaBaseUrl: requireEnv("OLLAMA_BASE_URL"),
  ollamaModel: requireEnv("OLLAMA_MODEL"),
  conversationsFile: process.env.CONVERSATIONS_FILE ?? "data/conversations.json",
  skillsDirectory: process.env.SKILLS_DIR ?? "skills",
  /** Only this Telegram user may talk to the bot. */
  allowedUserId: optionalIntEnv("TELEGRAM_ALLOWED_USER_ID"),
  debug: process.env.AGENT_DEBUG === "1",
} as const;
