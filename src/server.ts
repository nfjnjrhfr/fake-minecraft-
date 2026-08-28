import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Request, Response } from "express";
import { describeError, generateTitle, streamTurn } from "./claude.js";
import type { Effort } from "./config.js";
import {
  EFFORT_LEVELS,
  MODELS,
  config,
  hasExplicitApiKey,
  modelById,
} from "./config.js";
import * as store from "./store.js";
import type { Attachment, ConversationSettings, StoredMessage } from "./types.js";

/** Express 5 types route params as `string | string[]`; we only ever use one. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js sits one level below the project root; src/server.ts sits in src/.
const publicDir = path.resolve(here, "..", "public");

const app = express();
app.use(express.json({ limit: config.maxRequestBody }));
app.use(express.static(publicDir, { extensions: ["html"] }));

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

function defaultSettings(): ConversationSettings {
  return {
    model: config.defaultModel,
    effort: config.defaultEffort,
    webSearch: false,
    showThinking: true,
  };
}

/** Accept only settings we recognise; anything else falls back to the default. */
function sanitizeSettings(
  input: unknown,
  base: ConversationSettings,
): ConversationSettings {
  const raw = (input ?? {}) as Partial<ConversationSettings>;
  const model = MODELS.some((m) => m.id === raw.model) ? raw.model! : base.model;
  const effort = (EFFORT_LEVELS as readonly string[]).includes(raw.effort ?? "")
    ? (raw.effort as Effort)
    : base.effort;
  const instructions =
    typeof raw.customInstructions === "string"
      ? raw.customInstructions.slice(0, 8000)
      : base.customInstructions;
  return {
    model,
    effort,
    webSearch:
      typeof raw.webSearch === "boolean" ? raw.webSearch : base.webSearch,
    showThinking:
      typeof raw.showThinking === "boolean"
        ? raw.showThinking
        : base.showThinking,
    ...(instructions ? { customInstructions: instructions } : {}),
  };
}

/** Validate uploads before they reach the API, and drop anything unsupported. */
function sanitizeAttachments(input: unknown): {
  attachments: Attachment[];
  rejected: string[];
} {
  if (!Array.isArray(input)) return { attachments: [], rejected: [] };
  const attachments: Attachment[] = [];
  const rejected: string[] = [];
  for (const item of input.slice(0, 10)) {
    const att = item as Partial<Attachment>;
    const name = typeof att.name === "string" ? att.name.slice(0, 200) : "file";
    if (
      typeof att.data !== "string" ||
      typeof att.mediaType !== "string" ||
      !ALLOWED_MEDIA.has(att.mediaType)
    ) {
      rejected.push(name);
      continue;
    }
    // base64 expands 4 chars per 3 bytes; estimate before decoding.
    const size = Math.floor((att.data.length * 3) / 4);
    if (size > config.maxAttachmentBytes) {
      rejected.push(name);
      continue;
    }
    attachments.push({
      id: typeof att.id === "string" ? att.id : randomUUID(),
      name,
      mediaType: att.mediaType,
      data: att.data.replace(/\s/g, ""),
      size,
    });
  }
  return { attachments, rejected };
}

app.get("/api/config", (_req: Request, res: Response) => {
  res.json({
    models: MODELS,
    efforts: EFFORT_LEVELS,
    defaults: defaultSettings(),
    /** The client shows a setup hint when no key is present in the env. */
    apiKeyConfigured: hasExplicitApiKey(),
    maxAttachmentBytes: config.maxAttachmentBytes,
  });
});

app.get("/api/conversations", async (_req: Request, res: Response) => {
  res.json(await store.list());
});

app.post("/api/conversations", async (req: Request, res: Response) => {
  const settings = sanitizeSettings(req.body?.settings, defaultSettings());
  const conv = await store.create(settings);
  res.status(201).json(conv);
});

app.get("/api/conversations/:id", async (req: Request, res: Response) => {
  const conv = await store.get(param(req, "id")).catch(() => null);
  if (!conv) return res.status(404).json({ error: "conversation not found" });
  res.json(conv);
});

app.patch("/api/conversations/:id", async (req: Request, res: Response) => {
  const updated = await store
    .update(param(req, "id"), (conv) => {
      if (typeof req.body?.title === "string" && req.body.title.trim()) {
        conv.title = req.body.title.trim().slice(0, 120);
      }
      if (req.body?.settings) {
        conv.settings = sanitizeSettings(req.body.settings, conv.settings);
      }
    })
    .catch(() => null);
  if (!updated) return res.status(404).json({ error: "conversation not found" });
  res.json(updated);
});

