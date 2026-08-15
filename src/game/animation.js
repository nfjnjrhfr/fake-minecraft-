// 動作系統：關鍵影格 pose 疊加程序化的走路 / 待機。
// pose 是 { 骨頭名: {rx, ry, rz} }，缺的欄位一律當 0。
//
// 座標慣例（見 rig.js）：+Z 前方、-X 角色右手邊。
//   rx < 0 -> 肢體往前擺   rz > 0 -> 右手往身體內側掃
//   ry > 0 -> 身體往左轉

import { lerp, clamp, smoothstep } from '../core/math.js';

export function blendPose(a, b, t, out = {}) {
  if (t <= 0) return Object.assign(out, a);
  if (t >= 1) return Object.assign(out, b);
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const pa = a[k] || EMPTY, pb = b[k] || EMPTY;
    out[k] = {
      rx: lerp(pa.rx || 0, pb.rx || 0, t),
      ry: lerp(pa.ry || 0, pb.ry || 0, t),
      rz: lerp(pa.rz || 0, pb.rz || 0, t),
    };
  }
  return out;
}

const EMPTY = { rx: 0, ry: 0, rz: 0 };

/** 把 b 以權重 w 疊加到 a 上（相加而非取代，用於呼吸、後座力等微調）。 */
export function addPose(a, b, w = 1, out = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const pa = a[k] || EMPTY, pb = b[k] || EMPTY;
    out[k] = {
      rx: (pa.rx || 0) + (pb.rx || 0) * w,
      ry: (pa.ry || 0) + (pb.ry || 0) * w,
      rz: (pa.rz || 0) + (pb.rz || 0) * w,
    };
  }
  return out;
}

/** 依時間比例 t (0~1) 取樣關鍵影格。 */
export function sampleClip(clip, t) {
  const frames = clip.frames;
  if (t <= frames[0].t) return frames[0].pose;
  const last = frames[frames.length - 1];
  if (t >= last.t) return last.pose;
  for (let i = 0; i < frames.length - 1; i++) {
    const f0 = frames[i], f1 = frames[i + 1];
    if (t >= f0.t && t <= f1.t) {
      const local = (t - f0.t) / (f1.t - f0.t || 1);
      const eased = f1.linear ? local : smoothstep(local);
      return blendPose(f0.pose, f1.pose, eased);
    }
  }
  return last.pose;
}

// ---------------------------------------------------------------------------
// 基礎姿勢
// ---------------------------------------------------------------------------

/** 持劍預備架式：劍在右側斜舉、盾在身前。 */
export const POSE_GUARD = {
  torso:     { ry: -0.30, rx: 0.05 },
  head:      { ry: 0.30 },
  armRUpper: { rx: -0.35, rz: -0.55 },
  armRLower: { rx: -0.85, rz: -0.25 },
  handR:     { rx: -0.15 },
  armLUpper: { rx: -0.70, rz: 0.45 },
  armLLower: { rx: -1.15, rz: 0.30 },
  handL:     { rz: -0.25 },
  legRUpper: { rx: 0.14, rz: -0.10 },
  legRLower: { rx: -0.20 },
  legLUpper: { rx: -0.18, rz: 0.10 },
  legLLower: { rx: 0.24 },
  hips:      { ry: 0.18 },
};

/** 舉盾格擋：盾牌整片擋在正前方，劍收在後方待機。 */
export const POSE_BLOCK = {
  torso:     { ry: -0.12, rx: 0.16 },
  head:      { ry: 0.12, rx: -0.10 },
  armRUpper: { rx: -0.15, rz: -0.75 },
  armRLower: { rx: -1.5, rz: -0.35 },
  armLUpper: { rx: -1.45, rz: 0.30 },
  armLLower: { rx: -1.35, rz: 0.05 },
  handL:     { rx: 0.25 },
  legRUpper: { rx: 0.30, rz: -0.12 },
  legRLower: { rx: -0.45 },
  legLUpper: { rx: -0.30, rz: 0.12 },
  legLLower: { rx: 0.40 },
  hips:      { ry: 0.10 },
};

/** 被打中的踉蹌。 */
export const POSE_HURT = {
  torso:     { rx: -0.35, ry: 0.25 },
  head:      { rx: -0.30, ry: 0.2 },
  armRUpper: { rx: 0.45, rz: -0.7 },
  armRLower: { rx: -0.5 },
  armLUpper: { rx: 0.35, rz: 0.6 },
  legRUpper: { rx: -0.25 },
  legLUpper: { rx: 0.35 },
  legLLower: { rx: -0.35 },
};

