#!/usr/bin/env node
// 網頁版 Claude 聊天的後端：靜態檔案 + /api/chat（Server-Sent Events 串流）。
// API key 只留在伺服器這邊，不會進到瀏覽器。
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { makeStaticHandler } from '../../server.mjs';
import { REPO_ROOT, ALL_TOOLS } from './tools.js';
import { runTurn, describeError, DEFAULT_MODEL } from './session.js';

const port = Number(process.env.PORT) || 8081;
const model = process.env.CLAUDE_MODEL || DEFAULT_MODEL;
const client = new Anthropic();
const serveStatic = makeStaticHandler(REPO_ROOT);
const sessions = new Map(); // sessionId → messages[]

function send(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('請求太大'));
    });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    return;
  }
  const sessionId = String(body.sessionId || 'default');
  const text = String(body.text || '').trim();
  if (!text) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: '沒有內容' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  try {
    const result = await runTurn({
      client,
      messages: sessions.get(sessionId) || [],
      userText: text,
      model,
      onText: (t) => send(res, { type: 'text', text: t }),
      onThinking: (t) => send(res, { type: 'thinking', text: t }),
      onToolUse: (name, input) => send(res, { type: 'tool', name, input }),
      onRefusal: (category) => send(res, { type: 'refusal', category }),
    });
    sessions.set(sessionId, result.messages);
    send(res, { type: 'done', usage: result.usage });
  } catch (err) {
    send(res, { type: 'error', message: describeError(err) });
  }
  res.end();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'POST' && url.pathname === '/api/chat') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    sessions.delete(String(new URL(req.url, 'http://x').searchParams.get('session') || 'default'));
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (url.pathname === '/api/info') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ model, tools: ALL_TOOLS.map((t) => ({ name: t.name, description: t.description })) })
    );
    return;
  }
  serveStatic(req, res);
});

server.listen(port, () => {
  console.log(`Claude 聊天：http://localhost:${port}/claude.html`);
  console.log(`（API key 留在伺服器端，瀏覽器只拿得到串流出來的文字）`);
});

export { server };
