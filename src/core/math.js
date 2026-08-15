// 極簡 3D 數學庫：column-major 4x4 矩陣 + 向量工具。
// 沒有任何外部相依，Node 與瀏覽器都可直接 import。

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (t) => t * t * (3 - 2 * t);
export const TAU = Math.PI * 2;

/** 把角度包進 (-PI, PI]，用於角度插值與轉身。 */
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** 角度插值（走最短路徑）。 */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

/** 讓 a 以最大步長 step 轉向 b。 */
export function turnToward(a, b, step) {
  const d = wrapAngle(b - a);
  if (Math.abs(d) <= step) return wrapAngle(b);
  return wrapAngle(a + Math.sign(d) * step);
}

export const vec3 = (x = 0, y = 0, z = 0) => ({ x, y, z });

export function v3add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
export function v3sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
export function v3scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
export function v3dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
export function v3len(a) { return Math.hypot(a.x, a.y, a.z); }
export function v3lerp(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) };
}
export function v3norm(a) {
  const l = v3len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
export function v3cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** 水平面（XZ）距離，戰鬥判定幾乎都用這個。 */
export function distXZ(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ---------------------------------------------------------------------------
// 矩陣：Float32Array(16)，column-major（跟 OpenGL 一致）
// m[col * 4 + row]
// ---------------------------------------------------------------------------

export function mat4() {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function mIdentity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mCopy(out, a) {
  out.set(a);
  return out;
}

/** out = a * b（先套用 b 再套用 a，跟一般數學寫法一致）。 */
export function mMul(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

export function mTranslate(out, x, y, z) {
  mIdentity(out);
  out[12] = x; out[13] = y; out[14] = z;
  return out;
}

export function mScale(out, x, y, z) {
  mIdentity(out);
  out[0] = x; out[5] = y; out[10] = z;
  return out;
}

export function mRotX(out, r) {
  const c = Math.cos(r), s = Math.sin(r);
  mIdentity(out);
  out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
  return out;
}

export function mRotY(out, r) {
  const c = Math.cos(r), s = Math.sin(r);
  mIdentity(out);
  out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
  return out;
}

export function mRotZ(out, r) {
  const c = Math.cos(r), s = Math.sin(r);
  mIdentity(out);
  out[0] = c; out[1] = s; out[4] = -s; out[5] = c;
  return out;
}

const _tmpA = mat4();
const _tmpB = mat4();

/** 組出 T * Ry * Rx * Rz（骨架關節用的標準順序）。 */
export function mCompose(out, tx, ty, tz, rx, ry, rz) {
  mTranslate(out, tx, ty, tz);
  if (ry) { mRotY(_tmpA, ry); mMul(out, out, _tmpA); }
  if (rx) { mRotX(_tmpA, rx); mMul(out, out, _tmpA); }
  if (rz) { mRotZ(_tmpA, rz); mMul(out, out, _tmpA); }
  return out;
}

/** 點（w=1）乘上矩陣。 */
export function mTransformPoint(m, p, out = { x: 0, y: 0, z: 0 }) {
  const { x, y, z } = p;
  out.x = m[0] * x + m[4] * y + m[8] * z + m[12];
  out.y = m[1] * x + m[5] * y + m[9] * z + m[13];
  out.z = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** 向量（w=0）乘上矩陣，忽略平移。 */
export function mTransformDir(m, p, out = { x: 0, y: 0, z: 0 }) {
  const { x, y, z } = p;
  out.x = m[0] * x + m[4] * y + m[8] * z;
  out.y = m[1] * x + m[5] * y + m[9] * z;
  out.z = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

export function mPerspective(out, fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function mLookAt(out, eye, target, up = { x: 0, y: 1, z: 0 }) {
  const z = v3norm(v3sub(eye, target));
  const x = v3norm(v3cross(up, z));
  const y = v3cross(z, x);
  out[0] = x.x; out[1] = y.x; out[2] = z.x; out[3] = 0;
  out[4] = x.y; out[5] = y.y; out[6] = z.y; out[7] = 0;
  out[8] = x.z; out[9] = y.z; out[10] = z.z; out[11] = 0;
  out[12] = -v3dot(x, eye);
  out[13] = -v3dot(y, eye);
  out[14] = -v3dot(z, eye);
  out[15] = 1;
  return out;
}

/** 只做剛體變換的反矩陣（旋轉轉置 + 平移取負），骨架都是剛體所以夠用。 */
export function mInvertRigid(out, m) {
  out[0] = m[0]; out[1] = m[4]; out[2] = m[8]; out[3] = 0;
  out[4] = m[1]; out[5] = m[5]; out[6] = m[9]; out[7] = 0;
  out[8] = m[2]; out[9] = m[6]; out[10] = m[10]; out[11] = 0;
  const tx = m[12], ty = m[13], tz = m[14];
  out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
  out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
  out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
  out[15] = 1;
  return out;
}

/** 線段對線段最短距離（劍刃 vs 肢體中軸的判定核心）。 */
export function segSegDistance(p1, q1, p2, q2) {
  const d1 = v3sub(q1, p1);
  const d2 = v3sub(q2, p2);
  const r = v3sub(p1, p2);
  const a = v3dot(d1, d1);
  const e = v3dot(d2, d2);
  const f = v3dot(d2, r);
  const EPS = 1e-8;
  let s, t;
  if (a <= EPS && e <= EPS) return v3len(r);
  if (a <= EPS) {
    s = 0;
    t = clamp(f / e, 0, 1);
  } else {
    const c = v3dot(d1, r);
    if (e <= EPS) {
      t = 0;
      s = clamp(-c / a, 0, 1);
    } else {
      const b = v3dot(d1, d2);
      const denom = a * e - b * b;
      s = denom > EPS ? clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = v3add(p1, v3scale(d1, s));
  const c2 = v3add(p2, v3scale(d2, t));
  return v3len(v3sub(c1, c2));
}

/** 決定性亂數（netcode 需要兩端一致的隨機）。 */
export function makeRng(seed = 1) {
  let s = seed >>> 0 || 1;
  return function rng() {
    // xorshift32
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}
