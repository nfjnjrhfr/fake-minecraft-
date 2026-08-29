// 網頁前端：把 /api/chat 的 SSE 串流畫成對話。
const $ = (id) => document.getElementById(id);
const log = $('log');
const sessionId = Math.random().toString(36).slice(2);
let busy = false;
const usage = { input: 0, output: 0 };

const EXAMPLES = [
  '讓挖礦 AI 玩三回合，講評一下',
  '問 mini-GPT 它是誰',
  '這個 repo 的注意力是怎麼實作的？',
  'DQN 跟 Transformer 差在哪',
];

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** 很簡單的 markdown：程式碼區塊、行內程式碼、粗體 */
function render(text) {
  return escapeHtml(text)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code}</code></pre>`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

function addMsg(who, cls) {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = `<span class="who">${who}</span><span class="bubble"></span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

function scroll() {
  log.scrollTop = log.scrollHeight;
}

async function ask(text) {
  addMsg('你', 'me').querySelector('.bubble').textContent = text;
  const aiMsg = addMsg('Claude', 'ai');
  const bubble = aiMsg.querySelector('.bubble');
  let answer = '';
  let thinkEl = null;

  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!res.ok || !res.body) {
    bubble.textContent = `（伺服器回應 ${res.status}）`;
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const ev = JSON.parse(line.slice(6));

      if (ev.type === 'text') {
        answer += ev.text;
        bubble.innerHTML = render(answer);
        scroll();
      } else if (ev.type === 'thinking') {
        if (!$('thinking').checked) continue;
        if (!thinkEl) {
          thinkEl = document.createElement('div');
          thinkEl.className = 'think';
          aiMsg.insertBefore(thinkEl, bubble);
        }
        thinkEl.textContent += ev.text;
        scroll();
      } else if (ev.type === 'tool') {
        const chip = document.createElement('div');
        chip.className = 'tool';
        chip.textContent = `⚙ 呼叫工具 ${ev.name}(${JSON.stringify(ev.input)})`;
        aiMsg.insertBefore(chip, bubble);
        thinkEl = null;
        scroll();
      } else if (ev.type === 'refusal') {
        bubble.innerHTML += `<br /><i>（這次請求被拒絕：${ev.category ?? '未說明'}）</i>`;
      } else if (ev.type === 'error') {
        bubble.innerHTML += `<br /><i>${escapeHtml(ev.message)}</i>`;
      } else if (ev.type === 'done') {
        usage.input += ev.usage?.input ?? 0;
        usage.output += ev.usage?.output ?? 0;
        $('s-in').textContent = usage.input.toLocaleString();
        $('s-out').textContent = usage.output.toLocaleString();
      }
    }
  }
  if (!answer && !thinkEl) bubble.textContent = '（沒有回應）';
}

async function boot() {
  try {
    const info = await (await fetch('/api/info')).json();
    $('s-model').textContent = info.model;
    $('tools').innerHTML = info.tools
      .map((t) => `<div><b>${t.name}</b> — ${escapeHtml(t.description.slice(0, 60))}…</div>`)
      .join('');
    $('input').disabled = false;
    $('send').disabled = false;
    $('input').placeholder = '問點什麼…';
    $('hint').textContent = '提示：叫它去用工具，你會看到它實際去跑另外兩個 AI。';
    $('chips').innerHTML = EXAMPLES.map((e) => `<span class="chip">${e}</span>`).join('');
    document.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        $('input').value = c.textContent;
        $('form').requestSubmit();
      })
    );
  } catch (err) {
    $('hint').textContent = `連不上伺服器：${err.message}（請跑 npm run claude:web）`;
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || busy) return;
  busy = true;
  $('send').disabled = true;
  $('input').value = '';
  try {
    await ask(text);
  } catch (err) {
    addMsg('系統', 'ai').querySelector('.bubble').textContent = `錯誤：${err.message}`;
  }
  busy = false;
  $('send').disabled = false;
  $('input').focus();
});

$('clear').onclick = async () => {
  log.innerHTML = '';
  await fetch(`/api/reset?session=${sessionId}`, { method: 'POST' });
};

boot();
