// Shape of the /api/chat request body.

import { looksLikeBinary } from "./public/codec.js";

export const MAX_MESSAGES = 100;

/** Return an error string if `messages` is not a valid conversation, else null. */
export function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "messages must be a non-empty array";
  }
  if (messages.length > MAX_MESSAGES) {
    return `too many messages (max ${MAX_MESSAGES})`;
  }
  if (messages.at(-1)?.role !== "user") {
    return "the last message must be from the user";
  }
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      return `unsupported role: ${message?.role}`;
    }
    if (typeof message.content !== "string") {
      return "every message needs string content";
    }
    // The whole point: a user turn reaches the server already encoded.
    if (message.role === "user" && !looksLikeBinary(message.content)) {
      return "user messages must be binary - encode them before sending";
    }
  }
  return null;
}
