// 方塊渲染器：把一堆有旋轉的長方體投影到 2D canvas。
// 用畫家演算法排序面 + 面法線打光，做出 Minecraft 風格的塊狀角色。
// 完全不需要 WebGL，也就不需要任何外部函式庫。

import {
  mat4, mMul, mPerspective, mLookAt, mTransformPoint, mIdentity,
  clamp, v3sub, v3cross, v3norm, v3dot,
} from './math.js';

// 單位立方體的 8 個頂點（中心在原點，邊長 1）
const CUBE_VERTS = [
  { x: -0.5, y: -0.5, z: -0.5 }, { x: 0.5, y: -0.5, z: -0.5 },
  { x: 0.5, y: 0.5, z: -0.5 }, { x: -0.5, y: 0.5, z: -0.5 },
  { x: -0.5, y: -0.5, z: 0.5 }, { x: 0.5, y: -0.5, z: 0.5 },
  { x: 0.5, y: 0.5, z: 0.5 }, { x: -0.5, y: 0.5, z: 0.5 },
];

// 6 個面（逆時針，法線朝外）
const CUBE_FACES = [
  { idx: [4, 5, 6, 7], n: { x: 0, y: 0, z: 1 } },   // 前
  { idx: [1, 0, 3, 2], n: { x: 0, y: 0, z: -1 } },  // 後
  { idx: [5, 1, 2, 6], n: { x: 1, y: 0, z: 0 } },   // 右
  { idx: [0, 4, 7, 3], n: { x: -1, y: 0, z: 0 } },  // 左
  { idx: [3, 7, 6, 2], n: { x: 0, y: 1, z: 0 } },   // 上
  { idx: [0, 1, 5, 4], n: { x: 0, y: -1, z: 0 } },  // 下
];

const LIGHT = v3norm({ x: -0.45, y: 0.82, z: 0.36 });

/** 近平面的 w 下限。低於這個值的頂點在相機後方，必須裁掉。 */
const NEAR_W = 0.05;

/**
 * 把齊次座標的多邊形對近平面做 Sutherland–Hodgman 裁剪。
 * 沒有這一步的話，橫跨相機的大面（例如整片競技場地板）會整面被丟掉。
 */
function clipNear(poly) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = cur.w > NEAR_W;
    const prevIn = prev.w > NEAR_W;
    if (curIn !== prevIn) {
      // 邊跨越近平面：插出交點
      const t = (NEAR_W - prev.w) / (cur.w - prev.w);
      out.push({
        x: prev.x + (cur.x - prev.x) * t,
        y: prev.y + (cur.y - prev.y) * t,
        z: prev.z + (cur.z - prev.z) * t,
        w: NEAR_W,
      });
    }
    if (curIn) out.push(cur);
  }
  return out;
}

/** #rrggbb -> {r,g,b} */
function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

