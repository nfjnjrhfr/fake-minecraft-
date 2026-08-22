import { escapeHtml, renderMarkdown } from "./markdown.js";

/**
 * SGPT front end. Talks to the server over JSON for conversation management
 * and over SSE for the streaming answer itself.
 */

const $ = (id) => document.getElementById(id);

const els = {
  app: $("app"),
  sidebar: $("sidebar"),
  convList: $("conv-list"),
  newChat: $("new-chat"),
  transcript: $("transcript"),
  messages: $("messages"),
  welcome: $("welcome"),
  suggestions: $("suggestions"),
  composer: $("composer"),
  input: $("input"),
  send: $("send"),
  stop: $("stop"),
  attachBtn: $("attach-btn"),
  fileInput: $("file-input"),
  attachments: $("attachments"),
  chatTitle: $("chat-title"),
  modelChip: $("model-chip"),
  toast: $("toast"),
  modal: $("settings-modal"),
  modelSelect: $("model-select"),
  modelBlurb: $("model-blurb"),
  effortSelect: $("effort-select"),
  webSearch: $("web-search"),
  showThinking: $("show-thinking"),
  customInstructions: $("custom-instructions"),
};

const state = {
  /** Server config: model catalog, effort levels, defaults. */
  config: null,
  /** The open conversation, or null before the first message is sent. */
  conversation: null,
  /** Settings used for the next new conversation. */
  settings: null,
  /** Files staged for the next message. */
  pending: [],
  /** AbortController for the in-flight generation. */
  inflight: null,
};

/* ---------- helpers ---------- */

