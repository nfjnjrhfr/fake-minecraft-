// 進入點：把選單、輸入、渲染與遊戲邏輯接起來。

import { Renderer } from './core/renderer.js';
import { Match, MATCH_MODE } from './game/match.js';
import { Fighter, emptyInput, CODE_BY_ATTACK } from './game/fighter.js';
import { drawRig } from './game/rig.js';
import {
  LOADOUT_PRESETS, MATERIALS, ARMOR_SLOTS, WEAPONS, OFFHANDS,
  WEAPON_KEYS, OFFHAND_KEYS, MATERIAL_KEYS, buildLoadout,
} from './game/equipment.js';
import { DIFFICULTIES, STYLES } from './game/ai.js';
import { ROUND_STATE } from './net/protocol.js';
import {
  BluetoothTransport, ChannelTransport, WebRTCTransport, STATUS,
} from './net/transport.js';
import { NetSession } from './net/netgame.js';
import { clamp } from './core/math.js';

const $ = (id) => document.getElementById(id);

/** structuredClone 的安全版：iOS 15.4 之前沒有這個 API，配裝是純 JSON 所以退回 JSON 拷貝即可。 */
const deepClone = (o) => (typeof structuredClone === 'function'
  ? structuredClone(o) : JSON.parse(JSON.stringify(o)));
const canvas = $('view');
const renderer = new Renderer(canvas);

// ---------------------------------------------------------------------------
// 全域狀態
// ---------------------------------------------------------------------------

const app = {
  match: null,
  session: null,
  transport: null,
  running: false,
  paused: false,
  lastTime: 0,
  mode: 'solo',
  showAiPanel: true,
  transportKind: 'bluetooth',
  netRole: 'host',
  settings: {
    difficulty: 'hard',
    aiStyle: 'balanced',
    enemyPreset: 'duelist',
    bestOf: 3,
    playerName: '玩家',
  },
  loadout: deepClone(LOADOUT_PRESETS.knight),
  wallet: { coins: 0 },
};

// 讀回上次的設定
try {
  const saved = JSON.parse(localStorage.getItem('blade-duel') || 'null');
  if (saved?.loadout) Object.assign(app.loadout, saved.loadout);
  if (saved?.settings) Object.assign(app.settings, saved.settings);
  if (Number.isFinite(saved?.wallet?.coins)) app.wallet.coins = Math.max(0, saved.wallet.coins);
} catch { /* 存檔壞了就用預設 */ }

function save() {
  try {
    localStorage.setItem('blade-duel', JSON.stringify({
      loadout: app.loadout, settings: app.settings, wallet: app.wallet,
    }));
  } catch { /* 無痕模式等情況，存不了就算了 */ }
}

// ---------------------------------------------------------------------------
// 畫布尺寸
// ---------------------------------------------------------------------------

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  renderer.resize(window.innerWidth, window.innerHeight, dpr);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
resize();

const isTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches
  || navigator.maxTouchPoints > 0;
if (isTouch) document.body.classList.add('touch');

// ---------------------------------------------------------------------------
// 輸入
// ---------------------------------------------------------------------------

const keys = new Set();
const pressedThisFrame = new Set();   // 這一幀新按下的鍵（攻擊只吃邊緣觸發）
const touchState = { active: false, dx: 0, dz: 0, block: false, queued: 0, dodge: false };

const KEY_ATTACK = {
  KeyJ: 'slashR', KeyQ: 'slashL', KeyE: 'overhead', KeyF: 'thrust', KeyR: 'bash',
};

window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'Escape') { togglePause(); return; }
  // 選單開著的時候不要吃掉輸入框的按鍵
  if (!app.running || app.paused) return;
  if (!keys.has(e.code)) pressedThisFrame.add(e.code);
  keys.add(e.code);
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (!app.running || app.paused) return;
  if (e.button === 0) pressedThisFrame.add('Mouse0');
  if (e.button === 2) keys.add('Mouse2');
  if (e.button === 1) pressedThisFrame.add('Mouse1');
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 2) keys.delete('Mouse2');
});

// --- 觸控搖桿 ---
const stick = $('stick');
const knob = $('stick-knob');
let stickId = null, stickOrigin = { x: 0, y: 0 };

stick.addEventListener('pointerdown', (e) => {
  stickId = e.pointerId;
  stick.setPointerCapture(e.pointerId);
  const r = stick.getBoundingClientRect();
  stickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  updateStick(e);
});
stick.addEventListener('pointermove', (e) => {
  if (e.pointerId === stickId) updateStick(e);
});
const endStick = (e) => {
  if (e.pointerId !== stickId) return;
  stickId = null;
  touchState.dx = touchState.dz = 0;
  knob.style.transform = '';
};
stick.addEventListener('pointerup', endStick);
stick.addEventListener('pointercancel', endStick);

