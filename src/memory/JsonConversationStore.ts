import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Message } from "../llm/index.js";
import type { ConversationStore } from "./ConversationStore.js";

type Conversations = Record<string, Message[]>;

export class JsonConversationStore implements ConversationStore {
  private readonly filePath: string;
  private conversations: Conversations | null = null;
  /** Serializes writes so concurrent chats cannot corrupt the file. */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async get(chatId: string): Promise<Message[]> {
    const conversations = await this.load();
    return conversations[chatId] ?? [];
  }

  async append(chatId: string, message: Message): Promise<void> {
    const conversations = await this.load();
    (conversations[chatId] ??= []).push(message);
    await this.persist();
  }

  async clear(chatId: string): Promise<void> {
    const conversations = await this.load();
    delete conversations[chatId];
    await this.persist();
  }

  private async load(): Promise<Conversations> {
    if (this.conversations) {
      return this.conversations;
    }

    try {
      const raw = await readFile(this.filePath, "utf8");
      this.conversations = JSON.parse(raw) as Conversations;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `Failed to read conversations from ${this.filePath}, starting empty`,
          error,
        );
      }
      this.conversations = {};
    }

    return this.conversations;
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify(this.conversations ?? {}, null, 2);

    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.filePath, snapshot, "utf8");
      })
      .catch((error: unknown) => {
        console.error(
          `Failed to persist conversations to ${this.filePath}`,
          error,
        );
      });

    return this.writeQueue;
  }
}
