/* ============================================================
   開玉 — 遊戲主邏輯
   狀態 / 工人 / 日循環 / 工房相玉 / 市場 / 補給站 / 存檔
   ============================================================ */
(function (global) {
  'use strict';
  const D = global.DATA, J = global.JADE, M = global.MINE;
  const { EQUIP, SUPPLY, SITES, ROLES, WEATHER, NAMES } = D;

  const SAVE_KEY = 'kaiyu-save-v1';
  let S = null;

  /* ---------------- 建檔 ---------------- */
  function newWorker(roleId, lvl) {
    const level = lvl || (1 + Math.floor(Math.random() * 3));
    const skill = { mine: 1, blast: 0, mech: 0, eye: 0, porter: 0 };
    const key = ROLES[roleId].key;
    skill[key] = 2 + Math.floor(Math.random() * 3) + level;
    skill.mine = Math.max(skill.mine, roleId === 'miner' ? skill.mine : 1 + Math.floor(Math.random() * 3));
    const maxStam = 70 + Math.floor(Math.random() * 40) + level * 5;
    return {
      id: 'W' + Math.random().toString(36).slice(2, 8),
      name: NAMES[Math.floor(Math.random() * NAMES.length)] + (Math.random() < 0.25 ? '仔' : ''),
      role: roleId, level,
      skill, maxStam, stam: maxStam,
      morale: 65 + Math.floor(Math.random() * 20),
      injury: 0, exp: 0,
      wage: Math.round((650 + level * 220 + skill[key] * 90) / 10) * 10,
      hired: false
    };
  }

  function newGame() {
    S = {
      day: 1, money: 260000, rep: 0, morale: 70,
      weather: WEATHER[0],
      workers: [newWorker('miner', 2), newWorker('miner', 1), newWorker('porter', 1)],
      owned: { huika: true },
      equip: {},
      supply: { diesel: 40, battery: 6, grindwheel: 4, blade: 1, dynamite: 0, wood: 2, food: 20, medicine: 2 },
      stones: [],       // 已運下山、在工房
      stash: {},        // 留在各場口山上的料
      session: null,
      market: 1.0,
      buyers: [],
      log: [],
      stats: { mined: 0, sold: 0, revenue: 0, bestSale: 0, days: 0, accidents: 0, deaths: 0 },
      heat: 0, warPath: 0, pendingMilitia: 0, pendingArmy: false,
      hideouts: 3, raid: false,
      lastAuction: 0,
      over: null
    };
    // 起手設備
    ['pickaxe', 'shovel', 'chisel', 'basket', 'headlamp', 'helmet', 'flashlight', 'loupe', 'tent', 'shotgun'].forEach(id => addEquip(id));
    dedupeNames();
    rollBuyers();
    log('第 1 天。你接手了一支三個人的採玉隊，口袋裡 ' + money(S.money) + '。山就在那裡。');
    log('🏠 村裡長輩把會卡的一口老坑留給你 — 礦權是你的，上山不用再繳日費。', 'ok');
    log('🔫 床底下還留著一把土製獵槍。「山裡不太平，」長輩只說了這句。', 'warn');
    return S;
  }

  // 隊上同名的人加個稱呼區別，喊人才不會亂
  function dedupeNames() {
    const seen = {};
    const suffix = ['', '（二）', '（三）', '（四）', '（五）'];
    S.workers.forEach(w => {
      const base = w.baseName || w.name;
      w.baseName = base;
      seen[base] = (seen[base] || 0) + 1;
      w.name = base + (suffix[seen[base] - 1] || '（' + seen[base] + '）');
    });
  }

  function addEquip(id, n) {
    n = n || 1;
    const def = EQUIP[id];
    if (!S.equip[id]) S.equip[id] = { qty: 0, dur: def.dur, max: def.dur };
    S.equip[id].qty += n;
    S.equip[id].dur = def.dur;
    S.equip[id].max = def.dur;
  }

  /* ---------------- 小工具 ---------------- */
  function money(v) {
    const s = Math.abs(Math.round(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 ? '-$' : '$') + s;
  }
  function log(msg, cls) {
    S.log.unshift({ day: S.day, msg, cls: cls || '' });
    if (S.log.length > 220) S.log.pop();
  }
  function has(id) { return S.equip[id] && S.equip[id].qty > 0 && S.equip[id].dur > 0; }
  function eyeSkill() {
    return S.workers.filter(w => w.injury === 0).reduce((m, w) => Math.max(m, w.skill.eye || 0), 0);
  }
  function team() { return S.session ? S.session.team.map(id => S.workers.find(w => w.id === id)).filter(Boolean) : []; }

  /* ---------------- 運輸能力 ---------------- */
  function carryCapacity(site) {
    let cap = 0;
    const roster = S.session ? team() : S.workers.filter(w => w.injury === 0);
    cap += roster.length * 20;                                 // 人力肩扛
    cap += roster.filter(w => w.role === 'porter').length * 40; // 背工加成
    for (const id in S.equip) {
      const def = EQUIP[id], e = S.equip[id];
      if (!def.carry || e.qty <= 0 || e.dur <= 0) continue;
      if (def.road && site && site.road < def.road) continue;   // 路太爛開不進來
      cap += def.carry * e.qty;
    }
    return Math.round(cap);
  }

  /* ---------------- 上山 ---------------- */
  function startMining(siteId, teamIds) {
    if (S.session) return { ok: false, msg: '已經在山上了。' };
    const site = SITES.find(s => s.id === siteId);
    if (!teamIds.length) return { ok: false, msg: '至少要帶一個人上山。' };
    const owned = !!(S.owned && S.owned[siteId]);
    if (!owned && S.money < site.fee) return { ok: false, msg: '付不出 ' + site.name + ' 的礦權日費 ' + money(site.fee) };

    const injured = teamIds.map(id => S.workers.find(w => w.id === id)).filter(w => w && w.injury > 0);
    if (injured.length) return { ok: false, msg: injured[0].name + ' 還在養傷，帶不上山。' };

    if (!owned) S.money -= site.fee;
    S.session = M.start(S, siteId, teamIds);
    log('隊伍出發前往 ' + site.name + '（海拔 ' + site.alt + 'm），' +
      (owned ? '自家礦權免日費' : '礦權費 ' + money(site.fee)) + '。天氣：' + S.weather.name, 'go');

    // 上山途中事件
    const ev = travelEvent(site);
    if (ev) log(ev, 'warn');
    return { ok: true };
  }

  function travelEvent(site) {
    const roadRisk = (4 - site.road) * 0.06 * S.weather.danger;
    if (Math.random() > roadRisk) return null;
    const r = Math.random();
    const t = team();
    const w = t[Math.floor(Math.random() * t.length)];
    if (r < 0.35 && w) {
      w.stam = Math.max(10, w.stam - 25);
      return '上山路上遇到坍方繞路，' + w.name + ' 到礦場就先累了一半。';
    } else if (r < 0.6) {
      const loss = Math.min(S.supply.diesel, 5 + Math.floor(Math.random() * 8));
      S.supply.diesel -= loss;
      return '油桶在爛路上顛破，漏掉 ' + loss + ' 公升柴油。';
    } else if (r < 0.8 && w) {
      w.injury += 1; w.stam = Math.floor(w.stam * 0.5);
      return '⚠️ ' + w.name + ' 在陡坡滑了一跤，扭傷，休息一天。';
    }
    S.money -= 3000;
    return '半路遇到臨檢站，塞了 ' + money(3000) + ' 才放行。';
  }

  /* ---------------- 收工下山 ---------------- */
  function haulOptions() {
    if (!S.session) return [];
    const stash = S.stash[S.session.siteId] || [];
    return S.session.stones.concat(stash);
  }

  function endMining(selectedIds) {
    if (!S.session) return { ok: false };
    const site = S.session.site;
    const all = haulOptions();
    const cap = carryCapacity(site);
    const chosen = all.filter(s => selectedIds.indexOf(s.id) >= 0);
    const load = chosen.reduce((a, s) => a + s.kg, 0);
    if (load > cap) return { ok: false, msg: '超載了：' + load.toFixed(1) + 'kg / 上限 ' + cap + 'kg' };

    chosen.forEach(s => S.stones.push(s));
    const left = all.filter(s => selectedIds.indexOf(s.id) < 0);
    S.stash[site.id] = left;
    S.stats.mined += S.session.stones.length;
    if (S.session.collapsed) S.stats.accidents += S.session.collapsed;

    log('收工下山：帶回 ' + chosen.length + ' 顆共 ' + load.toFixed(1) + 'kg' +
      (left.length ? '，' + left.length + ' 顆留在 ' + site.name + ' 山上' : '') + '。', 'ok');
    S.session = null;
    return { ok: true, hauled: chosen.length, left: left.length };
  }

  /* ---------------- 結束一天 ---------------- */
  function endDay(inMine) {
    if (S.session && !inMine) return { ok: false, msg: '隊伍還在山上，先收工。' };
    const notes = [];

    // 工資
    let wages = 0;
    S.workers.forEach(w => { if (w.mutant) return; wages += w.injury > 0 ? Math.round(w.wage * 0.5) : w.wage; });
    S.money -= wages;
    notes.push('發工資 ' + money(wages));
    if (S.money < 0) {
      S.morale -= 10;
      S.workers.forEach(w => w.morale -= 8);
      notes.push('資金見底，工人開始議論欠薪。');
    }

    // 糧食
    let need = S.workers.length + S.workers.filter(w => w.mutant).length * 4;
    if (has('stove')) need = Math.ceil(need * 0.8);
    for (const id in S.equip) {
      const def = EQUIP[id];
      if (def.upkeep && def.upkeep.food && S.equip[id].qty > 0) need += def.upkeep.food * S.equip[id].qty;
    }
    if (S.supply.food >= need) {
      S.supply.food -= need;
      if (has('stove')) { S.morale += 3; S.workers.forEach(w => w.morale = Math.min(100, w.morale + 3)); }
    } else {
      S.supply.food = 0;
      S.morale -= 12;
      S.workers.forEach(w => w.morale = Math.max(0, w.morale - 10));
      notes.push('⚠️ 糧食不足，全隊餓肚子，士氣重挫。');
    }

    // 休息回復（坑道裡打地鋪恢復差很多）
    const restBonus = has('tent') ? (inMine ? 5 : 10) : 0;
    const restRate = inMine ? 0.38 : 0.55;
    S.workers.forEach(w => {
      w.stam = Math.min(w.maxStam, w.stam + Math.round(w.maxStam * restRate) + restBonus);
      if (w.injury > 0) {
        w.injury--;
        if (S.supply.medicine > 0 && Math.random() < 0.6) { S.supply.medicine--; w.injury = Math.max(0, w.injury - 1); }
        if (w.injury === 0) notes.push(w.name + ' 傷好了，明天可以下坑。');
      }
      w.morale = Math.min(100, Math.max(0, w.morale + (S.money > 0 ? 2 : -2)));
    });
    S.morale = Math.min(100, Math.max(0, S.morale + (S.money > 0 ? 1 : -3)));

    // 離職
    S.workers.slice().forEach(w => {
      if (w.morale < 18 && Math.random() < 0.35) {
        S.workers = S.workers.filter(x => x.id !== w.id);
        notes.push('💔 ' + w.name + ' 收拾行李走人了。');
      }
    });

    // 市場波動
    const drift = (Math.random() - 0.48) * 0.09;
    S.market = J.clamp(S.market * (1 + drift), 0.55, 2.2);
    if (Math.random() < 0.12) {
      const shock = Math.random() < 0.5 ? -0.18 : 0.22;
      S.market = J.clamp(S.market * (1 + shock), 0.5, 2.6);
      notes.push(shock > 0 ? '📈 邊境開盤消息熱，玉價指數跳漲。' : '📉 買家縮手，玉價指數走跌。');
    }
    if (S.day % 2 === 0) rollBuyers();

    // 封鎖期間躲著不見：民兵一天抄一個地下據點
    if (S.pendingMilitia) {
      S.hideouts = (S.hideouts == null ? 3 : S.hideouts) - 1;
      let lost = '';
      if (S.stones.length && Math.random() < 0.5) {
        const st = S.stones.splice(Math.floor(Math.random() * S.stones.length), 1)[0];
        lost = '，抄走了一顆 ' + st.kg + 'kg 的料';
      }
      if (S.hideouts > 0) {
        notes.push('🚨 你躲著不見。民兵搜到你 ' + (3 - S.hideouts) + ' 號地下據點' + lost + ' — 藏身處只剩 ' + S.hideouts + ' 個。');
      } else {
        S.raid = true;
        notes.push('🚨 最後一個地下據點的位置也被摸清了' + lost + '。今晚，睡得不會安穩。');
      }
    }

    // 命案後果：民兵動身了，天亮就到（到營地畫面會攔住你做選擇）
    if (S.heat) {
      S.pendingMilitia = (S.pendingMilitia || 0) + S.heat;
      S.heat = 0;
      notes.push('⚠️ 坑裡開槍打死人的事傳到山下 — 有一隊人正往你的營地來。');
    }

    // 變異工人：不用薪水、絕對服從，但身體在倒數
    S.workers.slice().forEach(w => {
      if (!w.mutant) return;
      w.morale = 100;
      w.stam = w.maxStam;
      if (--w.mutDays <= 0) {
        S.workers = S.workers.filter(x => x.id !== w.id);
        S.stats.deaths = (S.stats.deaths || 0) + 1;
        notes.push('🧟 ' + w.name + ' 的心臟撐不住變異，天沒亮就倒在工寮外。');
        S.workers.forEach(o => { if (!o.mutant) o.morale = Math.max(0, o.morale - 10); });
      }
    });

    // 天氣
    S.weather = rollWeather();

    S.day++;
    S.stats.days++;
    log('—— 第 ' + S.day + ' 天　' + S.weather.icon + S.weather.name + '　' + S.weather.desc, 'day');
    notes.forEach(n => log(n));

    if (S.money < -120000) {
      S.over = '破產：債主上門，礦權被收回，隊伍就地解散。';
      log('💀 ' + S.over, 'bad');
    }
    save();
    return { ok: true, notes };
  }

  function rollWeather() {
    const r = Math.random();
    // 雨季（每 30 天為一輪，第 12~24 天雨多）
    const wet = (S.day % 30) >= 12 && (S.day % 30) <= 24;
    if (wet) {
      if (r < 0.32) return WEATHER[2];
      if (r < 0.5) return WEATHER[3];
      if (r < 0.66) return WEATHER[4];
      if (r < 0.85) return WEATHER[1];
      return WEATHER[0];
    }
    if (r < 0.45) return WEATHER[0];
    if (r < 0.7) return WEATHER[1];
    if (r < 0.85) return WEATHER[2];
    if (r < 0.93) return WEATHER[4];
    return WEATHER[3];
  }

  /* ---------------- 坑道過夜 ---------------- */
  function sleepInMine() {
    if (!S.session) return { ok: false, msg: '不在坑裡' };
    const sess = S.session, site = sess.site;
    const owned = !!(S.owned && S.owned[site.id]);
    if (!owned && S.money < site.fee) {
      return { ok: false, msg: '付不出明天的礦權日費 ' + money(site.fee) + '，只能下山了' };
    }
    const r = endDay(true);
    if (!r.ok) return r;
    const notes = r.notes.slice();
    const extra = [];

    if (!owned) { S.money -= site.fee; extra.push('隔天礦權日費 ' + money(site.fee)); }
    if (!has('tent')) {
      S.workers.forEach(w => { if (sess.team.indexOf(w.id) >= 0) w.morale = Math.max(0, w.morale - 6); });
      extra.push('沒有帳篷，全隊在坑道裡打地鋪，腰酸背痛（士氣 -6）。');
    }

    // 夜裡塌方：危險場口、壞天氣、坑木不足時最可怕
    const risk = Math.min(0.35, M.collapseRisk(S, sess) * 0.55 * S.weather.danger);
    if (Math.random() < risk) {
      const crew = sess.team.map(id => S.workers.find(w => w.id === id)).filter(Boolean);
      const w = crew[Math.floor(Math.random() * crew.length)];
      if (w) {
        const days = 1 + Math.floor(Math.random() * 3);
        w.injury += days;
        w.morale = Math.max(0, w.morale - 10);
        S.stats.accidents++;
        extra.push('⚠️ 睡到半夜塌了一角，' + w.name + ' 被砸傷，休養 ' + days + ' 天。');
      }
      if (sess.stones.length && Math.random() < 0.3) {
        const lost = sess.stones.pop();
        extra.push('一顆 ' + lost.kg + 'kg 的料被埋回土裡。');
      }
    } else if (Math.random() < 0.25) {
      extra.push('一夜平安，坑木在頭頂吱呀作響。');
    }

    log('😴 全隊在 ' + site.name + ' 坑道裡過夜，醒來繼續開工。', 'go');
    extra.forEach(n => log(n, n.indexOf('⚠️') === 0 ? 'bad' : ''));
    return { ok: true, notes: notes.concat(extra) };
  }

  /* ---------------- 工房：相玉與加工 ---------------- */
  function workshop(action, stoneId) {
    const st = S.stones.find(s => s.id === stoneId);
    if (!st) return { ok: false, msg: '找不到這顆料' };
    const eye = eyeSkill();

    if (action === 'candle') {
      if (!has('flashlight')) return { ok: false, msg: '需要強光手電筒' };
      if (S.supply.battery < 1) return { ok: false, msg: '沒電池了' };
      S.supply.battery--; S.equip.flashlight.dur -= 1;
      const r = J.candle(st); log('打燈 ' + J.label(st) + '：' + r.msg); return r;
    }
    if (action === 'loupe') {
      if (!has('loupe')) return { ok: false, msg: '需要十倍放大鏡' };
      const r = J.inspect(st); log('相玉 ' + J.label(st) + '：' + r.msg); return r;
    }
    if (action === 'window') {
      if (!has('grinder')) return { ok: false, msg: '需要手持磨機' };
      if (S.supply.grindwheel < 1) return { ok: false, msg: '沒有砂輪片' };
      if (st.state !== 'rough') return { ok: false, msg: '已經切開的料不用再開窗' };
      S.supply.grindwheel--; S.equip.grinder.dur -= 3;
      const r = J.openWindow(st, eye); log('開窗：' + r.msg, r.good ? 'ok' : 'warn'); return r;
    }
    if (action === 'cut') {
      if (!has('saw')) return { ok: false, msg: '需要切石機' };
      if (S.supply.blade < 1) return { ok: false, msg: '沒有切割片' };
      if (st.state !== 'rough') return { ok: false, msg: '已經切開了' };
      S.supply.blade--; S.equip.saw.dur -= 5;
      const est = J.estimate(st, eye);
      const r = J.cutOpen(st, eye);
      const v = J.trueValue(st);
      const win = v > est.mid * 1.15, lose = v < est.mid * 0.6;
      log('🔪 一刀切開 ' + st.siteName + '料 ' + st.kg + 'kg：' + r.msg +
        '　實價 ' + money(v) + '（切前估 ' + money(est.mid) + '）' +
        (win ? ' — 漲了！' : lose ? ' — 垮了。' : ''), win ? 'ok' : lose ? 'bad' : '');
      S.rep += win ? 2 : 0;
      return Object.assign(r, { value: v, est: est.mid, win, lose });
    }
    if (action === 'polish') {
      if (!has('polisher')) return { ok: false, msg: '需要拋光機' };
      if (st.state !== 'open') return { ok: false, msg: '只有切開的明料能拋光' };
      if (S.supply.grindwheel < 1) return { ok: false, msg: '沒有砂輪片' };
      S.supply.grindwheel--; S.equip.polisher.dur -= 2;
      const r = J.polish(st); log('拋光 ' + J.label(st) + '，售價 +30%'); return r;
    }
    return { ok: false, msg: '未知動作' };
  }

  /* ---------------- 市場 ---------------- */
  const BUYER_NAMES = ['瑞豐玉行', '老陳', '緬商吳先生', '廣東客', '台北盤商', '香港藏家', '雲南阿姐', '直播間王總'];
  const PREFS = [
    { id: 'bing', name: '愛冰種以上', test: s => s.zhong >= 4, mult: 1.35 },
    { id: 'green', name: '只認陽綠', test: s => s.color >= 10, mult: 1.45 },
    { id: 'big', name: '收大料', test: s => s.kg >= 8, mult: 1.3 },
    { id: 'rough', name: '專賭原石', test: s => s.state === 'rough', mult: 1.2 },
    { id: 'fine', name: '要成品', test: s => s.state === 'polished', mult: 1.4 },
    { id: 'purple', name: '找紫羅蘭', test: s => s.color === 9, mult: 1.5 }
  ];

  function rollBuyers() {
    S.buyers = [];
    const used = {};
    for (let i = 0; i < 3; i++) {
      let n; do { n = BUYER_NAMES[Math.floor(Math.random() * BUYER_NAMES.length)]; } while (used[n]);
      used[n] = 1;
      const pref = PREFS[Math.floor(Math.random() * PREFS.length)];
      S.buyers.push({
        name: n, pref,
        base: 0.6 + Math.random() * 0.3,             // 出價基準
        seed: Math.random(),
        haggle: 0.06 + Math.random() * 0.1
      });
    }
  }

  function offerFor(st, buyer) {
    const eye = eyeSkill();
    let base;
    if (st.state === 'rough') {
      // 玉商也是賭，他用自己的眼力估，並打賭性折扣
      const est = J.estimate(st, 4 + buyer.seed * 4);
      const risk = 0.45 + J.knownRatio(st) * 0.4;
      base = est.mid * risk;
    } else {
      base = J.trueValue(st) * 0.92;
    }
    let m = buyer.base * S.market;
    if (buyer.pref.test(st)) m *= buyer.pref.mult;
    m *= 1 + Math.min(0.25, S.rep * 0.004);          // 名聲
    if (has('scale')) m *= 1.08;                      // 過磅精準，殺價空間小
    if (S.workers.some(w => w.mutant)) m *= 0.92;     // 「那個礦場不乾淨」的傳聞
    m = Math.min(m, st.state === 'rough' ? 1.6 : 1.12); // 玉商不會做賠本生意
    return Math.max(300, Math.round(base * m));
  }

  function sell(stoneId, buyerIdx) {
    const i = S.stones.findIndex(s => s.id === stoneId);
    if (i < 0) return { ok: false, msg: '找不到料' };
    const st = S.stones[i];
    const buyer = S.buyers[buyerIdx];
    const price = offerFor(st, buyer);
    S.money += price;
    S.stats.sold++; S.stats.revenue += price;
    S.stats.bestSale = Math.max(S.stats.bestSale, price);
    S.rep += price > 500000 ? 6 : price > 100000 ? 3 : price > 20000 ? 1 : 0;
    S.stones.splice(i, 1);
    log('💰 賣給 ' + buyer.name + '：' + J.label(st) + ' → ' + money(price), 'ok');
    return { ok: true, price };
  }

  function auctionReady() { return S.day - S.lastAuction >= 7; }

  function auction(stoneIds) {
    if (!auctionReady()) return { ok: false, msg: '公盤每 7 天一次，還沒到。' };
    if (!stoneIds.length) return { ok: false, msg: '沒有投標的料' };
    let total = 0; const lines = [];
    stoneIds.forEach(id => {
      const i = S.stones.findIndex(s => s.id === id);
      if (i < 0) return;
      const st = S.stones[i];
      // 三口暗標取最高
      let best = 0;
      for (let k = 0; k < 3; k++) {
        const b = { base: 0.7 + Math.random() * 0.45, seed: Math.random(), pref: PREFS[Math.floor(Math.random() * PREFS.length)] };
        best = Math.max(best, offerFor(st, b));
      }
      const net = Math.round(best * 0.9); // 10% 公盤手續費
      total += net;
      lines.push(J.label(st) + ' → ' + money(net));
      S.stones.splice(i, 1);
      S.stats.sold++;
    });
    S.money += total; S.stats.revenue += total;
    S.lastAuction = S.day;
    S.rep += 4;
    log('🏛 公盤開標，' + lines.length + ' 件成交，淨收 ' + money(total), 'ok');
    return { ok: true, total, lines };
  }

  /* ---------------- 變異血清 ---------------- */
  function injectSerum(id) {
    const w = S.workers.find(x => x.id === id);
    if (!w) return { ok: false, msg: '人不在' };
    if (w.mutant) return { ok: false, msg: '已經變異了' };
    if ((S.supply.serum || 0) < 1) return { ok: false, msg: '沒有血清 — 補給站的黑市貨架有' };
    S.supply.serum--;
    w.mutant = true;
    w.mutDays = 6 + Math.floor(Math.random() * 5);
    w.skill.mine += 6;
    w.skill.eye = 0;
    w.maxStam = Math.round(w.maxStam * 2.5);
    w.stam = w.maxStam;
    w.morale = 100;
    w.wage = 0;
    S.workers.forEach(o => { if (!o.mutant) o.morale = Math.max(0, o.morale - 12); });
    S.morale = Math.max(0, S.morale - 8);
    log('🧪 你把血清扎進 ' + w.name + ' 的脖子。他抽搐、嘶吼、肌肉撐裂了衣服 — 然後安靜下來，眼神空了，只等你的命令。', 'bad');
    return { ok: true };
  }

  /* ---------------- 民兵上門：繳錢或開打 ---------------- */
  function militiaPay() {
    const n = S.pendingMilitia || 0;
    if (!n) return { ok: false };
    const fine = 250000 * n;
    S.money -= fine;
    S.rep = Math.max(0, S.rep - 15 * n);
    S.workers.forEach(w => { if (!w.mutant) w.morale = Math.max(0, w.morale - 20); });
    S.pendingMilitia = 0;
    S.hideouts = 3;
    log('民兵收了 ' + money(fine) + '，把命案壓了下來。工人看你的眼神都變了。', 'bad');
    if (S.money < -120000 && !S.over) { S.over = '破產：債主上門，礦權被收回，隊伍就地解散。'; log('💀 ' + S.over, 'bad'); }
    save();
    return { ok: true, fine };
  }

  function militiaFight() {
    const n = S.pendingMilitia || 0;
    if (!n) return { ok: false };
    if (!has('shotgun')) return { ok: false, msg: '沒有槍，拿什麼打？' };
    S.pendingMilitia = 0;
    S.hideouts = 3;
    const mutants = S.workers.filter(w => w.mutant).length;
    const chance = 0.45 + mutants * 0.08;
    if (Math.random() < chance) {
      S.warPath = (S.warPath || 0) + 1;
      S.rep = Math.max(0, S.rep - 25);
      S.stats.deaths += 2;
      log('🔥 你們在營地口跟民兵開火，把他們全撂倒了。從這一刻起，沒有回頭路了。', 'bad');
      if (S.warPath >= 2) {
        S.pendingArmy = true;
        log('山下已經在集結。這次來的，不會只是民兵。', 'bad');
      }
      save();
      return { ok: true, win: true, army: !!S.pendingArmy };
    }
    S.workers.forEach(w => { w.injury += 2; if (!w.mutant) w.morale = Math.max(0, w.morale - 25); });
    const fine = 500000 * n;
    S.money -= fine;
    log('你們打輸了，被按在地上。罰金加倍 ' + money(fine) + '，全隊掛彩。', 'bad');
    if (S.money < -120000 && !S.over) { S.over = '破產：債主上門，礦權被收回，隊伍就地解散。'; log('💀 ' + S.over, 'bad'); }
    save();
    return { ok: true, win: false, fine };
  }

  /* ---------------- 大部隊上門：最終決戰 ---------------- */
  function armyFight() {
    if (!S.pendingArmy) return { ok: false };
    S.pendingArmy = false;
    const mutants = S.workers.filter(w => w.mutant).length;
    const chance = 0.25 + mutants * 0.12;
    if (Math.random() < chance) {
      S.overKind = 'warlord';
      S.over = '警察和民兵倒在你的營地前，槍管還在冒煙。再也沒有人敢上這座山 — 從今天起，這裡沒有王法，只有你。';
      log('🏴 血玉軍閥：' + S.over, 'bad');
      save();
      return { ok: true, win: true };
    }
    S.overKind = 'dead';
    S.over = '你們被壓制在坑口，一個一個倒下。槍聲停了以後，山又安靜了。';
    log('💀 ' + S.over, 'bad');
    save();
    return { ok: true, win: false };
  }

  function armySurrender() {
    if (!S.pendingArmy) return { ok: false };
    S.pendingArmy = false;
    S.overKind = 'jail';
    S.over = '你被銬上手銬帶下山。礦權沒收、隊伍解散，山裡的傳聞很快就沒人記得了。';
    log('💀 ' + S.over, 'bad');
    save();
    return { ok: true };
  }

  /* ---------------- 地下黑市（封鎖期間） ---------------- */
  const BLACK_NAMES = ['地道口的獨眼販子', '收黑貨的緬商', '不問來路的阿豪'];
  function blackBuyers() {
    if (S._blackDay !== S.day || !S._black) {
      S._blackDay = S.day;
      S._black = BLACK_NAMES.map(n => ({
        name: n,
        base: 0.5 + Math.random() * 0.18,
        seed: Math.random(),
        pref: { name: '什麼都收，不問來路', test: () => false, mult: 1 },
        haggle: 0.2
      }));
    }
    return S._black;
  }

  function sellBlack(stoneId, idx) {
    const i = S.stones.findIndex(x => x.id === stoneId);
    if (i < 0) return { ok: false, msg: '找不到料' };
    const st = S.stones[i];
    const b = blackBuyers()[idx];
    const price = offerFor(st, b);
    S.money += price;
    S.stats.sold++; S.stats.revenue += price;
    S.stones.splice(i, 1);
    log('🕳 黑市出手：' + J.label(st) + ' 賣給' + b.name + ' → ' + money(price) + '（正常行情打了對折）', 'warn');
    return { ok: true, price };
  }

  /* ---------------- 突襲夜結算 ---------------- */
  function raidFight() {
    if (!S.raid) return { ok: false };
    S.raid = false;
    const mutants = S.workers.filter(w => w.mutant).length;
    const chance = 0.5 + mutants * 0.1;
    if (Math.random() < chance) {
      S.pendingMilitia = 0;
      S.hideouts = 3;
      S.overKind = 'warlord';
      S.over = 'AK-47 的火舌壓過了整支突襲隊。天亮的時候，山下再沒有人敢接這個案子 — 這座山、這些地道，從此都姓你。';
      log('🏴 血玉軍閥：' + S.over, 'bad');
      save();
      return { ok: true, win: true };
    }
    S.overKind = 'dead';
    S.over = '突襲隊的火力壓了進來。你在自己的地下據點裡倒下，手裡還握著那把發燙的 AK。';
    log('💀 ' + S.over, 'bad');
    save();
    return { ok: true, win: false };
  }

  function raidSurrender() {
    if (!S.raid) return { ok: false };
    S.raid = false;
    S.pendingMilitia = 0;
    S.overKind = 'jail';
    S.over = '你把 AK 丟在地上，跟著突襲隊走出據點。身後是被翻得亂七八糟的貨架。';
    log('💀 ' + S.over, 'bad');
    save();
    return { ok: true };
  }

  /* ---------------- 買斷礦權 ---------------- */
  function buyoutPrice(siteId) {
    const site = SITES.find(x => x.id === siteId);
    return site.fee * 45;
  }

  function buyoutSite(siteId) {
    const site = SITES.find(x => x.id === siteId);
    if (!site) return { ok: false, msg: '沒有這個場口' };
    if (S.owned && S.owned[siteId]) return { ok: false, msg: '已經是你的了' };
    const cost = buyoutPrice(siteId);
    if (S.money < cost) return { ok: false, msg: '買斷要 ' + money(cost) + '，錢不夠' };
    S.money -= cost;
    S.owned = S.owned || {};
    S.owned[siteId] = true;
    S.rep += 5;
    log('🏠 買斷 ' + site.name + ' 礦權 ' + money(cost) + ' — 這座山頭現在是你的了，上山免日費。', 'ok');
    return { ok: true, cost };
  }

  /* ---------------- 補給站 ---------------- */
  function buyEquip(id, n) {
    n = n || 1;
    const def = EQUIP[id];
    const cost = def.price * n;
    if (S.money < cost) return { ok: false, msg: '錢不夠（需要 ' + money(cost) + '）' };
    S.money -= cost; addEquip(id, n);
    log('購入 ' + def.name + ' ×' + n + '　-' + money(cost));
    return { ok: true };
  }

  function repairEquip(id) {
    const e = S.equip[id], def = EQUIP[id];
    if (!e) return { ok: false, msg: '沒有這個設備' };
    const missing = 1 - e.dur / e.max;
    const cost = Math.round(def.price * missing * 0.55);
    if (cost <= 0) return { ok: false, msg: '狀況良好，不用修' };
    if (S.money < cost) return { ok: false, msg: '修不起（需要 ' + money(cost) + '）' };
    S.money -= cost; e.dur = e.max;
    log('維修 ' + def.name + '　-' + money(cost));
    return { ok: true, cost };
  }

  function buySupply(id, n) {
    const cost = SUPPLY[id].price * n;
    if (S.money < cost) return { ok: false, msg: '錢不夠' };
    S.money -= cost;
    S.supply[id] = (S.supply[id] || 0) + n;
    return { ok: true };
  }

  /* ---------------- 人力市場 ---------------- */
  function candidates() {
    if (!S._cands || S._candDay !== S.day) {
      S._candDay = S.day;
      const roles = Object.keys(ROLES);
      S._cands = [0, 1, 2].map(() => newWorker(roles[Math.floor(Math.random() * roles.length)]));
    }
    return S._cands;
  }

  function hire(id) {
    const c = candidates().find(w => w.id === id);
    if (!c) return { ok: false, msg: '人已經走了' };
    const bonus = c.wage * 5;
    if (S.money < bonus) return { ok: false, msg: '簽約金 ' + money(bonus) + ' 付不出來' };
    S.money -= bonus;
    c.hired = true;
    S.workers.push(c);
    dedupeNames();
    S._cands = S._cands.filter(w => w.id !== id);
    log('僱用 ' + c.name + '（' + ROLES[c.role].name + '）簽約金 ' + money(bonus) + '，日薪 ' + money(c.wage));
    return { ok: true };
  }

  function fire(id) {
    const w = S.workers.find(x => x.id === id);
    if (!w) return { ok: false };
    S.workers = S.workers.filter(x => x.id !== id);
    S.morale -= 5;
    log('辭退 ' + w.name + '，其他人臉色不太好看。');
    return { ok: true };
  }

  function train(id) {
    const w = S.workers.find(x => x.id === id);
    if (!w) return { ok: false };
    const cost = 8000 + w.level * 4000;
    if (S.money < cost) return { ok: false, msg: '訓練費 ' + money(cost) + ' 不夠' };
    S.money -= cost;
    const key = ROLES[w.role].key;
    w.skill[key] += 1; w.level += 1; w.maxStam += 4;
    w.wage = Math.round(w.wage * 1.12 / 10) * 10;
    log(w.name + ' 完成訓練：' + skillLabel(key) + ' 提升到 ' + w.skill[key] + '（日薪調為 ' + money(w.wage) + '）');
    return { ok: true };
  }

  function skillLabel(k) { return { mine: '採礦', blast: '爆破', mech: '機械', eye: '相玉', porter: '負重' }[k] || k; }

  /* ---------------- 存檔 ---------------- */
  function save() {
    try {
      const copy = Object.assign({}, S);
      copy.session = null;                 // 山上作業不存檔
      copy.weather = { id: S.weather.id };
      localStorage.setItem(SAVE_KEY, JSON.stringify(copy));
      return true;
    } catch (e) { return false; }
  }

  function load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const d = JSON.parse(raw);
      d.weather = WEATHER.find(w => w.id === (d.weather && d.weather.id)) || WEATHER[0];
      d.session = null;
      d.owned = d.owned || { huika: true };
      if (!d.equip.shotgun) {
        const def = global.DATA.EQUIP.shotgun;
        d.equip.shotgun = { qty: 1, dur: def.dur, max: def.dur };
      }
      S = d;
      return true;
    } catch (e) { return false; }
  }

  function reset() { localStorage.removeItem(SAVE_KEY); return newGame(); }

  global.GAME = {
    get S() { return S; },
    newGame, load, save, reset, log, money, has, eyeSkill, team,
    carryCapacity, startMining, endMining, haulOptions, endDay,
    workshop, offerFor, sell, auction, auctionReady, rollBuyers,
    buyEquip, repairEquip, buySupply, candidates, hire, fire, train,
    buyoutSite, buyoutPrice, sleepInMine,
    injectSerum, militiaPay, militiaFight, armyFight, armySurrender,
    blackBuyers, sellBlack, raidFight, raidSurrender,
    skillLabel, newWorker
  };
})(window);