function updateStick(e) {
  const max = 48;
  let dx = e.clientX - stickOrigin.x;
  let dy = e.clientY - stickOrigin.y;
  const len = Math.hypot(dx, dy);
  if (len > max) { dx = dx / len * max; dy = dy / len * max; }
  knob.style.transform = `translate(${dx}px, ${dy}px)`;
  touchState.dx = dx / max;
  touchState.dz = -dy / max;   // 螢幕往上 = 往前
}

for (const btn of document.querySelectorAll('.tb')) {
  const act = btn.dataset.act;
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    btn.classList.add('on');
    if (act === 'block') touchState.block = true;
    else if (act === 'dodge') touchState.dodge = true;
    else touchState.queued = CODE_BY_ATTACK[act] || 0;
  });
  const release = () => {
    btn.classList.remove('on');
    if (act === 'block') touchState.block = false;
  };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('pointerleave', release);
}

/** 組出這一幀的本地輸入（鍵盤 + 觸控合併）。 */
function gatherInput() {
  const inp = emptyInput();
  let f = 0, r = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  f += touchState.dz;
  r += touchState.dx;

  // 移動是相對鏡頭的：鏡頭永遠在玩家背後看向對手，所以 W 就是往對手走
  const yaw = app.match ? app.match.camera.yaw : 0;
  inp.moveX = f * Math.sin(yaw) + r * Math.cos(yaw);
  inp.moveZ = f * Math.cos(yaw) - r * Math.sin(yaw);
  const len = Math.hypot(inp.moveX, inp.moveZ);
  if (len > 1) { inp.moveX /= len; inp.moveZ /= len; }

  for (const [code, move] of Object.entries(KEY_ATTACK)) {
    if (pressedThisFrame.has(code)) inp.attack = CODE_BY_ATTACK[move];
  }
  if (pressedThisFrame.has('Mouse0')) inp.attack = CODE_BY_ATTACK.slashR;
  if (pressedThisFrame.has('Mouse1')) inp.attack = CODE_BY_ATTACK.overhead;
  if (touchState.queued) { inp.attack = touchState.queued; touchState.queued = 0; }

  inp.block = keys.has('KeyK') || keys.has('Mouse2') || touchState.block;
  inp.dodge = pressedThisFrame.has('ShiftLeft') || pressedThisFrame.has('ShiftRight') || touchState.dodge;
  inp.jump = pressedThisFrame.has('Space');

  touchState.dodge = false;
  pressedThisFrame.clear();
  return inp;
}

// ---------------------------------------------------------------------------
// 裝備工坊的試衣間:即時渲染「你自己」目前的配裝,會慢速旋轉
// ---------------------------------------------------------------------------

const previewCanvas = $('preview');
const previewRenderer = previewCanvas ? new Renderer(previewCanvas) : null;
let previewFighter = null;
let previewDirty = true;

function rebuildPreview() { previewDirty = true; }

function renderPreview(dt, now) {
  if (!previewRenderer) return;
  const page = document.querySelector('.page[data-page="loadout"]');
  if (menu.classList.contains('hidden') || !page?.classList.contains('active')) return;

  if (previewDirty) {
    previewDirty = false;
    previewFighter = new Fighter(0, deepClone(app.loadout), { name: 'preview' });
  }
  if (!previewFighter) return;

  // 內部解析度固定,CSS 負責縮放
  if (previewCanvas.width !== 560) previewRenderer.resize(280, 190, 2);

  const f = previewFighter;
  f.yaw = now / 1400;                       // 慢速旋轉展示
  f.update(emptyInput(), dt, null);         // 待機呼吸動作

  const r = previewRenderer;
  r.begin();
  const ang = 0;                            // 相機固定,角色自轉
  r.setCamera({ x: Math.sin(ang) * 3.6, y: 1.75, z: Math.cos(ang) * 3.6 }, { x: 0, y: 1.05, z: 0 });
  r.pushShadow(f.x, f.z, 0.55, 0.3);
  drawRig(f.rig, r, {});
  r.end({ skyTop: '#0a0f1c', skyMid: '#141f36', skyBottom: '#1c1626', groundSize: 8, groundStep: 1 });
}

// ---------------------------------------------------------------------------
// 選單
// ---------------------------------------------------------------------------

const menu = $('menu');
const hud = $('hud');

function updateCoinBadge() {
  const el = $('coin-count');
  if (el) el.textContent = app.wallet.coins;
}

/** 把這一場掉的金幣結進錢包（只結一次）。 */
function bankCoins() {
  const m = app.match;
  if (!m || m.coinsBanked || !m.coinsEarned) return;
  m.coinsBanked = true;
  app.wallet.coins += m.coinsEarned;
  save();
  updateCoinBadge();
}

function showPage(name) {
  for (const p of document.querySelectorAll('.page')) {
    p.classList.toggle('active', p.dataset.page === name);
  }
  menu.classList.remove('hidden');
  menu.scrollTop = 0;
  updateCoinBadge();
  if (name === 'solo') updateMyLoadoutSummary();
}