app.delete("/api/conversations/:id", async (req: Request, res: Response) => {
  const removed = await store.remove(param(req, "id")).catch(() => false);
  res.status(removed ? 204 : 404).end();
});

/**
 * Drop the trailing turns of a conversation so the next send regenerates from
 * a chosen point. Used by both "regenerate" and "edit and resend".
 */
app.post("/api/conversations/:id/truncate", async (req: Request, res: Response) => {
  const afterId = req.body?.afterMessageId as string | undefined;
  const updated = await store
    .update(param(req, "id"), (conv) => {
      if (!afterId) {
        conv.messages = [];
        return;
      }
      const idx = conv.messages.findIndex((m) => m.id === afterId);
      if (idx >= 0) conv.messages = conv.messages.slice(0, idx);
    })
    .catch(() => null);
  if (!updated) return res.status(404).json({ error: "conversation not found" });
  res.json(updated);
});

function sseSend(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Send a message and stream the answer back over SSE. The user turn is
 * persisted before generation starts, so a dropped connection never loses
 * what the user typed.
 */
app.post("/api/conversations/:id/messages", async (req: Request, res: Response) => {
  const id = param(req, "id");
  const conv = await store.get(id).catch(() => null);
  if (!conv) return res.status(404).json({ error: "conversation not found" });

  const text = typeof req.body?.text === "string" ? req.body.text : "";
  const { attachments, rejected } = sanitizeAttachments(req.body?.attachments);
  if (!text.trim() && attachments.length === 0) {
    return res.status(400).json({ error: "message is empty" });
  }
  if (req.body?.settings) {
    conv.settings = sanitizeSettings(req.body.settings, conv.settings);
    await store.update(id, (c) => {
      c.settings = conv.settings;
    });
  }

  const userMessage: StoredMessage = {
    id: randomUUID(),
    role: "user",
    text,
    createdAt: new Date().toISOString(),
    ...(attachments.length ? { attachments } : {}),
  };
  await store.appendMessage(id, userMessage);
  const history = [...conv.messages, userMessage];

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  sseSend(res, "start", { userMessageId: userMessage.id, rejected });

  // Name the conversation from its first message, in parallel with the answer.
  const titlePromise =
    conv.messages.length === 0 && text.trim()
      ? generateTitle(text).then(async (title) => {
          await store.update(id, (c) => {
            c.title = title;
          });
          return title;
        })
      : null;

  const controller = new AbortController();
  // The client stops generation by aborting its fetch; that closes this socket.
  res.on("close", () => controller.abort());

  const assistantMessage: StoredMessage = {
    id: randomUUID(),
    role: "assistant",
    text: "",
    createdAt: new Date().toISOString(),
    model: conv.settings.model,
  };

  try {
    for await (const event of streamTurn({
      conversation: conv,
      messages: history,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case "text":
          sseSend(res, "text", { text: event.text });
          break;
        case "thinking":
          sseSend(res, "thinking", { text: event.text });
          break;
        case "tool":
          sseSend(res, "tool", event.call);
          break;
        case "error":
          sseSend(res, "error", { message: event.message });
          break;
        case "done": {
          assistantMessage.text = event.text;
          assistantMessage.model = event.model;
          assistantMessage.usage = event.usage;
          if (event.thinking) assistantMessage.thinking = event.thinking;
          if (event.toolCalls.length) assistantMessage.toolCalls = event.toolCalls;
          if (event.refusal) assistantMessage.refusal = event.refusal;
          if (assistantMessage.text || event.toolCalls.length) {
            await store.appendMessage(id, assistantMessage);
          }
          const title = await titlePromise;
          sseSend(res, "done", {
            message: assistantMessage,
            stopReason: event.stopReason,
            ...(title ? { title } : {}),
          });
          break;
        }
      }
    }
  } catch (err) {
    sseSend(res, "error", { message: describeError(err) });
  } finally {
    res.end();
  }
});

app.get("/api/health", (_req: Request, res: Response) => {
  res.json({ ok: true, model: modelById(config.defaultModel).id });
});

const server = await store.init().then(() =>
  app.listen(config.port, () => {
    console.log(`SGPT ready on http://localhost:${config.port}`);
    if (!hasExplicitApiKey()) {
      console.warn(
        "warning: ANTHROPIC_API_KEY is not set. SGPT will fall back to an " +
          "`ant auth login` profile if one exists; otherwise requests will fail.",
      );
    }
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
