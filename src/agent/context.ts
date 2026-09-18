import type { Message } from "../llm/index.js";

/**
 * A message plus a stable identifier for it inside one run. The ref is what
 * makes repeated context measurable: the same ref appearing in three LLM calls
 * means those tokens were paid for three times.
 */
export interface ContextEntry {
  ref: string;
  message: Message;
}

/** The text of a message as it is sent to the model, used for token estimates. */
export function messageText(message: Message): string {
  const parts = [message.role, message.content];

  if (message.toolName) {
    parts.push(message.toolName);
  }

  if (message.toolCalls && message.toolCalls.length > 0) {
    parts.push(JSON.stringify(message.toolCalls));
  }

  return parts.join("\n");
}
