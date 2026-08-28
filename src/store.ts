import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type {
  Conversation,
  ConversationSettings,
  ConversationSummary,
  StoredMessage,
} from "./types.js";

/**
 * Conversation persistence: one JSON file per conversation under the data
 * directory. Writes are serialized per conversation id so two concurrent
 * requests on the same chat cannot interleave and lose a turn.
 */

const dir = path.resolve(config.dataDir);
const writeQueues = new Map<string, Promise<unknown>>();

/** Conversation ids come from us, but the id also names a file — verify it. */
const ID_RE = /^[a-f0-9-]{36}$/i;

function fileFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error(`invalid conversation id: ${id}`);
  return path.join(dir, `${id}.json`);
}

export async function init(): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** Run `fn` after any in-flight write to the same conversation has settled. */
function serialize<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeQueues.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  writeQueues.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

async function writeFile(conv: Conversation): Promise<void> {
  const target = fileFor(conv.id);
  // Write-then-rename so a crash mid-write cannot truncate an existing chat.
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(conv, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export async function create(
  settings: ConversationSettings,
  title = "新對話",
): Promise<Conversation> {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    settings,
    messages: [],
  };
  await serialize(conv.id, () => writeFile(conv));
  return conv;
}

export async function get(id: string): Promise<Conversation | null> {
  try {
    const raw = await fs.readFile(fileFor(id), "utf8");
    return JSON.parse(raw) as Conversation;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Read-modify-write a conversation under its write lock. Returns null if the
 * conversation disappeared between the request and the update.
 */
export async function update(
  id: string,
  mutate: (conv: Conversation) => void,
): Promise<Conversation | null> {
  return serialize(id, async () => {
    const raw = await fs
      .readFile(fileFor(id), "utf8")
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") return null;
        throw err;
      });
    if (raw === null) return null;
    const conv = JSON.parse(raw) as Conversation;
    mutate(conv);
    conv.updatedAt = new Date().toISOString();
    await writeFile(conv);
    return conv;
  });
}

export async function appendMessage(
  id: string,
  message: StoredMessage,
): Promise<void> {
  await update(id, (conv) => {
    conv.messages.push(message);
  });
}

export async function remove(id: string): Promise<boolean> {
  return serialize(id, async () => {
    try {
      await fs.unlink(fileFor(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw err;
    }
  });
}

export async function list(): Promise<ConversationSummary[]> {
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  const summaries: ConversationSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(dir, entry), "utf8");
      const conv = JSON.parse(raw) as Conversation;
      summaries.push({
        id: conv.id,
        title: conv.title,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        messageCount: conv.messages.length,
      });
    } catch {
      // A half-written or hand-edited file should not take down the sidebar.
    }
  }
  summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return summaries;
}
