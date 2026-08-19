/* ============================================================
   開玉 — 突襲夜（3D 過場）
   躺在地下據點 → 炮彈聲驚醒 → 抓起 AK-47 → 門被炸開，是突襲隊
   ============================================================ */
(function (global) {
  'use strict';

  function play(S, done) {
    const wrap = document.createElement('div');
    wrap.id = 'raidwrap';
    wrap.innerHTML = '<canvas id="raidcv"></canvas>' +
      '<div id="raidsub"></div>' +
      '<div id="raidskip">點擊快轉 ▸</div>' +
      '<div id="raidbtns" style="display:none">' +
        '<button class="btn danger big-btn" data-raid="fight">🔥 開火！</button>' +
        '<button class="btn" data-raid="surrender">丟槍投降</button>' +
      '</div>';
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('#raidcv'), ctx = cv.getContext('2d');
    const sub = wrap.querySelector('#raidsub');
    const btns = wrap.querySelector('#raidbtns');
    const rs = () => { cv.width = window.innerWidth; cv.height = window.innerHeight; };
    rs(); window.addEventListener('resize', rs);
    try { const el = document.documentElement, fs = el.requestFullscreen || el.webkitRequestFullscreen; if (fs) { const r = fs.call(el); if (r && r.catch) r.catch(() => {}); } } catch (e) {}

    let t = 0, last = performance.now(), running = true, choiceShown = false;
    const dust = [], flashes = [];
    const BOOMS = [2.6, 3.5, 4.1];
    let boomed = {};

    function subtitle(txt) { sub.textContent = txt; }

    wrap.addEventListener('click', e => {
      if (e.target.closest('#raidbtns')) return;
      if (t < 8.4) t = 8.4;
    });
    btns.addEventListener('click', e => {
      const b = e.target.closest('[data-raid]');
      if (!b) return;
      cleanup();
      done(b.dataset.raid);
    });

    function cleanup() {
      running = false;
      window.removeEventListener('resize', rs);
      wrap.remove();
    }

    function frame(now) {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
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
      const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.fillStyle = '#07090c';
      ctx.fillRect(-30, -30, w + 60, h + 60);

      // 站起來的過渡：0=躺著看天花板 1=站著看門口
      const up = t < 4.5 ? 0 : t < 6 ? (t - 4.5) / 1.5 : 1;
      const ease = up * up * (3 - 2 * up);

      /* ---------- 躺視角：天花板 ---------- */
      if (ease < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - ease;
        ctx.translate(0, -ease * h * 0.9);
        // 天花板木樑
        ctx.strokeStyle = '#241c12'; ctx.lineWidth = h * 0.06;
        for (let i = 0; i < 6; i++) {
          const y = h * 0.12 + i * h * 0.16;
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }
        // 搖晃的燈泡
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
        // 打呼
        if (t < 2.4) {
          ctx.fillStyle = 'rgba(180,200,220,' + (0.5 + 0.4 * Math.sin(t * 3)) + ')';
          ctx.font = (24 + Math.sin(t * 2) * 6) + 'px sans-serif';
          ctx.fillText('z', w * 0.62, h * 0.55 - (t % 1.6) * 40);
          ctx.fillText('Z', w * 0.66, h * 0.62 - ((t + 0.8) % 1.6) * 40);
        }
        ctx.restore();
      }

      /* ---------- 站視角：據點內部與大門 ---------- */
      if (ease > 0) {
        ctx.save();
        ctx.globalAlpha = ease;
        ctx.translate(0, (1 - ease) * h * 0.7);
        // 地板
        ctx.fillStyle = '#151210';
        ctx.fillRect(0, h * 0.62, w, h * 0.38);
        // 兩側貨架（地下超市的架子）
        for (const side of [-1, 1]) {
          const bx = w / 2 + side * w * 0.34;
          ctx.fillStyle = '#1d1812';
          ctx.fillRect(bx - w * 0.09, h * 0.18, w * 0.18, h * 0.5);
          ctx.strokeStyle = '#2c241a'; ctx.lineWidth = 4;
          for (let i = 1; i < 4; i++) {
            ctx.beginPath(); ctx.moveTo(bx - w * 0.09, h * 0.18 + i * h * 0.125);
            ctx.lineTo(bx + w * 0.09, h * 0.18 + i * h * 0.125); ctx.stroke();
          }
          // 架上的貨（玉料箱）
          ctx.fillStyle = '#26382c';
          for (let i = 0; i < 3; i++) ctx.fillRect(bx - w * 0.07 + i * w * 0.05, h * 0.22, w * 0.035, h * 0.06);
        }
        // 大門
        const doorW = w * 0.16, doorH = h * 0.34;
        const dx0 = w / 2 - doorW / 2, dy0 = h * 0.3;
        const breach = t > 6.2;
        if (!breach) {
          ctx.fillStyle = '#241d14';
          ctx.fillRect(dx0, dy0, doorW, doorH);
          ctx.strokeStyle = '#3a2f1e'; ctx.lineWidth = 5;
          ctx.strokeRect(dx0, dy0, doorW, doorH);
        } else {
          // 門被炸開：白光、煙、突襲隊剪影
          const bo = Math.min(1, (t - 6.2) / 0.5);
          const g2 = ctx.createRadialGradient(w / 2, dy0 + doorH / 2, 6, w / 2, dy0 + doorH / 2, w * 0.5);
          g2.addColorStop(0, 'rgba(255,250,230,' + (0.95 - bo * 0.35) + ')');
          g2.addColorStop(0.25, 'rgba(255,220,160,' + (0.5 - bo * 0.2) + ')');
          g2.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g2;
          ctx.fillRect(0, 0, w, h);
          // 突襲隊剪影（逆光）
          const squad = Math.min(1, Math.max(0, (t - 6.6) / 1.2));
          for (let i = 0; i < 4; i++) {
            const px2 = w / 2 + (i - 1.5) * doorW * 0.32;
            const py2 = dy0 + doorH - squad * h * 0.05;
            const sc = (0.5 + squad * 0.5) * h * 0.001;
            ctx.fillStyle = 'rgba(8,8,10,.96)';
            ctx.beginPath(); ctx.arc(px2, py2 - 150 * sc, 34 * sc, 0, 7); ctx.fill();   // 頭盔
            ctx.fillRect(px2 - 40 * sc, py2 - 125 * sc, 80 * sc, 125 * sc);             // 身
            ctx.fillRect(px2 - 62 * sc, py2 - 95 * sc, 124 * sc, 16 * sc);              // 持槍手臂
            // 手電筒光束
            ctx.fillStyle = 'rgba(255,244,200,.08)';
            ctx.beginPath();
            ctx.moveTo(px2, py2 - 100 * sc);
            ctx.lineTo(px2 + (i - 1.5) * -120 * sc + (Math.sin(t * 2 + i) * 60) * sc, h);
            ctx.lineTo(px2 + (i - 1.5) * -120 * sc + (Math.sin(t * 2 + i) * 60 + 220) * sc, h);
            ctx.closePath(); ctx.fill();
          }
        }
        ctx.restore();

        /* ---- 手裡的 AK-47：從畫面下方舉起 ---- */
        const rifle = Math.min(1, Math.max(0, (t - 4.9) / 0.9));
        if (rifle > 0) {
          ctx.save();
          ctx.translate(w * 0.5, h * (1.35 - rifle * 0.38) + Math.sin(t * 7) * shake * 0.15);
          ctx.rotate(-0.08);
          const u = h * 0.001;
          // 槍托
          ctx.fillStyle = '#5a3a1e';
          ctx.beginPath();
          ctx.moveTo(150 * u, 40 * u); ctx.lineTo(300 * u, 90 * u); ctx.lineTo(300 * u, 150 * u); ctx.lineTo(160 * u, 90 * u);
          ctx.closePath(); ctx.fill();
          // 槍身
          ctx.fillStyle = '#23262b';
          ctx.fillRect(-260 * u, 30 * u, 430 * u, 46 * u);
          // 護木（木色）
          ctx.fillStyle = '#6b4a26';
          ctx.fillRect(-260 * u, 34 * u, 150 * u, 38 * u);
          // 槍管與準星
          ctx.fillStyle = '#2c3036';
          ctx.fillRect(-420 * u, 40 * u, 160 * u, 16 * u);
          ctx.fillRect(-430 * u, 20 * u, 10 * u, 30 * u);
          // 彎彈匣
          ctx.fillStyle = '#3c342a';
          ctx.beginPath();
          ctx.moveTo(-60 * u, 76 * u); ctx.quadraticCurveTo(-80 * u, 190 * u, 10 * u, 210 * u);
          ctx.lineTo(30 * u, 160 * u); ctx.quadraticCurveTo(-30 * u, 150 * u, -10 * u, 76 * u);
          ctx.closePath(); ctx.fill();
          // 握把手
          ctx.fillStyle = '#8a6547';
          ctx.beginPath(); ctx.arc(-180 * u, 86 * u, 34 * u, 0, 7); ctx.fill();
          ctx.beginPath(); ctx.arc(90 * u, 96 * u, 36 * u, 0, 7); ctx.fill();
          ctx.restore();
        }
      }

      // 爆炸白光
      for (let i = flashes.length - 1; i >= 0; i--) {
        const f = flashes[i];
        f.life -= dt;
        if (f.life <= 0) { flashes.splice(i, 1); continue; }
        ctx.fillStyle = 'rgba(255,190,120,' + f.life * 1.6 + ')';
        ctx.fillRect(-30, -30, w + 60, h + 60);
      }
      // 落塵
      for (let i = dust.length - 1; i >= 0; i--) {
        const d = dust[i];
        d.life -= dt;
        if (d.life <= 0) { dust.splice(i, 1); continue; }
        d.y += d.vy * dt; d.x += d.vx * dt;
        ctx.fillStyle = 'rgba(200,180,150,' + Math.min(0.5, d.life * 0.3) + ')';
        ctx.fillRect(d.x, d.y, d.s, d.s);
      }
      ctx.restore();

      // 字幕
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

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { cleanup };
  }

  global.RAID = { play };
})(window);
