// Small shared helpers used by every game in the collection.
// Plain script (not an ES module) so every game also runs straight from file://.
(function (global) {

/** Deterministic-ish PRNG (mulberry32) so a seed reproduces a scenario. */
function rng(seed = Date.now() >>> 0) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function shuffle(r, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Append a line to a `.log` container, newest last, auto-scrolled. */
function logger(el) {
  return function log(msg, cls = '') {
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = msg;
    el.appendChild(d);
    el.scrollTop = el.scrollHeight;
    while (el.children.length > 200) el.removeChild(el.firstChild);
  };
}

/** Canvas sized for the device pixel ratio; returns a ctx in CSS pixels. */
function fitCanvas(canvas, w, h) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Pointer position in canvas CSS pixels, mouse or touch. */
function pointerPos(canvas, ev) {
  const r = canvas.getBoundingClientRect();
  const p = ev.touches && ev.touches[0] ? ev.touches[0] : ev;
  return {
    x: (p.clientX - r.left) * (canvas.style.width ? parseFloat(canvas.style.width) / r.width : 1),
    y: (p.clientY - r.top) * (canvas.style.height ? parseFloat(canvas.style.height) / r.height : 1),
  };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Starfield backdrop shared by the space-themed boards. */
function starfield(ctx, w, h, r, count = 90) {
  ctx.save();
  for (let i = 0; i < count; i++) {
    const x = r() * w, y = r() * h, a = 0.15 + r() * 0.5, s = r() < 0.9 ? 1 : 1.8;
    ctx.fillStyle = `rgba(200,220,255,${a})`;
    ctx.fillRect(x, y, s, s);
  }
  ctx.restore();
}

const fmt = (n, d = 0) => Number(n).toLocaleString(undefined, {
  minimumFractionDigits: d, maximumFractionDigits: d,
});

  global.SG = {
    rng, randInt, pick, clamp, lerp, shuffle, logger,
    fitCanvas, pointerPos, roundRect, starfield, fmt,
  };
})(window);