function toast(message, ms = 2600) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    els.toast.hidden = true;
  }, ms);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok && res.status !== 204) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`無法讀取 ${file.name}`));
    reader.onload = () => {
      // result is "data:<mime>;base64,<payload>" — we only send the payload.
      const comma = String(reader.result).indexOf(",");
      resolve(String(reader.result).slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const atBottom = () =>
  els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight < 120;

function scrollToBottom(force = false) {
  if (force || atBottom()) {
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
}

/* ---------- rendering ---------- */

function attachmentChips(attachments) {
  if (!attachments?.length) return "";
  const chips = attachments
    .map(
      (a) =>
        `<span class="chip">${a.mediaType === "application/pdf" ? "📄" : "🖼"} ${escapeHtml(a.name)}</span>`,
    )
    .join("");
  return `<div class="attachment-chips">${chips}</div>`;
}

function toolCallHtml(call) {
  const query = call.detail ? safeQuery(call.detail) : "";
  const sources = (call.sources ?? [])
    .slice(0, 5)
    .map(
      (s) =>
        `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a></li>`,
    )
    .join("");
  return (
    `<div class="tool-call"><span class="tool-name">🔎 ${escapeHtml(call.name)}</span>` +
    (query ? ` ${escapeHtml(query)}` : "") +
    (sources ? `<ul>${sources}</ul>` : "") +
    `</div>`
  );
}

/** Tool input arrives as streamed JSON; show the query when it parses. */
function safeQuery(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed.query ?? parsed.url ?? "";
  } catch {
    return "";
  }
}

function usageLine(usage) {
  if (!usage) return "";
  const cached = usage.cacheReadTokens
    ? `，快取命中 ${usage.cacheReadTokens.toLocaleString()}`
    : "";
  return `輸入 ${usage.inputTokens.toLocaleString()} · 輸出 ${usage.outputTokens.toLocaleString()} tokens${cached}`;
}

function messageNode(msg) {
  const node = document.createElement("article");
  node.className = `msg ${msg.role}`;
  node.dataset.id = msg.id;

  if (msg.role === "user") {
    node.innerHTML =
      attachmentChips(msg.attachments) +
      `<div class="bubble">${escapeHtml(msg.text)}</div>` +
      `<div class="msg-actions"><button type="button" data-action="edit">編輯</button></div>`;
    return node;
  }

  node.innerHTML =
    `<div class="msg-role">SGPT</div>` +
    `<div class="thinking-slot"></div>` +
    `<div class="tools"></div>` +
    `<div class="bubble"></div>` +
    `<div class="msg-actions">` +
    `<button type="button" data-action="copy">複製</button>` +
    `<button type="button" data-action="regenerate">重新生成</button>` +
    `</div>` +
    `<div class="msg-meta"></div>`;

  paintAssistant(node, msg);
  return node;
}

/** Fill (or refresh) an assistant node from a message object. */
function paintAssistant(node, msg) {
  const slot = node.querySelector(".thinking-slot");
  if (msg.thinking) {
    slot.innerHTML =
      `<details class="thinking"><summary>思考過程</summary>` +
      `<div class="thinking-body">${escapeHtml(msg.thinking)}</div></details>`;
  } else {
    slot.innerHTML = "";
  }

  const tools = node.querySelector(".tools");
  tools.innerHTML = (msg.toolCalls ?? []).map(toolCallHtml).join("");

  const bubble = node.querySelector(".bubble");
  bubble.innerHTML = renderMarkdown(msg.text);
  if (msg.refusal) {
    bubble.insertAdjacentHTML(
      "beforeend",
      `<div class="error-note">SGPT 婉拒了這個請求${
        msg.refusal.category ? `（類別：${escapeHtml(msg.refusal.category)}）` : ""
      }。</div>`,
    );
  }

  node.querySelector(".msg-meta").textContent = usageLine(msg.usage);
}

function renderConversation() {
  els.messages.innerHTML = "";
  const conv = state.conversation;
  const hasMessages = Boolean(conv?.messages?.length);
  els.welcome.hidden = hasMessages;
  els.chatTitle.textContent = conv?.title ?? "SGPT";
  updateModelChip();
  if (!hasMessages) return;
  for (const msg of conv.messages) els.messages.appendChild(messageNode(msg));
  scrollToBottom(true);
}

function updateModelChip() {
  const settings = state.conversation?.settings ?? state.settings;
  const model = state.config?.models.find((m) => m.id === settings?.model);
  const bits = [model?.label ?? "SGPT"];
  if (model?.supportsEffort) bits.push(settings.effort);
  if (settings?.webSearch) bits.push("聯網");
  els.modelChip.textContent = bits.join(" · ");
}

function renderSidebar(items, activeId) {
  els.convList.innerHTML = "";
  if (!items.length) {
    els.convList.innerHTML = `<p class="conv-empty">還沒有對話。</p>`;
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `conv-item${item.id === activeId ? " active" : ""}`;
    row.innerHTML =
      `<span>${escapeHtml(item.title)}</span>` +
      `<button class="del" type="button" aria-label="刪除">🗑</button>`;
    row.querySelector("span").addEventListener("click", () => openConversation(item.id));
    row.querySelector(".del").addEventListener("click", async (event) => {
      event.stopPropagation();
      if (!confirm(`刪除「${item.title}」？`)) return;
      await api(`/api/conversations/${item.id}`, { method: "DELETE" });
      if (state.conversation?.id === item.id) startNewChat();
      else refreshSidebar();
    });
    els.convList.appendChild(row);
  }
}

async function refreshSidebar() {
  try {
    const items = await api("/api/conversations");
    renderSidebar(items, state.conversation?.id);
  } catch {
    // The sidebar is not worth an error toast; the chat still works.
  }
}

/* ---------- attachments ---------- */

function renderPending() {
  els.attachments.hidden = state.pending.length === 0;
  els.attachments.innerHTML = state.pending
    .map(
      (a, i) =>
        `<span class="chip">${a.mediaType === "application/pdf" ? "📄" : "🖼"} ` +
        `${escapeHtml(a.name)} <small>${formatBytes(a.size)}</small> ` +
        `<button type="button" data-index="${i}" aria-label="移除">✕</button></span>`,
    )
    .join("");
}

async function stageFiles(files) {
  const limit = state.config?.maxAttachmentBytes ?? 12 * 1024 * 1024;
  for (const file of files) {
    if (file.size > limit) {
      toast(`${file.name} 超過 ${formatBytes(limit)} 上限`);
      continue;
    }
    try {
      state.pending.push({
        id: crypto.randomUUID(),
        name: file.name,
        mediaType: file.type,
        size: file.size,
        data: await fileToBase64(file),
      });
    } catch (err) {
      toast(err.message);
    }
  }
  renderPending();
}

/* ---------- conversation lifecycle ---------- */

function startNewChat() {
  state.conversation = null;
  state.pending = [];
  renderPending();
  renderConversation();
  refreshSidebar();
  els.input.focus();
}

async function openConversation(id) {
  try {
    state.conversation = await api(`/api/conversations/${id}`);
    state.settings = { ...state.conversation.settings };
    renderConversation();
    refreshSidebar();
    closeSidebarOnMobile();
  } catch (err) {
    toast(`打不開這個對話：${err.message}`);
  }
}

async function ensureConversation() {
  if (state.conversation) return state.conversation;
  state.conversation = await api("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ settings: state.settings }),
  });
  return state.conversation;
}

/* ---------- streaming ---------- */

function setGenerating(on) {
  els.send.hidden = on;
  els.stop.hidden = !on;
  els.input.disabled = false;
}

/**
 * Send `text` plus any staged attachments and stream the answer in. The SSE
 * body is parsed by hand: the wire format is small and a parser would be a
 * dependency for no gain.
 */
async function sendMessage(text) {
  const conv = await ensureConversation();
  const attachments = state.pending;
  state.pending = [];
  renderPending();

  const userMsg = {
    id: `local-${crypto.randomUUID()}`,
    role: "user",
    text,
    attachments,
    createdAt: new Date().toISOString(),
  };
  conv.messages.push(userMsg);
  els.welcome.hidden = true;
  const userNode = messageNode(userMsg);
  els.messages.appendChild(userNode);

  const draft = {
    id: `local-${crypto.randomUUID()}`,
    role: "assistant",
    text: "",
    thinking: "",
    toolCalls: [],
    createdAt: new Date().toISOString(),
  };
  const node = messageNode(draft);
  node.querySelector(".bubble").classList.add("cursor");
  els.messages.appendChild(node);
  scrollToBottom(true);

  const controller = new AbortController();
  state.inflight = controller;
  setGenerating(true);

  try {
    const res = await fetch(`/api/conversations/${conv.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, attachments, settings: state.settings }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line.
      let split;
      while ((split = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        handleFrame(frame, { conv, draft, node, userMsg });
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      node
        .querySelector(".bubble")
        .insertAdjacentHTML("beforeend", `<div class="error-note">${escapeHtml(err.message)}</div>`);
    }
  } finally {
    node.querySelector(".bubble").classList.remove("cursor");
    state.inflight = null;
    setGenerating(false);
    refreshSidebar();
    els.input.focus();
  }
}

function handleFrame(frame, ctx) {
  let event = "message";
  const dataLines = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return;

  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    return;
  }

  const { conv, draft, node, userMsg } = ctx;

  switch (event) {
    case "start":
      userMsg.id = data.userMessageId;
      node.previousElementSibling?.setAttribute("data-id", data.userMessageId);
      if (data.rejected?.length) {
        toast(`已略過不支援的檔案：${data.rejected.join("、")}`);
      }
      break;

    case "thinking":
      draft.thinking += data.text;
      paintThinking(node, draft.thinking);
      scrollToBottom();
      break;

    case "text":
      draft.text += data.text;
      node.querySelector(".bubble").innerHTML = renderMarkdown(draft.text);
      scrollToBottom();
      break;

    case "tool":
      draft.toolCalls.push(data);
      node.querySelector(".tools").innerHTML = draft.toolCalls.map(toolCallHtml).join("");
      scrollToBottom();
      break;

    case "done": {
      Object.assign(draft, data.message);
      paintAssistant(node, draft);
      node.dataset.id = draft.id;
      conv.messages.push(draft);
      if (data.title) {
        conv.title = data.title;
        els.chatTitle.textContent = data.title;
      }
      if (data.stopReason === "max_tokens") {
        toast("回答太長被截斷了，可以請 SGPT 接著寫下去。");
      }
      break;
    }

    case "error":
      node
        .querySelector(".bubble")
        .insertAdjacentHTML("beforeend", `<div class="error-note">${escapeHtml(data.message)}</div>`);
      break;
  }
}

function paintThinking(node, thinking) {
  const slot = node.querySelector(".thinking-slot");
  if (!slot.querySelector(".thinking")) {
    slot.innerHTML =
      `<details class="thinking" open><summary>思考中…</summary>` +
      `<div class="thinking-body"></div></details>`;
  }
  const body = slot.querySelector(".thinking-body");
  body.textContent = thinking;
  body.scrollTop = body.scrollHeight;
}

/* ---------- actions on existing messages ---------- */

/** Drop everything from `messageId` onward, then resend `text`. */
async function truncateAndResend(messageId, text) {
  const conv = state.conversation;
  if (!conv) return;
  await api(`/api/conversations/${conv.id}/truncate`, {
    method: "POST",
    body: JSON.stringify({ afterMessageId: messageId }),
  });
  const index = conv.messages.findIndex((m) => m.id === messageId);
  if (index >= 0) conv.messages = conv.messages.slice(0, index);
  renderConversation();
  await sendMessage(text);
}

els.messages.addEventListener("click", async (event) => {
  const copyBtn = event.target.closest(".copy-code");
  if (copyBtn) {
    const code = decodeURIComponent(copyBtn.closest(".code-block").dataset.code);
    await navigator.clipboard.writeText(code).then(
      () => toast("已複製程式碼"),
      () => toast("複製失敗"),
    );
    return;
  }

  const actionBtn = event.target.closest("[data-action]");
  if (!actionBtn) return;
  const node = actionBtn.closest(".msg");
  const id = node?.dataset.id;
  const conv = state.conversation;
  if (!conv || !id) return;
  const index = conv.messages.findIndex((m) => m.id === id);
  if (index < 0) return;

  switch (actionBtn.dataset.action) {
    case "copy":
      await navigator.clipboard.writeText(conv.messages[index].text).then(
        () => toast("已複製回答"),
        () => toast("複製失敗"),
      );
      break;

    case "edit": {
      els.input.value = conv.messages[index].text;
      autoGrow();
      els.input.focus();
      // The edited message replaces this turn and everything after it.
      els.composer.dataset.replaceFrom = id;
      toast("編輯後按 Enter 會重送這則訊息");
      break;
    }

    case "regenerate": {
      // Re-run from the user turn that produced this answer.
      const userTurn = conv.messages[index - 1];
      if (!userTurn || userTurn.role !== "user") {
        toast("找不到對應的提問");
        return;
      }
      await truncateAndResend(userTurn.id, userTurn.text);
      break;
    }
  }
});

/* ---------- composer ---------- */

function autoGrow() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(els.input.scrollHeight, 200)}px`;
}

els.input.addEventListener("input", autoGrow);

els.input.addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter and IME composition insert a newline.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.inflight) return;
  const text = els.input.value.trim();
  if (!text && state.pending.length === 0) return;

  els.input.value = "";
  autoGrow();

  const replaceFrom = els.composer.dataset.replaceFrom;
  delete els.composer.dataset.replaceFrom;
  if (replaceFrom) {
    await truncateAndResend(replaceFrom, text);
    return;
  }
  await sendMessage(text);
});