/** 單機頁頂端的「你的裝備」一行摘要。 */
function updateMyLoadoutSummary() {
  const el = $('my-loadout-summary');
  if (!el) return;
  const l = buildLoadout(app.loadout);
  const armorCount = Object.keys(l.pieces).length;
  el.textContent = `${l.weapon.name}`
    + (l.offhand.kind === 'shield' ? ` + ${l.offhand.name}` : '')
    + ` · 護甲 ${armorCount}/8 件 · 防禦 ${l.ratingDefense} · ${l.weight.toFixed(1)}kg`;
}

function hideMenu() {
  menu.classList.add('hidden');
}

for (const el of document.querySelectorAll('[data-go]')) {
  el.addEventListener('click', () => {
    const to = el.dataset.go;
    if (to === 'demo') { startDemo(false); return; }
    showPage(to);
  });
}

/** 產生一組單選 chip。 */
function buildChips(container, items, getSelected, onSelect) {
  container.innerHTML = '';
  for (const item of items) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.innerHTML = item.sub ? `${item.label}<small>${item.sub}</small>` : item.label;
    b.classList.toggle('on', item.key === getSelected());
    b.addEventListener('click', () => {
      onSelect(item.key);
      for (const c of container.children) c.classList.remove('on');
      b.classList.add('on');
    });
    container.appendChild(b);
  }
}

// --- 單機設定 ---
buildChips($('difficulty-chips'),
  Object.entries(DIFFICULTIES).map(([key, d]) => ({
    key, label: d.name, sub: `反應 ${Math.round(d.reaction * 1000)}ms · 掉 ${d.bounty} 金幣`,
  })),
  () => app.settings.difficulty,
  (k) => { app.settings.difficulty = k; updateDifficultyHint(); save(); });

const DIFF_HINTS = {
  rookie: '反應很慢、常常失誤，適合熟悉操作與招式。',
  normal: '會格擋也會反擊，開始抓你的破綻。',
  hard: '主動預判、懂得控制距離，招架成功率不低。',
  master: '幾乎不失誤，會用假動作騙你的盾，體力管理精準。',
  singular: '反應 100ms、全力建模你的習慣：你連續用同一招會被直接讀死，落後時還會自動加壓。',
};
function updateDifficultyHint() {
  $('difficulty-hint').textContent = DIFF_HINTS[app.settings.difficulty] || '';
}
updateDifficultyHint();

buildChips($('style-chips'),
  Object.entries(STYLES).map(([key, s]) => ({ key, label: s.name })),
  () => app.settings.aiStyle,
  (k) => { app.settings.aiStyle = k; save(); });

buildChips($('enemy-preset-chips'),
  Object.entries(LOADOUT_PRESETS).map(([key, p]) => ({ key, label: p.name })),
  () => app.settings.enemyPreset,
  (k) => { app.settings.enemyPreset = k; save(); });

buildChips($('bestof-chips'),
  [{ key: 1, label: '單場定勝負' }, { key: 3, label: '三戰兩勝' }, { key: 5, label: '五戰三勝' }],
  () => app.settings.bestOf,
  (k) => { app.settings.bestOf = k; save(); });

$('show-ai-panel').checked = app.showAiPanel;
$('show-ai-panel').addEventListener('change', (e) => { app.showAiPanel = e.target.checked; });

$('start-solo').addEventListener('click', startSolo);

// ---------------------------------------------------------------------------
// 裝備工坊
// ---------------------------------------------------------------------------

const nameInput = $('player-name');
nameInput.value = app.settings.playerName;
nameInput.addEventListener('input', () => {
  app.settings.playerName = nameInput.value.trim() || '玩家';
  save();
});

buildChips($('preset-chips'),
  Object.entries(LOADOUT_PRESETS).map(([key, p]) => ({ key, label: p.name })),
  () => null,
  (k) => {
    app.loadout = deepClone(LOADOUT_PRESETS[k]);
    renderLoadoutEditor();
    save();
  });

