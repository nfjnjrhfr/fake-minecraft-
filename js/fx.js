/* ============================================================
   開玉 — 切石粒子動畫
   切石機下刀 → 火花 → 石體裂開 → 玉肉見光 → 碎屑飛散
   ============================================================ */
(function (global) {
  'use strict';
  const COLOR_HEX = {
    wuse: '#e8eef0', piaohua: '#bfe6d8', doulv: '#7fae6a', danlv: '#a8d8a0',
    qingshui: '#a9e2e8', lanshui: '#6fb6cf', huangfei: '#e0c169', hongfei: '#d1644a',
    mocui: '#26382f', ziluolan: '#b48bd6', yanglv: '#3fbf6a', zhengyang: '#18b04e', diwang: '#00913f'
  };

  function cut(stone, opts, done) {
    const zhong = global.DATA.ZHONG[stone.zhong], color = global.DATA.COLOR[stone.color];
    const hex = COLOR_HEX[color.id] || '#8fd6b8';
    const trans = stone.zhong / 6;                       // 種越好越透

    const wrap = document.createElement('div');
    wrap.className = 'fxwrap';
    wrap.innerHTML = '<canvas class="fxcv"></canvas><div class="fxcap"></div>';
    document.body.appendChild(wrap);
    const cv = wrap.querySelector('canvas'), ctx = cv.getContext('2d');
    const cap = wrap.querySelector('.fxcap');
    const rs = () => { cv.width = window.innerWidth; cv.height = window.innerHeight; };
    rs(); window.addEventListener('resize', rs);

    const P = [];
    let t = 0, last = performance.now(), split = 0, done2 = false;
    const W = () => cv.width, H = () => cv.height;
    const size = () => Math.min(W(), H()) * 0.22;

    function spark(x, y, n, col, spd) {
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const v = spd * (0.3 + Math.random());
        P.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 120, life: 0.4 + Math.random() * 0.9, max: 1.3, s: 1 + Math.random() * 3, c: col });
      }
    }

    function frame(now) {
      const dt = Math.min(0.05, (now - last) / 1000); last = now; t += dt;
      const w = W(), h = H(), cx = w / 2, cy = h / 2, R = size();

      ctx.fillStyle = 'rgba(4,6,9,.45)'; ctx.fillRect(0, 0, w, h);

      // 階段一：鋸片下刀，噴火花
      if (t < 1.5) {
        const prog = t / 1.5;
        const bladeY = cy - R * 1.9 + prog * R * 1.9;
        ctx.save();
        ctx.translate(cx, bladeY);
        ctx.strokeStyle = '#8c99a6'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, R * 0.85, 0, 7); ctx.stroke();
        for (let i = 0; i < 24; i++) {
          const a = i / 24 * Math.PI * 2 + t * 26;
          ctx.beginPath();
          ctx.moveTo(Math.cos(a) * R * 0.85, Math.sin(a) * R * 0.85);
          ctx.lineTo(Math.cos(a) * R * 0.95, Math.sin(a) * R * 0.95);
          ctx.stroke();
        }
        ctx.restore();
        if (prog > 0.45) spark(cx + (Math.random() - .5) * R * 0.3, bladeY + R * 0.8, 6, '#ffcf6a', 520);
      } else if (split < 1) {
        split = Math.min(1, split + dt * 1.1);
        if (split === 1 || t < 1.6) {
          spark(cx, cy, 90, hex, 700);
          spark(cx, cy, 40, '#fff3c4', 400);
        }
      }

      // 石體：兩半往外滑開，切面露出玉肉
      const gap = split * R * 0.55;
      for (const sgn of [-1, 1]) {
        ctx.save();
        ctx.translate(cx + sgn * gap, cy);
        ctx.rotate(sgn * split * 0.12);
        // 皮殼
        ctx.fillStyle = '#6a5a45';
        ctx.beginPath();
        ctx.moveTo(0, -R); ctx.lineTo(sgn * R * 0.95, -R * 0.55);
        ctx.lineTo(sgn * R * 1.05, R * 0.5); ctx.lineTo(0, R);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 2; ctx.stroke();
        // 切面（玉肉）
        if (split > 0.02) {
          const g = ctx.createLinearGradient(0, -R, 0, R);
          g.addColorStop(0, shade(hex, 0.12));
          g.addColorStop(0.5, shade(hex, 0.3 + trans * 0.5));
          g.addColorStop(1, shade(hex, -0.12));
          ctx.fillStyle = g;
          const fw = sgn * R * 0.22;   // 切面寬度
          ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(fw, -R * 0.55);
          ctx.lineTo(fw, R * 0.5); ctx.lineTo(0, R); ctx.closePath(); ctx.fill();
          // 棉
          ctx.fillStyle = 'rgba(255,255,255,' + (0.05 + stone.cotton * 0.25) + ')';
          for (let i = 0; i < 6; i++) {
            ctx.beginPath();
            ctx.ellipse(fw * 0.5, -R * 0.7 + i * R * 0.3, 5 + i, 8 + i * 2, 0, 0, 7); ctx.fill();
          }
          // 裂
          ctx.strokeStyle = 'rgba(20,25,20,' + (0.15 + stone.crack * 0.7) + ')'; ctx.lineWidth = 1.4;
          for (let i = 0; i < Math.round(1 + stone.crack * 7); i++) {
            ctx.beginPath();
            ctx.moveTo(fw * 0.4 + i * fw * 0.08, -R + i * R * 0.28);
            ctx.lineTo(fw * 0.6, -R + i * R * 0.28 + R * 0.4);
            ctx.stroke();
          }
          // 光暈：種越好越亮
          ctx.shadowColor = hex; ctx.shadowBlur = 25 * trans + 6;
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.15 + trans * 0.4) + ')';
          ctx.beginPath(); ctx.moveTo(0, -R); ctx.lineTo(0, R); ctx.stroke();
          ctx.shadowBlur = 0;
        }
        ctx.restore();
      }

      // 粒子
      for (let i = P.length - 1; i >= 0; i--) {
        const q = P[i]; q.life -= dt;
        if (q.life <= 0) { P.splice(i, 1); continue; }
        q.vy += 900 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        ctx.globalAlpha = Math.max(0, q.life / q.max);
        ctx.fillStyle = q.c;
        ctx.shadowColor = q.c; ctx.shadowBlur = 8;
        ctx.fillRect(q.x, q.y, q.s, q.s);
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }

      if (t > 1.8 && !done2) {
        done2 = true;
        cap.innerHTML = '<div class="fxbig" style="color:' + hex + '">' + zhong.name + '　' + color.name + '</div>' +
          '<div class="fxsub">' + (opts.win ? '🎉 切漲了' : opts.lose ? '💀 垮了' : '開了') + '</div>';
        cap.style.opacity = 1;
      }
      if (t > 3.4) {
        window.removeEventListener('resize', rs);
        wrap.remove();
        done && done();
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    wrap.addEventListener('click', () => { t = 3.4; });
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, r + amt * 255));
    g = Math.max(0, Math.min(255, g + amt * 255));
    b = Math.max(0, Math.min(255, b + amt * 255));
    return 'rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')';
  }

  global.FX = { cut };
})(window);