els.stop.addEventListener("click", () => {
  state.inflight?.abort();
  toast("已停止生成");
});

els.attachBtn.addEventListener("click", () => els.fileInput.click());

els.fileInput.addEventListener("change", async () => {
  await stageFiles(Array.from(els.fileInput.files ?? []));
  els.fileInput.value = "";
});

els.attachments.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-index]");
  if (!btn) return;
  state.pending.splice(Number(btn.dataset.index), 1);
  renderPending();
});

// Paste and drag-drop are the two ways people actually attach screenshots.
els.input.addEventListener("paste", async (event) => {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length) {
    event.preventDefault();
    await stageFiles(files);
  }
});

for (const type of ["dragover", "drop"]) {
  document.addEventListener(type, (event) => event.preventDefault());
}
document.addEventListener("drop", async (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) await stageFiles(files);
});

els.suggestions.addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-prompt]");
  if (!btn) return;
  els.input.value = btn.dataset.prompt;
  autoGrow();
  els.composer.requestSubmit();
});

/* ---------- sidebar / settings ---------- */

const closeSidebarOnMobile = () => els.app.classList.remove("sidebar-open");

els.newChat.addEventListener("click", () => {
  startNewChat();
  closeSidebarOnMobile();
});
$("sidebar-open").addEventListener("click", () => els.app.classList.add("sidebar-open"));
$("sidebar-close").addEventListener("click", closeSidebarOnMobile);