function renderLoadoutEditor() {
  buildChips($('weapon-chips'),
    WEAPON_KEYS.map((key) => ({
      key, label: WEAPONS[key].name,
      sub: `傷${WEAPONS[key].damage} 長${WEAPONS[key].blade.length.toFixed(2)}m`,
    })),
    () => app.loadout.weapon,
    (k) => { app.loadout.weapon = k; updateStats(); save(); });

  buildChips($('offhand-chips'),
    OFFHAND_KEYS.map((key) => ({
      key, label: OFFHANDS[key].name,
      sub: OFFHANDS[key].kind === 'shield' ? `擋${Math.round(OFFHANDS[key].block * 100)}%` : '靈活',
    })),
    () => app.loadout.offhand,
    (k) => { app.loadout.offhand = k; updateStats(); save(); });

  // 護甲逐件
  const grid = $('armor-grid');
  grid.innerHTML = '';
  for (const [slot, spec] of Object.entries(ARMOR_SLOTS)) {
    const row = document.createElement('div');
    row.className = 'armor-row';
    const label = document.createElement('label');
    label.textContent = spec.name;
    const chips = document.createElement('div');
    chips.className = 'chips';
    row.append(label, chips);
    grid.appendChild(row);
    buildChips(chips,
      MATERIAL_KEYS.map((key) => ({ key, label: key === 'none' ? '無' : MATERIALS[key].name })),
      () => app.loadout.armor[slot] || 'none',
      (k) => {
        if (k === 'none') delete app.loadout.armor[slot];
        else app.loadout.armor[slot] = k;
        updateStats(); save();
      });
  }

  // 顏色
  const colors = $('color-row');
  colors.innerHTML = '';
  for (const [key, label] of [['skin', '膚色'], ['shirt', '上衣'], ['pants', '褲子'], ['cape', '披風']]) {
    const wrap = document.createElement('div');
    wrap.className = 'color-item';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = app.loadout.skin?.[key] || '#888888';
    input.addEventListener('input', () => {
      app.loadout.skin = app.loadout.skin || {};
      app.loadout.skin[key] = input.value;
      rebuildPreview();
      save();
    });
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(input, span);
    colors.appendChild(wrap);
  }

  updateStats();
}

function updateStats() {
  rebuildPreview();
  const l = buildLoadout(app.loadout);
  const rows = [
    ['攻擊力', clamp(l.ratingOffense / 40, 0, 1), l.ratingOffense],
    ['防禦力', clamp(l.ratingDefense / 40, 0, 1), l.ratingDefense],
    ['移動速度', clamp(l.moveMul, 0, 1.2) / 1.2, `${Math.round(l.moveMul * 100)}%`],
    ['出招速度', clamp(l.attackSpeed, 0, 1.5) / 1.5, `${Math.round(l.attackSpeed * 100)}%`],
    ['體力回復', clamp(l.staminaMul, 0, 1.2) / 1.2, `${Math.round(l.staminaMul * 100)}%`],
    ['總重量', clamp(l.weight / 22, 0, 1), `${l.weight.toFixed(1)}kg`],
  ];
  $('stat-box').innerHTML = rows.map(([name, ratio, val]) => `
    <div class="stat-row">
      <span>${name}</span>
      <div class="stat-meter${name === '總重量' ? ' warn' : ''}"><i style="width:${(ratio * 100).toFixed(0)}%"></i></div>
      <b>${val}</b>
    </div>`).join('') + `
    <div class="stat-row" style="margin-top:10px">
      <span>部位減傷</span>
      <b style="flex:1;text-align:right;font-size:10px;color:var(--dim)">
        頭 ${Math.round(l.partDefense.head * 100)}% ·
        身 ${Math.round(l.partDefense.torso * 100)}% ·
        臂 ${Math.round(l.partDefense.armR * 100)}% ·
        腿 ${Math.round(l.partDefense.legR * 100)}%
      </b>
    </div>`;
}
renderLoadoutEditor();

// ---------------------------------------------------------------------------
// 連線設定
// ---------------------------------------------------------------------------

// check() 回傳 { ok, detail }：不只說能不能用，還要說不能用的原因，
// 否則使用者只會看到「不支援」卻不知道下一步該做什麼。
const TRANSPORTS = [
  {
    key: 'bluetooth', label: '藍牙 BLE',
    check: () => {
      const a = BluetoothTransport.availability;
      return { ok: a.ok, detail: a.detail, short: a.ok ? '可用' : BT_SHORT[a.reason] };
    },
  },
  {
    key: 'webrtc', label: '同網路直連',
    check: () => ({
      ok: WebRTCTransport.available,
      short: WebRTCTransport.available ? '可用' : '此瀏覽器不支援',
      detail: WebRTCTransport.available ? null : '這個瀏覽器沒有 WebRTC。',
    }),
  },
  {
    key: 'channel', label: '同機雙分頁',
    check: () => ({
      ok: ChannelTransport.available,
      short: ChannelTransport.available ? '可用' : '此瀏覽器不支援',
      detail: ChannelTransport.available ? null : '這個瀏覽器沒有 BroadcastChannel。',
    }),
  },
];

const BT_SHORT = {
  unsupported: '瀏覽器不支援',
  insecure: '需要 HTTPS',
  blocked: '被沙箱擋下',
};

const TRANSPORT_HINTS = {
  bluetooth:
    '透過 Nordic UART Service 連上 BLE 裝置。瀏覽器只能當中央端（無法自己廣播），'
    + '所以兩台裝置要對戰時，需要一顆 BLE 中繼把封包轉發過去 —— '
    + 'tools/esp32-ble-relay 裡有現成的 ESP32 韌體，燒進去、兩邊都連上同一顆即可。'
    + '需要 Chrome / Edge，且網頁要走 HTTPS 或 localhost。',
  webrtc:
    '不需要伺服器：房主產生邀請碼，用任何方式（訊息、AirDrop、口頭念）傳給對方，'
    + '對方貼上後把回應碼傳回來即可。同一個 Wi-Fi 下延遲最低。',
  channel:
    '同一台裝置開兩個分頁或視窗，一邊選房主一邊選挑戰者，房間名稱填一樣。'
    + '適合先熟悉連線流程，或兩個人擠同一台電腦。',
};

