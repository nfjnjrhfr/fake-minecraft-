// 瀏覽器端：一邊訓練一邊把 AI 的世界、學習曲線、Q 值畫出來。
import { MiniCraftEnv, TILE, ACTIONS } from '../src/env.js';
import { DQNAgent } from '../src/agent.js';

const $ = (id) => document.getElementById(id);
const worldCv = $('world');
const wctx = worldCv.getContext('2d');
const chartCv = $('chart');
const cctx = chartCv.getContext('2d');

const COLORS = {
  [TILE.AIR]: '#20242f',
  [TILE.BEDROCK]: '#4d556b',
  [TILE.WOOD]: '#8a5a2b',
  [TILE.STONE]: '#8b8b95',
  [TILE.DIAMOND]: '#3fe0cf',
  [TILE.LAVA]: '#e0561e',
};

let env, agent, obs, state;

function boot() {
  env = new MiniCraftEnv({ seed: (Math.random() * 1e9) | 0 });
  agent = new DQNAgent(env.obsSize, env.numActions, { seed: (Math.random() * 1e9) | 0 });
  obs = Float64Array.from(env.reset());
  state = {
    running: false,
    episode: 0,
    epReward: 0,
    window: [],
    curve: [],
    best: -Infinity,
    lastTick: performance.now(),
    stepsAtTick: 0,
    sps: 0,
  };
  buildQBars();
  draw();
  updateStats();
  drawChart();
  $('status').textContent = '尚未開始 — 按「開始訓練」讓 AI 從零開始摸索';
}

function buildQBars() {
  $('qbars').innerHTML = ACTIONS.map(
    (name, i) => `
    <div class="qbar" id="qb${i}">
      <span>${name}</span>
      <span class="qtrack"><span class="qfill" style="width:0%"></span></span>
      <span class="qval">0.00</span>
    </div>`
  ).join('');
}

/** 走一個環境步：選動作 → 互動 → 存經驗 → 學習 */
function stepOnce() {
  const greedy = $('greedy').checked;
  const a = agent.act(obs, greedy);
  const out = env.step(a);
  const next = Float64Array.from(out.obs);
  if (!greedy) {
    agent.remember(obs, a, out.reward, next, out.done);
    agent.maybeLearn();
  }
  obs = next;
  state.epReward += out.reward;

  if (out.done) {
    state.episode++;
    state.window.push(state.epReward);
    if (state.window.length > 100) state.window.shift();
    const avg = state.window.reduce((s, v) => s + v, 0) / state.window.length;
    if (state.window.length >= 20 && avg > state.best) state.best = avg;
    state.curve.push(avg);
    if (state.curve.length > 4000) state.curve.shift();
    state.epReward = 0;
    obs = Float64Array.from(env.reset());
  }
}

function loop() {
  if (!state.running) return;
  const n = Number($('speed').value);
  const turbo = $('turbo').checked;
  const batch = turbo ? n * 20 : n;
  for (let i = 0; i < batch; i++) stepOnce();

  const now = performance.now();
  if (now - state.lastTick > 500) {
    state.sps = Math.round(((agent.steps - state.stepsAtTick) * 1000) / (now - state.lastTick));
    state.lastTick = now;
    state.stepsAtTick = agent.steps;
  }

  draw();
  updateStats();
  drawChart();
  requestAnimationFrame(loop);
}

function draw() {
  const { width, height } = env.cfg;
  const cell = Math.floor(worldCv.width / width);
  wctx.fillStyle = '#14161d';
  wctx.fillRect(0, 0, worldCv.width, worldCv.height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = env.get(x, y);
      const px = x * cell;
      const py = y * cell;
      wctx.fillStyle = COLORS[t];
      wctx.fillRect(px, py, cell - 1, cell - 1);
      if (t === TILE.DIAMOND) {
        wctx.fillStyle = 'rgba(255,255,255,.55)';
        wctx.fillRect(px + cell * 0.3, py + cell * 0.25, cell * 0.18, cell * 0.18);
      } else if (t === TILE.LAVA) {
        wctx.fillStyle = 'rgba(255,220,80,.5)';
        wctx.fillRect(px + cell * 0.25, py + cell * 0.45, cell * 0.5, cell * 0.16);
      } else if (t === TILE.WOOD) {
        wctx.fillStyle = 'rgba(0,0,0,.22)';
        wctx.fillRect(px, py + cell * 0.42, cell - 1, cell * 0.16);
      }
    }
  }

  // AI 的 5x5 視野範圍
  wctx.strokeStyle = 'rgba(106,169,255,.35)';
  wctx.lineWidth = 1;
  wctx.strokeRect((env.px - 2) * cell, (env.py - 2) * cell, cell * 5 - 1, cell * 5 - 1);

  // AI 本體與面向
  const ax = env.px * cell;
  const ay = env.py * cell;
  wctx.fillStyle = '#f2d16b';
  wctx.fillRect(ax + 2, ay + 2, cell - 5, cell - 5);
  wctx.fillStyle = '#14161d';
  const d = [[0, -1], [1, 0], [0, 1], [-1, 0]][env.facing];
  wctx.fillRect(
    ax + cell / 2 - 2 + (d[0] * cell) / 3,
    ay + cell / 2 - 2 + (d[1] * cell) / 3,
    5,
    5
  );
}