const _shadeCache = new Map();
/** 依照亮度把顏色調亮/調暗，結果快取起來避免每格重算字串。 */
function shade(hex, amount) {
  const key = hex + '|' + (amount | 0);
  let c = _shadeCache.get(key);
  if (c) return c;
  const { r, g, b } = hexToRgb(hex);
  const f = amount / 100;
  const mix = (x) => clamp(Math.round(x * f), 0, 255);
  c = `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  _shadeCache.set(key, c);
  return c;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.width = canvas.width;
    this.height = canvas.height;
    this.view = mat4();
    this.proj = mat4();
    this.viewProj = mat4();
    this.faces = [];        // 本幀待畫的方塊面
    this.groundPolys = [];  // 貼地平面（地板、圖騰），永遠畫在方塊之下
    this.sprites = [];      // 疊在 3D 之上的畫面元素（傷害數字、特效）
    this.fovY = 0.9;
    this.near = 0.1;
    this.far = 200;
    this.shadowY = 0.002; // 影子貼地時稍微抬高避免 z-fighting
  }

  resize(w, h, dpr = 1) {
    this.canvas.width = Math.max(1, Math.round(w * dpr));
    this.canvas.height = Math.max(1, Math.round(h * dpr));
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.width = this.canvas.width;
    this.height = this.canvas.height;
  }

  setCamera(eye, target) {
    mLookAt(this.view, eye, target);
    mPerspective(this.proj, this.fovY, this.width / this.height, this.near, this.far);
    mMul(this.viewProj, this.proj, this.view);
    this.eye = eye;
  }

  begin() {
    this.faces.length = 0;
    this.groundPolys.length = 0;
    this.sprites.length = 0;
  }

  /** 世界座標 -> 齊次裁剪座標。 */
  toClip(p, out = { x: 0, y: 0, z: 0, w: 0 }) {
    const m = this.viewProj;
    out.x = m[0] * p.x + m[4] * p.y + m[8] * p.z + m[12];
    out.y = m[1] * p.x + m[5] * p.y + m[9] * p.z + m[13];
    out.z = m[2] * p.x + m[6] * p.y + m[10] * p.z + m[14];
    out.w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
    return out;
  }

  /** 齊次座標 -> 螢幕像素。 */
  clipToScreen(c) {
    const inv = 1 / c.w;
    return {
      x: (c.x * inv * 0.5 + 0.5) * this.width,
      y: (1 - (c.y * inv * 0.5 + 0.5)) * this.height,
      z: c.z * inv,
      w: c.w,
    };
  }

  /** 世界座標 -> 螢幕座標。回傳 null 表示在相機後方。 */
  project(p) {
    const c = this.toClip(p);
    if (c.w <= NEAR_W) return null;
    return this.clipToScreen(c);
  }

  /**
   * 送出一個長方體。
   * @param world 4x4 世界矩陣（已含平移旋轉，尺寸另外給）
   * @param size  {x,y,z} 邊長
   * @param color '#rrggbb'
   * @param opts  { alpha, outline, emissive }
   */
  pushBox(world, size, color, opts = {}) {
    const verts = new Array(8);
    for (let i = 0; i < 8; i++) {
      const cv = CUBE_VERTS[i];
      const local = { x: cv.x * size.x, y: cv.y * size.y, z: cv.z * size.z };
      verts[i] = mTransformPoint(world, local);
    }

    for (let f = 0; f < 6; f++) {
      const face = CUBE_FACES[f];
      const a = verts[face.idx[0]], b = verts[face.idx[1]], c = verts[face.idx[2]];
      // 世界空間法線（用實際頂點算，這樣旋轉自動生效）
      const n = v3norm(v3cross(v3sub(b, a), v3sub(c, a)));
      // 背面剔除：面朝離相機而去就跳過
      const toCam = v3sub(this.eye, a);
      if (v3dot(n, toCam) <= 0) continue;

      // 先轉到齊次空間再對近平面裁剪，橫跨相機的大面才不會整片消失
      const clipPoly = clipNear([
        this.toClip(verts[face.idx[0]]),
        this.toClip(verts[face.idx[1]]),
        this.toClip(verts[face.idx[2]]),
        this.toClip(verts[face.idx[3]]),
      ]);
      if (clipPoly.length < 3) continue;

      const pts = new Array(clipPoly.length);
      let depth = 0;
      for (let i = 0; i < clipPoly.length; i++) {
        pts[i] = this.clipToScreen(clipPoly[i]);
        depth += clipPoly[i].w;
      }
      depth /= clipPoly.length;

      const lambert = Math.max(0, v3dot(n, LIGHT));
      const brightness = opts.emissive ? 118 : 52 + lambert * 62;
      this.faces.push({
        pts,
        depth,
        color: shade(color, brightness),
        alpha: opts.alpha ?? 1,
        outline: opts.outline,
      });
    }
  }

  /** 地面上的橢圓影子（用畫家演算法的極遠深度確保先畫）。 */
  pushShadow(x, z, radius, strength = 0.32) {
    const p = this.project({ x, y: this.shadowY, z });
    if (!p) return;
    const edge = this.project({ x: x + radius, y: this.shadowY, z });
    if (!edge) return;
    const rx = Math.abs(edge.x - p.x);
    this.sprites.push({
      kind: 'shadow', x: p.x, y: p.y, rx, ry: rx * 0.45, strength, depth: p.w,
    });
  }

  /**
   * 貼地的平面多邊形（競技場地板、法陣圖騰）。
   *
   * 大面積的地板如果當成方塊丟進畫家演算法，會因為「平均深度」排序不可靠而
   * 蓋掉角色。地板反正永遠在所有東西下面，所以獨立成一層在方塊之前畫完。
   *
   * @param pts [{x, z}, ...] 世界座標，逆時針
   */
  pushGroundPoly(pts, color, opts = {}) {
    const y = opts.y ?? 0;
    const clip = clipNear(pts.map((p) => this.toClip({ x: p.x, y, z: p.z })));
    if (clip.length < 3) return;
    this.groundPolys.push({
      pts: clip.map((c) => this.clipToScreen(c)),
      color,
      alpha: opts.alpha ?? 1,
      stroke: opts.stroke,
    });
  }

  /** 產生一個圓形的地面多邊形頂點。 */
  static circlePoints(cx, cz, radius, segments = 40) {
    const pts = [];
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push({ x: cx + Math.cos(a) * radius, z: cz + Math.sin(a) * radius });
    }
    return pts;
  }

  /** 世界空間的文字（傷害數字、狀態提示）。 */
  pushLabel(pos, text, color, size = 22, alpha = 1) {
    const p = this.project(pos);
    if (!p) return;
    this.sprites.push({ kind: 'label', x: p.x, y: p.y, text, color, size, alpha, depth: p.w });
  }

  /** 世界空間的圓點（火花、粒子）。 */
  pushPoint(pos, radius, color, alpha = 1) {
    const p = this.project(pos);
    if (!p) return;
    const scale = this.height / (p.w * 2 * Math.tan(this.fovY / 2));
    this.sprites.push({
      kind: 'point', x: p.x, y: p.y, r: Math.max(0.6, radius * scale), color, alpha, depth: p.w,
    });
  }

  /** 畫地板格線（用投影後的線段，不進畫家排序，永遠在最底層）。 */
  drawGround(ctx, size, step, colorA, colorB) {
    const half = size / 2;
    for (let i = -half; i <= half; i += step) {
      for (const [p0, p1] of [
        [{ x: i, y: 0, z: -half }, { x: i, y: 0, z: half }],
        [{ x: -half, y: 0, z: i }, { x: half, y: 0, z: i }],
      ]) {
        // 線段也要對近平面裁剪，否則跨過相機的格線會整條消失
        let ca = this.toClip(p0), cb = this.toClip(p1);
        if (ca.w <= NEAR_W && cb.w <= NEAR_W) continue;
        if (ca.w <= NEAR_W || cb.w <= NEAR_W) {
          const inside = ca.w > NEAR_W ? ca : cb;
          const outside = ca.w > NEAR_W ? cb : ca;
          const t = (NEAR_W - outside.w) / (inside.w - outside.w);
          const cut = {
            x: outside.x + (inside.x - outside.x) * t,
            y: outside.y + (inside.y - outside.y) * t,
            z: outside.z + (inside.z - outside.z) * t,
            w: NEAR_W,
          };
          if (ca.w > NEAR_W) cb = cut; else ca = cut;
        }
        const a = this.clipToScreen(ca), b = this.clipToScreen(cb);
        ctx.strokeStyle = (Math.round(i) % (step * 4) === 0) ? colorB : colorA;
        ctx.lineWidth = (Math.round(i) % (step * 4) === 0) ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  /** 把這一幀累積的東西畫出來。 */
  end(env = {}) {
    const ctx = this.ctx;
    const W = this.width, H = this.height;

    // 天空漸層
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, env.skyTop || '#0b1020');
    sky.addColorStop(0.55, env.skyMid || '#1b2a4a');
    sky.addColorStop(1, env.skyBottom || '#2a1f2e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    if (env.ground !== false) {
      this.drawGround(ctx, env.groundSize || 60, env.groundStep || 2,
        env.gridColor || 'rgba(120,160,220,0.10)',
        env.gridColorMajor || 'rgba(150,200,255,0.22)');
    }

    // 地板平面（在網格之上、方塊之下）
    for (const g of this.groundPolys) {
      ctx.globalAlpha = g.alpha;
      ctx.fillStyle = g.color;
      ctx.beginPath();
      ctx.moveTo(g.pts[0].x, g.pts[0].y);
      for (let i = 1; i < g.pts.length; i++) ctx.lineTo(g.pts[i].x, g.pts[i].y);
      ctx.closePath();
      ctx.fill();
      if (g.stroke) {
        ctx.strokeStyle = g.stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // 影子接著畫（在所有方塊之下）
    for (const s of this.sprites) {
      if (s.kind !== 'shadow') continue;
      ctx.save();
      ctx.globalAlpha = s.strength;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(s.x, s.y, s.rx, s.ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // 畫家演算法：遠的先畫
    this.faces.sort((a, b) => b.depth - a.depth);
    for (const f of this.faces) {
      ctx.globalAlpha = f.alpha;
      ctx.fillStyle = f.color;
      ctx.beginPath();
      ctx.moveTo(f.pts[0].x, f.pts[0].y);
      for (let i = 1; i < f.pts.length; i++) ctx.lineTo(f.pts[i].x, f.pts[i].y);
      ctx.closePath();
      ctx.fill();
      // 補一圈同色描邊，蓋掉相鄰面之間的抗鋸齒縫隙
      ctx.strokeStyle = f.outline || f.color;
      ctx.lineWidth = f.outline ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 粒子與文字疊在最上層，彼此依深度排序
    const overlay = this.sprites.filter((s) => s.kind !== 'shadow');
    overlay.sort((a, b) => b.depth - a.depth);
    for (const s of overlay) {
      ctx.globalAlpha = s.alpha;
      if (s.kind === 'point') {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      } else if (s.kind === 'label') {
        ctx.font = `900 ${s.size}px ui-sans-serif, system-ui, "Noto Sans TC", sans-serif`;
        ctx.textAlign = 'center';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(s.text, s.x, s.y);
        ctx.fillStyle = s.color;
        ctx.fillText(s.text, s.x, s.y);
      }
    }
    ctx.globalAlpha = 1;
  }
}

export { mIdentity };
