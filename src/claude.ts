import Anthropic from "@anthropic-ai/sdk";
import { config, modelById } from "./config.js";
import { SGPT_SYSTEM_PROMPT, TITLE_SYSTEM_PROMPT } from "./persona.js";
import type {
  Attachment,
  Conversation,
  StoredMessage,
  ToolCall,
  TurnUsage,
} from "./types.js";

/**
 * Everything that talks to the Anthropic API lives here. The rest of the app
 * only sees SgptEvent objects.
 */

// Credentials resolve from ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
// `ant auth login` profile — never hardcode a key.
const client = new Anthropic();

/** Models that accept the dynamic-filtering web tools. */
const MODERN_WEB_TOOL_MODELS = [
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

/** Models that support server-side refusal fallbacks. */
const FALLBACK_MODELS = ["claude-opus-5", "claude-fable-5"];

export type SgptEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; call: ToolCall }
  | {
      type: "done";
      text: string;
      thinking: string;
      toolCalls: ToolCall[];
      usage: TurnUsage;
      model: string;
      refusal?: { category: string | null; explanation: string | null };
      stopReason: string | null;
    }
  | { type: "error"; message: string };

function attachmentBlock(att: Attachment): Anthropic.ContentBlockParam | null {
  if (att.mediaType === "application/pdf") {
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: att.data },
    };
  }
  if (
    att.mediaType === "image/png" ||
    att.mediaType === "image/jpeg" ||
    att.mediaType === "image/gif" ||
    att.mediaType === "image/webp"
  ) {
    return {
      type: "image",
      source: { type: "base64", media_type: att.mediaType, data: att.data },
    };
  }
  return null;
}

/**
 * Turn the stored transcript into Messages API params. Documents and images go
 * before the text block, which is what the models are tuned for. Assistant
 * turns are replayed as plain text: we do not persist thinking-block
 * signatures, and an unsigned thinking block would be rejected on replay.
 */
export function toMessageParams(
  messages: StoredMessage[],
): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const text = msg.text.trim();
      if (!text) continue; // an aborted turn with no output is not replayable
      out.push({ role: "assistant", content: text });
      continue;
    }
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const att of msg.attachments ?? []) {
      const block = attachmentBlock(att);
      if (block) blocks.push(block);
    }
    if (msg.text.trim() || blocks.length === 0) {
      blocks.push({ type: "text", text: msg.text });
    }
    out.push({ role: "user", content: blocks });
  }
  return out;
}

function buildSystem(
  customInstructions: string | undefined,
): Anthropic.TextBlockParam[] {
  // The persona is byte-stable and carries the cache breakpoint; per-chat
  // custom instructions go after it so they never invalidate the shared prefix.
  const blocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: SGPT_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
  ];
  const extra = customInstructions?.trim();
  if (extra) {
    blocks.push({
      type: "text",
      text: `## User's standing instructions for this conversation\n${extra}`,
    });
  }
  return blocks;
}

function emptyUsage(): TurnUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/** Server-tool result blocks are loosely typed; read them defensively. */
function sourcesFromResult(block: unknown): { title: string; url: string }[] {
  const content = (block as { content?: unknown }).content;
  if (!Array.isArray(content)) return []; // an error result is an object, not a list
  const sources: { title: string; url: string }[] = [];
  for (const item of content) {
    const url = (item as { url?: unknown }).url;
    if (typeof url !== "string") continue;
    const title = (item as { title?: unknown }).title;
    sources.push({ title: typeof title === "string" ? title : url, url });
  }
  return sources;
}

export interface StreamOptions {
  conversation: Conversation;
  /** Turns to send, already including the new user message. */
  messages: StoredMessage[];
  signal: AbortSignal;
}

/**
 * Stream one assistant turn. Yields incremental events and always ends with
 * either a `done` or an `error` event.
 */