function drawChart() {
  const w = chartCv.width;
  const h = chartCv.height;
  cctx.fillStyle = '#14161d';
  cctx.fillRect(0, 0, w, h);
  const data = state.curve;
  cctx.strokeStyle = '#2c3142';
  cctx.beginPath();
  cctx.moveTo(0, h / 2);
  cctx.lineTo(w, h / 2);
  cctx.stroke();
  if (data.length < 2) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (const v of data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < 1) {
    hi += 0.5;
    lo -= 0.5;
  }
  const pad = 6;
  const X = (i) => (i / (data.length - 1)) * (w - 2 * pad) + pad;
  const Y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);

  cctx.strokeStyle = '#55d6a0';
  cctx.lineWidth = 2;
  cctx.beginPath();
  data.forEach((v, i) => (i ? cctx.lineTo(X(i), Y(v)) : cctx.moveTo(X(i), Y(v))));
  cctx.stroke();

  cctx.fillStyle = '#9aa3bd';
  cctx.font = '11px monospace';
  cctx.fillText(hi.toFixed(1), 4, 12);
  cctx.fillText(lo.toFixed(1), 4, h - 4);
}

function updateStats() {
  const avg = state.window.length
    ? state.window.reduce((s, v) => s + v, 0) / state.window.length
    : null;
  $('s-ep').textContent = state.episode;
  $('s-steps').textContent = agent.steps.toLocaleString();
  $('s-eps').textContent = ($('greedy').checked ? 0 : agent.epsilon).toFixed(3);
  $('s-r').textContent = state.epReward.toFixed(2);
  $('s-avg').textContent = avg === null ? '—' : avg.toFixed(2);
  $('s-best').textContent = state.best === -Infinity ? '—' : state.best.toFixed(2);
  $('s-loss').textContent = agent.lastLoss ? agent.lastLoss.toFixed(4) : '—';
  $('s-buf').textContent = agent.buffer.size.toLocaleString();
  $('s-sps').textContent = `${state.sps.toLocaleString()} 步/秒`;

  const q = agent.lastQ;
  if (q) {
    let lo = Math.min(...q);
    let hi = Math.max(...q);
    if (hi - lo < 1e-6) hi = lo + 1e-6;
    let best = 0;
    for (let i = 1; i < q.length; i++) if (q[i] > q[best]) best = i;
    for (let i = 0; i < q.length; i++) {
      const row = $('qb' + i);
      row.classList.toggle('best', i === best);
      row.querySelector('.qfill').style.width = `${((q[i] - lo) / (hi - lo)) * 100}%`;
      row.querySelector('.qval').textContent = q[i].toFixed(2);
    }
  }

  const inv = env.inventory;
  $('status').textContent =
    `步數 ${env.steps}/${env.cfg.maxSteps}　採集分數 ${env.score}　` +
    `木 ${inv.wood} 石 ${inv.stone} 鑽 ${inv.diamond}　剩餘礦物 ${env.oresLeft}　${env.lastEvent}`;
}

$('toggle').onclick = () => {
  state.running = !state.running;
  $('toggle').textContent = state.running ? '暫停' : '繼續訓練';
  if (state.running) {
    state.lastTick = performance.now();
    state.stepsAtTick = agent.steps;
    requestAnimationFrame(loop);
  }
};
$('reset').onclick = () => {
  boot();
  $('toggle').textContent = '開始訓練';
};
$('speed').oninput = () => ($('speedVal').textContent = $('speed').value);
$('save').onclick = () => {
  const blob = new Blob([JSON.stringify(agent.toJSON())], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `minicraft-agent-ep${state.episode}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};
$('pretrained').onclick = async () => {
  try {
    const res = await fetch('./models/agent.json');
    if (!res.ok) throw new Error('找不到 models/agent.json，請先跑 npm run train');
    agent.loadWeights(await res.json());
    $('greedy').checked = true;
    updateStats();
    $('status').textContent =
      `已載入預訓練模型（訓練過 ${agent.steps.toLocaleString()} 步）—— 按「開始訓練」即可觀賞它挖礦`;
  } catch (err) {
    $('status').textContent = `載入失敗：${err.message}`;
  }
};
$('load').onclick = () => $('file').click();
$('file').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const obj = JSON.parse(await f.text());
    agent.loadWeights(obj);
    updateStats();
    $('status').textContent = `已載入模型（訓練過 ${agent.steps.toLocaleString()} 步）—— 打開展示模式看看它學到什麼`;
  } catch (err) {
    $('status').textContent = `載入失敗：${err.message}`;
  }
  e.target.value = '';
};

boot();
