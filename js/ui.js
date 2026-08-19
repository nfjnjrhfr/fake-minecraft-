/* ============================================================
   開玉 — 介面層
   ============================================================ */
(function (global) {
  'use strict';
  const D = global.DATA, J = global.JADE, M = global.MINE, G = global.GAME;
  const { EQUIP, SUPPLY, SITES, ROLES, ZHONG, COLOR } = D;

  let tab = 'camp';
  const sel = { team: {}, haul: {}, auct: {}, hover: null };

  const $ = s => document.querySelector(s);
  const money = v => G.money(v);
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const S = () => G.S;

  /* ---------------- toast ---------------- */
  function toast(msg, cls) {
    if (!msg) return;
    const box = $('#toast');
    // 同一句話不洗版，累加次數就好
    const last = box.lastElementChild;
    if (last && last.dataset.msg === msg) {
      last.dataset.n = (+last.dataset.n || 1) + 1;
      last.textContent = msg + ' ×' + last.dataset.n;
      clearTimeout(+last.dataset.timer);
      last.dataset.timer = setTimeout(() => last.remove(), 2600);
      return;
    }
    const d = document.createElement('div');
    d.className = 'toastmsg ' + (cls || '');
    d.dataset.msg = msg; d.dataset.n = 1;
    d.textContent = msg;
    box.appendChild(d);
    while (box.children.length > 3) box.firstElementChild.remove();
    d.dataset.timer = setTimeout(() => d.remove(), 2600);
  }

  /* ---------------- 頂欄 ---------------- */
  function header() {
    const s = S();
    const trend = s.market >= 1.15 ? '📈' : s.market <= 0.85 ? '📉' : '➖';
    $('#stats').innerHTML = [
      ['第 ' + s.day + ' 天', '日期'],
      [s.weather.icon + ' ' + s.weather.name, '天氣'],
      [money(s.money), '資金'],
      [Math.round(s.morale) + '%', '士氣'],
      [s.rep, '名聲'],
      [trend + ' ' + s.market.toFixed(2), '玉價指數'],
      [s.workers.length + ' 人', '隊伍'],
      [s.stones.length + ' 顆', '倉庫存料']
    ].map(([b, l]) => '<div class="stat"><b>' + esc(b) + '</b><span>' + l + '</span></div>').join('');
  }

  const TABS = [
    { id: 'camp', name: '⛺ 營地' },
    { id: 'mine', name: '⛏ 礦場' },
    { id: 'shop', name: '🔦 工房' },
    { id: 'market', name: '💰 市場' },
    { id: 'crew', name: '👷 人力' },
    { id: 'store', name: '🏪 補給站' },
    { id: 'log', name: '📜 日誌' }
  ];

  function tabsBar() {
    const s = S();
    $('#tabs').innerHTML = TABS.map(t => {
      let badge = '';
      if (t.id === 'mine' && s.session) badge = '<span class="badge">作業中</span>';
      if (t.id === 'shop' && s.stones.length) badge = '<span class="badge">' + s.stones.length + '</span>';
      if (t.id === 'market' && G.auctionReady()) badge = '<span class="badge">公盤</span>';
      return '<button class="tab ' + (tab === t.id ? 'on' : '') + '" data-act="tab" data-tab="' + t.id + '">' + t.name + badge + '</button>';
    }).join('');
  }

  /* ---------------- 營地 ---------------- */
  function viewCamp() {
    const s = S();
    const chosen = s.workers.filter(w => sel.team[w.id] && w.injury === 0);
    const cap = (function () {
      // 以目前勾選的隊伍估算載重
      const fake = { team: chosen.map(w => w.id) };
      const old = s.session; s.session = fake;
      const c = G.carryCapacity(null); s.session = old; return c;
    })();

    const checks = [
      ['照明', G.has('headlamp') || G.has('floodlight'), '沒燈只看得到洞口附近，還更容易出事'],
      ['抽水機', G.has('pump'), '水線以下效率只剩四成'],
      ['安全帽', s.equip.helmet && s.equip.helmet.qty >= Math.max(1, chosen.length), '一人一頂才算配齊'],
      ['運輸', cap > 60, '載重不足，挖到的料只能丟在山上'],
      ['柴油', s.supply.diesel >= 20, '機具沒油等於廢鐵'],
      ['糧食', s.supply.food >= s.workers.length * 2, '斷糧士氣崩盤']
    ];

    const crew = s.workers.map(w => {
      const on = sel.team[w.id] && w.injury === 0;
      return '<div class="checkrow ' + (on ? 'on' : '') + ' ' + (w.injury ? 'hurt' : '') + '" data-act="team" data-id="' + w.id + '">' +
        '<div style="flex:1"><b>' + esc(w.name) + '</b> <span class="tag">' + ROLES[w.role].name + ' Lv' + w.level + '</span>' +
        (w.injury ? '<span class="tag r">傷 ' + w.injury + '天</span>' : '') +
        '<div class="bar" style="margin-top:4px"><i style="width:' + (w.stam / w.maxStam * 100) + '%"></i></div>' +
        '<div class="tiny muted">體力 ' + Math.round(w.stam) + '/' + w.maxStam +
        '　採礦' + w.skill.mine + ' 爆破' + w.skill.blast + ' 機械' + w.skill.mech + ' 相玉' + w.skill.eye + '</div></div></div>';
    }).join('') || '<p class="muted">沒有工人了，去人力市場招人。</p>';

    const sites = SITES.map(st => {
      const stash = (s.stash[st.id] || []).length;
      const owned = !!(s.owned && s.owned[st.id]);
      return '<div class="card site' + (owned ? ' mine-owned' : '') + '">' +
        '<div class="spread"><h3>' + st.name + ' <span class="sub">海拔 ' + st.alt + 'm</span></h3>' +
        (owned ? '<b class="tag j">🏠 自家礦權</b>' : '<b class="est">' + money(st.fee) + '/天</b>') + '</div>' +
        '<p class="tiny muted" style="margin:4px 0 8px">' + st.desc + '</p>' +
        '<div class="tagline">' +
        '<span class="tag ' + (st.danger > 0.25 ? 'r' : '') + '">危險 ' + Math.round(st.danger * 100) + '%</span>' +
        '<span class="tag b">水位 ' + Math.round(st.water * 100) + '%</span>' +
        '<span class="tag">圍岩硬度 ×' + st.hardness + '</span>' +
        '<span class="tag">路況 ' + '★'.repeat(st.road) + '</span>' +
        '<span class="tag j">出料率 ' + Math.round(st.density * 100) + '%</span>' +
        (stash ? '<span class="tag g">山上存料 ' + stash + ' 顆</span>' : '') +
        '</div>' +
        '<div class="row">' +
        '<button class="btn primary" data-act="go" data-site="' + st.id + '"' + (chosen.length ? '' : ' disabled') + '>' +
        (chosen.length ? '帶 ' + chosen.length + ' 人上山' + (owned ? '（免費）' : '') + ' →' : '先在右邊編隊') + '</button>' +
        (owned ? '' : '<button class="btn sm gold" data-act="buyout" data-site="' + st.id + '">買斷 ' + money(G.buyoutPrice(st.id)) + '</button>') +
        '</div></div>';
    }).join('');

    return '<div class="grid cols2">' +
      '<div class="card"><h3>今天 <span class="sub">' + s.weather.icon + ' ' + s.weather.name + '　' + s.weather.desc + '</span></h3>' +
      '<div class="tagline">' + checks.map(c =>
        '<span class="tag ' + (c[1] ? 'j' : 'r') + '" title="' + c[2] + '">' + (c[1] ? '✓ ' : '✗ ') + c[0] + '</span>').join('') + '</div>' +
      '<div class="tiny muted">' + checks.filter(c => !c[1]).map(c => '· ' + c[0] + '：' + c[2]).join('<br>') + '</div>' +
      '<hr><div class="spread"><span>選定隊伍載重上限</span><b class="est">' + cap + ' kg</b></div>' +
      '<div class="tiny muted">載重＝人力 20kg/人＋背工 40kg＋運輸設備（路況不足的車輛開不進場口）</div>' +
      '</div>' +
      '<div class="card"><h3>編隊 <span class="sub">點選要上山的人</span></h3>' + crew + '</div>' +
      '</div>' +
      '<h3 style="margin:18px 0 8px;letter-spacing:2px">場口 — 你今天要賭哪一個坑？</h3>' +
      '<div class="grid cols3">' + sites + '</div>';
  }

  /* ---------------- 礦場 ---------------- */
  function viewMine() {
    const s = S();
    if (!s.session) {
      return '<div class="card" style="text-align:center;padding:50px">' +
        '<div class="big">隊伍還在營地</div>' +
        '<p class="muted">到「營地」編隊、選場口，付了礦權費才能上山。</p>' +
        '<button class="btn primary" data-act="tab" data-tab="camp">去營地 →</button></div>';
    }
    const ss = s.session;

    // 工人面板
    const crew = ss.team.map(id => {
      const w = s.workers.find(x => x.id === id);
      if (!w) return '';
      return '<div class="wrk ' + (ss.active === id ? 'on' : '') + ' ' + (w.injury ? 'hurt' : '') + '" data-act="active" data-id="' + id + '">' +
        '<div class="spread"><b>' + esc(w.name) + '</b><span class="tiny muted">' + ROLES[w.role].name + '</span></div>' +
        '<div class="bar' + (w.stam < w.maxStam * 0.25 ? ' red' : '') + '"><i style="width:' + Math.max(0, w.stam / w.maxStam * 100) + '%"></i></div>' +
        '<div class="tiny muted">體力 ' + Math.round(w.stam) + '/' + w.maxStam + (w.injury ? '　🩹傷' : '') + '</div></div>';
    }).join('');

    // 工具列
    const toolIds = Object.keys(EQUIP).filter(id => EQUIP[id].tool);
    const tools = toolIds.map((id, i) => {
      const e = EQUIP[id], chk = M.canUse(s, ss, id);
      const t = e.tool;
      const info = [
        '威力 ' + t.power,
        '型 ' + ({ single: '單格', vert3: '直三格', horz3: '橫三格', cross: '十字', box3: '3×3', blast: '爆破半徑2' })[t.pattern],
        '體力 ' + t.stam,
        '傷玉 ' + Math.round(t.crack * 100) + '%'
      ].join('　');
      const cost = [];
      if (t.fuel) for (const k in t.fuel) cost.push(SUPPLY[k].icon + t.fuel[k]);
      if (t.use) for (const k in t.use) cost.push(SUPPLY[k].icon + t.use[k]);
      return '<button class="toolbtn ' + (ss.tool === id ? 'on' : '') + '" data-act="tool" data-id="' + id + '"' +
        (chk.ok ? '' : ' disabled title="' + esc(chk.why) + '"') + '>' +
        '<span class="ico">' + e.icon + '</span><span style="flex:1"><b>' + e.name + '</b> <span class="tiny muted">[' + (i + 1) + ']</span>' +
        '<div class="meta">' + info + (cost.length ? '　' + cost.join(' ') : '') + '</div></span></button>';
    }).join('');

    const risk = M.collapseRisk(s, ss);
    const riskTxt = risk < 0.15 ? '低' : risk < 0.3 ? '中' : risk < 0.5 ? '高' : '極高';
    const found = ss.stones.length
      ? ss.stones.map(st => '<div class="tiny">💎 ' + st.kg + 'kg　' + st.siteName + '　<span class="muted">' + (st.note || '待相玉') + '</span></div>').join('')
      : '<div class="tiny muted">還沒挖到東西。往深處推進，玉脈帶（帶綠紋的岩層）機率最高。</div>';

    return '<div class="minewrap">' +
      '<div>' +
        '<div class="card"><h3>下坑班表</h3>' + crew + '</div>' +
        '<div class="card" style="margin-top:12px"><h3>支援設備</h3>' +
          '<button class="toolbtn ' + (ss.pumpOn ? 'on' : '') + '" data-act="pump"><span class="ico">💧</span><span><b>抽水機</b>' +
            '<div class="meta">' + (ss.pumpOn ? '運轉中（每 3 次作業耗 3L 柴油）' : '停機 — 水線下效率 40%') + '</div></span></button>' +
          '<button class="toolbtn ' + (ss.lightOn ? 'on' : '') + '" data-act="light"><span class="ico">💡</span><span><b>照明</b>' +
            '<div class="meta">' + (ss.lightOn ? '已開，可視半徑 ' + M.lightRadius(s, ss) : '關閉') + '</div></span></button>' +
          '<button class="toolbtn" data-act="timber"><span class="ico">🪵</span><span><b>架設坑木</b>' +
            '<div class="meta">已架 ' + ss.timbers + ' 組（庫存 ' + (s.supply.wood || 0) + '）　塌方 -18%/組</div></span></button>' +
        '</div>' +
        '<div class="card" style="margin-top:12px"><h3>坑內狀況</h3>' +
          '<div class="spread tiny"><span>塌方風險</span><b class="' + (risk > 0.3 ? 'tag r' : 'tag j') + '">' + riskTxt + '</b></div>' +
          '<div class="bar ' + (risk > 0.3 ? 'red' : '') + '"><i style="width:' + Math.min(100, risk * 160) + '%"></i></div>' +
          '<hr><div class="tiny muted">柴油 ' + Math.round(s.supply.diesel) + 'L　電池 ' + s.supply.battery +
          '　炸藥 ' + s.supply.dynamite + '　坑木 ' + s.supply.wood + '<br>已開挖 ' + ss.dugCount + ' 格　作業 ' + ss.actions + ' 次</div>' +
        '</div>' +
      '</div>' +
      '<div>' +
        '<div class="card enter3d">' +
          '<div class="e3-art"><span>⛏</span></div>' +
          '<div class="big">' + ss.site.name + '　坑口</div>' +
          '<p class="muted tiny">全螢幕第一人稱。頭燈只照得到前方，坑道深處看不見 —— <b>跟著地上的螢光導引線走</b>，走到底就是開採面。<br>你帶的隊友會跟你一起下坑、<b>自動散開找玉開挖</b>；按 T 可以接手任何一個人的位置。</p>' +
          '<button class="btn primary big-btn" data-act="enter3d">▶ 進入坑道（全螢幕 3D）</button>' +
          '<div class="keys">' +
            '<span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 走動</span>' +
            '<span><kbd>滑鼠</kbd> 環顧四周</span>' +
            '<span><kbd>左鍵</kbd> 揮工具開挖</span>' +
            '<span><kbd>1</kbd>~<kbd>8</kbd> 換工具</span>' +
            '<span><kbd>T</kbd> 換人</span>' +
            '<span><kbd>F</kbd> 燈　<kbd>P</kbd> 抽水　<kbd>G</kbd> 坑木</span>' +
            '<span><kbd>M</kbd> 小地圖（只顯示走過的地方）</span>' +
            '<span><kbd>Q</kbd> 離開坑道</span>' +
          '</div>' +
          '<p class="tiny muted" style="margin-top:8px">📱 觸控裝置：左下搖桿走路、滑畫面轉頭、右下 ⛏ 按住連挖，右上按鈕換工具／收工。</p>' +
          '<button class="btn gold" data-act="quit" style="margin-top:10px">🎒 收工下山</button>' +
        '</div>' +
      '</div>' +
      '<div class="card"><h3>今日產出 <span class="sub">' + ss.stones.length + ' 顆</span></h3>' + found +
        '<hr><h3>提示</h3><div class="tiny muted">' +
        '· 帶綠紋的<b>玉脈帶</b>出料率最高，硬岩其次。<br>' +
        '· 岩壁快被打穿時會透出<b>綠光</b>，那裡有料 — 換<b>鑿子</b>取出來才不會震裂。<br>' +
        '· 風鎬／挖土機／炸藥快，但傷玉率 50~85%，裂一多價格直接砍七成。<br>' +
        '· 積水區地面偏藍、走路變慢，開抽水機才挖得動。<br>' +
        '· 挖得越深越容易塌，記得架坑木。</div></div>' +
      '</div>';
  }

  /* ---------------- 收工／載運 ---------------- */
  function haulModal() {
    const s = S();
    const all = G.haulOptions();
    const cap = G.carryCapacity(s.session.site);
    // 預設自動挑：估價/公斤 高的優先
    if (!sel.haulInit) {
      sel.haul = {};
      let load = 0;
      all.slice().sort((a, b) => J.estimate(b, G.eyeSkill()).mid / b.kg - J.estimate(a, G.eyeSkill()).mid / a.kg)
        .forEach(st => { if (load + st.kg <= cap) { sel.haul[st.id] = true; load += st.kg; } });
      sel.haulInit = true;
    }
    const load = all.filter(st => sel.haul[st.id]).reduce((a, b) => a + b.kg, 0);
    const rows = all.map(st => {
      const e = J.estimate(st, G.eyeSkill());
      return '<div class="checkrow ' + (sel.haul[st.id] ? 'on' : '') + '" data-act="haul" data-id="' + st.id + '">' +
        '<span style="flex:1"><b>' + st.kg + 'kg</b> ' + st.siteName + '　<span class="tiny muted">' +
        (D.SKIN.find(k => k.id === st.skin) || {}).name + '　' + (st.note || '') + '</span></span>' +
        '<span class="est tiny">估 ' + money(e.low) + '～' + money(e.high) + '</span></div>';
    }).join('') || '<p class="muted">今天空手而回。</p>';

    return '<h3>收工下山 — 挑要扛下去的料</h3>' +
      '<p class="tiny muted">載重上限 ' + cap + 'kg（人力＋背工＋運輸設備）。沒帶下去的留在山上，下次來還在，但會被別人摸走一部分的風險自負。</p>' +
      '<div class="spread"><span>目前裝載</span><b class="' + (load > cap ? 'tag r' : 'est') + '">' + load.toFixed(1) + ' / ' + cap + ' kg</b></div>' +
      '<div class="bar ' + (load > cap ? 'red' : 'gold') + '" style="margin:6px 0 12px"><i style="width:' + Math.min(100, load / cap * 100) + '%"></i></div>' +
      rows +
      '<div class="row" style="margin-top:14px"><button class="btn primary" data-act="haul-ok">確認下山</button>' +
      '<button class="btn ghost" data-act="close">再挖一下</button></div>';
  }

  /* ---------------- 工房 ---------------- */
  function viewShop() {
    const s = S();
    const eye = G.eyeSkill();
    const tools = [
      ['flashlight', '打燈看種水', 'candle'],
      ['loupe', '放大鏡看裂棉', 'loupe'],
      ['grinder', '磨機開窗看色', 'window'],
      ['saw', '切石機開料', 'cut'],
      ['polisher', '拋光起貨', 'polish'],
      ['scale', '電子秤（被動）', null]
    ];
    const bar = tools.map(([id, desc]) => {
      const ok = G.has(id), e = s.equip[id];
      return '<span class="tag ' + (ok ? 'j' : 'r') + '">' + EQUIP[id].icon + ' ' + EQUIP[id].name +
        (e ? '　' + Math.round(e.dur / e.max * 100) + '%' : '（未購入）') + '</span>';
    }).join('');

    if (!s.stones.length) {
      return '<div class="card"><h3>工房</h3><div class="tagline">' + bar + '</div>' +
        '<p class="muted">倉庫沒有料。上山挖，或者從市場…市場只收不賣。</p></div>';
    }

    const cards = s.stones.map(st => {
      const d = J.describe(st, eye), e = J.estimate(st, eye);
      const rough = st.state === 'rough';
      const btn = (a, label, cond, tip) =>
        '<button class="btn sm ' + (a === 'cut' ? 'gold' : '') + '" data-act="ws" data-a="' + a + '" data-id="' + st.id + '"' +
        (cond ? '' : ' disabled') + ' title="' + esc(tip || '') + '">' + label + '</button>';
      return '<div class="stone ' + st.state + '">' +
        '<span class="kg">' + st.kg + ' kg</span>' +
        '<div class="name">' + (rough ? st.siteName + '　原石' : (st.state === 'polished' ? '✨ 成品' : '🔪 明料')) + '</div>' +
        '<div class="tiny muted">' + d.skin.name + '　' + d.skin.hint + '</div>' +
        '<div class="kv">' +
        '<b>種</b><span>' + d.zhong + '</span>' +
        '<b>色</b><span>' + d.color + '</span>' +
        '<b>裂</b><span>' + d.crack + '</span>' +
        '<b>棉</b><span>' + d.cotton + '</span>' +
        (st.window ? '<b>窗</b><span>' + (st.window > 0 ? '開得漂亮' : '窗口見髒') + '</span>' : '') +
        '</div>' +
        '<div class="est">' + (rough ? '估值 ' + money(e.low) + ' ～ ' + money(e.high) : '實價 ' + money(J.trueValue(st))) +
        '<span class="tiny muted">　把握度 ' + Math.round(e.sure * 100) + '%</span></div>' +
        '<div class="acts">' +
        btn('candle', '🔦 打燈', rough && !st.known.zhong && G.has('flashlight') && s.supply.battery > 0, '揭示種') +
        btn('loupe', '🔍 相裂', rough && !st.known.crack && G.has('loupe'), '揭示裂與棉') +
        btn('window', '🪚 開窗', rough && !st.window && G.has('grinder') && s.supply.grindwheel > 0, '揭示色，消耗砂輪片') +
        btn('cut', '🪓 切開', rough && G.has('saw') && s.supply.blade > 0, '一刀定生死，消耗切割片') +
        btn('polish', '✨ 拋光', st.state === 'open' && G.has('polisher') && s.supply.grindwheel > 0, '售價 +30%') +
        '</div></div>';
    }).join('');

    return '<div class="card"><h3>工房 <span class="sub">相玉師眼力 ' + eye + '／10　— 眼力越高，估價越準、開窗切石越不容易失手</span></h3>' +
      '<div class="tagline">' + bar + '</div>' +
      '<div class="tiny muted">砂輪片 ' + s.supply.grindwheel + '　切割片 ' + s.supply.blade + '　電池 ' + s.supply.battery + '</div>' +
      '<div class="row" style="margin-top:8px">' +
      '<button class="btn sm" data-act="wsall" data-a="candle">🔦 全部打燈</button>' +
      '<button class="btn sm" data-act="wsall" data-a="loupe">🔍 全部相裂</button>' +
      '<span class="tiny muted">批次處理，耗材不夠就做到沒有為止</span></div></div>' +
      '<div class="grid cols3" style="margin-top:12px">' + cards + '</div>';
  }

  /* ---------------- 市場 ---------------- */
  function viewMarket() {
    const s = S();
    const buyers = s.buyers.map((b, i) =>
      '<div class="card"><h3>' + esc(b.name) + ' <span class="sub">' + b.pref.name + '</span></h3>' +
      '<div class="tiny muted">出價基準 ' + (b.base * s.market).toFixed(2) + '×　對口的貨加 ' +
      Math.round((b.pref.mult - 1) * 100) + '%</div></div>').join('');

    const rows = s.stones.map(st => {
      const e = J.estimate(st, G.eyeSkill());
      const offers = s.buyers.map((b, i) => {
        const p = G.offerFor(st, b);
        return '<td><button class="btn sm" data-act="sell" data-id="' + st.id + '" data-b="' + i + '">' + money(p) + '</button></td>';
      }).join('');
      return '<tr><td><b>' + st.kg + 'kg</b> ' + (st.state === 'rough' ? st.siteName + '原石' :
        ZHONG[st.zhong].name + COLOR[st.color].name + (st.state === 'polished' ? '成品' : '明料')) +
        '<div class="tiny muted">' + (st.state === 'rough' ? '自估 ' + money(e.mid) : '實價 ' + money(J.trueValue(st))) + '</div></td>' +
        offers +
        '<td><label class="tiny"><input type="checkbox" data-act="auct" data-id="' + st.id + '"' +
        (sel.auct[st.id] ? ' checked' : '') + '> 投公盤</label></td></tr>';
    }).join('');

    const auctBtn = G.auctionReady()
      ? '<button class="btn gold" data-act="auction">🏛 送件開標（手續費 10%）</button>'
      : '<button class="btn" disabled>下次公盤：第 ' + (s.lastAuction + 7) + ' 天</button>';

    return '<div class="grid cols3">' + buyers + '</div>' +
      '<div class="card" style="margin-top:12px"><div class="spread"><h3>出貨 <span class="sub">玉價指數 ' + s.market.toFixed(2) + '　名聲加成 +' +
      Math.round(Math.min(25, s.rep * 0.4)) + '%</span></h3>' + auctBtn + '</div>' +
      (s.stones.length ? '<table><thead><tr><th>貨</th>' +
        s.buyers.map(b => '<th>' + esc(b.name) + '</th>').join('') + '<th>公盤</th></tr></thead><tbody>' + rows + '</tbody></table>'
        : '<p class="muted">沒有貨可賣。</p>') +
      '<hr><div class="tiny muted">原石（未切）玉商會壓賭性折扣，資訊揭露越多、折扣越少；切開的明料按實價收，拋光再加三成。' +
      '公盤三口暗標取最高，通常比玉商好，但七天才一次。</div></div>';
  }

  /* ---------------- 人力 ---------------- */
  function viewCrew() {
    const s = S();
    const card = (w, hireMode) => {
      const cost = w.wage * 5;
      return '<div class="card"><div class="spread"><h3>' + esc(w.name) +
        ' <span class="sub">' + ROLES[w.role].name + '　Lv' + w.level + '</span></h3>' +
        '<b class="est">' + money(w.wage) + '/天</b></div>' +
        '<div class="tiny muted">' + ROLES[w.role].desc + '</div>' +
        '<div class="kv tiny" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin:8px 0">' +
        ['mine', 'blast', 'mech', 'eye'].map(k =>
          '<span>' + G.skillLabel(k) + ' <b class="est">' + w.skill[k] + '</b></span>').join('') + '</div>' +
        '<div class="bar"><i style="width:' + (w.stam / w.maxStam * 100) + '%"></i></div>' +
        '<div class="tiny muted">體力 ' + Math.round(w.stam) + '/' + w.maxStam + '　士氣 ' + Math.round(w.morale) + '%' +
        (w.injury ? '　<span class="tag r">傷 ' + w.injury + ' 天</span>' : '') + '</div>' +
        '<div class="row" style="margin-top:8px">' +
        (hireMode
          ? '<button class="btn primary" data-act="hire" data-id="' + w.id + '">僱用（簽約金 ' + money(cost) + '）</button>'
          : '<button class="btn" data-act="train" data-id="' + w.id + '">訓練 ' + money(8000 + w.level * 4000) + '</button>' +
            '<button class="btn danger sm" data-act="fire" data-id="' + w.id + '">辭退</button>') +
        '</div></div>';
    };
    return '<h3 style="letter-spacing:2px">我的隊伍（每天發薪 ' +
      money(s.workers.reduce((a, w) => a + w.wage, 0)) + '）</h3>' +
      '<div class="grid cols3">' + (s.workers.map(w => card(w, false)).join('') || '<p class="muted">沒人了。</p>') + '</div>' +
      '<h3 style="margin-top:20px;letter-spacing:2px">今天在山下等活的人</h3>' +
      '<div class="grid cols3">' + G.candidates().map(w => card(w, true)).join('') + '</div>';
  }

  /* ---------------- 補給站 ---------------- */
  function viewStore() {
    const s = S();
    const CATS = { dig: '採掘工具', support: '支援設備', safety: '安全裝備', transport: '運輸工具', shop: '工房器材', camp: '營地設施' };
    const blocks = Object.keys(CATS).map(cat => {
      const items = Object.keys(EQUIP).filter(id => EQUIP[id].cat === cat).map(id => {
        const def = EQUIP[id], e = s.equip[id];
        const dur = e ? Math.round(e.dur / e.max * 100) : 0;
        const need = (def.needs || []).map(n => EQUIP[n].name).join('、');
        return '<div class="card" style="padding:10px">' +
          '<div class="spread"><b>' + def.icon + ' ' + def.name + (e && e.qty ? ' ×' + e.qty : '') + '</b>' +
          '<span class="est">' + money(def.price) + '</span></div>' +
          '<div class="tiny muted">' + def.desc + (need ? '　<span class="tag r">需 ' + need + '</span>' : '') + '</div>' +
          (e && e.qty ? '<div class="bar ' + (dur < 30 ? 'red' : '') + '" style="margin:6px 0"><i style="width:' + dur + '%"></i></div>' +
            '<div class="tiny muted">耐久 ' + dur + '%</div>' : '') +
          '<div class="row" style="margin-top:6px">' +
          '<button class="btn sm" data-act="buyeq" data-id="' + id + '">購入</button>' +
          (e && e.qty && dur < 100 ? '<button class="btn sm gold" data-act="repair" data-id="' + id + '">維修</button>' : '') +
          '</div></div>';
      }).join('');
      return '<h3 style="margin:16px 0 8px;letter-spacing:2px">' + CATS[cat] + '</h3><div class="grid cols3">' + items + '</div>';
    }).join('');

    const sup = Object.keys(SUPPLY).map(id => {
      const d = SUPPLY[id];
      return '<div class="card" style="padding:10px"><div class="spread"><b>' + d.icon + ' ' + d.name + '</b>' +
        '<span class="est">' + money(d.price) + '/' + d.unit + '</span></div>' +
        '<div class="tiny muted">庫存 ' + (s.supply[id] || 0) + ' ' + d.unit + '</div>' +
        '<div class="row" style="margin-top:6px">' +
        [1, 10, 50].map(n => '<button class="btn sm" data-act="buysup" data-id="' + id + '" data-n="' + n + '">+' + n + '</button>').join('') +
        '</div></div>';
    }).join('');

    return '<div class="card"><h3>補給站 <span class="sub">資金 ' + money(s.money) + '</span></h3>' +
      '<div class="tiny muted">設備會磨損，耐久 0 就報廢不能用；維修比重買便宜。運輸工具受場口路況限制。</div></div>' +
      '<h3 style="margin:16px 0 8px;letter-spacing:2px">消耗品</h3><div class="grid cols3">' + sup + '</div>' + blocks;
  }

  /* ---------------- 日誌 ---------------- */
  function viewLog() {
    const s = S();
    return '<div class="grid cols2">' +
      '<div class="card"><h3>經營數據</h3><table><tbody>' +
      [['經營天數', s.stats.days], ['挖出原石', s.stats.mined + ' 顆'], ['成交', s.stats.sold + ' 件'],
       ['總營收', money(s.stats.revenue)], ['單筆最高', money(s.stats.bestSale)], ['工安事故', s.stats.accidents + ' 次'],
       ['名聲', s.rep], ['現金', money(s.money)]]
        .map(r => '<tr><td class="muted">' + r[0] + '</td><td><b>' + r[1] + '</b></td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="card"><h3>山上存料</h3>' +
      (Object.keys(s.stash).filter(k => s.stash[k].length).map(k =>
        '<div class="tiny">' + SITES.find(x => x.id === k).name + '：' + s.stash[k].length + ' 顆（' +
        s.stash[k].reduce((a, b) => a + b.kg, 0).toFixed(1) + 'kg）等著搬下山</div>').join('') || '<p class="tiny muted">沒有。</p>') +
      '</div></div>' +
      '<div class="card" style="margin-top:12px"><h3>工作日誌</h3>' +
      s.log.map(l => '<div class="logline ' + l.cls + '"><span class="d">D' + l.day + '</span>' + esc(l.msg) + '</div>').join('') +
      '</div>';
  }

  /* ---------------- 主渲染 ---------------- */
  function render() {
    const s = S();
    header(); tabsBar();
    if (s.over) {
      $('#view').innerHTML = '<div class="card" style="text-align:center;padding:60px">' +
        '<div class="big" style="color:var(--red)">遊戲結束</div><p>' + esc(s.over) + '</p>' +
        '<p class="muted">經營 ' + s.stats.days + ' 天，總營收 ' + money(s.stats.revenue) + '</p>' +
        '<button class="btn primary" data-act="reset">再開一局</button></div>';
      return;
    }
    const v = { camp: viewCamp, mine: viewMine, shop: viewShop, market: viewMarket, crew: viewCrew, store: viewStore, log: viewLog }[tab];
    $('#view').innerHTML = v();
  }

  /* ---------------- 全螢幕 ---------------- */
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }
  function goFullscreen() {
    if (isFullscreen()) {
      const ex = document.exitFullscreen || document.webkitExitFullscreen;
      if (ex) { try { const r = ex.call(document); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
      return;
    }
    const el = document.documentElement;
    const fs = el.requestFullscreen || el.webkitRequestFullscreen;
    const hint = () => toast('瀏覽器擋住了全螢幕。iPad 可以用 Safari 的 分享 → 加入主畫面，從主畫面圖示打開就是全螢幕。', 'bad');
    if (!fs) { hint(); return; }
    try {
      const r = fs.call(el);
      if (r && r.catch) r.catch(hint);
    } catch (e) { hint(); }
  }
  function fsLabel() {
    const btn = $('#fsBtn');
    if (btn) btn.textContent = isFullscreen() ? '🡼 離開全螢幕' : '⛶ 全螢幕';
  }
  document.addEventListener('fullscreenchange', fsLabel);
  document.addEventListener('webkitfullscreenchange', fsLabel);

  /* ---------------- 固定畫面 ---------------- */
  let lockGuard = null;
  function setLock(on) {
    document.body.classList.toggle('locked', on);
    const btn = $('#lockBtn');
    if (btn) { btn.textContent = on ? '🔒 已固定' : '🔓 固定畫面'; btn.classList.toggle('on', on); }
    try { localStorage.setItem('kaiyu-lock', on ? '1' : ''); } catch (e) {}
    if (on) {
      const el = document.documentElement;
      const fs = el.requestFullscreen || el.webkitRequestFullscreen;
      if (fs) { try { const r = fs.call(el); if (r && r.catch) r.catch(() => {}); } catch (e) {} }
      if (!lockGuard) {
        lockGuard = e => e.preventDefault();
        document.addEventListener('gesturestart', lockGuard, { passive: false });  // 捏合縮放
        document.addEventListener('dblclick', lockGuard);                          // 雙擊縮放
      }
    } else {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      if (lockGuard) {
        document.removeEventListener('gesturestart', lockGuard);
        document.removeEventListener('dblclick', lockGuard);
        lockGuard = null;
      }
    }
  }
  function toggleLock() { setLock(!document.body.classList.contains('locked')); }

  function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); sel.haulInit = false; }

  /* ---------------- 事件 ---------------- */
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const a = el.dataset.act, id = el.dataset.id;
    const s = S();

    switch (a) {
      case 'tab': tab = el.dataset.tab; render(); break;

      case 'team':
        if (sel.team[id]) delete sel.team[id]; else sel.team[id] = true;
        render(); break;

      case 'buyout': {
        const r = G.buyoutSite(el.dataset.site);
        toast(r.ok ? '這座山頭是你的了！' : r.msg, r.ok ? 'gold' : 'bad');
        if (r.ok) G.save();
        render(); break;
      }

      case 'go': {
        const ids = s.workers.filter(w => sel.team[w.id] && w.injury === 0).map(w => w.id);
        const r = G.startMining(el.dataset.site, ids);
        if (!r.ok) { toast(r.msg, 'bad'); break; }
        tab = 'mine'; render(); break;
      }

      case 'active': s.session.active = id; render(); break;
      case 'tool': s.session.tool = id; render(); break;
      case 'pump': { const r = M.togglePump(s, s.session); toast(r.msg, r.ok ? '' : 'bad'); render(); break; }
      case 'light': { const r = M.toggleLight(s, s.session); toast(r.msg, r.ok ? '' : 'bad'); render(); break; }
      case 'timber': { const r = M.placeTimber(s, s.session); toast(r.msg, r.ok ? '' : 'bad'); render(); break; }

      case 'enter3d': {
        if (!s.session) { toast('隊伍不在山上', 'bad'); break; }
        M.enter(s, () => { G.save(); render(); toast('回到坑口'); });
        break;
      }
      case 'quit': sel.haulInit = false; openModal(haulModal()); break;
      case 'haul':
        if (sel.haul[id]) delete sel.haul[id]; else sel.haul[id] = true;
        openModal(haulModal()); break;
      case 'haul-ok': {
        const r = G.endMining(Object.keys(sel.haul).filter(k => sel.haul[k]));
        if (!r.ok) { toast(r.msg, 'bad'); break; }
        closeModal(); sel.haul = {}; tab = 'shop'; G.save(); render(); break;
      }
      case 'close': closeModal(); render(); break;

      case 'ws': {
        const r = G.workshop(el.dataset.a, id);
        toast(r.msg || '完成', r.ok ? (r.lose ? 'bad' : r.win ? 'gold' : '') : 'bad');
        if (r.ok && el.dataset.a === 'cut') {
          const st = s.stones.find(x => x.id === id);
          const showResult = () => openModal('<h3>' + (r.win ? '🎉 切漲了！' : r.lose ? '💀 垮了' : '🔪 開了') + '</h3>' +
            '<p>' + esc(r.msg) + '</p>' +
            '<div class="spread"><span>切前估價</span><b>' + money(r.est) + '</b></div>' +
            '<div class="spread"><span>實際價值</span><b class="est" style="font-size:20px">' + money(r.value) + '</b></div>' +
            '<button class="btn primary" data-act="close" style="margin-top:12px">收下</button>');
          if (st && global.FX) FX.cut(st, { win: r.win, lose: r.lose }, showResult); else showResult();
        }
        render(); break;
      }

      case 'wsall': {
        let n = 0, fail = '';
        s.stones.slice().forEach(st => {
          if (st.state !== 'rough') return;
          const r = G.workshop(el.dataset.a, st.id);
          if (r.ok) n++; else fail = r.msg;
        });
        toast(n ? '處理了 ' + n + ' 顆' : (fail || '沒有可處理的料'), n ? '' : 'bad');
        render(); break;
      }

      case 'sell': { const r = G.sell(id, +el.dataset.b);toast(r.ok ? '成交 ' + money(r.price) : r.msg, r.ok ? 'gold' : 'bad'); render(); break; }
      case 'auction': {
        const r = G.auction(Object.keys(sel.auct).filter(k => sel.auct[k]));
        if (!r.ok) { toast(r.msg, 'bad'); break; }
        sel.auct = {};
        openModal('<h3>🏛 公盤結果</h3>' + r.lines.map(l => '<div class="tiny">' + esc(l) + '</div>').join('') +
          '<hr><div class="spread"><span>淨收</span><b class="est" style="font-size:20px">' + money(r.total) + '</b></div>' +
          '<button class="btn primary" data-act="close" style="margin-top:12px">好</button>');
        render(); break;
      }

      case 'hire': { const r = G.hire(id); toast(r.ok ? '簽下了' : r.msg, r.ok ? '' : 'bad'); render(); break; }
      case 'fire': { G.fire(id); render(); break; }
      case 'train': { const r = G.train(id); toast(r.ok ? '訓練完成' : r.msg, r.ok ? '' : 'bad'); render(); break; }

      case 'buyeq': { const r = G.buyEquip(id, 1); toast(r.ok ? '已購入 ' + EQUIP[id].name : r.msg, r.ok ? '' : 'bad'); render(); break; }
      case 'repair': { const r = G.repairEquip(id); toast(r.ok ? '修好了 -' + money(r.cost) : r.msg, r.ok ? '' : 'bad'); render(); break; }
      case 'buysup': { const r = G.buySupply(id, +el.dataset.n); toast(r.ok ? '補給入庫' : r.msg, r.ok ? '' : 'bad'); render(); break; }

      case 'endday': {
        const r = G.endDay();
        if (!r.ok) { toast(r.msg, 'bad'); break; }
        openModal('<h3>第 ' + (s.day - 1) + ' 天結算</h3>' +
          r.notes.map(n => '<div class="tiny">· ' + esc(n) + '</div>').join('') +
          '<hr><div class="spread"><span>現金</span><b class="est">' + money(s.money) + '</b></div>' +
          '<div class="spread"><span>明天天氣</span><b>' + s.weather.icon + ' ' + s.weather.name + '</b></div>' +
          '<div class="tiny muted">' + s.weather.desc + '</div>' +
          '<button class="btn primary" data-act="close" style="margin-top:12px">開工</button>');
        render(); break;
      }
      case 'fullscreen': goFullscreen(); break;
      case 'lockscreen':
        toggleLock();
        toast(document.body.classList.contains('locked')
          ? '畫面已固定：擋掉下拉刷新、回彈與縮放' : '已解除固定');
        break;
      case 'save': G.save(); toast('已存檔'); break;
      case 'reset':
        if (confirm('確定要重新開始？目前進度會消失。')) { G.reset(); sel.team = {}; tab = 'camp'; closeModal(); render(); }
        break;
    }
  });

  document.addEventListener('change', e => {
    const el = e.target.closest('[data-act="auct"]');
    if (!el) return;
    if (el.checked) sel.auct[el.dataset.id] = true; else delete sel.auct[el.dataset.id];
  });

  // 礦場快捷鍵 1~8 切工具
  document.addEventListener('keydown', e => {
    if (tab !== 'mine' || !S().session) return;
    const n = parseInt(e.key, 10);
    if (!n) return;
    const ids = Object.keys(EQUIP).filter(id => EQUIP[id].tool);
    const id = ids[n - 1];
    if (!id) return;
    const chk = M.canUse(S(), S().session, id);
    if (!chk.ok) { toast(chk.why, 'bad'); return; }
    S().session.tool = id; render();
  });

  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  /* ---------------- 啟動 ---------------- */
  if (!G.load()) {
    G.newGame();
    openModal('<h3>開玉 — 你接手了一支採玉隊</h3>' +
      '<p class="tiny">口袋裡 ' + money(260000) + '、三個工人、幾把手工具。目標很簡單：把這支隊伍做大，切出一塊足以翻身的料。</p>' +
      '<div class="tiny muted"><b>一天的流程</b><br>' +
      '① <b>營地</b>編隊、檢查裝備 → 選場口上山（<b>會卡的老坑是你自家的，免礦權費</b>；其他場口付日費，賺夠了也能買斷）<br>' +
      '② <b>礦場</b>用工具敲開岩壁挖料（注意水線、照明、塌方）<br>' +
      '③ <b>收工</b>依載重挑料下山，其餘留在山上<br>' +
      '④ <b>工房</b>打燈、相裂、開窗，決定賣原石還是切開<br>' +
      '⑤ <b>市場</b>賣給玉商或送公盤 → <b>結束這一天</b>發工資</div>' +
      '<hr><div class="tiny muted">賭石的規則：資訊揭露越多，估價越準、但玉商也知道了，賭性溢價就沒了。' +
      '要嘛賭運氣賣原石，要嘛一刀切開見真章。</div>' +
      '<button class="btn primary" data-act="close" style="margin-top:12px">上山</button>');
  }
  render();
  try { if (localStorage.getItem('kaiyu-lock')) setLock(true); } catch (e) {}
  global.UI = { render, toast, setLock, toggleLock, goFullscreen };
})(window);
