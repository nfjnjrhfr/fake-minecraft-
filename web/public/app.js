// Browser side: your text becomes bits here, before it ever leaves the page.

import { encode } from "./codec.js";

const SHOW_BITS = new URLSearchParams(location.search).has("debug");

const log = document.querySelector("#log");
const form = document.querySelector("#composer");
const input = document.querySelector("#input");
const send = document.querySelector("#send");

/** The conversation as the API sees it: user turns are binary, replies are text. */
const history = [];
let busy = false;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text && !busy) ask(text);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
});

async function ask(text) {
  const bits = encode(text);

  addTurn("user", text, SHOW_BITS ? bits : null);
  input.value = "";
  input.style.height = "auto";
  setBusy(true);

  history.push({ role: "user", content: bits });
  const bubble = addTurn("ai", "");
  bubble.classList.add("cursor");

  let reply = "";
  try {
    for await (const event of streamChat(history)) {
      if (event.type === "delta") {
        reply += event.text;
        bubble.textContent = reply;
        scrollToEnd();
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
    }
    if (!reply) throw new Error("沒有收到回覆。");
    history.push({ role: "assistant", content: reply });
  } catch (error) {
    history.pop(); // drop the turn that never got an answer
    bubble.closest(".turn").remove();
    addTurn("error", error.message);
  } finally {
    bubble.classList.remove("cursor");
    setBusy(false);
  }
}

/** POST the conversation and yield the server-sent events as they arrive. */
async function* streamChat(messages) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `伺服器回應 ${response.status}`);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;

    let split;
    while ((split = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, split).trim();
      buffer = buffer.slice(split + 2);
      if (frame.startsWith("data:")) {
        yield JSON.parse(frame.slice(5));
      }
    }
  }
}

function addTurn(kind, text, bits = null) {
  log.querySelector(".empty")?.remove();

  const turn = document.createElement("div");
  turn.className = `turn ${kind}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  turn.append(bubble);

  if (bits) {
    const line = document.createElement("div");
    line.className = "bits";
    line.textContent = bits;
    turn.append(line);
  }

  log.append(turn);
  scrollToEnd();
  return bubble;
}

function setBusy(value) {
  busy = value;
  send.disabled = value;
  input.disabled = value;
  if (!value) input.focus();
}

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
  window.scrollTo({ top: document.body.scrollHeight });
}
