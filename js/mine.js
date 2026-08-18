/* ============================================================
   開玉 — 礦場作業（上山開礦的互動核心）
   岩壁格網 / 照明迷霧 / 水位 / 塌方 / 各式設備的實際手感
   ============================================================ */
(function (global) {
  'use strict';
  const { EQUIP, SITES } = global.DATA;
  const J = global.JADE;

  const W = 18, H = 12;
  const CELL = {
    dirt: { name: '表土', hp: 14, hard: 0.6, col: '#6b5334' },
    rock: { name: '圍岩', hp: 42, hard: 1.0, col: '#4a4f57' },
    hard: { name: '硬岩', hp: 92, hard: 1.7, col: '#33373d' },
    vein: { name: '玉脈帶', hp: 58, hard: 1.2, col: '#2f5f4f' }
  };

  const PATTERNS = {
    single: [[0, 0]],
    vert3: [[0, 0], [0, 1], [0, 2]],
    horz3: [[-1, 0], [0, 0], [1, 0]],
    cross: [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]],
    box3: [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]],
    blast: (function () {
      const a = [];
      for (let x = -2; x <= 2; x++) for (let y = -2; y <= 2; y++) if (Math.abs(x) + Math.abs(y) <= 2) a.push([x, y]);
      return a;
    })()
  };

  /* ---------------- 產生礦場 ---------------- */
  function buildGrid(site, day) {
    const g = [];
    const waterRow = Math.round(H - 1 - site.water * (H - 4));
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < W; x++) {
        let t;
        const depth = y / (H - 1);
        const r = Math.random();
        if (y === 0) t = 'dirt';
        else if (depth < 0.22) t = r < 0.75 ? 'dirt' : 'rock';
        else if (depth < 0.5) t = r < 0.55 ? 'rock' : (r < 0.85 ? 'dirt' : 'vein');
        else t = r < 0.42 ? 'rock' : (r < 0.72 ? 'hard' : 'vein');
        const base = CELL[t];
        const hp = Math.round(base.hp * (0.8 + depth * 0.9) * site.hardness);
        // 出料機率：越深越高，玉脈帶最高
        let p = site.density * (0.35 + depth * 1.5) * (t === 'vein' ? 2.4 : t === 'hard' ? 1.1 : t === 'rock' ? 0.7 : 0.15);
        p = Math.min(p, 0.3);
        const hasStone = y > 1 && Math.random() < p;
        row.push({
          x, y, t, hp, maxhp: hp, dug: false, seen: false,
          water: y >= waterRow,
          stone: hasStone ? J.makeStone(site, { sizeMul: 0.6 + depth * 0.9, luck: (depth - 0.5) * 0.25 }) : null,
          timber: false
        });
      }
      g.push(row);
    }
    return { g, waterRow };
  }

  /* ---------------- 開工 ---------------- */
  function start(S, siteId, teamIds) {
    const site = SITES.find(s => s.id === siteId);
    const built = buildGrid(site, S.day);
    const sess = {
      site, siteId,
      grid: built.g, waterRow: built.waterRow,
      team: teamIds.slice(),
      active: teamIds[0] || null,
      tool: firstTool(S),
      stones: [],
      pumpOn: false, lightOn: hasWorking(S, 'headlamp') || hasWorking(S, 'floodlight'),
      timbers: 0,
      dugCount: 0,
      actions: 0,
      accum: { pump: 0, light: 0, lamp: 0 },
      collapsed: 0,
      log: [],
      over: false
    };
    reveal(S, sess);
    return sess;
  }

  function firstTool(S) {
    const order = ['pickaxe', 'shovel', 'chisel', 'prybar', 'sledge', 'jackhammer', 'excavator', 'dynamite_kit'];
    for (const id of order) if (hasWorking(S, id)) return id;
    return null;
  }

  function hasWorking(S, id) {
    const e = S.equip[id];
    return !!(e && e.qty > 0 && e.dur > 0);
  }

  /* ---------------- 照明與可見度 ---------------- */
  function lightRadius(S, sess) {
    let r = 1; // 洞口自然光
    if (sess.lightOn && hasWorking(S, 'headlamp')) r = Math.max(r, 1 + EQUIP.headlamp.light);
    if (sess.lightOn && hasWorking(S, 'floodlight') && hasWorking(S, 'generator')) r = Math.max(r, 1 + EQUIP.floodlight.light);
    if (S.weather.id === 'fog') r -= 1;
    return Math.max(1, r);
  }

  function reveal(S, sess) {
    const r = lightRadius(S, sess);
    const g = sess.grid;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (y === 0) { g[y][x].seen = true; continue; }
      if (g[y][x].seen) continue;
      let ok = false;
      for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r && !ok; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (Math.abs(dx) + Math.abs(dy) > r + 1) continue;
        if (g[ny][nx].dug) ok = true;
      }
      if (ok) g[y][x].seen = true;
    }
  }

  function accessible(sess, x, y) {
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    const g = sess.grid;
    if (g[y][x].dug) return false;
    if (y === 0) return true;
    const n = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return n.some(([dx, dy]) => {
      const nx = x + dx, ny = y + dy;
      return nx >= 0 && ny >= 0 && nx < W && ny < H && g[ny][nx].dug;
    });
  }

  /* ---------------- 執行一次挖掘 ---------------- */
  function canUse(S, sess, toolId) {
    const eq = EQUIP[toolId];
    if (!eq || !eq.tool) return { ok: false, why: '沒有這個工具' };
    if (!hasWorking(S, toolId)) return { ok: false, why: eq.name + ' 沒有或已損壞' };
    const t = eq.tool;
    for (const need of (t.needs || [])) {
      if (!hasWorking(S, need)) return { ok: false, why: '需要 ' + EQUIP[need].name };
    }
    if (t.use) for (const k in t.use) {
      if ((S.supply[k] || 0) < t.use[k]) return { ok: false, why: '缺 ' + global.DATA.SUPPLY[k].name };
    }
    if (t.fuel) for (const k in t.fuel) {
      if ((S.supply[k] || 0) < t.fuel[k]) return { ok: false, why: '缺 ' + global.DATA.SUPPLY[k].name };
    }
    // 機具與爆破必須由「當前選定的工人」親自操作
    if (t.skill) {
      const w = worker(S, sess.active);
      if (!w) return { ok: false, why: '沒有選定工人' };
      for (const k in t.skill) {
        if ((w.skill[k] || 0) < t.skill[k]) {
          const able = sess.team.map(id => worker(S, id)).filter(x => x && (x.skill[k] || 0) >= t.skill[k]);
          return {
            ok: false,
            why: able.length
              ? '要由 ' + able.map(x => x.name).join('、') + ' 操作（' + skillName(k) + ' ' + t.skill[k] + '↑）'
              : '隊上沒有 ' + skillName(k) + ' ' + t.skill[k] + ' 以上的人'
          };
        }
      }
    }
    return { ok: true };
  }

  function skillName(k) { return { mine: '採礦', blast: '爆破', mech: '機械', eye: '相玉' }[k] || k; }
  function worker(S, id) { return S.workers.find(w => w.id === id); }

  function dig(S, sess, cx, cy) {
    if (sess.over) return { ok: false, msg: '今天已經收工了。' };
    const chk = canUse(S, sess, sess.tool);
    if (!chk.ok) return { ok: false, msg: chk.why };
    const w = worker(S, sess.active);
    if (!w) return { ok: false, msg: '先在左邊選一個工人。' };
    if (w.injury > 0) return { ok: false, msg: w.name + ' 受傷中，下不了坑。' };

    const eq = EQUIP[sess.tool], t = eq.tool;
    if (!accessible(sess, cx, cy)) return { ok: false, msg: '挖不到那裡 — 只能從洞口或已挖開的地方往裡推進。' };

    const stamCost = Math.round(t.stam * (1 - (w.skill.mine || 0) * 0.03) * (S.weather.work < 1 ? 1.15 : 1));
    if (w.stam < stamCost) return { ok: false, msg: w.name + ' 沒力氣了，換人或收工。' };

    // 消耗
    w.stam -= stamCost;
    if (t.use) for (const k in t.use) S.supply[k] -= t.use[k];
    if (t.fuel) for (const k in t.fuel) S.supply[k] -= t.fuel[k];
    const wear = t.wear * (bestSkill(S, sess, 'mech') >= 3 ? 0.7 : 1);
    const gear = S.equip[sess.tool];
    const wasAlive = gear.dur > 0;
    gear.dur = Math.max(0, gear.dur - wear);
    const broke = wasAlive && gear.dur <= 0;

    // 支援設備耗材
    upkeep(S, sess);

    const msgs = [];
    const pat = PATTERNS[t.pattern] || PATTERNS.single;
    const skillBonus = 1 + (w.skill.mine || 0) * 0.05;
    let hits = 0;

    for (const [dx, dy] of pat) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const c = sess.grid[y][x];
      if (c.dug) continue;
      const base = CELL[c.t];
      let dmg = t.power * skillBonus * S.weather.work;
      dmg *= (t.soft || 1) / base.hard;
      if (c.water && !sess.pumpOn) dmg *= 0.4;                // 水下作業效率腰斬
      dmg *= 0.85 + Math.random() * 0.3;
      c.hp -= dmg;
      hits++;
      if (c.hp <= 0) {
        c.dug = true; sess.dugCount++;
        if (c.stone) {
          const crackAdd = t.crack * (0.5 + Math.random() * 0.8);
          J.addMiningCrack(c.stone, crackAdd);
          c.stone.note = crackAdd > 0.35 ? '開採震裂' : (crackAdd <= 0.02 ? '取料乾淨' : '');
          sess.stones.push(c.stone);
          msgs.push('💎 出料！' + c.stone.kg + 'kg 原石' + (crackAdd > 0.35 ? '（可惜震出裂）' : ''));
          c.stone = null;
        }
      }
    }

    sess.actions++;
    reveal(S, sess);

    // 危險判定
    const acc = accident(S, sess, t, w);
    if (acc) msgs.push(acc);

    if (broke) { msgs.push('🔧 ' + eq.name + ' 用到報廢了，回補給站維修。'); sess.log.push(eq.name + ' 報廢'); }
    if (hits === 0) msgs.push('打在空處，白費力氣。');
    return { ok: true, msg: msgs.join('　'), stam: stamCost };
  }

  function bestSkill(S, sess, key) {
    return sess.team.map(id => worker(S, id)).filter(Boolean)
      .reduce((m, x) => Math.max(m, x.skill[key] || 0), 0);
  }

  function upkeep(S, sess) {
    const a = sess.accum;
    if (sess.pumpOn && hasWorking(S, 'pump')) {
      a.pump += 1;
      if (a.pump >= 3) { a.pump = 0; S.supply.diesel = Math.max(0, S.supply.diesel - 3); S.equip.pump.dur -= 1; }
      if (S.supply.diesel <= 0) { sess.pumpOn = false; sess.log.push('柴油用光，抽水機停了，水又漫上來。'); }
    }
    if (sess.lightOn) {
      if (hasWorking(S, 'floodlight') && hasWorking(S, 'generator')) {
        a.light += 1;
        if (a.light >= 2) { a.light = 0; S.supply.diesel = Math.max(0, S.supply.diesel - 2); S.equip.generator.dur -= 1; }
      } else if (hasWorking(S, 'headlamp')) {
        a.lamp += 1;
        if (a.lamp >= 12) { a.lamp = 0; S.supply.battery = Math.max(0, S.supply.battery - 1); S.equip.headlamp.dur -= 1; }
      }
    }
  }

  /* ---- 塌方 / 落石 / 意外 ---- */
  function collapseRisk(S, sess) {
    const depthFactor = sess.dugCount / (W * H);
    let risk = sess.site.danger * (0.25 + depthFactor * 1.8) * S.weather.danger;
    risk *= Math.max(0.25, 1 - sess.timbers * 0.18);          // 坑木
    if (sess.pumpOn) risk *= 0.9;
    if (!sess.lightOn) risk *= 1.25;
    return risk;
  }

  // 安全裝備覆蓋率：一人一頂才算全隊配齊
  function coverage(S, sess, id) {
    const e = S.equip[id];
    if (!e || e.qty <= 0 || e.dur <= 0) return 0;
    return Math.min(1, e.qty / Math.max(1, sess.team.length));
  }

  function accident(S, sess, t, w) {
    const helm = coverage(S, sess, 'helmet');
    const ropeC = coverage(S, sess, 'rope');
    let p = collapseRisk(S, sess) * 0.05 + (t.danger || 0) * 0.12;
    p *= 1.5 - helm * 0.5;                       // 沒安全帽風險 ×1.5
    p *= 1 - ropeC * EQUIP.rope.safety * 0.5;    // 安全繩降低墜落
    if (Math.random() > p) return null;

    // 事故發生
    const severe = Math.random() < 0.35 * (1 - coverage(S, sess, 'harness') * EQUIP.harness.safety);
    let days = severe ? 3 + Math.floor(Math.random() * 4) : 1 + Math.floor(Math.random() * 2);
    days = Math.max(1, Math.round(days * (1 - helm * EQUIP.helmet.safety)));
    if (hasWorking(S, 'firstaid') && S.supply.medicine > 0) { S.supply.medicine--; days = Math.max(1, days - 1); }
    if (hasWorking(S, 'radio') && severe) { days = Math.max(1, Math.round(days * 0.65)); sess.log.push('📻 無線電叫到山下支援，傷者及早送醫。'); }
    w.injury += days;
    w.stam = Math.max(0, w.stam - 25);
    w.morale = Math.max(0, w.morale - 12);
    S.morale = Math.max(0, S.morale - 4);
    sess.collapsed++;

    // 大塌方：埋掉一部分已開挖面，可能壓壞今天的料
    let extra = '';
    if (Math.random() < 0.4) {
      let buried = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const c = sess.grid[y][x];
        if (c.dug && Math.random() < 0.06) { c.dug = false; c.hp = c.maxhp * 0.5; buried++; sess.dugCount--; }
      }
      if (sess.stones.length && Math.random() < 0.3) {
        const lost = sess.stones.pop();
        extra = '，還壓掉一顆 ' + lost.kg + 'kg 的料';
      }
      extra = '土石回填 ' + buried + ' 格' + extra;
    }
    const line = '⚠️ 事故！' + w.name + (severe ? ' 重傷' : ' 受傷') + '，休養 ' + days + ' 天。' + extra;
    sess.log.push(line);
    return line;
  }

  /* ---- 架坑木 ---- */
  function placeTimber(S, sess) {
    if (!hasWorking(S, 'timber')) return { ok: false, msg: '沒有坑木支撐架' };
    if ((S.supply.wood || 0) < 1) return { ok: false, msg: '沒有坑木了' };
    S.supply.wood--;
    sess.timbers++;
    return { ok: true, msg: '架好一組支撐，坑壁穩了不少（塌方風險 -18%）。' };
  }

  function togglePump(S, sess) {
    if (!hasWorking(S, 'pump')) return { ok: false, msg: '沒有抽水機' };
    if (!sess.pumpOn && S.supply.diesel < 3) return { ok: false, msg: '柴油不夠發動抽水機' };
    sess.pumpOn = !sess.pumpOn;
    return { ok: true, msg: sess.pumpOn ? '抽水機轟隆隆運轉，坑底水位開始下降。' : '抽水機關了。' };
  }

  function toggleLight(S, sess) {
    if (!hasWorking(S, 'headlamp') && !hasWorking(S, 'floodlight')) return { ok: false, msg: '沒有任何照明設備' };
    sess.lightOn = !sess.lightOn;
    if (sess.lightOn) reveal(S, sess);
    return { ok: true, msg: sess.lightOn ? '燈亮了，看得清楚多了。' : '關燈，省點電。' };
  }

  /* ---------------- 繪圖 ---------------- */
  function draw(cv, S, sess, hover) {
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const cw = w / W, ch = h / H;
    ctx.clearRect(0, 0, w, h);

    // 天空/洞口漸層背景
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#1b2430'); bg.addColorStop(1, '#0a0d12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);

    const r = lightRadius(S, sess);

    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = sess.grid[y][x];
      const px = x * cw, py = y * ch;

      if (!c.seen) { ctx.fillStyle = '#05070a'; ctx.fillRect(px, py, cw - 1, ch - 1); continue; }

      if (c.dug) {
        ctx.fillStyle = c.water && !sess.pumpOn ? '#123244' : '#14181f';
        ctx.fillRect(px, py, cw - 1, ch - 1);
      } else {
        const base = CELL[c.t];
        ctx.fillStyle = base.col;
        ctx.fillRect(px, py, cw - 1, ch - 1);
        // 損傷顯示
        const dmg = 1 - c.hp / c.maxhp;
        if (dmg > 0.02) {
          ctx.fillStyle = 'rgba(255,220,150,' + (dmg * 0.45) + ')';
          ctx.fillRect(px, py, cw - 1, ch - 1);
        }
        if (c.water && !sess.pumpOn) {
          ctx.fillStyle = 'rgba(40,120,180,0.35)';
          ctx.fillRect(px, py, cw - 1, ch - 1);
        }
        // 玉脈紋理
        if (c.t === 'vein') {
          ctx.strokeStyle = 'rgba(120,230,190,0.45)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(px + 3, py + ch - 5); ctx.lineTo(px + cw - 4, py + 4); ctx.stroke();
        }
        // 已探明可見的料（有燈才看得出隱約綠光）
        if (c.stone && sess.lightOn && dmg > 0.35) {
          ctx.fillStyle = 'rgba(90,255,190,0.5)';
          ctx.beginPath(); ctx.arc(px + cw / 2, py + ch / 2, Math.min(cw, ch) * 0.22, 0, 7); ctx.fill();
        }
      }
      if (c.timber) { ctx.strokeStyle = '#a97c3f'; ctx.lineWidth = 2; ctx.strokeRect(px + 2, py + 2, cw - 5, ch - 5); }

      if (accessible(sess, x, y)) {
        ctx.strokeStyle = 'rgba(120,220,180,0.25)'; ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, cw - 2, ch - 2);
      }
    }

    // 水線
    ctx.strokeStyle = sess.pumpOn ? 'rgba(90,190,255,0.25)' : 'rgba(90,190,255,0.6)';
    ctx.setLineDash([6, 5]); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, sess.waterRow * ch); ctx.lineTo(w, sess.waterRow * ch); ctx.stroke();
    ctx.setLineDash([]);

    // 滑鼠預覽（顯示工具作用範圍）
    if (hover && sess.tool && EQUIP[sess.tool] && EQUIP[sess.tool].tool) {
      const pat = PATTERNS[EQUIP[sess.tool].tool.pattern] || PATTERNS.single;
      const ok = accessible(sess, hover.x, hover.y);
      for (const [dx, dy] of pat) {
        const x = hover.x + dx, y = hover.y + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        ctx.fillStyle = ok ? 'rgba(255,225,120,0.22)' : 'rgba(255,80,80,0.18)';
        ctx.fillRect(x * cw, y * ch, cw - 1, ch - 1);
      }
      ctx.strokeStyle = ok ? '#ffe27a' : '#ff6b6b'; ctx.lineWidth = 2;
      ctx.strokeRect(hover.x * cw + 1, hover.y * ch + 1, cw - 3, ch - 3);
    }
  }

  function cellAt(cv, sess, mx, my) {
    const x = Math.floor(mx / (cv.width / W)), y = Math.floor(my / (cv.height / H));
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    return { x, y };
  }

  function cellInfo(sess, x, y) {
    const c = sess.grid[y][x];
    if (!c.seen) return '未探明的岩層';
    if (c.dug) return (c.water && !sess.pumpOn ? '積水坑道' : '已開挖坑道');
    return CELL[c.t].name + '　硬度 ' + CELL[c.t].hard.toFixed(1) +
      '　剩餘 ' + Math.max(0, Math.round(c.hp)) + '/' + c.maxhp +
      (c.water ? '（水線下）' : '');
  }

  global.MINE = {
    W, H, CELL, PATTERNS, start, dig, draw, cellAt, cellInfo, reveal,
    placeTimber, togglePump, toggleLight, collapseRisk, lightRadius,
    canUse, hasWorking, accessible, coverage
  };
})(window);