export async function* streamTurn(
  opts: StreamOptions,
): AsyncGenerator<SgptEvent> {
  const { conversation, messages, signal } = opts;
  const model = modelById(conversation.settings.model);
  const settings = conversation.settings;

  const params: Record<string, unknown> = {
    model: model.id,
    // Clamp to the model's own ceiling — a larger value is rejected outright.
    max_tokens: Math.min(config.maxTokens, model.maxOutputTokens),
    system: buildSystem(settings.customInstructions),
    messages: toMessageParams(messages),
  };

  if (model.supportsThinking) {
    // `display` must be opted into: the default returns empty thinking text.
    params.thinking = settings.showThinking
      ? { type: "adaptive", display: "summarized" }
      : { type: "adaptive" };
  }
  if (model.supportsEffort) {
    params.output_config = { effort: settings.effort };
  }
  if (settings.webSearch) {
    params.tools = [
      MODERN_WEB_TOOL_MODELS.includes(model.id)
        ? { type: "web_search_20260209", name: "web_search" }
        : { type: "web_search_20250305", name: "web_search" },
    ];
  }

  const useFallbacks = config.fallbacks && FALLBACK_MODELS.includes(model.id);
  if (useFallbacks) {
    // Route refusals to a capable backup model instead of dead-ending the chat.
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  let text = "";
  let thinking = "";
  const toolCalls: ToolCall[] = [];
  let pendingToolInput = "";
  let pendingToolName = "";

  try {
    const stream = useFallbacks
      ? client.beta.messages.stream(params as never, { signal })
      : client.messages.stream(params as never, { signal });

    for await (const event of stream) {
      if (signal.aborted) break;

      if (event.type === "content_block_start") {
        const block = event.content_block as { type: string; name?: string };
        if (block.type === "server_tool_use") {
          pendingToolName = block.name ?? "tool";
          pendingToolInput = "";
        } else if (block.type.endsWith("_tool_result")) {
          const call: ToolCall = {
            name: pendingToolName || "web_search",
            detail: pendingToolInput,
            sources: sourcesFromResult(block),
          };
          toolCalls.push(call);
          yield { type: "tool", call };
          pendingToolName = "";
          pendingToolInput = "";
        }
        continue;
      }

      if (event.type !== "content_block_delta") continue;
      const delta = event.delta as {
        type: string;
        text?: string;
        thinking?: string;
        partial_json?: string;
      };
      if (delta.type === "text_delta" && delta.text) {
        text += delta.text;
        yield { type: "text", text: delta.text };
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        thinking += delta.thinking;
        yield { type: "thinking", text: delta.thinking };
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        pendingToolInput += delta.partial_json;
      }
    }

    if (signal.aborted) {
      yield {
        type: "done",
        text,
        thinking,
        toolCalls,
        usage: emptyUsage(),
        model: model.id,
        stopReason: "aborted",
      };
      return;
    }

    const final = await stream.finalMessage();
    const usage = final.usage as {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number | null;
      cache_creation_input_tokens?: number | null;
    };

    // stop_details is populated only on a refusal — guard before reading it.
    const stopDetails =
      final.stop_reason === "refusal"
        ? (final as { stop_details?: { category?: string | null; explanation?: string | null } })
            .stop_details
        : undefined;

    yield {
      type: "done",
      text,
      thinking,
      toolCalls,
      model: final.model || model.id,
      stopReason: final.stop_reason ?? null,
      ...(stopDetails
        ? {
            refusal: {
              category: stopDetails.category ?? null,
              explanation: stopDetails.explanation ?? null,
            },
          }
        : {}),
      usage: {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        cacheReadTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (err) {
    if (signal.aborted) {
      yield {
        type: "done",
        text,
        thinking,
        toolCalls,
        usage: emptyUsage(),
        model: model.id,
        stopReason: "aborted",
      };
      return;
    }
    yield { type: "error", message: describeError(err) };
  }
}

/** Turn an SDK error into something a user can act on. */
export function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "驗證失敗：請確認 ANTHROPIC_API_KEY 已設定且有效。";
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return "沒有權限使用這個模型，請改選其他模型或確認帳號權限。";
  }
  if (err instanceof Anthropic.NotFoundError) {
    return "找不到這個模型，請在設定中改選其他模型。";
  }
  if (err instanceof Anthropic.RateLimitError) {
    return "請求太頻繁（429），請稍等幾秒後再試一次。";
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return "無法連線到 Anthropic API，請檢查網路連線。";
  }
  if (err instanceof Anthropic.APIError) {
    return err.status
      ? `API 錯誤 ${err.status}：${err.message}`
      : `API 錯誤：${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Name a conversation from its first user message. Best effort: a failure here
 * must never break the chat, so the caller gets a trimmed fallback instead.
 */
export async function generateTitle(firstMessage: string): Promise<string> {
  const fallback = firstMessage.replace(/\s+/g, " ").trim().slice(0, 30) || "新對話";
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: firstMessage.slice(0, 2000) }],
    });
    const title = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim()
      .replace(/^["'「『]|["'」』]$/g, "");
    return title ? title.slice(0, 60) : fallback;
  } catch {
    return fallback;
  }
}