buildChips($('transport-chips'),
  TRANSPORTS.map((t) => {
    const s = t.check();
    return { key: t.key, label: t.label, sub: s.short };
  }),
  () => app.transportKind,
  (k) => { app.transportKind = k; updateTransportUI(); });

buildChips($('role-chips'),
  [{ key: 'host', label: '房主（當裁判）' }, { key: 'guest', label: '挑戰者' }],
  () => app.netRole,
  (k) => { app.netRole = k; updateTransportUI(); });

function updateTransportUI() {
  const spec = TRANSPORTS.find((t) => t.key === app.transportKind);
  const state = spec ? spec.check() : { ok: true };
  // 不能用的話，先講為什麼不能用，再講這個管道本來是怎麼運作的
  $('transport-hint').textContent = state.ok
    ? TRANSPORT_HINTS[app.transportKind]
    : `${state.detail}\n\n（${TRANSPORT_HINTS[app.transportKind]}）`;
  $('transport-hint').classList.toggle('warn', !state.ok);
  $('connect-btn').disabled = !state.ok && app.transportKind !== 'webrtc';
  $('webrtc-box').classList.toggle('hidden', app.transportKind !== 'webrtc');
  $('channel-box').classList.toggle('hidden', app.transportKind !== 'channel');
  $('connect-btn').classList.toggle('hidden', app.transportKind === 'webrtc');
  if (app.transportKind === 'webrtc') updateWebRtcSteps();
}

/**
 * 依身分排好連線碼的兩個步驟。
 *
 * 兩邊的動作是互補的，所以「哪個框先做」是相反的。畫面順序一定要跟
 * 實際操作順序一致，而且兩種身分都必須有一顆看得到的按鈕可以按 ——
 * 之前挑戰者身分會讓唯一的按鈕整顆消失，等於卡死在這一頁。
 */
function updateWebRtcSteps() {
  const isHost = app.netRole === 'host';

  // 房主：先產生邀請碼（本地框）再收回應碼（遠端框）；挑戰者反過來
  $('step-local').style.order = isHost ? '1' : '2';
  $('step-remote').style.order = isHost ? '2' : '1';
  $('local-step-no').textContent = isHost ? '1' : '2';
  $('remote-step-no').textContent = isHost ? '2' : '1';

  $('code-label').textContent = isHost
    ? '產生邀請碼，用任何方式傳給對方'
    : '把這個回應碼傳回給房主，就完成了';
  $('remote-label').textContent = isHost
    ? '貼上對方回傳的回應碼'
    : '貼上房主給你的邀請碼';

  // 挑戰者不需要「產生邀請碼」——他的代碼是貼上邀請碼之後才生得出來，
  // 所以那顆按鈕收起來，改由下面的主要動作鍵負責。
  $('gen-code').classList.toggle('hidden', !isHost);
  $('local-code').placeholder = isHost
    ? '按下方的「產生邀請碼」' : '貼上邀請碼並送出後，這裡就會出現你的回應碼';

  const apply = $('apply-code');
  apply.textContent = isHost ? '完成連線' : '產生回應碼';
  apply.classList.toggle('primary', !isHost);   // 挑戰者的主要動作在這一顆
}
updateTransportUI();

function setConnStatus(text, kind = '') {
  const el = $('conn-status');
  el.textContent = text;
  el.className = 'conn-status' + (kind ? ' ' + kind : '');
}

$('connect-btn').addEventListener('click', async () => {
  try {
    let t;
    if (app.transportKind === 'bluetooth') {
      t = new BluetoothTransport();
      t.onStatus = (s, msg) => setConnStatus(msg, s === STATUS.CONNECTED ? 'ok' : s === STATUS.ERROR ? 'err' : '');
      await t.connect();
    } else if (app.transportKind === 'channel') {
      t = new ChannelTransport($('room-name').value.trim() || 'sword-duel');
      t.onStatus = (s, msg) => setConnStatus(msg, s === STATUS.CONNECTED ? 'ok' : '');
      await t.connect();
    }
    app.transport = t;
    prepareSession();
  } catch (err) {
    setConnStatus(`連線失敗：${err.message}`, 'err');
  }
});

