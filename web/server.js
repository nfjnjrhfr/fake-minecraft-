// Static file server + streaming chat endpoint.
//
// The browser encodes what you type into binary before it is sent, so the
// request body that reaches this server - and the message that reaches Claude -
// really is nothing but 0s and 1s. Plain text in a user turn is rejected.

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";

import { streamReply } from "./chat.js";
import { validateMessages } from "./protocol.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const PORT = Number(process.env.PORT ?? 3000);
const MAX_BODY_BYTES = 1_000_000;

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

// Built on first use so a missing API key surfaces as a chat error, not a
// crash at startup.
let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/chat") {
      await handleChat(req, res);
    } else if (req.method === "GET" || req.method === "HEAD") {
      await serveStatic(req, res);
    } else {
      sendJson(res, 405, { error: "method not allowed" });
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
    res.end();
  }
});

async function serveStatic(req, res) {
  const requested = new URL(req.url, "http://localhost").pathname;
  const relative = requested === "/" ? "index.html" : requested.slice(1);
  const filePath = path.join(PUBLIC_DIR, relative);

  // Refuse anything that escapes the public directory.
  if (path.relative(PUBLIC_DIR, filePath).startsWith("..")) {
    return sendJson(res, 403, { error: "forbidden" });
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type":
        CONTENT_TYPES[path.extname(filePath)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const messages = payload?.messages;
  const invalid = validateMessages(messages);
  if (invalid) return sendJson(res, 400, { error: invalid });

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const controller = new AbortController();
  res.on("close", () => controller.abort());

  try {
    for await (const chunk of streamReply(getClient(), messages, {
      signal: controller.signal,
    })) {
      sendEvent(res, { type: "delta", text: chunk });
    }
    sendEvent(res, { type: "done" });
  } catch (error) {
    if (!controller.signal.aborted) {
      console.error(error);
      sendEvent(res, { type: "error", message: describe(error) });
    }
  }
  res.end();
}

function describe(error) {
  if (error instanceof Anthropic.AuthenticationError) {
    return "No valid credentials - set ANTHROPIC_API_KEY before starting the server.";
  }
  if (error instanceof Anthropic.RateLimitError) {
    return "Rate limited - wait a moment and try again.";
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return "Could not reach the Claude API.";
  }
  if (error instanceof Anthropic.APIError) {
    return `The API returned ${error.status ?? "an error"}.`;
  }
  return "Something went wrong.";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendEvent(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`binary-ai listening on http://localhost:${PORT}`);
});

export { server };
