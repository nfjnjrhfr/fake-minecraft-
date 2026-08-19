/* ============================================================
   開玉 — 第一人稱 3D 坑道引擎
   自寫軟體光線投射（raycasting）：只看得見燈照到的前方，
   坑道要跟著地上的導引線走，看不到完整地圖。
   ============================================================ */
(function (global) {
  'use strict';
  const { EQUIP, SITES, SUPPLY } = global.DATA;
  const J = global.JADE;

  const MS = 56;                 // 地圖格數
  const OPEN = 0, ROCK = 1, HARD = 2, VEIN = 3, BED = 4;
  const TYPE = {
    1: { name: '圍岩', hp: 42, hard: 1.0, rgb: [96, 102, 112] },
    2: { name: '硬岩', hp: 96, hard: 1.75, rgb: [64, 68, 76] },
    3: { name: '玉脈帶', hp: 60, hard: 1.2, rgb: [62, 122, 100] },
    4: { name: '岩盤', hp: 1e9, hard: 99, rgb: [40, 42, 48] }
  };
  const idx = (x, y) => y * MS + x;

  /* ================= 產生坑道 ================= */
  function genLevel(S, site) {
    const map = new Uint8Array(MS * MS).fill(ROCK);
    const hp = new Float32Array(MS * MS);
    const wet = new Uint8Array(MS * MS);
    const seen = new Uint8Array(MS * MS);
    const path = new Uint8Array(MS * MS);
    const nodes = {};

    for (let y = 1; y < MS - 1; y++) for (let x = 1; x < MS - 1; x++) {
      const depth = x / MS, r = Math.random();
      let t = ROCK;
      if (r < 0.16 + depth * 0.3) t = HARD;
      else if (r > 0.9 - depth * 0.14) t = VEIN;
      map[idx(x, y)] = t;
      hp[idx(x, y)] = TYPE[t].hp * (0.75 + depth * 1.0) * site.hardness;
      if (depth > 1 - site.water) wet[idx(x, y)] = 1;
    }
    for (let i = 0; i < MS; i++) { map[idx(i, 0)] = BED; map[idx(i, MS - 1)] = BED; map[idx(0, i)] = BED; map[idx(MS - 1, i)] = BED; }

    const carve = (x, y) => {
      if (x < 1 || y < 1 || x >= MS - 1 || y >= MS - 1) return;
      map[idx(x, y)] = OPEN;
    };
    const room = (x, y, r) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) carve(x + i, y + j); };

    // 洞口
    let cx = 3, cy = MS >> 1;
    room(cx, cy, 2);
    const way = [];
    let dir = 0;                       // 0:+x 1:+y 2:-y
    for (let step = 0; step < 150 && cx < MS - 8; step++) {
      const r = Math.random();
      if (r < 0.24) dir = 1; else if (r < 0.48) dir = 2; else dir = 0;
      const dx = dir === 0 ? 1 : 0;
      const dy = dir === 1 ? 1 : dir === 2 ? -1 : 0;
      const nx = cx + dx, ny = Math.max(4, Math.min(MS - 5, cy + dy));
      if (dir !== 0 && Math.abs(ny - (MS >> 1)) > 14) continue;
      cx = Math.min(MS - 5, nx); cy = ny;
      carve(cx, cy); carve(cx, cy - 1);            // 坑道高一點好走
      path[idx(cx, cy)] = 1;
      way.push([cx, cy]);
      if (Math.random() < 0.12) room(cx, cy, 1);    // 偶爾一個小硐室
    }
    // 開採面
    room(cx, cy, 2);
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) {
      const x = cx + i, y = cy + j;
      if (x > 0 && y > 0 && x < MS - 1 && y < MS - 1 && map[idx(x, y)] !== OPEN && map[idx(x, y)] !== BED) {
        map[idx(x, y)] = VEIN; hp[idx(x, y)] = TYPE[VEIN].hp * 1.6 * site.hardness;
      }
    }

    // 埋玉：靠近坑道與玉脈帶機率最高，越深越好
    for (let y = 1; y < MS - 1; y++) for (let x = 1; x < MS - 1; x++) {
      const t = map[idx(x, y)];
      if (t === OPEN || t === BED) continue;
      let near = false;
      for (let j = -2; j <= 2 && !near; j++) for (let i = -2; i <= 2 && !near; i++) {
        const nx = x + i, ny = y + j;
        if (nx > 0 && ny > 0 && nx < MS && ny < MS && map[idx(nx, ny)] === OPEN) near = true;
      }
      const depth = x / MS;
      let p = site.density * (0.3 + depth * 1.6) * (t === VEIN ? 2.4 : t === HARD ? 1.0 : 0.55);
      if (!near) p *= 0.45;
      p = Math.min(p, 0.3);
      if (Math.random() < p) {
        nodes[idx(x, y)] = J.makeStone(site, { sizeMul: 0.6 + depth * 0.9, luck: (depth - 0.45) * 0.3 });
      }
    }

    return { map, hp, wet, seen, path, nodes, way, spawn: { x: 3.5, y: (MS >> 1) + 0.5 }, face: { x: cx, y: cy } };
  }

  /* ================= 開工 ================= */
  function start(S, siteId, teamIds) {
    const site = SITES.find(s => s.id === siteId);
    const lv = genLevel(S, site);
    const sess = {
      site, siteId, lv,
      team: teamIds.slice(),
      active: teamIds[0] || null,
      tool: firstTool(S),
      stones: [],
      pumpOn: false,
      lightOn: hasWorking(S, 'headlamp') || hasWorking(S, 'floodlight'),
      timbers: 0, dugCount: 0, actions: 0, collapsed: 0,
      accum: { pump: 0, light: 0, lamp: 0 },
      player: { x: lv.spawn.x, y: lv.spawn.y, ang: 0, bob: 0, vx: 0, vy: 0 },
      log: [], over: false
    };
    markSeen(sess);
    return sess;
  }

  function firstTool(S) {
    const order = ['pickaxe', 'chisel', 'shovel', 'prybar', 'sledge', 'jackhammer', 'excavator', 'dynamite_kit'];
    for (const id of order) if (hasWorking(S, id)) return id;
    return null;
  }
  function hasWorking(S, id) { const e = S.equip[id]; return !!(e && e.qty > 0 && e.dur > 0); }
  function worker(S, id) { return S.workers.find(w => w.id === id); }
  function skillName(k) { return { mine: '採礦', blast: '爆破', mech: '機械', eye: '相玉' }[k] || k; }
  function coverage(S, sess, id) {
    const e = S.equip[id];
    if (!e || e.qty <= 0 || e.dur <= 0) return 0;
    return Math.min(1, e.qty / Math.max(1, sess.team.length));
  }
  function bestSkill(S, sess, key) {
    return sess.team.map(id => worker(S, id)).filter(Boolean).reduce((m, x) => Math.max(m, x.skill[key] || 0), 0);
  }

  function lightRadius(S, sess) {
    let r = 3.5;
    if (sess.lightOn && hasWorking(S, 'headlamp')) r = Math.max(r, 3.5 + EQUIP.headlamp.light * 2.6);
    if (sess.lightOn && hasWorking(S, 'floodlight') && hasWorking(S, 'generator')) r = Math.max(r, 3.5 + EQUIP.floodlight.light * 2.6);
    if (S.weather.id === 'fog') r -= 2;
    return Math.max(2.5, r);
  }

  function markSeen(sess) {
    const p = sess.player, lv = sess.lv, R = 5;
    for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) {
      const x = Math.floor(p.x) + i, y = Math.floor(p.y) + j;
      if (x > 0 && y > 0 && x < MS && y < MS) lv.seen[idx(x, y)] = 1;
    }
  }

  /* ================= 工具可用性 ================= */
  function canUse(S, sess, toolId) {
    const eq = EQUIP[toolId];
    if (!eq || !eq.tool) return { ok: false, why: '沒有這個工具' };
    if (!hasWorking(S, toolId)) return { ok: false, why: eq.name + ' 沒有或已損壞' };
    const t = eq.tool;
    for (const need of (t.needs || [])) if (!hasWorking(S, need)) return { ok: false, why: '需要 ' + EQUIP[need].name };
    if (t.use) for (const k in t.use) if ((S.supply[k] || 0) < t.use[k]) return { ok: false, why: '缺 ' + SUPPLY[k].name };
    if (t.fuel) for (const k in t.fuel) if ((S.supply[k] || 0) < t.fuel[k]) return { ok: false, why: '缺 ' + SUPPLY[k].name };
    if (t.skill) {
      const w = worker(S, sess.active);
      if (!w) return { ok: false, why: '沒有選定工人' };
      for (const k in t.skill) {
        if ((w.skill[k] || 0) < t.skill[k]) {
          const able = sess.team.map(id => worker(S, id)).filter(x => x && (x.skill[k] || 0) >= t.skill[k]);
          return { ok: false, why: able.length ? '要由 ' + able.map(x => x.name).join('、') + ' 操作' : '隊上沒有 ' + skillName(k) + ' ' + t.skill[k] + ' 以上的人' };
        }
      }
    }
    return { ok: true };
  }

  /* ================= 挖掘 ================= */
  // 從眼睛射一條線，找出面前的岩壁
  function aim(sess, reach) {
    const p = sess.player, lv = sess.lv;
    const dx = Math.cos(p.ang), dy = Math.sin(p.ang);
    for (let d = 0.15; d < (reach || 2.0); d += 0.06) {
      const x = Math.floor(p.x + dx * d), y = Math.floor(p.y + dy * d);
      if (x < 0 || y < 0 || x >= MS || y >= MS) return null;
      const t = lv.map[idx(x, y)];
      if (t !== OPEN) return { x, y, t, d };
    }
    return null;
  }

  function patternCells(sess, tx, ty, pattern) {
    const p = sess.player;
    const fx = Math.abs(Math.cos(p.ang)) > Math.abs(Math.sin(p.ang)) ? 1 : 0; // 面向 x 或 y
    const out = [];
    const add = (x, y) => out.push([x, y]);
    switch (pattern) {
      case 'single': add(tx, ty); break;
      case 'vert3': add(tx, ty); add(tx + (fx ? Math.sign(Math.cos(p.ang)) : 0), ty + (fx ? 0 : Math.sign(Math.sin(p.ang))));
        add(tx + (fx ? 2 * Math.sign(Math.cos(p.ang)) : 0), ty + (fx ? 0 : 2 * Math.sign(Math.sin(p.ang)))); break;
      case 'horz3': add(tx, ty); if (fx) { add(tx, ty - 1); add(tx, ty + 1); } else { add(tx - 1, ty); add(tx + 1, ty); } break;
      case 'cross': add(tx, ty); add(tx + 1, ty); add(tx - 1, ty); add(tx, ty + 1); add(tx, ty - 1); break;
      case 'box3': for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) add(tx + i, ty + j); break;
      case 'blast': for (let j = -2; j <= 2; j++) for (let i = -2; i <= 2; i++) if (Math.abs(i) + Math.abs(j) <= 2) add(tx + i, ty + j); break;
      default: add(tx, ty);
    }
    return out;
  }

  function dig(S, sess) {
    const chk = canUse(S, sess, sess.tool);
    if (!chk.ok) return { ok: false, msg: chk.why };
    const w = worker(S, sess.active);
    if (!w) return { ok: false, msg: '沒有選定工人' };
    if (w.injury > 0) return { ok: false, msg: w.name + ' 受傷中' };

    const eq = EQUIP[sess.tool], t = eq.tool;
    const target = aim(sess, 2.0);
    if (!target) return { ok: false, msg: '面前沒有岩壁' };
    if (target.t === BED) return { ok: false, msg: '這是岩盤，挖不動' };

    const stamCost = Math.round(t.stam * (1 - (w.skill.mine || 0) * 0.03) * (S.weather.work < 1 ? 1.15 : 1));
    if (w.stam < stamCost) return { ok: false, msg: w.name + ' 沒力氣了，按 [T] 換人或 [Q] 收工' };

    w.stam -= stamCost;
    if (t.use) for (const k in t.use) S.supply[k] -= t.use[k];
    if (t.fuel) for (const k in t.fuel) S.supply[k] -= t.fuel[k];
    const gear = S.equip[sess.tool];
    const wasAlive = gear.dur > 0;
    gear.dur = Math.max(0, gear.dur - t.wear * (bestSkill(S, sess, 'mech') >= 3 ? 0.7 : 1));
    const broke = wasAlive && gear.dur <= 0;
    upkeep(S, sess);

    const lv = sess.lv, msgs = [], got = [];
    const skillBonus = 1 + (w.skill.mine || 0) * 0.05;
    let hits = 0;

    for (const [x, y] of patternCells(sess, target.x, target.y, t.pattern)) {
      if (x < 1 || y < 1 || x >= MS - 1 || y >= MS - 1) continue;
      const i = idx(x, y), cell = lv.map[i];
      if (cell === OPEN || cell === BED) continue;
      let dmg = t.power * skillBonus * S.weather.work * ((t.soft || 1) / TYPE[cell].hard);
      if (lv.wet[i] && !sess.pumpOn) dmg *= 0.4;
      dmg *= 0.85 + Math.random() * 0.3;
      lv.hp[i] -= dmg;
      hits++;
      if (lv.hp[i] <= 0) {
        lv.map[i] = OPEN; sess.dugCount++;
        const st = lv.nodes[i];
        if (st) {
          const crackAdd = t.crack * (0.5 + Math.random() * 0.8);
          J.addMiningCrack(st, crackAdd);
          st.note = crackAdd > 0.35 ? '開採震裂' : (crackAdd <= 0.02 ? '取料乾淨' : '');
          sess.stones.push(st); got.push(st);
          delete lv.nodes[i];
          msgs.push('💎 出料！' + st.kg + 'kg' + (crackAdd > 0.35 ? '（震出裂）' : ''));
        }
      }
    }

    sess.actions++;
    markSeen(sess);
    const acc = accident(S, sess, t, w);
    if (acc) msgs.push(acc);
    if (broke) msgs.push('🔧 ' + eq.name + ' 報廢了');
    return { ok: true, msg: msgs.join('　'), hits, got, target, stam: stamCost };
  }

  function upkeep(S, sess) {
    const a = sess.accum;
    if (sess.pumpOn && hasWorking(S, 'pump')) {
      if (++a.pump >= 3) { a.pump = 0; S.supply.diesel = Math.max(0, S.supply.diesel - 3); S.equip.pump.dur -= 1; }
      if (S.supply.diesel <= 0) { sess.pumpOn = false; sess.log.push('柴油用光，抽水機停了。'); }
    }
    if (sess.lightOn) {
      if (hasWorking(S, 'floodlight') && hasWorking(S, 'generator')) {
        if (++a.light >= 2) { a.light = 0; S.supply.diesel = Math.max(0, S.supply.diesel - 2); S.equip.generator.dur -= 1; }
      } else if (hasWorking(S, 'headlamp')) {
        if (++a.lamp >= 12) { a.lamp = 0; S.supply.battery = Math.max(0, S.supply.battery - 1); S.equip.headlamp.dur -= 1; }
      }
    }
  }

  function collapseRisk(S, sess) {
    const depth = sess.player.x / MS;
    let risk = sess.site.danger * (0.25 + depth * 1.5 + sess.dugCount / 900) * S.weather.danger;
    risk *= Math.max(0.25, 1 - sess.timbers * 0.18);
    if (sess.pumpOn) risk *= 0.9;
    if (!sess.lightOn) risk *= 1.25;
    return risk;
  }

  function accident(S, sess, t, w) {
    const helm = coverage(S, sess, 'helmet'), ropeC = coverage(S, sess, 'rope');
    let p = collapseRisk(S, sess) * 0.05 + (t.danger || 0) * 0.12;
    p *= 1.5 - helm * 0.5;
    p *= 1 - ropeC * EQUIP.rope.safety * 0.5;
    if (Math.random() > p) return null;

    const severe = Math.random() < 0.35 * (1 - coverage(S, sess, 'harness') * EQUIP.harness.safety);
    let days = severe ? 3 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 2);
    days = Math.max(1, Math.round(days * (1 - helm * EQUIP.helmet.safety)));
    if (hasWorking(S, 'firstaid') && S.supply.medicine > 0) { S.supply.medicine--; days = Math.max(1, days - 1); }
    if (hasWorking(S, 'radio') && severe) days = Math.max(1, Math.round(days * 0.65));
    w.injury += days; w.stam = Math.max(0, w.stam - 25); w.morale = Math.max(0, w.morale - 12);
    S.morale = Math.max(0, S.morale - 4);
    sess.collapsed++;

    // 塌方：坑道被土石回填
    let extra = '';
    if (Math.random() < 0.45) {
      const lv = sess.lv; let buried = 0;
      const px = Math.floor(sess.player.x), py = Math.floor(sess.player.y);
      for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) {
        const x = px + i, y = py + j, k = idx(x, y);
        if (x < 1 || y < 1 || x >= MS - 1 || y >= MS - 1) continue;
        if (lv.map[k] === OPEN && !lv.path[k] && Math.random() < 0.12) {
          lv.map[k] = ROCK; lv.hp[k] = TYPE[ROCK].hp * 0.5; buried++; sess.dugCount--;
        }
      }
      if (buried) extra = '，土石回填 ' + buried + ' 格';
    }
    const line = '⚠️ 落石！' + w.name + (severe ? ' 重傷' : ' 受傷') + '，休養 ' + days + ' 天' + extra;
    sess.log.push(line);
    return line;
  }

  function placeTimber(S, sess) {
    if (!hasWorking(S, 'timber')) return { ok: false, msg: '沒有坑木支撐架' };
    if ((S.supply.wood || 0) < 1) return { ok: false, msg: '沒有坑木了' };
    S.supply.wood--; sess.timbers++;
    return { ok: true, msg: '架好一組支撐（塌方 -18%）' };
  }
  function togglePump(S, sess) {
    if (!hasWorking(S, 'pump')) return { ok: false, msg: '沒有抽水機' };
    if (!sess.pumpOn && S.supply.diesel < 3) return { ok: false, msg: '柴油不夠' };
    sess.pumpOn = !sess.pumpOn;
    return { ok: true, msg: sess.pumpOn ? '抽水機運轉，水位下降' : '抽水機關閉' };
  }
  function toggleLight(S, sess) {
    if (!hasWorking(S, 'headlamp') && !hasWorking(S, 'floodlight')) return { ok: false, msg: '沒有照明設備' };
    sess.lightOn = !sess.lightOn;
    return { ok: true, msg: sess.lightOn ? '開燈' : '關燈' };
  }

  /* ================================================================
     第一人稱渲染器
     ================================================================ */
  const RW = 400, RH = 225;      // 內部解析度（放大到全螢幕）

  function FP(S, sess, onExit) {
    const wrap = document.createElement('div');
    wrap.id = 'fpwrap';
    wrap.innerHTML =
      '<canvas id="fpcv"></canvas>' +
      '<div id="fphud">' +
        '<div class="fp-top"><span id="fp-depth"></span><span id="fp-risk"></span><span id="fp-supply"></span></div>' +
        '<canvas id="fpmap" width="150" height="150"></canvas>' +
        '<div id="fp-msg"></div>' +
        '<div class="fp-target" id="fp-target"></div>' +
        '<div class="fp-bottom">' +
          '<div id="fp-worker"></div>' +
          '<div id="fp-tools"></div>' +
        '</div>' +
        '<div class="fp-help">滑鼠移動＝看　WASD＝走　左鍵/空白鍵＝挖　1~8＝換工具　T＝換人　F＝燈　P＝抽水　G＝架坑木　M＝地圖　Z＝過夜　Q＝收工</div>' +
      '</div>' +
      '<div id="fp-touch">' +
        '<div id="joy"><i></i></div>' +
        '<button id="btn-dig">⛏</button>' +
        '<div id="fp-actions">' +
          '<button data-k="tool">🔧工具</button>' +
          '<button data-k="T">👷換人</button>' +
          '<button data-k="F">💡燈</button>' +
          '<button data-k="P">💧抽水</button>' +
          '<button data-k="G">🪵坑木</button>' +
          '<button data-k="M">🗺地圖</button>' +
          '<button data-k="Z">😴過夜</button>' +
          '<button data-k="L">🔒固定</button>' +
          '<button data-k="FS">⛶全螢幕</button>' +
          '<button data-k="Q" class="quit">🎒收工</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(wrap);

    const cv = wrap.querySelector('#fpcv'), ctx = cv.getContext('2d');
    const mapCv = wrap.querySelector('#fpmap'), mapCtx = mapCv.getContext('2d');
    const buf = ctx.createImageData(RW, RH);
    const px = buf.data;
    const zbuf = new Float32Array(RW);
    const off = document.createElement('canvas'); off.width = RW; off.height = RH;
    const offCtx = off.getContext('2d');

    let running = true, showMap = false, msgT = 0, msg = '';
    let night = null;   // 過夜黑幕演出 { t, lines }
    const keys = {};
    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const joy = { f: 0, s: 0, id: null, ox: 0, oy: 0 };
    let digHold = false, lookId = null, lookX = 0;
    const particles = [];
    const swing = { t: 1, dur: 0.42, hit: false };

    /* ---- 隊友 NPC：散開找料、自動開挖 ---- */
    function mkNpc(wid, x, y) {
      return { wid, x, y, ang: 0, phase: Math.random() * 6, state: 'idle', path: null, pi: 0, target: 0, claim: 0, cool: 0.5 + Math.random() };
    }
    sess.claims = sess.claims || {};
    sess.npcs = sess.npcs || [];
    (function syncNpcs() {
      const lv = sess.lv;
      const have = {};
      sess.npcs.forEach(n => have[n.wid] = 1);
      const spots = [[0, 1], [0, -1], [1, 0], [1, 1], [1, -1], [-1, 0], [0, 2], [2, 0]];
      let si = 0;
      sess.team.forEach(id => {
        if (id === sess.active || have[id]) return;
        let px = lv.spawn.x, py = lv.spawn.y;
        while (si < spots.length) {
          const cx = Math.floor(lv.spawn.x) + spots[si][0], cy = Math.floor(lv.spawn.y) + spots[si][1];
          si++;
          if (lv.map[idx(cx, cy)] === OPEN) { px = cx + 0.5; py = cy + 0.5; break; }
        }
        sess.npcs.push(mkNpc(id, px, py));
      });
      // 自己不該同時是 NPC（重複進出坑道時）
      sess.npcs = sess.npcs.filter(n => n.wid !== sess.active);
    })();

    function release(npc) {
      if (npc.claim) { delete sess.claims[npc.claim]; npc.claim = 0; }
      npc.path = null; npc.target = 0;
    }

    // BFS：找最值錢又沒人認領的岩壁（有料 > 玉脈 > 一般），回傳走過去的路徑
    function findJob(npc) {
      const lv = sess.lv;
      const sx = Math.floor(npc.x), sy = Math.floor(npc.y);
      const start = idx(sx, sy);
      if (lv.map[start] !== OPEN) return false;
      const prev = new Map([[start, { p: -1, d: 0 }]]);
      const q = [start];
      let best = null, bestScore = -1;
      for (let qi = 0; qi < q.length && qi < 900; qi++) {
        const c = q[qi], cx = c % MS, cy = (c / MS) | 0, d = prev.get(c).d;
        for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = cx + ddx, ny = cy + ddy;
          if (nx < 1 || ny < 1 || nx >= MS - 1 || ny >= MS - 1) continue;
          const ni = idx(nx, ny), t = lv.map[ni];
          if (t === OPEN) {
            if (!prev.has(ni)) { prev.set(ni, { p: c, d: d + 1 }); q.push(ni); }
          } else if (t !== BED) {
            if (sess.claims[ni] && sess.claims[ni] !== npc.wid) continue;
            const sc = (lv.nodes[ni] ? 120 : 0) + (t === VEIN ? 8 : t === HARD ? 2 : 4) + nx * 0.15 - d * 0.6;
            if (sc > bestScore) { bestScore = sc; best = { open: c, wall: ni }; }
          }
        }
      }
      if (!best) return false;
      const path = [];
      let c = best.open;
      while (c !== -1 && c !== start) { path.push({ x: c % MS, y: (c / MS) | 0 }); c = prev.get(c).p; }
      path.reverse();
      npc.path = path; npc.pi = 0;
      npc.target = best.wall; npc.claim = best.wall;
      sess.claims[best.wall] = npc.wid;
      npc.state = 'walk';
      return true;
    }

    function npcStep(dt) {
      const lv = sess.lv;
      for (const npc of sess.npcs) {
        const w = worker(S, npc.wid);
        if (!w) continue;
        if (w.injury > 0 || w.stam < 10) { release(npc); npc.state = 'rest'; continue; }
        if (npc.state === 'rest') npc.state = 'idle';
        if (npc.state === 'idle') { findJob(npc); continue; }

        if (npc.state === 'walk') {
          if (lv.map[npc.target] === OPEN) { release(npc); npc.state = 'idle'; continue; }
          const tgt = npc.path && npc.path[npc.pi];
          if (!tgt) { npc.state = 'dig'; npc.cool = 0.4; continue; }
          const txc = tgt.x + 0.5, tyc = tgt.y + 0.5;
          const dx = txc - npc.x, dy = tyc - npc.y, dlen = Math.hypot(dx, dy);
          let sp = 2.2;
          if (lv.wet[idx(Math.floor(npc.x), Math.floor(npc.y))] && !sess.pumpOn) sp *= 0.5;
          if (dlen < 0.14) {
            npc.pi++;
            if (npc.pi >= npc.path.length) { npc.state = 'dig'; npc.cool = 0.4; }
          } else {
            npc.x += dx / dlen * sp * dt; npc.y += dy / dlen * sp * dt;
            npc.ang = Math.atan2(dy, dx);
            npc.phase += sp * dt * 3.2;
          }
          continue;
        }

        if (npc.state === 'dig') {
          const ti = npc.target;
          if (!ti || lv.map[ti] === OPEN || lv.map[ti] === BED) { release(npc); npc.state = 'idle'; continue; }
          const tx = ti % MS, ty = (ti / MS) | 0;
          npc.ang = Math.atan2(ty + 0.5 - npc.y, tx + 0.5 - npc.x);
          npc.phase += dt * 7;
          npc.cool -= dt;
          if (npc.cool > 0) continue;
          npc.cool = 1.15 - Math.min(0.4, (w.skill.mine || 0) * 0.04);
          const hasNode = !!lv.nodes[ti];
          const careful = hasNode && lv.hp[ti] < 35;      // 快見料就改鑿子小心敲
          const T = TYPE[lv.map[ti]];
          let dmg = (careful ? 13 : 24) * (1 + (w.skill.mine || 0) * 0.05) * S.weather.work / T.hard;
          if (lv.wet[ti] && !sess.pumpOn) dmg *= 0.4;
          lv.hp[ti] -= dmg * (0.85 + Math.random() * 0.3);
          w.stam -= Math.max(2, 4 - (w.skill.mine || 0) * 0.1);
          sess.actions++;
          if (lv.hp[ti] <= 0) {
            lv.map[ti] = OPEN; sess.dugCount++;
            const st = lv.nodes[ti];
            if (st) {
              const add = (careful ? 0.05 : 0.22) * (0.5 + Math.random() * 0.8);
              J.addMiningCrack(st, add);
              st.note = add <= 0.05 ? '取料乾淨' : '';
              sess.stones.push(st);
              delete lv.nodes[ti];
              say('💎 ' + w.name + ' 喊：出料了！' + st.kg + 'kg');
              sess.log.push(w.name + ' 挖出 ' + st.kg + 'kg 原石');
            }
            release(npc); npc.state = 'idle';
          }
          if (Math.random() < collapseRisk(S, sess) * 0.018) {
            const m = accident(S, sess, { danger: 0 }, w);
            if (m) say(m);
          }
        }
      }
    }

    let aiAcc = 0;
    function aiTick(dt) {
      if (night) return;
      aiAcc += dt;
      while (aiAcc >= 0.12) { aiAcc -= 0.12; npcStep(0.12); }
    }


    function resize() {
      cv.width = window.innerWidth; cv.height = window.innerHeight;
      ctx.imageSmoothingEnabled = false;
    }
    resize();
    window.addEventListener('resize', resize);

    /* ---- 輸入 ---- */
    function onKey(e, down) {
      keys[e.code] = down;
      if (!down) return;
      if (e.code === 'KeyQ' || e.code === 'Escape') { if (e.code === 'KeyQ') quit(); return; }
      if (e.code === 'Space') doDig();
      if (e.code === 'KeyZ') doSleep();
      if (e.code === 'KeyM') showMap = !showMap;
      if (e.code === 'KeyF') { const r = toggleLight(S, sess); say(r.msg); }
      if (e.code === 'KeyP') { const r = togglePump(S, sess); say(r.msg); }
      if (e.code === 'KeyG') { const r = placeTimber(S, sess); say(r.msg); }
      if (e.code === 'KeyT') nextWorker();
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 8) {
        const ids = Object.keys(EQUIP).filter(id => EQUIP[id].tool);
        const id = ids[n - 1];
        if (id) { const c = canUse(S, sess, id); if (c.ok) { sess.tool = id; say('換上 ' + EQUIP[id].name); hud(); } else say(c.why); }
      }
    }
    const kd = e => { if (['KeyW','KeyA','KeyS','KeyD','Space','KeyQ'].indexOf(e.code) >= 0) e.preventDefault(); onKey(e, true); };
    const ku = e => onKey(e, false);
    document.addEventListener('keydown', kd);
    document.addEventListener('keyup', ku);

    const mm = e => { if (document.pointerLockElement === cv) sess.player.ang += e.movementX * 0.0026; };
    document.addEventListener('mousemove', mm);
    cv.addEventListener('click', () => { if (document.pointerLockElement !== cv) cv.requestPointerLock(); });
    const md = e => { if (document.pointerLockElement === cv && e.button === 0) doDig(); };
    document.addEventListener('mousedown', md);

    /* ---- 觸控：左下搖桿走路、畫面拖曳轉頭、右下按住連挖 ---- */
    const touchUI = wrap.querySelector('#fp-touch');
    if (!isTouch) touchUI.style.display = 'none';
    else {
      wrap.querySelector('.fp-help').style.display = 'none';
      const joyEl = wrap.querySelector('#joy'), knob = joyEl.querySelector('i');
      const findT = (e, id) => { for (const t of e.changedTouches) if (t.identifier === id) return t; return null; };
      joyEl.addEventListener('touchstart', e => {
        e.preventDefault();
        const t = e.changedTouches[0];
        joy.id = t.identifier; joy.ox = t.clientX; joy.oy = t.clientY;
      }, { passive: false });
      joyEl.addEventListener('touchmove', e => {
        e.preventDefault();
        const t = findT(e, joy.id); if (!t) return;
        const dx = Math.max(-1, Math.min(1, (t.clientX - joy.ox) / 45));
        const dy = Math.max(-1, Math.min(1, (t.clientY - joy.oy) / 45));
        joy.f = -dy; joy.s = dx;
        knob.style.transform = 'translate(' + dx * 26 + 'px,' + dy * 26 + 'px)';
      }, { passive: false });
      const joyEnd = e => { const t = findT(e, joy.id); if (!t) return; joy.f = joy.s = 0; joy.id = null; knob.style.transform = ''; };
      joyEl.addEventListener('touchend', joyEnd);
      joyEl.addEventListener('touchcancel', joyEnd);

      cv.addEventListener('touchstart', e => { const t = e.changedTouches[0]; lookId = t.identifier; lookX = t.clientX; }, { passive: true });
      cv.addEventListener('touchmove', e => {
        e.preventDefault();
        const t = findT(e, lookId); if (!t) return;
        sess.player.ang += (t.clientX - lookX) * 0.006;
        lookX = t.clientX;
      }, { passive: false });

      const digBtn = wrap.querySelector('#btn-dig');
      digBtn.addEventListener('touchstart', e => { e.preventDefault(); digHold = true; doDig(); }, { passive: false });
      const digEnd = e => { e.preventDefault(); digHold = false; };
      digBtn.addEventListener('touchend', digEnd);
      digBtn.addEventListener('touchcancel', digEnd);

      wrap.querySelector('#fp-actions').addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        const k = b.dataset.k;
        if (k === 'tool') {
          const ids = Object.keys(EQUIP).filter(id => EQUIP[id].tool && canUse(S, sess, id).ok);
          if (!ids.length) { say('沒有能用的工具'); return; }
          const i = ids.indexOf(sess.tool);
          sess.tool = ids[(i + 1) % ids.length];
          say('換上 ' + EQUIP[sess.tool].name); hud();
        }
        else if (k === 'T') nextWorker();
        else if (k === 'F') say(toggleLight(S, sess).msg);
        else if (k === 'P') say(togglePump(S, sess).msg);
        else if (k === 'G') say(placeTimber(S, sess).msg);
        else if (k === 'M') showMap = !showMap;
        else if (k === 'Z') doSleep();
        else if (k === 'L') { if (global.UI && global.UI.toggleLock) { global.UI.toggleLock(); say('切換固定畫面'); } }
        else if (k === 'FS') { if (global.UI && global.UI.goFullscreen) global.UI.goFullscreen(); }
        else if (k === 'Q') quit();
      });
    }

    // 換人＝身體交換：你去接手隊友的位置，原本操控的人留在原地繼續幫挖
    function nextWorker() {
      const list = sess.team.filter(id => { const w = worker(S, id); return w && w.injury === 0; });
      if (list.length < 2) { say('沒有其他人能接手'); return; }
      const i = list.indexOf(sess.active);
      const nid = list[(i + 1) % list.length];
      if (nid === sess.active) return;
      const p = sess.player;
      sess.npcs.push(mkNpc(sess.active, p.x, p.y));
      const j = sess.npcs.findIndex(n => n.wid === nid);
      if (j >= 0) {
        const n = sess.npcs[j];
        p.x = n.x; p.y = n.y;
        if (n.claim) delete sess.claims[n.claim];
        sess.npcs.splice(j, 1);
      }
      sess.active = nid;
      const w = worker(S, nid);
      say('接手 ' + w.name + '（體力 ' + Math.round(w.stam) + '）— 原本那位留在原地繼續挖');
    }

    function say(m) { if (!m) return; msg = m; msgT = 2.6; }

    /* ---- 坑道過夜 ---- */
    function doSleep() {
      if (night) return;
      const r = global.GAME.sleepInMine();
      if (!r.ok) { say(r.msg); return; }
      night = {
        t: 0,
        lines: ['第 ' + S.day + ' 天　' + S.weather.icon + ' ' + S.weather.name]
          .concat((r.notes || []).slice(0, 5))
      };
      hud();
    }

    /* ---- 揮動：關節動畫 ---- */
    function doDig() {
      if (night) return;
      if (swing.t < 1) return;                 // 上一下還沒揮完
      const eq = EQUIP[sess.tool];
      const c = canUse(S, sess, sess.tool);
      if (!c.ok) { say(c.why); return; }
      swing.t = 0; swing.hit = false;
      swing.dur = eq.tool.pattern === 'blast' ? 1.1 : eq.tool.stam > 8 ? 0.6 : 0.42;
    }

    function applyHit() {
      const r = dig(S, sess);
      if (!r.ok) { say(r.msg); return; }
      if (r.msg) say(r.msg);
      // 碎屑粒子
      const t = r.target;
      const cell = t ? TYPE[t.t] || TYPE[1] : TYPE[1];
      const n = EQUIP[sess.tool].tool.pattern === 'blast' ? 90 : 26;
      for (let i = 0; i < n; i++) {
        particles.push({
          x: cv.width / 2 + (Math.random() - 0.5) * 90,
          y: cv.height / 2 + (Math.random() - 0.5) * 90,
          vx: (Math.random() - 0.5) * 620, vy: (Math.random() - 0.9) * 520,
          life: 0.5 + Math.random() * 0.6, max: 1.1,
          size: 1 + Math.random() * 3.5,
          c: cell.rgb
        });
      }
      (r.got || []).forEach(() => {
        for (let i = 0; i < 60; i++) particles.push({
          x: cv.width / 2, y: cv.height / 2,
          vx: (Math.random() - 0.5) * 700, vy: (Math.random() - 0.5) * 700,
          life: 0.9 + Math.random() * 0.7, max: 1.6, size: 1.5 + Math.random() * 3,
          c: [80, 240, 190], glow: true
        });
      });
      hud();
    }

    /* ---- 移動 ---- */
    function move(dt) {
      if (night) return;
      const p = sess.player, lv = sess.lv;
      const w = worker(S, sess.active);
      let sp = 2.7 * (keys.ShiftLeft ? 1.6 : 1);
      if (w && w.stam < 20) sp *= 0.6;
      const here = idx(Math.floor(p.x), Math.floor(p.y));
      if (lv.wet[here] && !sess.pumpOn) sp *= 0.45;             // 積水難走

      let fx = 0, fy = 0;
      if (keys.KeyW || keys.ArrowUp) fx += 1;
      if (keys.KeyS || keys.ArrowDown) fx -= 1;
      if (keys.KeyA) fy -= 1;
      if (keys.KeyD) fy += 1;
      fx += joy.f; fy += joy.s;
      if (keys.ArrowLeft) p.ang -= 1.8 * dt;
      if (keys.ArrowRight) p.ang += 1.8 * dt;
      if (Math.abs(fx) < 0.08 && Math.abs(fy) < 0.08) { p.bob *= 0.9; return; }

      const c = Math.cos(p.ang), s = Math.sin(p.ang);
      let dx = (c * fx - s * fy), dy = (s * fx + c * fy);
      const len = Math.hypot(dx, dy) || 1;
      dx = dx / len * sp * dt; dy = dy / len * sp * dt;
      const R = 0.28;
      const solid = (x, y) => {
        const t = lv.map[idx(Math.floor(x), Math.floor(y))];
        return t !== OPEN && t !== undefined;
      };
      if (!solid(p.x + dx + Math.sign(dx) * R, p.y)) p.x += dx;
      if (!solid(p.x, p.y + dy + Math.sign(dy) * R)) p.y += dy;
      p.bob += sp * dt * 3.4;
      markSeen(sess);
    }

    /* ---- 光線投射渲染 ---- */
    function render() {
      const p = sess.player, lv = sess.lv;
      const lightR = lightRadius(S, sess);
      const fov = 0.9;
      const dirX = Math.cos(p.ang), dirY = Math.sin(p.ang);
      const planeX = -dirY * fov, planeY = dirX * fov;
      const horizon = (RH >> 1) + Math.sin(p.bob) * 2.2;

      // 天花板與地板（含地上的導引線）
      for (let y = 0; y < RH; y++) {
        const isFloor = y > horizon;
        const rowDist = isFloor ? (0.5 * RH) / (y - horizon) : (0.5 * RH) / (horizon - y);
        const stepX = (dirX + planeX) * rowDist, stepY = (dirY + planeY) * rowDist;
        const dX = ((dirX - planeX) * rowDist - stepX) / RW, dY = ((dirY - planeY) * rowDist - stepY) / RW;
        let fxp = p.x + stepX, fyp = p.y + stepY;
        const fog = Math.max(0, 1 - rowDist / lightR);
        const shade = fog * fog;
        for (let x = 0; x < RW; x++) {
          const cxi = Math.floor(fxp), cyi = Math.floor(fyp);
          let r, g, b;
          if (isFloor) {
            const k = idx(cxi, cyi);
            const onPath = cxi > 0 && cyi > 0 && cxi < MS && cyi < MS && lv.path[k];
            const wetc = cxi > 0 && cyi > 0 && cxi < MS && cyi < MS && lv.wet[k] && !sess.pumpOn;
            const chk = ((cxi * 7 + cyi * 13) & 3) * 6;
            if (onPath) {
              // 螢光導引線：自體發光，黑暗中也看得見
              const pulse = 0.75 + 0.25 * Math.sin(perf * 3 + cxi + cyi);
              const em = Math.max(shade, 0.42 * pulse);
              r = 30 * em; g = (150 + 90 * pulse) * em; b = (120 + 60 * pulse) * em;
            } else if (wetc) { r = 20 * shade; g = (60 + chk) * shade; b = (95 + chk) * shade; }
            else { r = (62 + chk) * shade; g = (52 + chk) * shade; b = (40 + chk) * shade; }
          } else {
            const chk = ((cxi * 5 + cyi * 11) & 3) * 4;
            r = (30 + chk) * shade; g = (28 + chk) * shade; b = (26 + chk) * shade;
          }
          const o = (y * RW + x) << 2;
          px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
          fxp += dX; fyp += dY;
        }
      }

      // 牆面
      for (let x = 0; x < RW; x++) {
        const camX = 2 * x / RW - 1;
        const rdx = dirX + planeX * camX, rdy = dirY + planeY * camX;
        let mapX = Math.floor(p.x), mapY = Math.floor(p.y);
        const dDistX = Math.abs(1 / (rdx || 1e-6)), dDistY = Math.abs(1 / (rdy || 1e-6));
        let stepX2, stepY2, sideDistX, sideDistY;
        if (rdx < 0) { stepX2 = -1; sideDistX = (p.x - mapX) * dDistX; } else { stepX2 = 1; sideDistX = (mapX + 1 - p.x) * dDistX; }
        if (rdy < 0) { stepY2 = -1; sideDistY = (p.y - mapY) * dDistY; } else { stepY2 = 1; sideDistY = (mapY + 1 - p.y) * dDistY; }
        let hit = 0, side = 0, guard = 0;
        while (!hit && guard++ < 90) {
          if (sideDistX < sideDistY) { sideDistX += dDistX; mapX += stepX2; side = 0; }
          else { sideDistY += dDistY; mapY += stepY2; side = 1; }
          if (mapX < 0 || mapY < 0 || mapX >= MS || mapY >= MS) break;
          if (lv.map[idx(mapX, mapY)] !== OPEN) hit = 1;
        }
        if (!hit) { zbuf[x] = 1e9; continue; }
        const dist = side === 0 ? (sideDistX - dDistX) : (sideDistY - dDistY);
        zbuf[x] = dist;
        const h = Math.floor(RH / Math.max(dist, 0.12));
        let y0 = Math.floor(horizon - h / 2), y1 = Math.floor(horizon + h / 2);
        const cell = lv.map[idx(mapX, mapY)];
        const T = TYPE[cell] || TYPE[1];
        const k = idx(mapX, mapY);
        const dmg = 1 - Math.max(0, lv.hp[k]) / (T.hp * 2.2);      // 打過的痕跡
        const fog = Math.max(0, 1 - dist / lightR);
        let shade = fog * fog * (side ? 0.72 : 1);
        // 玉肉透光：快挖穿又有料時透出綠光
        const node = lv.nodes[k];
        const glow = node && lv.hp[k] < T.hp * 0.55 ? (1 - lv.hp[k] / (T.hp * 0.55)) : 0;
        let r = T.rgb[0], g = T.rgb[1], b = T.rgb[2];
        if (dmg > 0) { r += dmg * 55; g += dmg * 40; b += dmg * 20; }
        if (glow > 0) { r = r * (1 - glow) + 70 * glow; g = g * (1 - glow) + 255 * glow; b = b * (1 - glow) + 190 * glow; }
        if (lv.wet[k] && !sess.pumpOn) { r *= 0.7; g *= 0.9; b *= 1.25; }
        r *= shade; g *= shade; b *= shade;
        if (y0 < 0) y0 = 0; if (y1 > RH) y1 = RH;
        for (let y = y0; y < y1; y++) {
          const o = (y * RW + x) << 2;
          px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
        }
      }

      offCtx.putImageData(buf, 0, 0);

      // ---- 隊友（billboard，吃 zbuffer 遮擋與照明衰減） ----
      const labels = [];
      const order = sess.npcs
        .map(n => ({ n, d: (n.x - p.x) * (n.x - p.x) + (n.y - p.y) * (n.y - p.y) }))
        .sort((a, b) => b.d - a.d);
      const invDet = 1 / (planeX * dirY - dirX * planeY);
      for (const { n } of order) {
        const w = worker(S, n.wid);
        if (!w) continue;
        const dx = n.x - p.x, dy = n.y - p.y;
        const tX = invDet * (dirY * dx - dirX * dy);
        const tY = invDet * (-planeY * dx + planeX * dy);
        if (tY < 0.22) continue;
        const sx = Math.floor((RW / 2) * (1 + tX / tY));
        if (sx < -40 || sx > RW + 40) continue;
        const col = Math.max(0, Math.min(RW - 1, sx));
        if (tY >= zbuf[col] + 0.15) continue;                 // 被牆擋住
        const a = Math.max(0, Math.min(1, 1 - tY / lightR));
        if (a <= 0.04) continue;                              // 黑暗中看不見
        const h = Math.min(RH / tY, RH * 1.15);
        drawMiner(offCtx, sx, horizon, h, n, a);
        labels.push({ sx, top: horizon - h * 0.42, name: w.name, a, state: n.state, tY });
      }

      ctx.drawImage(off, 0, 0, RW, RH, 0, 0, cv.width, cv.height);

      // 名牌（放大後畫，才不會糊）
      const kx = cv.width / RW, ky = cv.height / RH;
      for (const L of labels) {
        if (L.tY > 7) continue;
        ctx.globalAlpha = L.a;
        ctx.font = '600 13px "Noto Sans TC",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = '#0009';
        const icon = L.state === 'dig' ? '⛏' : L.state === 'walk' ? '👣' : L.state === 'rest' ? '😮‍💨' : '·';
        const txt = icon + ' ' + L.name;
        const tx2 = L.sx * kx, ty2 = L.top * ky;
        ctx.fillRect(tx2 - ctx.measureText(txt).width / 2 - 5, ty2 - 13, ctx.measureText(txt).width + 10, 17);
        ctx.fillStyle = '#d9f5e8';
        ctx.fillText(txt, tx2, ty2);
        ctx.globalAlpha = 1;
      }
      ctx.textAlign = 'left';
    }

    // 迷你礦工人形：頭盔、身體、走路擺腿、挖掘揮臂
    function drawMiner(c2, sx, horizon, h, n, a) {
      const fy = horizon + h * 0.5;             // 腳踩地
      const hb = h * 0.58, wb = hb * 0.3;
      c2.save();
      c2.globalAlpha = a;
      c2.lineCap = 'round';
      const walk = n.state === 'walk' ? Math.sin(n.phase) : 0;
      // 腿
      c2.strokeStyle = '#2b3138'; c2.lineWidth = Math.max(1.5, wb * 0.3);
      c2.beginPath();
      c2.moveTo(sx, fy - hb * 0.45); c2.lineTo(sx - walk * wb * 0.5, fy);
      c2.moveTo(sx, fy - hb * 0.45); c2.lineTo(sx + walk * wb * 0.5, fy);
      c2.stroke();
      // 身體（工作背心）
      c2.fillStyle = n.state === 'rest' ? '#4a4438' : '#33584a';
      c2.fillRect(sx - wb / 2, fy - hb * 0.95, wb, hb * 0.52);
      // 頭 + 安全帽
      c2.fillStyle = '#a5745a';
      c2.beginPath(); c2.arc(sx, fy - hb * 1.04, hb * 0.12, 0, 7); c2.fill();
      c2.fillStyle = '#e8c46a';
      c2.beginPath(); c2.arc(sx, fy - hb * 1.07, hb * 0.13, Math.PI, 0); c2.fill();
      // 手臂（挖掘時掄鎬）
      const dig = n.state === 'dig';
      const armA = dig ? -0.7 + Math.abs(Math.sin(n.phase * 1.6)) * 1.5 : 0.5 + walk * 0.3;
      const shX = sx + wb * 0.45, shY = fy - hb * 0.88;
      const haX = shX + Math.cos(armA) * hb * 0.3, haY = shY + Math.sin(armA) * hb * 0.3;
      c2.strokeStyle = '#8a6547'; c2.lineWidth = Math.max(1.5, wb * 0.24);
      c2.beginPath(); c2.moveTo(shX, shY); c2.lineTo(haX, haY); c2.stroke();
      if (dig) {   // 鎬子
        c2.strokeStyle = '#c9d2da'; c2.lineWidth = Math.max(1, wb * 0.14);
        c2.beginPath(); c2.moveTo(haX, haY);
        c2.lineTo(haX + Math.cos(armA - 0.5) * hb * 0.34, haY + Math.sin(armA - 0.5) * hb * 0.34);
        c2.stroke();
      }
      c2.restore();
    }

    /* ---- 手臂關節動畫 ---- */
    function drawArm() {
      const W = cv.width, H = cv.height;
      const eq = EQUIP[sess.tool];
      if (!eq) return;
      const p = sess.player;
      const t = Math.min(1, swing.t);
      // 揮動曲線：抬起 → 下砸 → 收回
      const raise = t < 0.35 ? t / 0.35 : t < 0.55 ? 1 - (t - 0.35) / 0.2 * 1.35 : -0.35 + (t - 0.55) / 0.45 * 0.35;
      const bob = Math.sin(p.bob) * 0.02, bob2 = Math.cos(p.bob * 2) * 0.012;

      const pat = eq.tool.pattern;
      const heavy = pat === 'box3' || pat === 'blast' || eq.tool.power > 40;
      const S0 = { x: W * (0.80 + bob2), y: H * (1.16 + bob) };          // 肩
      const upper = H * 0.34, fore = H * 0.30;

      // 肩→肘→腕 的關節角度
      let a1 = -1.15 - raise * 0.95;             // 上臂
      let a2 = 0.85 + raise * 1.25;              // 前臂相對角
      if (pat === 'cross') { a1 += Math.sin(swing.t * 40) * 0.04; a2 += Math.cos(swing.t * 40) * 0.05; } // 風鎬震動
      if (heavy) { a1 -= 0.12; }

      const E = { x: S0.x + Math.cos(a1) * upper, y: S0.y + Math.sin(a1) * upper };
      const Hd = { x: E.x + Math.cos(a1 + a2) * fore, y: E.y + Math.sin(a1 + a2) * fore };

      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // 上臂（袖子）
      ctx.strokeStyle = '#2c3b33'; ctx.lineWidth = H * 0.085;
      ctx.beginPath(); ctx.moveTo(S0.x, S0.y); ctx.lineTo(E.x, E.y); ctx.stroke();
      // 前臂（皮膚）
      ctx.strokeStyle = '#8a6547'; ctx.lineWidth = H * 0.068;
      ctx.beginPath(); ctx.moveTo(E.x, E.y); ctx.lineTo(Hd.x, Hd.y); ctx.stroke();
      // 手套
      ctx.fillStyle = '#3a2f26';
      ctx.beginPath(); ctx.arc(Hd.x, Hd.y, H * 0.042, 0, 7); ctx.fill();

      // 工具本體：從手往前延伸
      const ta = a1 + a2 - 0.5;
      const tl = H * (heavy ? 0.34 : 0.26);
      const Tp = { x: Hd.x + Math.cos(ta) * tl, y: Hd.y + Math.sin(ta) * tl };
      ctx.strokeStyle = '#6b4d2f'; ctx.lineWidth = H * 0.022;
      ctx.beginPath(); ctx.moveTo(Hd.x, Hd.y); ctx.lineTo(Tp.x, Tp.y); ctx.stroke();

      ctx.translate(Tp.x, Tp.y); ctx.rotate(ta);
      ctx.fillStyle = '#c9d2da';
      const s = H * 0.001;
      switch (sess.tool) {
        case 'pickaxe':
          ctx.fillRect(-60 * s, -6 * s, 120 * s, 12 * s);
          ctx.beginPath(); ctx.moveTo(60 * s, 0); ctx.lineTo(30 * s, -22 * s); ctx.lineTo(34 * s, 6 * s); ctx.fill(); break;
        case 'sledge': ctx.fillRect(-26 * s, -34 * s, 52 * s, 68 * s); break;
        case 'chisel':
          ctx.fillStyle = '#b9c2cc'; ctx.fillRect(-8 * s, -8 * s, 70 * s, 16 * s);
          ctx.beginPath(); ctx.moveTo(62 * s, -8 * s); ctx.lineTo(78 * s, 0); ctx.lineTo(62 * s, 8 * s); ctx.fill(); break;
        case 'shovel':
          ctx.beginPath(); ctx.ellipse(30 * s, 0, 38 * s, 26 * s, 0, 0, 7); ctx.fill(); break;
        case 'prybar':
          ctx.fillRect(-70 * s, -5 * s, 140 * s, 10 * s);
          ctx.beginPath(); ctx.moveTo(70 * s, -5 * s); ctx.lineTo(92 * s, -16 * s); ctx.lineTo(92 * s, 4 * s); ctx.fill(); break;
        case 'jackhammer':
          ctx.fillStyle = '#d8a13a'; ctx.fillRect(-40 * s, -22 * s, 80 * s, 44 * s);
          ctx.fillStyle = '#9aa3ad'; ctx.fillRect(40 * s, -7 * s, 90 * s, 14 * s); break;
        case 'excavator':
          ctx.fillStyle = '#e0a92b'; ctx.fillRect(-90 * s, -18 * s, 180 * s, 30 * s);
          ctx.fillStyle = '#8c939b';
          ctx.beginPath(); ctx.moveTo(90 * s, -18 * s); ctx.lineTo(150 * s, 10 * s); ctx.lineTo(90 * s, 40 * s); ctx.fill(); break;
        case 'dynamite_kit':
          ctx.fillStyle = '#c0392b'; ctx.fillRect(-14 * s, -34 * s, 28 * s, 68 * s);
          ctx.strokeStyle = '#e8c46a'; ctx.lineWidth = 3 * s;
          ctx.beginPath(); ctx.moveTo(0, -34 * s); ctx.quadraticCurveTo(30 * s, -60 * s, 60 * s, -40 * s); ctx.stroke(); break;
        default: ctx.fillRect(-30 * s, -8 * s, 60 * s, 16 * s);
      }
      ctx.restore();
    }

    /* ---- 粒子 ---- */
    function drawParticles(dt) {
      for (let i = particles.length - 1; i >= 0; i--) {
        const q = particles[i];
        q.life -= dt;
        if (q.life <= 0) { particles.splice(i, 1); continue; }
        q.vy += 1400 * dt;
        q.x += q.vx * dt; q.y += q.vy * dt;
        const a = Math.max(0, q.life / q.max);
        ctx.fillStyle = 'rgba(' + (q.c[0] | 0) + ',' + (q.c[1] | 0) + ',' + (q.c[2] | 0) + ',' + a + ')';
        if (q.glow) { ctx.shadowColor = 'rgba(80,255,200,.9)'; ctx.shadowBlur = 12; }
        ctx.fillRect(q.x, q.y, q.size, q.size);
        ctx.shadowBlur = 0;
      }
    }

    /* ---- 小地圖（只畫走過的地方） ---- */
    function drawMap() {
      const lv = sess.lv, p = sess.player;
      const R = 14, cell = 150 / (R * 2);
      mapCtx.clearRect(0, 0, 150, 150);
      mapCtx.fillStyle = 'rgba(4,8,10,.85)'; mapCtx.fillRect(0, 0, 150, 150);
      for (let j = -R; j < R; j++) for (let i = -R; i < R; i++) {
        const x = Math.floor(p.x) + i, y = Math.floor(p.y) + j;
        if (x < 0 || y < 0 || x >= MS || y >= MS) continue;
        const k = idx(x, y);
        if (!lv.seen[k]) continue;
        const t = lv.map[k];
        mapCtx.fillStyle = t === OPEN ? (lv.path[k] ? '#2f8f6d' : '#20272e') : (t === VEIN ? '#2b4a3f' : '#3a4048');
        mapCtx.fillRect((i + R) * cell, (j + R) * cell, cell, cell);
      }
      mapCtx.fillStyle = '#5db2ff';
      for (const n of sess.npcs) {
        const mx = 75 + (n.x - p.x) * cell, my = 75 + (n.y - p.y) * cell;
        if (mx > 2 && my > 2 && mx < 148 && my < 148) { mapCtx.beginPath(); mapCtx.arc(mx, my, 2.2, 0, 7); mapCtx.fill(); }
      }
      mapCtx.fillStyle = '#ffd76a';
      mapCtx.beginPath(); mapCtx.arc(75, 75, 3, 0, 7); mapCtx.fill();
      mapCtx.strokeStyle = '#ffd76a'; mapCtx.beginPath(); mapCtx.moveTo(75, 75);
      mapCtx.lineTo(75 + Math.cos(p.ang) * 11, 75 + Math.sin(p.ang) * 11); mapCtx.stroke();
    }

    /* ---- HUD ---- */
    function hud() {
      const w = worker(S, sess.active);
      const risk = collapseRisk(S, sess);
      wrap.querySelector('#fp-depth').textContent = '深度 ' + Math.round(sess.player.x) + 'm　產出 ' + sess.stones.length + ' 顆';
      wrap.querySelector('#fp-risk').innerHTML = '塌方 <b style="color:' +
        (risk > 0.3 ? '#ff6b6b' : '#3fd6a4') + '">' + (risk < 0.15 ? '低' : risk < 0.3 ? '中' : risk < 0.5 ? '高' : '極高') + '</b>' +
        '　坑木 ' + sess.timbers;
      wrap.querySelector('#fp-supply').textContent =
        '🛢' + Math.round(S.supply.diesel) + '　🔋' + S.supply.battery + '　🧨' + S.supply.dynamite + '　🪵' + S.supply.wood +
        (sess.pumpOn ? '　💧抽水中' : '') + (sess.lightOn ? '　💡燈亮' : '　🌑無燈');
      if (w) {
        const stateTxt = { idle: '找目標', walk: '走向岩壁', dig: '⛏ 開挖中', rest: '沒力了' };
        const mates = sess.npcs.map(n => {
          const m = worker(S, n.wid);
          if (!m) return '';
          return '<div class="fp-mate"><span>' + m.name + '</span><span class="tiny">' +
            (m.injury > 0 ? '🩹 養傷' : stateTxt[n.state] || n.state) +
            '　' + Math.round(m.stam) + '</span></div>';
        }).join('');
        wrap.querySelector('#fp-worker').innerHTML =
          '<b>' + w.name + '</b> <span class="tiny">' + global.DATA.ROLES[w.role].name + '（你）</span>' +
          '<div class="fp-bar"><i style="width:' + Math.max(0, w.stam / w.maxStam * 100) + '%"></i></div>' +
          '<span class="tiny">體力 ' + Math.round(w.stam) + '/' + w.maxStam + '　[T] 接手隊友</span>' +
          (mates ? '<hr style="border-color:#26303d;margin:6px 0">' + mates : '');
      }
      const ids = Object.keys(EQUIP).filter(id => EQUIP[id].tool);
      wrap.querySelector('#fp-tools').innerHTML = ids.map((id, i) => {
        const ok = canUse(S, sess, id).ok;
        return '<span class="fp-tool ' + (sess.tool === id ? 'on' : '') + (ok ? '' : ' off') + '">' +
          (i + 1) + ' ' + EQUIP[id].icon + EQUIP[id].name + '</span>';
      }).join('');
    }
    hud();

    /* ---- 主迴圈 ---- */
    let last = performance.now(), perf = 0, hudT = 0;
    function loop(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now; perf += dt;

      move(dt);
      aiTick(dt);
      if (swing.t < 1) {
        swing.t += dt / swing.dur;
        if (!swing.hit && swing.t >= 0.5) { swing.hit = true; applyHit(); }
        if (swing.t >= 1 && (keys.Space || digHold)) doDig();
      }
      render();
      drawArm();
      drawParticles(dt);

      // 準心與目標資訊
      const tgt = aim(sess, 2.0);
      ctx.strokeStyle = tgt ? 'rgba(255,220,120,.9)' : 'rgba(255,255,255,.35)';
      ctx.lineWidth = 2;
      const cxp = cv.width / 2, cyp = cv.height / 2;
      ctx.beginPath();
      ctx.moveTo(cxp - 10, cyp); ctx.lineTo(cxp - 3, cyp);
      ctx.moveTo(cxp + 3, cyp); ctx.lineTo(cxp + 10, cyp);
      ctx.moveTo(cxp, cyp - 10); ctx.lineTo(cxp, cyp - 3);
      ctx.moveTo(cxp, cyp + 3); ctx.lineTo(cxp, cyp + 10);
      ctx.stroke();

      const tEl = wrap.querySelector('#fp-target');
      if (tgt) {
        const T = TYPE[tgt.t], k = idx(tgt.x, tgt.y);
        const pct = Math.max(0, Math.min(1, sess.lv.hp[k] / (T.hp * 2.2)));
        tEl.style.display = 'block';
        tEl.innerHTML = T.name + '　<span class="fp-hpbar"><i style="width:' + (pct * 100) + '%"></i></span>';
      } else tEl.style.display = 'none';

      if (showMap) { mapCv.style.display = 'block'; drawMap(); } else mapCv.style.display = 'none';

      // 過夜：黑幕淡入 → 顯示結算 → 淡出醒來
      if (night) {
        night.t += dt;
        const t = night.t;
        const a = t < 0.9 ? t / 0.9 : t < 3.2 ? 1 : Math.max(0, (4.1 - t) / 0.9);
        ctx.fillStyle = 'rgba(0,0,0,' + a + ')';
        ctx.fillRect(0, 0, cv.width, cv.height);
        if (t > 0.9 && t < 3.4) {
          ctx.textAlign = 'center';
          ctx.fillStyle = '#e8c46a';
          ctx.font = '700 30px "Noto Sans TC",sans-serif';
          ctx.fillText('😴 坑道裡的一夜', cv.width / 2, cv.height * 0.32);
          ctx.font = '15px "Noto Sans TC",sans-serif';
          night.lines.forEach((ln, i) => {
            ctx.fillStyle = ln.indexOf('⚠️') === 0 ? '#ff8f8f' : '#cfe3da';
            ctx.fillText(ln, cv.width / 2, cv.height * 0.42 + i * 26);
          });
          ctx.textAlign = 'left';
        }
        if (t >= 4.1) { night = null; say('天亮了，繼續開工。'); }
      }

      if (msgT > 0) { msgT -= dt; const el = wrap.querySelector('#fp-msg'); el.textContent = msg; el.style.opacity = Math.min(1, msgT); }
      hudT += dt; if (hudT > 0.25) { hudT = 0; hud(); }

      requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    function quit() {
      running = false;
      document.removeEventListener('keydown', kd);
      document.removeEventListener('keyup', ku);
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mousedown', md);
      window.removeEventListener('resize', resize);
      if (document.pointerLockElement) document.exitPointerLock();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      wrap.remove();
      onExit && onExit();
    }

    return { quit };
  }

  function enter(S, onExit) {
    const el = document.documentElement;
    const fs = el.requestFullscreen || el.webkitRequestFullscreen;
    if (fs) { try { const r = fs.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
    return FP(S, S.session, onExit);
  }

  global.MINE = {
    MS, TYPE, start, enter, dig, canUse, hasWorking, coverage,
    placeTimber, togglePump, toggleLight, collapseRisk, lightRadius, aim
  };
})(window);