function openSettings() {
  const settings = state.conversation?.settings ?? state.settings;
  els.modelSelect.value = settings.model;
  els.effortSelect.value = settings.effort;
  els.webSearch.checked = settings.webSearch;
  els.showThinking.checked = settings.showThinking;
  els.customInstructions.value = settings.customInstructions ?? "";
  syncModelBlurb();
  els.modal.hidden = false;
}

function syncModelBlurb() {
  const model = state.config.models.find((m) => m.id === els.modelSelect.value);
  els.modelBlurb.textContent = model?.blurb ?? "";
  els.effortSelect.disabled = !model?.supportsEffort;
  els.showThinking.disabled = !model?.supportsThinking;
}

$("open-settings").addEventListener("click", openSettings);
$("top-settings").addEventListener("click", openSettings);
$("settings-close").addEventListener("click", () => (els.modal.hidden = true));
els.modal.addEventListener("click", (event) => {
  if (event.target === els.modal) els.modal.hidden = true;
});
els.modelSelect.addEventListener("change", syncModelBlurb);

$("settings-save").addEventListener("click", async () => {
  const settings = {
    model: els.modelSelect.value,
    effort: els.effortSelect.value,
    webSearch: els.webSearch.checked,
    showThinking: els.showThinking.checked,
    customInstructions: els.customInstructions.value.trim(),
  };
  state.settings = settings;
  localStorage.setItem("sgpt.settings", JSON.stringify(settings));
  if (state.conversation) {
    try {
      state.conversation = await api(`/api/conversations/${state.conversation.id}`, {
        method: "PATCH",
        body: JSON.stringify({ settings }),
      });
    } catch (err) {
      toast(`設定沒存起來：${err.message}`);
    }
  }
  updateModelChip();
  els.modal.hidden = true;
  toast("設定已更新");
});

