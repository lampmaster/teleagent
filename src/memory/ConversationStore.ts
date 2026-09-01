import type { Message } from "../llm/index.js";

export interface ConversationStore {
  get(chatId: string): Promise<Message[]>;
  append(chatId: string, message: Message): Promise<void>;
  clear(chatId: string): Promise<void>;
}