/** 倒地。 */
export const POSE_DOWN = {
  torso:     { rx: 0.5 },
  head:      { rx: -0.6 },
  armRUpper: { rx: 0.9, rz: -1.1 },
  armLUpper: { rx: 0.8, rz: 1.1 },
  legRUpper: { rx: -0.8 },
  legRLower: { rx: 1.3 },
  legLUpper: { rx: -0.6 },
  legLLower: { rx: 1.1 },
};

// ---------------------------------------------------------------------------
// 攻擊動作
// ---------------------------------------------------------------------------

/**
 * 右橫斬：軀幹先往右擰，接著手臂往正前方伸直、軀幹回擰帶著劍身橫掃過去。
 * 揮擊的動力主要來自 torso.ry（轉腰），手臂負責把劍送到身體前方的高度。
 */
export const CLIP_SLASH_R = {
  name: 'slashR',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.32, pose: { // 蓄力：轉腰向右、劍舉到右側
      torso:     { ry: -0.85, rx: -0.08 },
      head:      { ry: 0.65 },
      armRUpper: { rx: -0.55, rz: -1.35 },
      armRLower: { rx: -0.90, rz: -0.35 },
      handR:     { rz: -0.30 },
      armLUpper: { rx: -0.60, rz: 0.70 },
      armLLower: { rx: -1.30, rz: 0.35 },
      legRUpper: { rx: 0.22, rz: -0.10 },
      legLUpper: { rx: -0.26, rz: 0.10 },
      legLLower: { rx: 0.30 },
      hips:      { ry: 0.38 },
    } },
    { t: 0.52, linear: true, pose: { // 揮擊：手臂伸向正前方，劍身掃過身體正面
      torso:     { ry: 0.42, rx: 0.14 },
      head:      { ry: -0.20 },
      armRUpper: { rx: -1.46, rz: -0.06 },
      armRLower: { rx: -0.14 },
      handR:     { rz: 0.12 },
      armLUpper: { rx: -0.35, rz: 0.95 },
      armLLower: { rx: -0.90 },
      legRUpper: { rx: -0.22 },
      legLUpper: { rx: 0.24 },
      hips:      { ry: -0.30 },
    } },
    { t: 0.72, pose: { // 收勢：劍隨慣性掃到左側
      torso:     { ry: 0.80, rx: 0.22 },
      head:      { ry: -0.45 },
      armRUpper: { rx: -1.12, rz: 0.85 },
      armRLower: { rx: -0.40, rz: 0.35 },
      armLUpper: { rx: -0.30, rz: 0.85 },
      armLLower: { rx: -1.00 },
      legRUpper: { rx: -0.30 },
      legLUpper: { rx: 0.28 },
      hips:      { ry: -0.42 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/** 左反斬：從左側回掃到右側，是右橫斬的鏡像。 */
export const CLIP_SLASH_L = {
  name: 'slashL',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.28, pose: {
      torso:     { ry: 0.72, rx: -0.05 },
      head:      { ry: -0.45 },
      armRUpper: { rx: -0.85, rz: 1.15 },
      armRLower: { rx: -1.05, rz: 0.45 },
      handR:     { rz: 0.35 },
      armLUpper: { rx: -0.55, rz: 0.35 },
      armLLower: { rx: -1.25 },
      legRUpper: { rx: -0.20 },
      legLUpper: { rx: 0.24 },
      hips:      { ry: -0.34 },
    } },
    { t: 0.48, linear: true, pose: {
      torso:     { ry: -0.48, rx: 0.12 },
      head:      { ry: 0.35 },
      armRUpper: { rx: -1.42, rz: -0.04 },
      armRLower: { rx: -0.16 },
      handR:     { rz: -0.10 },
      armLUpper: { rx: -0.75, rz: 0.55 },
      armLLower: { rx: -1.05 },
      legRUpper: { rx: 0.24 },
      legLUpper: { rx: -0.22 },
      hips:      { ry: 0.34 },
    } },
    { t: 0.68, pose: {
      torso:     { ry: -0.82, rx: 0.16 },
      head:      { ry: 0.55 },
      armRUpper: { rx: -1.00, rz: -0.95 },
      armRLower: { rx: -0.50, rz: -0.40 },
      armLUpper: { rx: -0.70, rz: 0.50 },
      legRUpper: { rx: 0.28 },
      legLUpper: { rx: -0.26 },
      hips:      { ry: 0.42 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/**
 * 上段直劈：把劍舉到頭頂前上方，再沿身體正前方劈下。
 * armRUpper.rx 全程走 -0.35 -> -2.5 -> -0.8 這條單調路徑，
 * 不會繞到背後去（負值代表往前擺）。
 */
export const CLIP_OVERHEAD = {
  name: 'overhead',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.38, pose: { // 高舉過頭
      torso:     { rx: -0.30, ry: -0.18 },
      head:      { rx: -0.20, ry: 0.15 },
      armRUpper: { rx: -2.50, rz: -0.18 },
      armRLower: { rx: -0.50 },
      handR:     { rx: 0.15 },
      armLUpper: { rx: -1.95, rz: 0.40 },
      armLLower: { rx: -0.70 },
      legRUpper: { rx: 0.30 },
      legRLower: { rx: -0.35 },
      legLUpper: { rx: -0.32 },
      legLLower: { rx: 0.35 },
      hips:      { ry: 0.10 },
    } },
    { t: 0.58, linear: true, pose: { // 劈下：手臂通過水平位置，劍鋒掃過對手上半身
      torso:     { rx: 0.42, ry: -0.02 },
      head:      { rx: 0.20 },
      armRUpper: { rx: -1.28, rz: -0.10 },
      armRLower: { rx: -0.12 },
      handR:     { rx: -0.05 },
      armLUpper: { rx: -0.30, rz: 0.75 },
      armLLower: { rx: -0.85 },
      legRUpper: { rx: -0.34 },
      legLUpper: { rx: 0.32 },
      legLLower: { rx: -0.25 },
      hips:      { ry: 0 },
    } },
    { t: 0.76, pose: { // 劍砍到腳邊的收勢
      torso:     { rx: 0.66 },
      head:      { rx: 0.35 },
      armRUpper: { rx: -0.70, rz: -0.06 },
      armRLower: { rx: -0.30 },
      armLUpper: { rx: -0.20, rz: 0.65 },
      legRUpper: { rx: -0.42 },
      legLUpper: { rx: 0.34 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/** 突刺：手肘先收到腰際、劍尖已經指向前方，再整條手臂打直送出去。 */
export const CLIP_THRUST = {
  name: 'thrust',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.28, pose: { // 收劍蓄力，劍尖朝前
      torso:     { ry: -0.52 },
      head:      { ry: 0.42 },
      armRUpper: { rx: -0.22, rz: -0.50 },
      armRLower: { rx: -1.90, rz: -0.10 },
      handR:     { rx: 0.05 },
      armLUpper: { rx: -0.85, rz: 0.55 },
      armLLower: { rx: -1.25, rz: 0.25 },
      legRUpper: { rx: 0.34, rz: -0.10 },
      legRLower: { rx: -0.40 },
      legLUpper: { rx: -0.30, rz: 0.10 },
      hips:      { ry: 0.30 },
    } },
    { t: 0.44, linear: true, pose: { // 送出：手臂完全打直朝正前方
      torso:     { ry: 0.14, rx: 0.14 },
      head:      { ry: -0.08 },
      armRUpper: { rx: -1.52, rz: -0.12 },
      armRLower: { rx: -0.04 },
      handR:     { rx: 0 },
      armLUpper: { rx: -0.30, rz: 0.95 },
      armLLower: { rx: -0.95 },
      legRUpper: { rx: -0.32 },
      legLUpper: { rx: 0.36 },
      legLLower: { rx: -0.30 },
      hips:      { ry: -0.08 },
    } },
    { t: 0.62, pose: {
      torso:     { ry: 0.08, rx: 0.08 },
      armRUpper: { rx: -1.30, rz: -0.22 },
      armRLower: { rx: -0.45 },
      armLUpper: { rx: -0.40, rz: 0.85 },
      legRUpper: { rx: -0.18 },
      legLUpper: { rx: 0.22 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/** 盾擊：用盾牌整面往前撞，專破對手的格擋。 */
export const CLIP_SHIELD_BASH = {
  name: 'bash',
  frames: [
    { t: 0.00, pose: POSE_BLOCK },
    { t: 0.30, pose: {
      torso:     { ry: 0.45, rx: -0.12 },
      armLUpper: { rx: -0.55, rz: 0.85 },
      armLLower: { rx: -1.55, rz: 0.35 },
      armRUpper: { rx: -0.10, rz: -0.85 },
      armRLower: { rx: -1.50 },
      legLUpper: { rx: 0.25 },
      legRUpper: { rx: -0.15 },
      hips:      { ry: -0.25 },
    } },
    { t: 0.46, linear: true, pose: {
      torso:     { ry: -0.30, rx: 0.22 },
      armLUpper: { rx: -1.55, rz: 0.16 },
      armLLower: { rx: -0.30 },
      armRUpper: { rx: -0.05, rz: -0.90 },
      armRLower: { rx: -1.55 },
      legLUpper: { rx: -0.35 },
      legRUpper: { rx: 0.30 },
      hips:      { ry: 0.22 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/** 翻滾閃避。 */
export const CLIP_DODGE = {
  name: 'dodge',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.35, pose: {
      torso:     { rx: 0.75 },
      head:      { rx: 0.30 },
      armRUpper: { rx: -0.90, rz: -0.55 },
      armRLower: { rx: -1.10 },
      armLUpper: { rx: -1.10, rz: 0.60 },
      armLLower: { rx: -1.40 },
      legRUpper: { rx: -1.25 },
      legRLower: { rx: 1.75 },
      legLUpper: { rx: -1.05 },
      legLLower: { rx: 1.55 },
    } },
    { t: 0.72, pose: {
      torso:     { rx: 0.30 },
      armRUpper: { rx: -0.50, rz: -0.60 },
      legRUpper: { rx: -0.40 },
      legRLower: { rx: 0.60 },
      legLUpper: { rx: 0.25 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

/** 格檔成功後把對手彈開的反饋。 */
export const CLIP_PARRY = {
  name: 'parry',
  frames: [
    { t: 0.00, pose: POSE_GUARD },
    { t: 0.22, linear: true, pose: {
      torso:     { ry: -0.55, rx: -0.15 },
      head:      { ry: 0.40 },
      armRUpper: { rx: -0.45, rz: -1.15 },
      armRLower: { rx: -0.75, rz: -0.45 },
      armLUpper: { rx: -0.95, rz: 0.65 },
      armLLower: { rx: -1.20 },
      hips:      { ry: 0.28 },
    } },
    { t: 1.00, pose: POSE_GUARD },
  ],
};

export const CLIPS = {
  slashR: CLIP_SLASH_R,
  slashL: CLIP_SLASH_L,
  overhead: CLIP_OVERHEAD,
  thrust: CLIP_THRUST,
  bash: CLIP_SHIELD_BASH,
  dodge: CLIP_DODGE,
  parry: CLIP_PARRY,
};

// ---------------------------------------------------------------------------
// 程序化的移動 / 待機
// ---------------------------------------------------------------------------

/**
 * 走路循環：腿交替擺動、手臂反向擺、身體上下起伏。
 * @param phase 0~1 循環相位
 * @param speed 0~1 速度權重
 */
export function walkPose(phase, speed, out = {}) {
  const a = phase * Math.PI * 2;
  const s = Math.sin(a), c = Math.cos(a);
  const amp = 0.85 * speed;
  out.legRUpper = { rx: -s * amp * 0.75, rz: -0.05 };
  out.legLUpper = { rx: s * amp * 0.75, rz: 0.05 };
  out.legRLower = { rx: Math.max(0, s) * amp * 0.85 };
  out.legLLower = { rx: Math.max(0, -s) * amp * 0.85 };
  out.footR = { rx: -Math.max(0, s) * amp * 0.35 };
  out.footL = { rx: -Math.max(0, -s) * amp * 0.35 };
  out.hips = { ry: -s * 0.12 * speed, rz: c * 0.04 * speed };
  out.torso = { ry: s * 0.16 * speed, rx: 0.05 * speed };
  return out;
}

/** 走路造成的身體上下起伏（公尺）。 */
export function walkBob(phase, speed) {
  return Math.abs(Math.sin(phase * Math.PI * 2)) * 0.055 * speed;
}

/** 待機呼吸。 */
export function idlePose(t, out = {}) {
  const b = Math.sin(t * 1.7);
  const b2 = Math.sin(t * 1.1 + 1.2);
  out.torso = { rx: b * 0.022, ry: b2 * 0.03 };
  out.head = { rx: -b * 0.03, ry: b2 * 0.07 };
  out.armRUpper = { rx: b * 0.045, rz: -b * 0.03 };
  out.armLUpper = { rx: b2 * 0.04, rz: b * 0.03 };
  return out;
}

/** 依速度算走路相位的推進量。 */
export function advanceWalkPhase(phase, speed, dt) {
  return (phase + dt * (1.1 + speed * 1.9)) % 1;
}
