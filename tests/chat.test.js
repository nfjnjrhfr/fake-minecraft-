import assert from "node:assert/strict";
import test from "node:test";

import { FALLBACK_BETA, SYSTEM_PROMPT, streamReply } from "../web/chat.js";
import { decode, encode } from "../web/public/codec.js";

/** A stand-in for the SDK's stream: an async iterable of raw events. */
function fakeStream(chunks) {
  return (async function* () {
    for (const text of chunks) {
      yield { type: "content_block_delta", delta: { type: "text_delta", text } };
    }
    yield { type: "message_stop" };
  })();
}

function fakeMessages({ chunks = ["hi"], error = null } = {}) {
  const calls = [];
  return {
    calls,
    stream(params, options) {
      calls.push({ params, options });
      if (error) {
        return (async function* () {
          throw error;
        })();
      }
      return fakeStream(chunks);
    },
  };
}

function fakeClient({ messages, beta } = {}) {
  const plain = messages ?? fakeMessages();
  const betaMessages = beta ?? fakeMessages();
  return { messages: plain, beta: { messages: betaMessages }, plain, betaMessages };
}

async function collect(iterable) {
  const out = [];
  for await (const chunk of iterable) out.push(chunk);
  return out.join("");
}

test("sends binary, not plain text, and returns the reply", async () => {
  const client = fakeClient({ beta: fakeMessages({ chunks: ["hel", "lo"] }) });

  const reply = await collect(
    streamReply(client, [{ role: "user", content: encode("測試訊息") }]),
  );

  assert.equal(reply, "hello");
  const sent = client.betaMessages.calls[0].params.messages.at(-1).content;
  assert.match(sent, /^[01 ]+$/);
  assert.ok(!sent.includes("測試訊息"));
  assert.equal(decode(sent), "測試訊息");
});

test("carries the system prompt, effort and fallback beta", async () => {
  const client = fakeClient();

  await collect(
    streamReply(client, [{ role: "user", content: encode("hi") }], {
      effort: "low",
    }),
  );

  const { params } = client.betaMessages.calls[0];
  assert.equal(params.system, SYSTEM_PROMPT);
  assert.deepEqual(params.betas, [FALLBACK_BETA]);
  assert.equal(params.fallbacks, "default");
  assert.deepEqual(params.output_config, { effort: "low" });
  assert.equal(params.model, "claude-opus-5");
});

test("falls back to the plain endpoint when the beta is unavailable", async () => {
  const rejected = Object.assign(new Error("beta not enabled"), { status: 400 });
  const client = fakeClient({
    beta: fakeMessages({ error: rejected }),
    messages: fakeMessages({ chunks: ["ok"] }),
  });
  const turn = [{ role: "user", content: encode("hi") }];

  assert.equal(await collect(streamReply(client, turn)), "ok");
  assert.equal(client.betaMessages.calls.length, 1);
  assert.equal(client.plain.calls[0].params.fallbacks, undefined);

  // The downgrade sticks, so the beta endpoint is not retried.
  assert.equal(await collect(streamReply(client, turn)), "ok");
  assert.equal(client.betaMessages.calls.length, 1);
  assert.equal(client.plain.calls.length, 2);
});

test("other API errors are not swallowed", async () => {
  const boom = Object.assign(new Error("overloaded"), { status: 529 });
  const client = fakeClient({ beta: fakeMessages({ error: boom }) });

  await assert.rejects(
    () => collect(streamReply(client, [{ role: "user", content: encode("hi") }])),
    /overloaded/,
  );
});