$('gen-code').addEventListener('click', async () => {
  if (!WebRTCTransport.available) {
    return setConnStatus('這個瀏覽器沒有 WebRTC，無法用這個方式連線。', 'err');
  }
  const btn = $('gen-code');
  btn.disabled = true;
  try {
    const t = new WebRTCTransport();
    t.onStatus = (s, msg) => setConnStatus(msg, s === STATUS.CONNECTED ? 'ok' : '');
    app.transport = t;
    setConnStatus('正在收集網路候選…（最多幾秒）');
    $('local-code').value = await t.createOffer();
    setConnStatus('邀請碼已產生。複製後傳給對方，然後把他的回應碼貼到下面。', 'ok');
  } catch (err) {
    app.transport = null;
    setConnStatus(`產生邀請碼失敗：${err.name || ''} ${err.message}`, 'err');
  } finally {
    btn.disabled = false;
  }
});

$('apply-code').addEventListener('click', async () => {
  const code = $('remote-code').value.trim();
  if (!code) {
    return setConnStatus(app.netRole === 'host'
      ? '請先貼上對方傳回來的回應碼。'
      : '請先貼上房主給你的邀請碼。', 'err');
  }
  const btn = $('apply-code');
  btn.disabled = true;
  try {
    if (app.netRole === 'host') {
      if (!app.transport) return setConnStatus('請先產生邀請碼', 'err');
      await app.transport.acceptAnswer(code);
      setConnStatus('已送出，等待資料通道開啟…');
    } else {
      const t = new WebRTCTransport();
      t.onStatus = (s, msg) => setConnStatus(msg, s === STATUS.CONNECTED ? 'ok' : '');
      app.transport = t;
      $('local-code').value = await t.acceptOffer(code);
      setConnStatus('回應碼已產生。複製後傳回給房主，等他送出就會自動開打。', 'ok');
    }
    prepareSession();
  } catch (err) {
    setConnStatus(`代碼看起來不完整或不是這個遊戲的代碼（${err.name || 'Error'}）。`
      + '請確認整段都複製到了，中間不要斷行遺漏。', 'err');
  } finally {
    btn.disabled = false;
  }
});

$('copy-code').addEventListener('click', async () => {
  const v = $('local-code').value;
  if (!v) return;
  try {
    await navigator.clipboard.writeText(v);
    setConnStatus('已複製到剪貼簿');
  } catch {
    $('local-code').select();
    setConnStatus('請手動複製（已為你選取）');
  }
});

function prepareSession() {
  if (!app.transport || app.session) return;
  const session = new NetSession(app.transport, app.netRole === 'host', app.loadout, {
    name: app.settings.playerName,
    bestOf: app.settings.bestOf,
  });
  session.onStatus = (s, msg) => setConnStatus(msg, s === 'connected' ? 'ok' : s === 'error' ? 'err' : '');
  session.onReady = () => {
    setConnStatus(`配對完成，對手：${session.remoteName}`, 'ok');
    $('start-net').classList.remove('hidden');
  };
  app.session = session;
  session.start();
  // 沒有連上也持續重試握手
  const pump = setInterval(() => {
    if (!app.session) return clearInterval(pump);
    if (app.session.match) return clearInterval(pump);
    app.session.update(emptyInput(), 0.25);
  }, 250);
}

$('start-net').addEventListener('click', () => {
  if (!app.session?.match) return;
  app.match = app.session.match;
  app.mode = 'net';
  app.attract = false;
  enterGame();
});

// ---------------------------------------------------------------------------
// 開場
// ---------------------------------------------------------------------------

function startSolo() {
  app.session = null;
  app.mode = 'solo';
  app.attract = false;
  app.match = new Match({
    mode: MATCH_MODE.SOLO,
    loadouts: [app.loadout, LOADOUT_PRESETS[app.settings.enemyPreset]],
    names: [app.settings.playerName, `NPC · ${DIFFICULTIES[app.settings.difficulty].name}`],
    difficulty: app.settings.difficulty,
    aiStyle: app.settings.aiStyle,
    bestOf: app.settings.bestOf,
    seed: (Math.random() * 1e6) | 0,
  });
  enterGame();
}

function startDemo(attract = false) {
  app.session = null;
  app.mode = 'demo';
  app.attract = attract;
  app.match = new Match({
    mode: MATCH_MODE.DEMO,
    loadouts: [LOADOUT_PRESETS.champion, LOADOUT_PRESETS.netherlord],
    names: ['鑽石鬥士', '獄髓領主'],
    difficulty: 'singular',
    bestOf: 5,
    seed: (Math.random() * 1e6) | 0,
  });
  enterGame();
}

function enterGame() {
  if (!app.attract) {
    hideMenu();
    hud.classList.remove('hidden');
  }
  app.running = !app.attract;
  app.paused = false;
  app.lastTime = performance.now();
  $('ai-panel').classList.toggle('hidden', !(app.showAiPanel && app.match.ais.some(Boolean)));
  $('net-panel').classList.toggle('hidden', app.mode !== 'net');
  $('touch-layer').classList.toggle('hidden', app.mode === 'demo');
  initHud();
  if (!app.rafId) loop(performance.now());
}

