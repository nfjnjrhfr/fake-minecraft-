/* 數學通道 — 一個只放固定幾個 B 站片單的觀看通道
 * 純前端、無框架、無建置流程。所有個人資料（綁定的 BV 號、觀看進度、
 * 自訂片單、播放設定）都只存在瀏覽器 localStorage，不會上傳任何地方。 */
(() => {
'use strict';

/* ------------------------------------------------------------------ 儲存 */
const NS = 'bili-channel:';
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(NS + key); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(NS + key, JSON.stringify(value)); } catch {}
  },
  clearAll() {
    Object.keys(localStorage).filter(k => k.startsWith(NS)).forEach(k => localStorage.removeItem(k));
  }
};

let overrides = store.get('overrides', {});   // { [id]: {bvid, title, parts, tag, cover} }
let custom    = store.get('custom', []);      // 自己新增的片單
let progress  = store.get('progress', {});    // { [id]: { seen:[p], last:p } }
let opts      = Object.assign(
  { danmaku: false, autoplay: true, wide: true, continuous: true },
  store.get('opts', {})
);

/* ------------------------------------------------------------- 片單資料 */
function library() {
  const base = (window.DEFAULT_LIBRARY?.collections || []).map(c => {
    const o = overrides[c.id] || {};
    return Object.assign({}, c, o, { builtin: true });
  });
  return base.concat(custom);
}
function findCollection(id) { return library().find(c => c.id === id); }

function episodesOf(c) {
  const listed = c.episodes || [];
  const n = Math.max(Number(c.parts) || 1, listed.length);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const e = listed[i - 1] || {};
    out.push({
      p: Number(e.p) || i,               // 片單裡的第幾集（路由與進度用）
      vp: Number(e.p) || (e.bvid ? 1 : i), // 傳給播放器的 ?p=：獨立影片一律 1
      title: e.title || ('P' + i),
      dur: Number(e.dur) || 0,          // 秒；連續播放靠它倒數
      bvid: e.bvid || c.bvid || '',
      aid: e.aid || c.aid || ''
    });
  }
  return out;
}
function isBound(c) { return Boolean(c.bvid || c.aid || (c.episodes || []).some(e => e.bvid || e.aid)); }

