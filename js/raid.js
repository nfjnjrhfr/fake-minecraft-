/* ============================================================
   開玉 — 戰鬥過場（3D）
   mode 'raid'  ：睡在地下據點 → 炮聲驚醒 → 抓 AK-47 → 突襲隊 → 你選開火/投降
   mode 'battle'：民兵/大部隊上門 → 舉槍對峙 → 交火 → 勝負演出（結果已定）
   ============================================================ */
(function (global) {
  'use strict';

  function play(S, opts, done) {
    if (typeof opts === 'function') { done = opts; opts = {}; }
    opts = opts || {};
    const mode = opts.mode || 'raid';
    const foes = opts.foes || 4;

    const wrap = document.createElement('div');
    wrap.id = 'raidwrap';
    wrap.innerHTML = '<canvas id="raidcv"></canvas>' +
      '<div id="raidsub"></div>' +
      '<div id="raidskip">點擊快轉 ▸</div>' +
      '<div id="raidbtns" style="display:none">' +
        '<button class="btn danger big-btn" data-raid="fight">🔥 開火！</button>' +
        '<button class="btn" data-raid="surrender">丟槍投降</button>' +
      '</div>' +
      '<div id="raidend" style="display:none"><button class="btn primary big-btn" data-raid="end">繼續</button></div>';
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('#raidcv'), ctx = cv.getContext('2d');
    const sub = wrap.querySelector('#raidsub');
    const btns = wrap.querySelector('#raidbtns');
    const endBtn = wrap.querySelector('#raidend');
    const rs = () => { cv.width = window.innerWidth; cv.height = window.innerHeight; };
    rs(); window.addEventListener('resize', rs);
    try { const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen; if (fs) { const r = fs.call(el); if (r && r.catch) r.catch(() => {}); } } catch (e) {}

    let t = mode === 'battle' ? 4.6 : 0;
    let last = performance.now(), running = true, choiceShown = false, outcomeShown = false;
    let fight = null;                       // { t, win } 交火演出
    const dust = [], flashes = [], muzzles = [];
    const BOOMS = mode === 'battle' ? [5.0] : [2.6, 3.5, 4.1];
    const boomed = {};

    function subtitle(txt) { sub.textContent = txt; }

    wrap.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      if (!fight && t < 8.4) t = 8.4;
    });

    btns.addEventListener('click', e => {
      const b = e.target.closest('[data-raid]');
      if (!b) return;
      if (b.dataset.raid === 'surrender') {
        if (opts.onSurrender) opts.onSurrender();
        cleanup(); done && done();
        return;
      }
      // 開火：結果現在才擲
      const r = opts.onFight ? opts.onFight() : { win: false };
      btns.style.display = 'none';
      fight = { t: 0, win: !!(r && r.win) };
    });
    endBtn.addEventListener('click', () => { cleanup(); done && done(); });

    function cleanup() {
      running = false;
      window.removeEventListener('resize', rs);
      wrap.remove();
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (!fight) t += dt;
      const w = cv.width, h = cv.height;

      // 震動
      let shake = 0;
      for (const bt of BOOMS) {
        const d = t - bt;
        if (d > 0 && d < 0.6) shake = Math.max(shake, (0.6 - d) * 26);
        if (d > 0 && !boomed[bt]) {
          boomed[bt] = 1;
          flashes.push({ life: 0.35 });
          for (let i = 0; i < 40; i++) dust.push({
            x: Math.random() * w, y: -10,
            vy: 60 + Math.random() * 160, vx: (Math.random() - 0.5) * 40,
            s: 1 + Math.random() * 3, life: 2 + Math.random() * 2
          });
        }
      }
      if (fight) shake = Math.max(shake, fight.t < 2 ? 10 : 3);
      const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.fillStyle = '#07090c';
      ctx.fillRect(-30, -30, w + 60, h + 60);

      const up = mode === 'battle' ? 1 : (t < 4.5 ? 0 : t < 6 ? (t - 4.5) / 1.5 : 1);
      const ease = up * up * (3 - 2 * up);

      /* ---------- 躺視角（只有 raid 模式有） ---------- */
      if (ease < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - ease;
        ctx.translate(0, -ease * h * 0.9);
        ctx.strokeStyle = '#241c12'; ctx.lineWidth = h * 0.06;
        for (let i = 0; i < 6; i++) {
          const y = h * 0.12 + i * h * 0.16;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        const sw = Math.sin(t * (shake ? 9 : 1.6)) * (0.12 + shake * 0.02);
        const lx = w / 2 + Math.sin(sw) * h * 0.18, ly = h * 0.34;
        ctx.strokeStyle = '#3a342a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(lx, ly); ctx.stroke();
        const g = ctx.createRadialGradient(lx, ly, 4, lx, ly, h * 0.42);
        g.addColorStop(0, 'rgba(255,214,140,.85)');
        g.addColorStop(0.12, 'rgba(255,190,110,.28)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#ffd98c';
        ctx.beginPath(); ctx.arc(lx, ly, 7, 0, 7); ctx.fill();
        if (t < 2.4) {
          ctx.fillStyle = 'rgba(180,200,220,' + (0.5 + 0.4 * Math.sin(t * 3)) + ')';
          ctx.font = (24 + Math.sin(t * 2) * 6) + 'px sans-serif';
          ctx.fillText('z', w * 0.62, h * 0.55 - (t % 1.6) * 40);
          ctx.fillText('Z', w * 0.66, h * 0.62 - ((t + 0.8) % 1.6) * 40);
        }
        ctx.restore();
      }

      /* ---------- 站視角：室內／門口 ---------- */
      if (ease > 0) {
        ctx.save();
        ctx.globalAlpha = ease;
        ctx.translate(0, (1 - ease) * h * 0.7);
        ctx.fillStyle = '#151210';
        ctx.fillRect(0, h * 0.62, w, h * 0.38);
        for (const side of [-1, 1]) {
          const bx = w / 2 + side * w * 0.34;
          ctx.fillStyle = '#1d1812';
          ctx.fillRect(bx - w * 0.09, h * 0.18, w * 0.18, h * 0.5);
          ctx.strokeStyle = '#2c241a'; ctx.lineWidth = 4;
          for (let i = 1; i < 4; i++) {
            ctx.beginPath(); ctx.moveTo(bx - w * 0.09, h * 0.18 + i * h * 0.125);
            ctx.lineTo(bx + w * 0.09, h * 0.18 + i * h * 0.125); ctx.stroke();
          }
          ctx.fillStyle = '#26382c';
          for (let i = 0; i < 3; i++) ctx.fillRect(bx - w * 0.07 + i * w * 0.05, h * 0.22, w * 0.035, h * 0.06);
        }
        const doorW = w * 0.16 * (1 + Math.min(1, (foes - 4) * 0.1)), doorH = h * 0.34;
        const dx0 = w / 2 - doorW / 2, dy0 = h * 0.3;
        const breach = t > 6.2;
        if (!breach) {
          ctx.fillStyle = '#241d14';
          ctx.fillRect(dx0, dy0, doorW, doorH);
          ctx.strokeStyle = '#3a2f1e'; ctx.lineWidth = 5;
          ctx.strokeRect(dx0, dy0, doorW, doorH);
        } else {
          const bo = Math.min(1, (t - 6.2) / 0.5);
          const g2 = ctx.createRadialGradient(w / 2, dy0 + doorH / 2, 6, w / 2, dy0 + doorH / 2, w * 0.5);
          g2.addColorStop(0, 'rgba(255,250,230,' + (0.95 - bo * 0.35) + ')');
          g2.addColorStop(0.25, 'rgba(255,220,160,' + (0.5 - bo * 0.2) + ')');
          g2.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g2;
          ctx.fillRect(0, 0, w, h);

          // 敵方剪影
          const squad = Math.min(1, Math.max(0, (t - 6.6) / 1.2));
          const fallP = fight && fight.win ? Math.min(1, fight.t / 1.6) : 0;
          for (let i = 0; i < foes; i++) {
            const stagger = (i * 0.37) % 1;
            const myFall = fight && fight.win ? Math.min(1, Math.max(0, (fight.t - stagger) / 1.1)) : 0;
            const px2 = w / 2 + (i - (foes - 1) / 2) * doorW * (foes > 4 ? 0.24 : 0.32);
            const py2 = dy0 + doorH - squad * h * 0.05 + myFall * h * 0.12;
            const sc = (0.5 + squad * 0.5) * h * 0.001;
            ctx.globalAlpha = ease * (1 - myFall * 0.9);
            ctx.fillStyle = 'rgba(8,8,10,.96)';
            ctx.beginPath(); ctx.arc(px2, py2 - 150 * sc, 34 * sc, 0, 7); ctx.fill();
            ctx.fillRect(px2 - 40 * sc, py2 - 125 * sc, 80 * sc, 125 * sc);
            ctx.fillRect(px2 - 62 * sc, py2 - 95 * sc, 124 * sc, 16 * sc);
            // 交火：對方槍口焰
            if (fight && !myFall && Math.random() < 0.1) {
              muzzles.push({ x: px2 - 62 * sc, y: py2 - 88 * sc, life: 0.09 });
            }
            // 手電筒
            if (!fight) {
              ctx.fillStyle = 'rgba(255,244,200,.08)';
              ctx.beginPath();
              ctx.moveTo(px2, py2 - 100 * sc);
              ctx.lineTo(px2 + (i - (foes - 1) / 2) * -120 * sc + (Math.sin(t * 2 + i) * 60) * sc, h);
              ctx.lineTo(px2 + (i - (foes - 1) / 2) * -120 * sc + (Math.sin(t * 2 + i) * 60 + 220) * sc, h);
              ctx.closePath(); ctx.fill();
            }
            ctx.globalAlpha = ease;
          }
        }
        ctx.restore();

        /* ---- 手裡的槍 ---- */
        const rifle = mode === 'battle' ? 1 : Math.min(1, Math.max(0, (t - 4.9) / 0.9));
        if (rifle > 0) {
          const recoil = fight && fight.t < 2 ? Math.abs(Math.sin(fight.t * 26)) * h * 0.012 : 0;
          ctx.save();
          ctx.translate(w * 0.5 + (Math.random() - 0.5) * recoil, h * (1.35 - rifle * 0.38) + recoil + Math.sin(t * 7) * shake * 0.15);
          ctx.rotate(-0.08);
          const u = h * 0.001;
          ctx.fillStyle = '#5a3a1e';
          ctx.beginPath();
          ctx.moveTo(150 * u, 40 * u); ctx.lineTo(300 * u, 90 * u); ctx.lineTo(300 * u, 150 * u); ctx.lineTo(160 * u, 90 * u);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#23262b';
          ctx.fillRect(-260 * u, 30 * u, 430 * u, 46 * u);
          ctx.fillStyle = '#6b4a26';
          ctx.fillRect(-260 * u, 34 * u, 150 * u, 38 * u);
          ctx.fillStyle = '#2c3036';
          ctx.fillRect(-420 * u, 40 * u, 160 * u, 16 * u);
          ctx.fillRect(-430 * u, 20 * u, 10 * u, 30 * u);
          ctx.fillStyle = '#3c342a';
          ctx.beginPath();
          ctx.moveTo(-60 * u, 76 * u); ctx.quadraticCurveTo(-80 * u, 190 * u, 10 * u, 210 * u);
          ctx.lineTo(30 * u, 160 * u); ctx.quadraticCurveTo(-30 * u, 150 * u, -10 * u, 76 * u);
          ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#8a6547';
          ctx.beginPath(); ctx.arc(-180 * u, 86 * u, 34 * u, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(90 * u, 96 * u, 36 * u, 0, 7); ctx.fill();
          // 我方槍口焰
          if (fight && fight.t < 2 && Math.random() < 0.35) {
            const g3 = ctx.createRadialGradient(-440 * u, 46 * u, 2, -440 * u, 46 * u, 90 * u);
            g3.addColorStop(0, 'rgba(255,240,180,.95)');
            g3.addColorStop(1, 'rgba(255,140,40,0)');
            ctx.fillStyle = g3;
            ctx.beginPath(); ctx.arc(-440 * u, 46 * u, 90 * u, 0, 7); ctx.fill();
          }
          ctx.restore();
        }
      }

      /* ---- 交火演出 ---- */
      if (fight) {
        fight.t += dt;
        // 對方槍口焰
        for (let i = muzzles.length - 1; i >= 0; i--) {
          const m = muzzles[i];
          m.life -= dt;
          if (m.life <= 0) { muzzles.splice(i, 1); continue; }
          const g4 = ctx.createRadialGradient(m.x, m.y, 2, m.x, m.y, 40);
          g4.addColorStop(0, 'rgba(255,230,160,.9)');
          g4.addColorStop(1, 'rgba(255,120,30,0)');
          ctx.fillStyle = g4;
          ctx.beginPath(); ctx.arc(m.x, m.y, 40, 0, 7); ctx.fill();
        }
        // 打輸：畫面染紅變暗
        if (!fight.win) {
          const dark = Math.min(0.92, fight.t / 2.6);
          ctx.fillStyle = 'rgba(60,0,0,' + dark * 0.5 + ')';
          ctx.fillRect(-30, -30, w + 60, h + 60);
          ctx.fillStyle = 'rgba(0,0,0,' + dark + ')';
          ctx.fillRect(-30, -30, w + 60, h + 60);
        }
        if (fight.t > 2.6 && !outcomeShown) {
          outcomeShown = true;
          endBtn.style.display = 'flex';
          wrap.querySelector('#raidskip').style.display = 'none';
        }
      }

      // 爆炸白光 / 落塵
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.life -= dt;
        if (f.life <= 0) { flashes.splice(i, 1); continue; }
        ctx.fillStyle = 'rgba(255,190,120,' + f.life * 1.6 + ')';
        ctx.fillRect(-30, -30, w + 60, h + 60);
      }
      for (let i = dust.length - 1; i >= 0; i--) {
        const d = dust[i];
        d.life -= dt;
        if (d.life <= 0) { dust.splice(i, 1); continue; }
        d.y += d.vy * dt; d.x += d.vx * dt;
        ctx.fillStyle = 'rgba(200,180,150,' + Math.min(0.5, d.life * 0.3) + ')';
        ctx.fillRect(d.x, d.y, d.s, d.s);
      }
      ctx.restore();

      /* ---- 字幕 ---- */
      if (fight) {
        if (fight.t < 2.4) subtitle(fight.win ? '槍聲蓋過槍聲——' : '火力壓了過來——');
        else subtitle(fight.win
          ? (opts.winText || '🔥 對面先倒下。硝煙散去，站著的是你們。')
          : (opts.loseText || '💀 畫面暗了下去。'));
      } else if (mode === 'battle') {
        if (t < 6.2) subtitle(opts.introSub || '他們上來了。你握緊了槍，頂在門後。');
        else if (t < 8.2) subtitle('門被撞開 — ' + (opts.foeName || '民兵') + '湧了進來！');
        else {
          // 決定已下，自動開打
          const r = opts.onFight ? opts.onFight() : { win: !!opts.win };
          fight = { t: 0, win: r && 'win' in r ? !!r.win : !!opts.win };
        }
      } else {
        if (t < 2.5) subtitle('地下據點的深夜。你守著最後一批貨，睡得正沉……');
        else if (t < 4.5) subtitle('轟——！！炮彈聲！你被驚醒——');
        else if (t < 6.2) subtitle('你摸黑抓起牆邊的 AK-47。');
        else if (t < 8.4) subtitle('門被炸開 —— 手電筒的光柱裡站著人。是突襲隊！');
        else {
          subtitle('槍已經上膛。他們也是。');
          if (!choiceShown) {
            choiceShown = true;
            btns.style.display = 'flex';
            wrap.querySelector('#raidskip').style.display = 'none';
          }
        }
      }

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { cleanup };
  }

  global.RAID = { play };
})(window);
