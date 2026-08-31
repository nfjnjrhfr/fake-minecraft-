import assert from "node:assert/strict";
import test from "node:test";

import { MAX_MESSAGES, validateMessages } from "../web/protocol.js";
import { encode } from "../web/public/codec.js";

const user = (text) => ({ role: "user", content: encode(text) });
const ai = (text) => ({ role: "assistant", content: text });

test("accepts a binary conversation", () => {
  assert.equal(validateMessages([user("hi"), ai("hello"), user("你好")]), null);
});

test("rejects plain text in a user turn", () => {
  const error = validateMessages([{ role: "user", content: "hi" }]);
  assert.match(error, /must be binary/);
});

test("rejects a half-encoded conversation", () => {
  const error = validateMessages([
    user("hi"),
    ai("hello"),
    { role: "user", content: "not encoded" },
  ]);
  assert.match(error, /must be binary/);
});

test("requires the last turn to be the user's", () => {
  assert.match(validateMessages([user("hi"), ai("hello")]), /last message/);
});

test("rejects empty, oversized and malformed payloads", () => {
  assert.match(validateMessages([]), /non-empty/);
  assert.match(validateMessages("nope"), /non-empty/);
  assert.match(
    validateMessages(Array.from({ length: MAX_MESSAGES + 1 }, () => user("x"))),
    /too many/,
  );
  assert.match(
    validateMessages([{ role: "system", content: "0101" }, user("hi")]),
    /unsupported role/,
  );
  assert.match(validateMessages([{ role: "user", content: 42 }]), /string/);
});