/* ------------------------------------------------------------ 小工具 */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function hue(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function coverStyle(c) {
  const h = hue(c.shortTitle || c.title || c.id);
  return `background:linear-gradient(135deg,hsl(${h} 62% 34%),hsl(${(h + 48) % 360} 58% 20%))`;
}

/** 從貼上的連結 / BV 號 / av 號解析出播放參數 */
function parseBili(input) {
  const s = String(input || '').trim();
  const out = {};
  if (!s) return out;
  const bv = s.match(/BV[0-9A-Za-z]{10}/);
  if (bv) out.bvid = bv[0];
  const av = s.match(/av(\d+)/i);
  if (!out.bvid && av) out.aid = av[1];
  const p = s.match(/[?&]p=(\d+)/);
  if (p) out.p = Number(p[1]);
  return out;
}

function playerSrc(ep) {
  const q = new URLSearchParams();
  if (ep.bvid) q.set('bvid', ep.bvid);
  else if (ep.aid) q.set('aid', ep.aid);
  q.set('p', ep.vp || ep.p);
  q.set('autoplay', opts.autoplay ? '1' : '0');
  q.set('danmaku', opts.danmaku ? '1' : '0');
  q.set('high_quality', '1');
  q.set('as_wide', opts.wide ? '1' : '0');
  return 'https://player.bilibili.com/player.html?' + q.toString();
}
/* ---------------------------------------------------- 連續播放倒數計時器 */
const GRACE = 6;                     // 播放器載入 / 緩衝的寬限秒數
let timer = { id: 0, endsAt: 0, remain: 0, paused: false, onEnd: null };

function stopTimer() {
  if (timer.id) clearInterval(timer.id);
  timer = { id: 0, endsAt: 0, remain: 0, paused: false, onEnd: null };
}
function startTimer(seconds, onEnd) {
  stopTimer();
  timer.onEnd = onEnd;
  timer.endsAt = Date.now() + seconds * 1000;
  timer.id = setInterval(tickTimer, 500);
  tickTimer();
}
function timerLeft() {
  return timer.paused ? timer.remain : Math.max(0, Math.round((timer.endsAt - Date.now()) / 1000));
}
function fmt(sec) {
  const m = Math.floor(sec / 60), s2 = sec % 60;
  return m + ':' + String(s2).padStart(2, '0');
}
function tickTimer() {
  const bar = document.getElementById('auto-bar');
  if (!bar) return stopTimer();
  const left = timerLeft();
  const label = document.getElementById('ap-text');
  if (label) {
    label.innerHTML = timer.paused
      ? '倒數已暫停 · 剩 <b>' + fmt(left) + '</b>'
      : '連續播放中 · <b>' + fmt(left) + '</b> 後跳下一集';
  }
  bar.classList.toggle('paused', timer.paused);
  if (!timer.paused && left <= 0) {
    const fn = timer.onEnd;
    stopTimer();
    fn && fn();
  }
}

function biliUrl(ep) {
  const base = ep.bvid ? 'https://www.bilibili.com/video/' + ep.bvid
             : ep.aid  ? 'https://www.bilibili.com/video/av' + ep.aid
             : '';
  return base ? base + '?p=' + (ep.vp || ep.p) : '';
}

/* ------------------------------------------------------------- 觀看進度 */
function prog(id) {
  const p = progress[id] || (progress[id] = { seen: [], last: 0 });
  if (!Array.isArray(p.seen)) p.seen = [];
  return p;
}
function markSeen(id, p, on = true) {
  const rec = prog(id);
  const set = new Set(rec.seen);
  on ? set.add(p) : set.delete(p);
  rec.seen = Array.from(set).sort((a, b) => a - b);
  store.set('progress', progress);
}
function seenCount(id) { return prog(id).seen.length; }

/* ------------------------------------------------------------------ 路由 */
function route() {
  stopTimer();
  const hash = location.hash.replace(/^#\/?/, '');
  const [section, id, p] = hash.split('/');
  if (section === 'c' && id) renderPlayer(decodeURIComponent(id), Number(p) || undefined);
  else renderHome();
  window.scrollTo(0, 0);
  renderStats();
}

/* -------------------------------------------------------------- 首頁 */
let keyword = '';

function matches(c) {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  const hay = [c.title, c.shortTitle, c.tag, c.bvid, ...(c.episodes || []).map(e => e.title)]
    .filter(Boolean).join(' ').toLowerCase();
  return hay.includes(k);
}

function cardHtml(c) {
  const eps = episodesOf(c);
  const seen = seenCount(c.id);
  const pct = eps.length ? Math.round(seen / eps.length * 100) : 0;
  const cover = c.cover
    ? `<img src="${esc(c.cover)}" alt="" referrerpolicy="no-referrer" loading="lazy"
            onerror="this.remove()">`
    : '';
  return `
    <article class="card" data-id="${esc(c.id)}" tabindex="0">
      <div class="cover" style="${coverStyle(c)}">
        ${cover}
        <div class="cover-text">${esc(c.shortTitle || c.title)}</div>
        <span class="badge">${eps.length}P</span>
        ${isBound(c) ? '' : '<span class="badge warn">未綁定 BV</span>'}
        <div class="progress-bar"><i style="width:${pct}%"></i></div>
      </div>
      <div class="card-body">
        <div class="card-title">${esc(c.title)}</div>
        <div class="card-meta">
          ${c.tag ? `<span class="tag">${esc(c.tag)}</span>` : ''}
          ${c.size ? `<span>${esc(c.size)}</span>` : ''}
          <span>${seen} / ${eps.length} 已看</span>
        </div>
      </div>
    </article>`;
}

function renderHome() {
  const list = library().filter(matches);
  const resume = keyword ? null : resumeTarget();
  $('#view').innerHTML = `
    ${resume ? `
      <h2 class="section-title">繼續觀看</h2>
      <div class="grid">${cardHtml(resume.c)}</div>` : ''}
    <h2 class="section-title">已緩存視頻 <small>${list.length} 個片單</small></h2>
    ${list.length
      ? `<div class="grid">${list.map(cardHtml).join('')}</div>`
      : `<p class="empty">${keyword ? '找不到符合的片單' : '還沒有片單，按右上角「＋ 新增」加一個。'}</p>`}
  `;
  $$('.card').forEach(el => {
    const go = () => { location.hash = '#/c/' + encodeURIComponent(el.dataset.id); };
    el.addEventListener('click', go);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

function resumeTarget() {
  let best = null;
  for (const c of library()) {
    const rec = progress[c.id];
    if (rec && rec.last && rec.ts) {
      if (!best || rec.ts > best.ts) best = { c, p: rec.last, ts: rec.ts };
    }
  }
  return best;
}

/* -------------------------------------------------------------- 播放頁 */
function renderPlayer(id, wantP) {
  const c = findCollection(id);
  if (!c) { location.hash = '#/'; return; }
  const eps = episodesOf(c);
  const rec = prog(c.id);
  const p = wantP || rec.last || eps[0].p;
  const idx = Math.max(0, eps.findIndex(e => e.p === p));
  const ep = eps[idx];

  rec.last = ep.p; rec.ts = Date.now();
  store.set('progress', progress);

  const bound = Boolean(ep.bvid || ep.aid);
  $('#view').innerHTML = `
    <div class="crumb"><a href="#/">‹ 全部片單</a></div>
    <div class="player-page">
      <section>
        <div class="player-head">
          <h1>${esc(c.title)}</h1>
          <button class="btn ghost" id="btn-edit-this">編輯</button>
        </div>
        <div class="player-box">
          ${bound ? `<iframe id="player" src="${esc(playerSrc(ep))}"
                        allowfullscreen="true" allow="fullscreen; autoplay; picture-in-picture"
                        scrolling="no" frameborder="0"></iframe>`
                  : `<div class="player-empty">
                        <strong>還沒綁定 B 站影片</strong>
                        <p class="hint">在 B 站找到這個影片，複製網址貼進來就能在這裡播放。</p>
                        <button class="btn primary" id="btn-bind">貼上連結綁定</button>
                     </div>`}
        </div>
        <div class="autoplay-bar" id="auto-bar" hidden>
          <span class="ap-dot"></span>
          <span class="ap-text" id="ap-text"></span>
          <button class="linklike" id="ap-toggle">暫停倒數</button>
          <button class="linklike" id="ap-plus">＋30 秒</button>
          <button class="linklike" id="ap-off">關閉</button>
        </div>
        <div class="player-tools">
          <button class="btn ghost" id="btn-prev" ${idx === 0 ? 'disabled' : ''}>‹ 上一 P</button>
          <button class="btn ghost" id="btn-next" ${idx === eps.length - 1 ? 'disabled' : ''}>下一 P ›</button>
          <button class="btn ${rec.seen.includes(ep.p) ? 'ghost' : 'primary'}" id="btn-seen">
            ${rec.seen.includes(ep.p) ? '✓ 已看過（點此取消）' : '標記為已看'}
          </button>
          ${bound ? `<a class="btn ghost" href="${esc(biliUrl(ep))}" target="_blank" rel="noopener">在 B 站開啟</a>` : ''}
        </div>
      </section>
      <aside class="ep-list">
        <h3><span>播放清單</span><span style="color:var(--fg-dim);font-weight:400">${rec.seen.length}/${eps.length}</span></h3>
        <div class="ep-scroll">
          ${eps.map((e, i) => `
            <div class="ep ${i === idx ? 'active' : ''}" data-p="${e.p}">
              <span class="num">${i + 1}</span>
              <span class="name" title="${esc(e.title)}">${esc(e.title)}</span>
              ${rec.seen.includes(e.p) ? '<span class="seen">✓</span>' : ''}
            </div>`).join('')}
        </div>
      </aside>
    </div>`;

  const goto = np => { location.hash = `#/c/${encodeURIComponent(c.id)}/${np}`; };
  $$('.ep').forEach(el => el.addEventListener('click', () => goto(Number(el.dataset.p))));
  $('#btn-prev')?.addEventListener('click', () => goto(eps[idx - 1].p));
  $('#btn-next')?.addEventListener('click', () => { markSeen(c.id, ep.p); goto(eps[idx + 1].p); });
  $('#btn-seen')?.addEventListener('click', () => {
    markSeen(c.id, ep.p, !rec.seen.includes(ep.p));
    renderPlayer(c.id, ep.p);
    renderStats();
  });
  $('#btn-bind')?.addEventListener('click', () => openEdit(c));
  $('#btn-edit-this')?.addEventListener('click', () => openEdit(c));

  setupCountdown(c, eps, idx, ep, goto);

  const activeEl = $('.ep.active');
  activeEl?.scrollIntoView({ block: 'nearest' });
}

/** 連續播放：用這一集的實際長度倒數，時間到就自動跳下一集 */
function setupCountdown(c, eps, idx, ep, goto) {
  const bar = $('#auto-bar');
  if (!bar) return;
  const bound = Boolean(ep.bvid || ep.aid);
  const hasNext = idx < eps.length - 1;
  if (!opts.continuous || !bound || !ep.dur || !hasNext) {
    bar.hidden = true;
    if (opts.continuous && bound && hasNext && !ep.dur) {
      // 沒有長度資料就退回手動，並說清楚原因
      bar.hidden = false;
      $('#ap-text').textContent = '這一集沒有長度資料，無法自動跳下一集';
      $('#ap-toggle').hidden = $('#ap-plus').hidden = true;
      bar.classList.add('paused');
    }
    return;
  }

  bar.hidden = false;
  startTimer(ep.dur + GRACE, () => {
    markSeen(c.id, ep.p);
    goto(eps[idx + 1].p);
  });

  $('#ap-toggle').addEventListener('click', e => {
    if (timer.paused) {
      timer.endsAt = Date.now() + timer.remain * 1000;
      timer.paused = false;
      e.target.textContent = '暫停倒數';
    } else {
      timer.remain = timerLeft();
      timer.paused = true;
      e.target.textContent = '繼續倒數';
    }
    tickTimer();
  });
  $('#ap-plus').addEventListener('click', () => {
    if (timer.paused) timer.remain += 30; else timer.endsAt += 30000;
    tickTimer();
  });
  $('#ap-off').addEventListener('click', () => {
    opts.continuous = false;
    store.set('opts', opts);
    stopTimer();
    bar.hidden = true;
    syncContinuousBtn();
  });
}

/* ------------------------------------------------------- 新增 / 編輯片單 */
let editing = null;

function openEdit(c) {
  editing = c || null;
  const f = $('#form-edit');
  $('#edit-title').textContent = c ? '編輯片單' : '新增片單';
  f.title.value  = c ? (c.title || '') : '';
  f.link.value   = c ? (c.bvid || (c.aid ? 'av' + c.aid : '')) : '';
  f.parts.value  = c ? (c.parts || 1) : 1;
  f.tag.value    = c ? (c.tag || '') : '';
  f.cover.value  = c ? (c.cover || '') : '';
  $('#edit-delete').hidden = !(c && !c.builtin);
  $('#edit-err').hidden = true;
  $('#dlg-edit').showModal();
}

function saveEdit(e) {
  e.preventDefault();
  const f = $('#form-edit');
  const title = f.title.value.trim();
  if (!title) return;
  const link = f.link.value.trim();
  const parsed = parseBili(link);
  if (link && !parsed.bvid && !parsed.aid) {
    const err = $('#edit-err');
    err.textContent = '看不懂這個連結，請貼 B 站網址或 BV 號（例如 BV1GJ411x7h7）。';
    err.hidden = false;
    return;
  }
  const patch = {
    title,
    bvid: parsed.bvid || '',
    aid: parsed.aid || '',
    parts: Math.max(1, Number(f.parts.value) || 1),
    tag: f.tag.value.trim(),
    cover: f.cover.value.trim()
  };

  if (editing && editing.builtin) {
    overrides[editing.id] = Object.assign({}, overrides[editing.id], patch);
    store.set('overrides', overrides);
  } else if (editing) {
    const i = custom.findIndex(x => x.id === editing.id);
    if (i >= 0) custom[i] = Object.assign({}, custom[i], patch);
    store.set('custom', custom);
  } else {
    const id = 'my-' + Math.random().toString(36).slice(2, 9);
    custom.push(Object.assign({ id, episodes: [] }, patch));
    store.set('custom', custom);
  }

  $('#dlg-edit').close();
  const stay = editing;
  editing = null;
  if (stay) {
    // 連結裡帶 ?p=N 就直接跳到那一 P
    if (parsed.p) location.hash = `#/c/${encodeURIComponent(stay.id)}/${parsed.p}`;
    else renderPlayer(stay.id);
  } else route();
  renderStats();
}

function deleteEditing() {
  if (!editing || editing.builtin) return;
  if (!confirm('刪除「' + (editing.shortTitle || editing.title) + '」？')) return;
  custom = custom.filter(x => x.id !== editing.id);
  store.set('custom', custom);
  delete progress[editing.id];
  store.set('progress', progress);
  $('#dlg-edit').close();
  editing = null;
  location.hash = '#/';
  route();
}

/* ------------------------------------------------------------ 匯出 / 匯入 */
function exportJson() {
  const data = { collections: library().map(({ builtin, ...rest }) => rest) };
  const text = JSON.stringify(data, null, 2);
  navigator.clipboard?.writeText(text).then(
    () => alert('片單 JSON 已複製到剪貼簿。\n可以貼進 assets/data.js 的 collections 讓它變成預設片單。'),
    () => prompt('複製下面的 JSON：', text)
  );
}

function importJson(e) {
  e.preventDefault();
  const err = $('#import-err');
  try {
    const data = JSON.parse($('#form-import').json.value);
    const cols = Array.isArray(data) ? data : data.collections;
    if (!Array.isArray(cols)) throw new Error('缺少 collections 陣列');
    const builtinIds = new Set((window.DEFAULT_LIBRARY?.collections || []).map(c => c.id));
    cols.forEach(c => {
      if (!c || !c.title) return;
      const id = c.id || 'my-' + Math.random().toString(36).slice(2, 9);
      if (builtinIds.has(id)) {
        overrides[id] = Object.assign({}, overrides[id], c);
      } else {
        const i = custom.findIndex(x => x.id === id);
        const rec = Object.assign({ episodes: [] }, c, { id });
        i >= 0 ? custom[i] = rec : custom.push(rec);
      }
    });
    store.set('overrides', overrides);
    store.set('custom', custom);
    $('#dlg-import').close();
    $('#form-import').json.value = '';
    route();
  } catch (ex) {
    err.textContent = 'JSON 解析失敗：' + ex.message;
    err.hidden = false;
  }
}

/* ------------------------------------------------------------------ 其他 */
function renderStats() {
  const cols = library();
  const total = cols.reduce((n, c) => n + episodesOf(c).length, 0);
  const seen = cols.reduce((n, c) => n + seenCount(c.id), 0);
  $('#stats').textContent = `${cols.length} 個片單 · ${seen}/${total} 集已看`;
}

function syncContinuousBtn() {
  const btn = $('#btn-continuous');
  if (!btn) return;
  btn.classList.toggle('on', Boolean(opts.continuous));
  btn.textContent = opts.continuous ? '▶ 連續播放' : '▷ 連續播放';
  btn.title = opts.continuous ? '連續播放：開（點一下關閉）' : '連續播放：關（點一下開啟）';
  const cb = $('#opt-continuous');
  if (cb) cb.checked = Boolean(opts.continuous);
}

function bindSettings() {
  const map = { 'opt-danmaku': 'danmaku', 'opt-autoplay': 'autoplay', 'opt-wide': 'wide', 'opt-continuous': 'continuous' };
  for (const [elId, key] of Object.entries(map)) {
    const el = document.getElementById(elId);
    el.checked = Boolean(opts[key]);
    el.addEventListener('change', () => {
      opts[key] = el.checked;
      store.set('opts', opts);
      syncContinuousBtn();
      if (location.hash.startsWith('#/c/')) route();
    });
  }
}

document.addEventListener('keydown', e => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName) || document.querySelector('dialog[open]')) return;
  if (e.key === 'ArrowRight') $('#btn-next')?.click();
  if (e.key === 'ArrowLeft')  $('#btn-prev')?.click();
  if (e.key === 'Escape' && location.hash.startsWith('#/c/')) location.hash = '#/';
});

window.addEventListener('hashchange', route);

document.addEventListener('DOMContentLoaded', () => {
  bindSettings();
  syncContinuousBtn();
  $('#search').addEventListener('input', e => {
    keyword = e.target.value.trim();
    if (!location.hash.startsWith('#/c/')) renderHome();
    else { location.hash = '#/'; }
  });
  $('#btn-continuous').addEventListener('click', () => {
    opts.continuous = !opts.continuous;
    store.set('opts', opts);
    syncContinuousBtn();
    if (location.hash.startsWith('#/c/')) route();
  });
  $('#btn-add').addEventListener('click', () => openEdit(null));
  $('#btn-settings').addEventListener('click', () => $('#dlg-settings').showModal());
  $('#settings-close').addEventListener('click', () => $('#dlg-settings').close());
  $('#form-edit').addEventListener('submit', saveEdit);
  $('#edit-cancel').addEventListener('click', () => $('#dlg-edit').close());
  $('#edit-delete').addEventListener('click', deleteEditing);
  $('#btn-export').addEventListener('click', exportJson);
  $('#btn-import').addEventListener('click', () => $('#dlg-import').showModal());
  $('#form-import').addEventListener('submit', importJson);
  $('#import-cancel').addEventListener('click', () => $('#dlg-import').close());
  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('清除所有本機資料（綁定的 BV 號、觀看進度、自訂片單）？')) return;
    store.clearAll();
    overrides = {}; custom = []; progress = {};
    opts = { danmaku: false, autoplay: true, wide: true, continuous: true };
    bindSettings();
    syncContinuousBtn();
    location.hash = '#/';
    route();
  });
  route();
});
})();
