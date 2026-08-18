/* ============================================================
   開玉 — 玉石模型
   原石生成 / 隱藏屬性 / 估價 / 相玉揭示（打燈、放大鏡、開窗、切開）
   ============================================================ */
(function (global) {
  'use strict';
  const { ZHONG, COLOR, SKIN, SITES } = global.DATA;

  let seq = 1;

  /* ---- 工具函數 ---- */
  const rnd = Math.random;
  function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  // 常態分佈近似（-1 ~ 1 集中在 0）
  function gauss() { return (rnd() + rnd() + rnd() + rnd() - 2) / 2; }

  /* ---- 品質權重：好料本來就是萬中選一 ---- */
  // 磚頭料 豆種 糯種 糯冰 冰種 高冰 玻璃種
  const ZHONG_W = [34, 30, 19, 10, 5, 1.6, 0.4];
  // 無色 飄花 豆綠 淡綠 晴水 藍水 黃翡 紅翡 墨翠 紫羅蘭 陽綠 正陽綠 帝王綠
  const COLOR_W = [34, 12, 13, 11, 5, 5, 5, 3, 3, 2, 3, 0.9, 0.2];

  // bias > 0 把分佈往「好」的那端推（場口特性、深度、運氣）
  function weightedIndex(weights, bias) {
    let sum = 0;
    const w = new Array(weights.length);
    for (let i = 0; i < weights.length; i++) { w[i] = weights[i] * Math.exp(bias * i * 1.25); sum += w[i]; }
    let r = rnd() * sum;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return w.length - 1;
  }

  /* ---- 產生一顆原石 ---- */
  function makeStone(site, opts) {
    opts = opts || {};
    const s = typeof site === 'string' ? SITES.find(x => x.id === site) : site;

    const kg = clamp(
      Math.round((0.4 + Math.pow(rnd(), 2.4) * 26) * s.sizeMul * (opts.sizeMul || 1) * 10) / 10,
      0.2, 90
    );

    // 大料的種通常差一點（大而完美太稀有）
    const sizePenalty = kg > 12 ? -0.12 : (kg < 1.5 ? 0.06 : 0);
    const zi = weightedIndex(ZHONG_W, s.zhongBias + sizePenalty + (opts.luck || 0));
    const ci = weightedIndex(COLOR_W, s.colorBias + (opts.luck || 0) * 0.8);

    // 裂：開採手法造成的裂在外面加
    let crack = clamp(0.10 + rnd() * 0.45 + s.crackBias, 0, 0.95);
    if (kg > 15) crack = clamp(crack + 0.12, 0, 0.95);
    const cotton = clamp(rnd() * 0.7 - (zi >= 4 ? 0.15 : 0), 0, 0.9);

    const skinId = pick(s.skins);

    return {
      id: 'S' + (seq++),
      site: s.id, siteName: s.name,
      skin: skinId,
      kg,
      zhong: zi,          // 索引
      color: ci,
      crack,              // 0~1
      cotton,             // 0~1
      state: 'rough',     // rough 原石 / open 明料 / polished 成品
      window: 0,          // 0 未開窗 1 窗口漂亮 -1 窗口髒
      known: { zhong: false, color: false, crack: false, cotton: false },
      seed: rnd(),        // 用來讓估價噪音固定
      note: ''
    };
  }

  /* ---- 明料真實價值 ---- */
  function trueValue(st) {
    const z = ZHONG[st.zhong], c = COLOR[st.color];
    let unit = z.base * c.mult;
    unit *= (1 - 0.72 * st.crack);
    unit *= (1 - 0.35 * st.cotton);
    // 大料加成（手鐲位、擺件位）
    const sizeBonus = 1 + clamp(Math.log2(Math.max(st.kg, 0.25)) * 0.14, -0.35, 0.75);
    let v = unit * st.kg * sizeBonus;
    if (st.state === 'polished') v *= 1.3;
    if (st.window === 1) v *= 1.04;
    if (st.window === -1) v *= 0.9;
    return Math.round(v);
  }

  /* ---- 玩家/玉商看到的估價（依已知資訊噪音遞減） ---- */
  function knownRatio(st) {
    const k = st.known;
    let r = 0.12;
    if (k.zhong) r += 0.34;
    if (k.color) r += 0.30;
    if (k.crack) r += 0.14;
    if (k.cotton) r += 0.10;
    if (st.state !== 'rough') r = 1;
    return clamp(r, 0, 1);
  }

  // eyeSkill 0~10：相玉師越強噪音越小
  function estimate(st, eyeSkill) {
    const tv = trueValue(st);
    if (st.state !== 'rough') return { low: tv, high: tv, mid: tv, sure: 1 };
    const known = knownRatio(st);
    const skill = clamp((eyeSkill || 0) / 10, 0, 1);
    // 不確定度：完全不知道時可能差 8 倍
    const spread = (1 - known) * (1 - skill * 0.45) * 1.6 + 0.12;
    // 固定偏移，讓同一顆石頭每次看到的估價一致
    const bias = (st.seed - 0.5) * spread;
    const mid = Math.max(200, tv * Math.exp(bias));
    return {
      low: Math.round(mid / Math.exp(spread)),
      high: Math.round(mid * Math.exp(spread)),
      mid: Math.round(mid),
      sure: known
    };
  }

  /* ---- 顯示用文字（未知就給模糊區間） ---- */
  function describe(st, eyeSkill) {
    const skill = clamp((eyeSkill || 0) / 10, 0, 1);
    const out = {};
    const zi = st.zhong, ci = st.color;

    if (st.known.zhong || st.state !== 'rough') out.zhong = ZHONG[zi].name;
    else {
      const w = Math.max(1, Math.round(2.2 - skill * 1.2));
      const a = clamp(zi - w, 0, ZHONG.length - 1), b = clamp(zi + w, 0, ZHONG.length - 1);
      out.zhong = ZHONG[a].name + '～' + ZHONG[b].name + '？';
    }

    if (st.known.color || st.state !== 'rough') out.color = COLOR[ci].name;
    else if (st.window !== 0) out.color = COLOR[clamp(ci + (st.seed > 0.7 ? 1 : 0), 0, COLOR.length - 1)].name + '（窗口所見）';
    else out.color = '皮下未明';

    const lv = v => v < 0.2 ? '幾乎無' : v < 0.4 ? '少' : v < 0.65 ? '中等' : v < 0.85 ? '多' : '滿';
    out.crack = (st.known.crack || st.state !== 'rough') ? lv(st.crack) : '未探';
    out.cotton = (st.known.cotton || st.state !== 'rough') ? lv(st.cotton) : '未探';
    out.skin = SKIN.find(s => s.id === st.skin);
    return out;
  }

  /* ---- 相玉動作 ---- */

  // 打燈：揭示種；相玉師差的話有機會誤判（顯示但標記存疑）
  function candle(st) {
    st.known.zhong = true;
    return { ok: true, msg: '打燈：光透進去，質地看清楚了 — ' + ZHONG[st.zhong].name };
  }

  // 放大鏡：揭示裂與棉
  function inspect(st) {
    st.known.crack = true;
    st.known.cotton = true;
    return { ok: true, msg: '十倍鏡下：裂' + (st.crack > 0.6 ? '一片' : st.crack > 0.35 ? '不少' : '不多') +
      '，棉' + (st.cotton > 0.5 ? '偏重' : '還好') };
  }

  // 開窗：揭示色（有機會擦壞）
  function openWindow(st, eyeSkill) {
    const skill = clamp((eyeSkill || 0) / 10, 0, 1);
    st.known.color = true;
    st.known.zhong = true;
    const good = rnd() < 0.45 + skill * 0.35;
    st.window = good ? 1 : -1;
    return {
      ok: true, good,
      msg: good
        ? '窗口擦得漂亮，色從窗口透出來 — ' + COLOR[st.color].name + '，賭性降了，價也好開口。'
        : '手一抖擦歪了，窗口見髒見綹 — ' + COLOR[st.color].name + '，行家看了搖頭。'
    };
  }

  // 切開：全揭示，切壞會加裂
  function cutOpen(st, eyeSkill) {
    const skill = clamp((eyeSkill || 0) / 10, 0, 1);
    const before = trueValue(st);
    // 切歪：沒相玉師時容易一刀切在色上
    if (rnd() > 0.5 + skill * 0.4) st.crack = clamp(st.crack + 0.08 + rnd() * 0.12, 0, 0.97);
    st.state = 'open';
    st.known = { zhong: true, color: true, crack: true, cotton: true };
    const after = trueValue(st);
    return { ok: true, before, after, msg: '切面見肉：' + ZHONG[st.zhong].name + ' ' + COLOR[st.color].name };
  }

  function polish(st) {
    st.state = 'polished';
    return { ok: true, msg: '拋光完成，起貨了。' };
  }

  /* ---- 開採造成的裂 ---- */
  function addMiningCrack(st, amount) {
    st.crack = clamp(st.crack + amount, 0, 0.97);
  }

  function label(st) {
    const z = ZHONG[st.zhong], c = COLOR[st.color];
    if (st.state === 'rough') return st.siteName + '原石 ' + st.kg + 'kg';
    return (st.state === 'polished' ? '成品 ' : '明料 ') + z.name + c.name + ' ' + st.kg + 'kg';
  }

  global.JADE = {
    makeStone, trueValue, estimate, describe, candle, inspect,
    openWindow, cutOpen, polish, addMiningCrack, label, knownRatio, clamp, gauss, pick
  };
})(window);
