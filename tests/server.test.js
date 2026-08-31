import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { once } from "node:events";

import { encode } from "../web/public/codec.js";

process.env.PORT = "0"; // let the OS pick a free port

let server;
let base;

before(async () => {
  ({ server } = await import("../web/server.js"));
  if (!server.listening) await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("serves the chat page", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /binary-ai/);
});

test("serves the module the browser needs to encode", async () => {
  const response = await fetch(`${base}/codec.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /javascript/);
  assert.match(await response.text(), /export function encode/);
});

test("404s unknown paths and refuses to escape the public directory", async () => {
  assert.equal((await fetch(`${base}/nope.html`)).status, 404);
  const escaped = await fetch(`${base}/../server.js`, { redirect: "manual" });
  assert.ok(escaped.status === 403 || escaped.status === 404, `got ${escaped.status}`);
});

test("rejects a chat request that was not encoded", async () => {
  const response = await post({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /must be binary/);
});

test("rejects a malformed body", async () => {
  assert.equal((await post({ messages: [] })).status, 400);
  assert.equal(
    (
      await post({
        messages: [{ role: "user", content: encode("hi") }, { role: "assistant", content: "x" }],
      })
    ).status,
    400,
  );
});

test("rejects other methods", async () => {
  const response = await fetch(`${base}/api/chat`, { method: "DELETE" });
  assert.equal(response.status, 405);
});

function post(body) {
  return fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