function togglePause() {
  if (!app.running) return;
  app.paused = !app.paused;
  if (app.paused) showPage('pause');
  else { hideMenu(); app.lastTime = performance.now(); }
}
$('pause-btn').addEventListener('click', togglePause);
$('resume-btn').addEventListener('click', togglePause);
$('restart-btn').addEventListener('click', () => {
  app.paused = false;
  hideMenu();
  if (app.mode === 'solo') startSolo();
  else if (app.mode === 'demo') startDemo(false);
  else { app.paused = false; hideMenu(); }
});
$('quit-btn').addEventListener('click', quitToMenu);
$('result-home').addEventListener('click', quitToMenu);
$('again-btn').addEventListener('click', () => {
  if (app.mode === 'solo') startSolo();
  else if (app.mode === 'demo') startDemo(false);
  else quitToMenu();
});

function quitToMenu() {
  bankCoins();   // 中途退場也把已經掉落的金幣帶走
  app.running = false;
  app.paused = false;
  hud.classList.add('hidden');
  startDemo(true);   // 回到選單就恢復背景對打
  if (app.session) { app.session.close(); app.session = null; app.transport = null; }
  showPage('home');
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hudCache = { hp: [100, 100], ghost: [100, 100], ghostTimer: [0, 0] };

function initHud() {
  const m = app.match;
  for (let i = 0; i < 2; i++) {
    const f = m.fighters[i];
    $(`p${i}-name`).textContent = f.name;
    $(`p${i}-gear`).textContent =
      `${f.loadout.weapon.name}${f.loadout.offhand.kind === 'shield' ? ' + ' + f.loadout.offhand.name : ''}`;
    hudCache.hp[i] = f.health;
    hudCache.ghost[i] = f.health;
    // 護甲耐久格
    const armorEl = $(`p${i}-armor`);
    armorEl.innerHTML = '';
    for (const slot of Object.keys(ARMOR_SLOTS)) {
      const piece = f.loadout.pieces[slot];
      const span = document.createElement('span');
      span.title = ARMOR_SLOTS[slot].name;
      if (piece) {
        span.style.color = piece.color;
        span.innerHTML = '<i style="width:100%"></i>';
        span.dataset.slot = slot;
      } else {
        span.style.opacity = '0.25';
      }
      armorEl.appendChild(span);
    }
  }
  $('combat-log').innerHTML = '';
}

let lastLogLen = 0;

function updateHud(dt) {
  const m = app.match;
  if (!m) return;

  for (let i = 0; i < 2; i++) {
    const f = m.fighters[i];
    const hpPct = clamp(f.health / f.loadout.maxHealth, 0, 1) * 100;
    const spPct = clamp(f.stamina / f.loadout.maxStamina, 0, 1) * 100;
    const hpEl = $(`p${i}-hp`);
    hpEl.style.width = hpPct + '%';
    hpEl.classList.toggle('low', hpPct < 30);
    const spEl = $(`p${i}-sp`);
    spEl.style.width = spPct + '%';
    spEl.classList.toggle('empty', spPct < 12);

    // 殘影：受傷後停一下才追上去
    if (hpPct < hudCache.ghost[i]) {
      hudCache.ghostTimer[i] = 0.45;
    } else {
      hudCache.ghost[i] = hpPct;
    }
    if (hudCache.ghostTimer[i] > 0) {
      hudCache.ghostTimer[i] -= dt;
      if (hudCache.ghostTimer[i] <= 0) hudCache.ghost[i] = hpPct;
    }
    $(`p${i}-hp-ghost`).style.width = hudCache.ghost[i] + '%';

    // 護甲耐久
    const armorEl = $(`p${i}-armor`);
    for (const span of armorEl.children) {
      const slot = span.dataset.slot;
      if (!slot) continue;
      const piece = f.loadout.pieces[slot];
      const bar = span.firstElementChild;
      if (piece && bar) {
        const pct = clamp(piece.durability / piece.maxDurability, 0, 1) * 100;
        bar.style.width = pct + '%';
        span.style.opacity = pct <= 0 ? '0.2' : '1';
      }
    }

    // 圈圈計分
    const pips = $(`pips-${i}`);
    const need = Math.ceil(m.bestOf / 2);
    if (pips.children.length !== need) {
      pips.innerHTML = Array.from({ length: need }, () => '<i></i>').join('');
    }
    for (let k = 0; k < need; k++) {
      pips.children[k].classList.toggle('on', k < m.wins[i]);
    }
  }

  const timer = $('timer');
  timer.textContent = Math.ceil(m.timeLeft);
  timer.classList.toggle('urgent', m.timeLeft <= 10 && m.state === ROUND_STATE.FIGHTING);
  $('round-label').textContent = `第 ${m.roundNo} 回合`;

  // 中央大字
  const msgEl = $('center-msg');
  if (m.state === ROUND_STATE.COUNTDOWN && m.stateTimer > 0) {
    const n = Math.ceil(m.stateTimer);
    msgEl.textContent = n > 0 ? n : '';
    msgEl.style.color = '#fff';
    msgEl.style.opacity = String(1 - (Math.ceil(m.stateTimer) - m.stateTimer) * 0.5);
  } else if (m.messages.length) {
    const msg = m.messages[m.messages.length - 1];
    msgEl.textContent = msg.text;
    msgEl.style.color = msg.color;
    msgEl.style.opacity = String(clamp(1 - (msg.t / msg.duration) ** 3, 0, 1));
  } else {
    msgEl.textContent = '';
  }

  // 戰鬥紀錄
  if (m.log.length !== lastLogLen) {
    lastLogLen = m.log.length;
    $('combat-log').innerHTML = m.log.map((l) => `<div>${escapeHtml(l.text)}</div>`).join('');
  }

  // NPC 思考面板
  const ai = m.ais[1] || m.ais[0];
  if (ai && app.showAiPanel) {
    $('ai-intent').textContent = ai.debug.intent || '—';
    $('ai-threat').textContent = ai.debug.threat.toFixed(2);
    const pk = ai.debug.predicted;
    $('ai-predict').textContent = pk
      ? `${MOVE_LABELS[pk] || pk} ${Math.round((ai.debug.confidence || 0) * 100)}%` : '觀察中';
    $('ai-blockrate').textContent = `${Math.round(ai.model.blockRate * 100)}%`;
    $('ai-reaction').textContent = `${Math.round(ai.reactionTime * 1000)}ms`;
  }

  // 連線面板
  if (app.mode === 'net' && app.session) {
    const t = app.session.transport;
    $('net-kind').textContent = TRANSPORTS.find((x) => x.key === app.transportKind)?.label || '—';
    $('net-role').textContent = app.session.isHost ? '房主' : '挑戰者';
    $('net-ping').textContent = `${app.session.pingMs} ms`;
    $('net-io').textContent = `${t.stats.received} / ${t.stats.sent}`;
  }

  // 結算
  if (m.matchOver && app.running) {
    showResult();
  }
}

const MOVE_LABELS = {
  slashR: '右橫斬', slashL: '左橫斬', overhead: '上段劈', thrust: '突刺', bash: '盾擊',
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showResult() {
  const m = app.match;
  bankCoins();
  app.running = false;
  const meIdx = app.session && !app.session.isHost ? 1 : 0;
  const won = m.finalWinner === meIdx;
  const title = $('result-title');
  if (app.mode === 'demo') {
    title.textContent = `${m.fighters[m.finalWinner].name} 獲勝`;
    title.className = '';
  } else {
    title.textContent = won ? '勝利' : '敗北';
    title.className = won ? 'win' : 'lose';
  }
  const rows = [];
  for (let i = 0; i < 2; i++) {
    const f = m.fighters[i];
    const s = f.stats;
    rows.push(`<div class="result-row"><span>${escapeHtml(f.name)}</span><b>${m.wins[i]} 勝</b></div>`);
    rows.push(`<div class="result-row"><span>　命中 / 爆頭</span><b>${s.hits} / ${s.headshots}</b></div>`);
    rows.push(`<div class="result-row"><span>　格擋 / 招架</span><b>${s.blocked} / ${s.parries}</b></div>`);
    rows.push(`<div class="result-row"><span>　造成傷害</span><b>${Math.round(s.damageDealt)}</b></div>`);
  }
  if (m.coinsEarned > 0) {
    rows.push(`<div class="result-row coin"><span>💰 本場獲得</span><b>+${m.coinsEarned} 金幣</b></div>`);
    rows.push(`<div class="result-row coin"><span>💰 目前持有</span><b>${app.wallet.coins} 金幣</b></div>`);
  }
  $('result-box').innerHTML = rows.join('');
  showPage('result');
}

// ---------------------------------------------------------------------------
// 主迴圈
// ---------------------------------------------------------------------------

function loop(now) {
  app.rafId = requestAnimationFrame(loop);
  const rawDt = (now - app.lastTime) / 1000;
  app.lastTime = now;
  // 分頁切回來時 dt 會爆掉，夾住避免物理穿模
  const dt = clamp(rawDt, 0, 1 / 20);

  renderPreview(dt, now);

  if (!app.match) return;

  if (app.attract) {
    // 主選單背景的 NPC 對打
    app.match.update(dt);
    app.match.render(renderer);
    return;
  }

  if (app.running && !app.paused) {
    const input = gatherInput();
    if (app.session) {
      app.session.update(input, dt);
    } else {
      app.match.setInput(0, input);
      app.match.update(dt);
    }
    updateHud(dt);
  }

  app.match.render(renderer);
}

// 讓瀏覽器主控台與自動化測試能檢查內部狀態
window.__app = app;
// 告訴開機保險絲：主程式活著，不用顯示故障畫面
window.__bladeDuelBooted = true;

// 開場先跑一場 NPC 對打當選單背景
startDemo(true);
showPage('home');
