import type { Effort } from "./config.js";

/** A file the user attached to a message. */
export interface Attachment {
  /** Stable id, used by the client for de-duplication. */
  id: string;
  /** Original file name, shown in the transcript. */
  name: string;
  /** MIME type, e.g. image/png or application/pdf. */
  mediaType: string;
  /** Raw bytes, base64-encoded without newlines. */
  data: string;
  /** Byte length of the decoded file. */
  size: number;
}

/** One turn in a stored conversation. */
export interface StoredMessage {
  id: string;
  role: "user" | "assistant";
  /** Visible answer text. */
  text: string;
  /** Summarized reasoning, when the model returned any. */
  thinking?: string;
  /** Web searches and other server tools used while producing this turn. */
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  /** Set when the model declined; carries the refusal category. */
  refusal?: { category: string | null; explanation: string | null };
  usage?: TurnUsage;
  model?: string;
  createdAt: string;
}

export interface ToolCall {
  name: string;
  /** Short human-readable summary, e.g. the search query. */
  detail: string;
  /** Sources surfaced by the tool, when it returns any. */
  sources?: { title: string; url: string }[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ConversationSettings {
  model: string;
  effort: Effort;
  /** Whether the web-search server tool is offered to the model. */
  webSearch: boolean;
  /** Whether summarized reasoning is requested and shown. */
  showThinking: boolean;
  /** Extra user-supplied instructions, appended after the SGPT persona. */
  customInstructions?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  settings: ConversationSettings;
  messages: StoredMessage[];
}

/** Sidebar entry — a conversation without its (potentially huge) messages. */
export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}