$("delete-chat").addEventListener("click", async () => {
  if (!state.conversation) {
    els.modal.hidden = true;
    return;
  }
  if (!confirm("確定要刪除這個對話？")) return;
  await api(`/api/conversations/${state.conversation.id}`, { method: "DELETE" });
  els.modal.hidden = true;
  startNewChat();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    els.modal.hidden = true;
    closeSidebarOnMobile();
  }
  // Ctrl/Cmd+K starts a fresh chat, same as most chat apps.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    startNewChat();
  }
});

/* ---------- boot ---------- */

async function boot() {
  state.config = await api("/api/config");

  els.modelSelect.innerHTML = state.config.models
    .map((m) => `<option value="${m.id}">${escapeHtml(m.label)}</option>`)
    .join("");
  els.effortSelect.innerHTML = state.config.efforts
    .map((e) => `<option value="${e}">${e}</option>`)
    .join("");

  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem("sgpt.settings") ?? "null");
  } catch {
    // A corrupt preference should not block startup.
  }
  state.settings = { ...state.config.defaults, ...(saved ?? {}) };
  // A stale saved model (renamed or removed) must not break the picker.
  if (!state.config.models.some((m) => m.id === state.settings.model)) {
    state.settings.model = state.config.defaults.model;
  }

  if (!state.config.apiKeyConfigured) {
    toast("尚未設定 ANTHROPIC_API_KEY，請看 README 的設定步驟。", 8000);
  }

  renderConversation();
  await refreshSidebar();
  els.input.focus();
}

boot().catch((err) => {
  toast(`啟動失敗：${err.message}`, 8000);
});
