// 瀏覽器端聊天：模型在你的分頁裡一個字一個字算出來，沒有任何後端。
import { GPT, sampleFrom } from '../src/gpt/model.js';
import { CharTokenizer } from '../src/gpt/tokenizer.js';
import { buildPrompt } from '../src/gpt/infer.js';

const $ = (id) => document.getElementById(id);
const log = $('log');
let model = null;
let tok = null;
let busy = false;

const EXAMPLES = ['你好', '你是誰', '你會做什麼', '挖到鑽石有幾分', '岩漿危險嗎',
  '三加四等於多少', '八和五哪個大', '天空是什麼顏色', '什麼是神經網路'];

function addMsg(who, cls, text = '') {
  const div = document.createElement('div');
  div.className = `msg ${cls}`;
  div.innerHTML = `<span class="who">${who}</span><span class="bubble"></span>`;
  div.querySelector('.bubble').textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div.querySelector('.bubble');
}

function showProbs(list) {
  $('probs').innerHTML = list
    .map(
      (p) => `<div class="prob">
        <span class="ch">${p.char === '\n' ? '⏎' : p.char}</span>
        <span class="track"><span class="fill" style="width:${(p.prob * 100).toFixed(1)}%"></span></span>
        <span class="pct">${(p.prob * 100).toFixed(1)}%</span>
      </div>`
    )
    .join('');
}

const sleep = () => new Promise((r) => requestAnimationFrame(r));

/** 自迴歸生成：每產生一個字就更新畫面，等於自己實作了「串流輸出」 */
async function generate(question) {
  const V = model.cfg.vocabSize;
  const temperature = Number($('temp').value) / 100;
  const topP = Number($('topp').value) / 100;
  const nl = tok.stoi.get('\n');
  let ids = Array.from(tok.encode(buildPrompt(question)));

  const bubble = addMsg('小方塊：', 'ai');
  const caret = document.createElement('span');
  caret.className = 'caret';
  caret.textContent = ' ';
  bubble.after(caret);

  let text = '';
  const t0 = performance.now();
  let n = 0;
  for (; n < 40; n++) {
    const ctx = ids.slice(Math.max(0, ids.length - model.cfg.blockSize));
    const { logits } = model.forward(Int32Array.from(ctx), 1, ctx.length);
    const off = (ctx.length - 1) * V;

    // 先看看原始機率分佈（不受溫度影響，純粹是模型的想法）
    const raw = new Float64Array(V);
    let maxv = -Infinity;
    for (let j = 0; j < V; j++) if (logits.data[off + j] > maxv) maxv = logits.data[off + j];
    let sum = 0;
    for (let j = 0; j < V; j++) { raw[j] = Math.exp(logits.data[off + j] - maxv); sum += raw[j]; }
    const top = Array.from({ length: V }, (_, i) => i)
      .sort((a, b) => raw[b] - raw[a])
      .slice(0, 8)
      .map((i) => ({ char: tok.itos[i], prob: raw[i] / sum }));
    showProbs(top);

    const scaled = new Float64Array(V);
    for (let j = 0; j < V; j++) scaled[j] = logits.data[off + j] / Math.max(0.01, temperature);
    const next = sampleFrom(scaled, 0, topP, Math.random);
    if (next === nl) break;
    ids.push(next);
    text += tok.itos[next];
    bubble.textContent = text;
    log.scrollTop = log.scrollHeight;
    await sleep();
  }
  caret.remove();
  const ms = performance.now() - t0;
  $('m-speed').textContent = `${(n / (ms / 1000)).toFixed(1)} 字/秒`;
  if (!text) bubble.textContent = '（它說不出話）';
}

async function boot() {
  try {
    const res = await fetch('./models/gpt.json');
    if (!res.ok) throw new Error('找不到 models/gpt.json，請先跑 npm run gpt:train');
    const saved = await res.json();
    model = GPT.fromJSON(saved.model);
    tok = CharTokenizer.fromJSON(saved.tokenizer);

    $('m-params').textContent = `${(model.numParams / 1000).toFixed(0)}k`;
    $('m-layer').textContent = model.cfg.nLayer;
    $('m-head').textContent = model.cfg.nHead;
    $('m-embd').textContent = model.cfg.nEmbd;
    $('m-block').textContent = `${model.cfg.blockSize} 個字`;
    $('m-vocab').textContent = `${tok.vocabSize} 個字`;
    $('input').disabled = false;
    $('send').disabled = false;
    $('input').placeholder = '問它一句話…';
    $('hint').textContent = '提示：它只學過一份很小的中文語料，會的東西不多，但每個字都是自己算出來的。';
    addMsg('小方塊：', 'ai', '你好，我是小方塊。');
    $('chips').innerHTML = EXAMPLES.map((e) => `<span class="chip">${e}</span>`).join('');
    document.querySelectorAll('.chip').forEach((c) =>
      c.addEventListener('click', () => {
        $('input').value = c.textContent;
        $('form').requestSubmit();
      })
    );
  } catch (err) {
    $('hint').textContent = `載入失敗：${err.message}`;
  }
}

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('input').value.trim();
  if (!q || busy || !model) return;
  busy = true;
  $('send').disabled = true;
  $('input').value = '';
  addMsg('你：', 'me', q);
  await generate(q);
  busy = false;
  $('send').disabled = false;
  $('input').focus();
});
$('clear').onclick = () => (log.innerHTML = '');
$('temp').oninput = () => ($('tempV').textContent = (Number($('temp').value) / 100).toFixed(2));
$('topp').oninput = () => ($('toppV').textContent = (Number($('topp').value) / 100).toFixed(2));

boot();
