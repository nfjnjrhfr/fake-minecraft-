import assert from "node:assert/strict";
import test from "node:test";

import {
  BinaryDecodeError,
  decode,
  encode,
  looksLikeBinary,
} from "../web/public/codec.js";

test("encodes a known value", () => {
  assert.equal(encode("Hi"), "01001000 01101001");
});

test("encodes without a separator", () => {
  assert.equal(encode("Hi", ""), "0100100001101001");
});

test("round-trips every kind of text", () => {
  for (const text of [
    "hello world",
    "你好，世界",
    "こんにちは",
    "emoji 🙂🚀",
    "",
    "line1\nline2",
    "0101",
  ]) {
    assert.equal(decode(encode(text)), text, `round-trip failed for ${text}`);
  }
});

test("uses one 8-bit group per UTF-8 byte", () => {
  const groups = encode("你").split(" ");
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.length === 8));
});

test("decoding ignores whitespace", () => {
  assert.equal(decode(" 01001000\n01101001 "), "Hi");
  assert.equal(decode("   "), "");
});

test("decoding rejects malformed input", () => {
  assert.throws(() => decode("0100100x"), BinaryDecodeError);
  assert.throws(() => decode("0100100"), BinaryDecodeError);
  assert.throws(() => decode("11111111"), BinaryDecodeError);
});

test("looksLikeBinary recognises well-formed bits only", () => {
  assert.ok(looksLikeBinary("01001000 01101001"));
  assert.ok(!looksLikeBinary("hello"));
  assert.ok(!looksLikeBinary("0100100"));
  assert.ok(!looksLikeBinary(""));
});

test("the JS and Python encoders agree", () => {
  // Same expectation as tests/test_codec.py::test_encode_known_value.
  assert.equal(encode("你好"), "11100100 10111101 10100000 11100101 10100101 10111101");
});
