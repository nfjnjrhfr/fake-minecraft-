import { randomUUID } from 'node:crypto';
import {
  HISTORY_TURNS,
  IMAGE_MEMORY_TURNS,
  MAX_SESSIONS,
  SESSION_TTL_MS,
} from './config.js';

/** 記憶體中的對話記錄。重啟即清空；前端另有 localStorage 保存筆記。 */
const sessions = new Map();

export function createSession(mode = 'chat') {
  const id = randomUUID();
  const now = Date.now();
  sessions.set(id, { id, mode, messages: [], createdAt: now, updatedAt: now });
  prune();
  return sessions.get(id);
}

export function getSession(id, mode) {
  if (id && sessions.has(id)) {
    const s = sessions.get(id);
    s.updatedAt = Date.now();
    if (mode) s.mode = mode;
    return s;
  }
  return createSession(mode);
}

export function resetSession(id) {
  if (id && sessions.has(id)) {
    const s = sessions.get(id);
    s.messages = [];
    s.updatedAt = Date.now();
    return s;
  }
  return createSession();
}

export function appendMessage(session, message) {
  session.messages.push(message);
  session.updatedAt = Date.now();
  trim(session);
}

/**
 * 送出前的歷史整理：
 * 1) 只保留最近 HISTORY_TURNS 則訊息；
 * 2) 較舊的圖片換成文字佔位，避免每一輪都重送整包圖片。
 */
export function historyForRequest(session) {
  const recent = session.messages.slice(-HISTORY_TURNS);
  const userIndexes = [];
  recent.forEach((m, i) => {
    if (m.role === 'user') userIndexes.push(i);
  });
  const keepImagesFrom = userIndexes.length > IMAGE_MEMORY_TURNS
    ? userIndexes[userIndexes.length - IMAGE_MEMORY_TURNS]
    : 0;

  return recent.map((m, i) => {
    if (i >= keepImagesFrom || !Array.isArray(m.content)) return m;
    const content = m.content.map((block) =>
      block.type === 'image'
        ? { type: 'text', text: '［稍早上傳的圖片，內容已在前面的回覆中記錄］' }
        : block,
    );
    return { ...m, content };
  });
}

function trim(session) {
  if (session.messages.length > HISTORY_TURNS * 2) {
    session.messages = session.messages.slice(-HISTORY_TURNS);
  }
}

function prune() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.updatedAt < cutoff) sessions.delete(id);
  }
  while (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) break;
    sessions.delete(oldest[0]);
  }
}

export function stats() {
  return { sessions: sessions.size };
}
