# teleagent

A Telegram bot that runs a small autonomous agent on top of a local
[Ollama](https://ollama.com) instance. The agent can run shell commands
(`exec` tool), load reusable Skills (Markdown files in `skills/`), and
remembers conversations across restarts (`data/conversations.json`).

> **Note:** `exec` gives the model shell access under the account running
> the bot. Set `TELEGRAM_ALLOWED_USER_ID` to restrict it to yourself and/or
> run it in Docker.

## Setup

- Node.js 22+
- A local Ollama instance (default `http://localhost:11434`)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A model with tool-calling support (e.g. `ollama pull qwen2.5:14b`)

```bash
cp .env.example .env   # then fill in TELEGRAM_BOT_TOKEN, OLLAMA_BASE_URL, OLLAMA_MODEL
```

## Commands

```bash
npm install
npm run build
npm start              # run the bot
npm run start:debug    # same, with agent-loop logging
npm run build -- --watch   # dev: run this in one terminal...
npm run dev                # ...and this in another

docker compose up --build  # run sandboxed in Docker (recommended)
docker compose restart     # restart, e.g. after adding a Skill
```

In Telegram: send any text message; `/new` starts a fresh conversation.
