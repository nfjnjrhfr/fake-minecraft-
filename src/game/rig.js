// 人形骨架：完整肢體（頭、軀幹、上下臂、手、上下腿、腳）+ 穿在骨頭上的裝備。
// 同一份骨架資料同時餵給渲染器（方塊）與戰鬥系統（受擊膠囊、劍刃線段）。

import {
  mat4, mMul, mCompose, mTranslate, mScale, mTransformPoint, mIdentity,
} from '../core/math.js';
import { ARMOR_SLOTS, MATERIALS } from './equipment.js';

/**
 * 骨骼定義。
 * offset: 相對父骨頭原點的關節位置
 * size:   方塊尺寸
 * center: 方塊中心相對本骨頭關節的位置（肢體都是從關節往下長，所以 y 是負的）
 * 座標系：+Y 上、+Z 為角色正前方、角色的右手邊是 -X。
 */
export const BONES = [
  { name: 'hips',      parent: null,        offset: { x: 0, y: 0, z: 0 },         size: { x: 0.46, y: 0.20, z: 0.28 }, center: { x: 0, y: 0, z: 0 },        tint: 'pants' },
  { name: 'torso',     parent: 'hips',      offset: { x: 0, y: 0.10, z: 0 },      size: { x: 0.50, y: 0.62, z: 0.29 }, center: { x: 0, y: 0.31, z: 0 },     tint: 'shirt' },
  { name: 'head',      parent: 'torso',     offset: { x: 0, y: 0.70, z: 0 },      size: { x: 0.44, y: 0.44, z: 0.44 }, center: { x: 0, y: 0.22, z: 0 },     tint: 'skin' },

  { name: 'armRUpper', parent: 'torso',     offset: { x: -0.335, y: 0.55, z: 0 }, size: { x: 0.19, y: 0.36, z: 0.19 }, center: { x: 0, y: -0.18, z: 0 },    tint: 'shirt' },
  { name: 'armRLower', parent: 'armRUpper', offset: { x: 0, y: -0.36, z: 0 },     size: { x: 0.17, y: 0.34, z: 0.17 }, center: { x: 0, y: -0.17, z: 0 },    tint: 'skin' },
  { name: 'handR',     parent: 'armRLower', offset: { x: 0, y: -0.34, z: 0 },     size: { x: 0.17, y: 0.17, z: 0.17 }, center: { x: 0, y: -0.085, z: 0 },   tint: 'skin' },

  { name: 'armLUpper', parent: 'torso',     offset: { x: 0.335, y: 0.55, z: 0 },  size: { x: 0.19, y: 0.36, z: 0.19 }, center: { x: 0, y: -0.18, z: 0 },    tint: 'shirt' },
  { name: 'armLLower', parent: 'armLUpper', offset: { x: 0, y: -0.36, z: 0 },     size: { x: 0.17, y: 0.34, z: 0.17 }, center: { x: 0, y: -0.17, z: 0 },    tint: 'skin' },
  { name: 'handL',     parent: 'armLLower', offset: { x: 0, y: -0.34, z: 0 },     size: { x: 0.17, y: 0.17, z: 0.17 }, center: { x: 0, y: -0.085, z: 0 },   tint: 'skin' },

  { name: 'legRUpper', parent: 'hips',      offset: { x: -0.13, y: -0.10, z: 0 }, size: { x: 0.21, y: 0.44, z: 0.21 }, center: { x: 0, y: -0.22, z: 0 },    tint: 'pants' },
  { name: 'legRLower', parent: 'legRUpper', offset: { x: 0, y: -0.44, z: 0 },     size: { x: 0.19, y: 0.42, z: 0.19 }, center: { x: 0, y: -0.21, z: 0 },    tint: 'pants' },
  { name: 'footR',     parent: 'legRLower', offset: { x: 0, y: -0.42, z: 0 },     size: { x: 0.20, y: 0.11, z: 0.30 }, center: { x: 0, y: -0.055, z: 0.05 }, tint: 'boots' },

  { name: 'legLUpper', parent: 'hips',      offset: { x: 0.13, y: -0.10, z: 0 },  size: { x: 0.21, y: 0.44, z: 0.21 }, center: { x: 0, y: -0.22, z: 0 },    tint: 'pants' },
  { name: 'legLLower', parent: 'legLUpper', offset: { x: 0, y: -0.44, z: 0 },     size: { x: 0.19, y: 0.42, z: 0.19 }, center: { x: 0, y: -0.21, z: 0 },    tint: 'pants' },
  { name: 'footL',     parent: 'legLLower', offset: { x: 0, y: -0.42, z: 0 },     size: { x: 0.20, y: 0.11, z: 0.30 }, center: { x: 0, y: -0.055, z: 0.05 }, tint: 'boots' },
];

/** 站立時 hips 關節離地高度（腳底剛好貼地）。 */
export const HIP_HEIGHT = 1.005;
/** 角色全高，攝影機與命中判定會用到。 */
export const BODY_HEIGHT = 2.21;

const BONE_INDEX = new Map(BONES.map((b, i) => [b.name, i]));

/**
 * 受擊部位 -> 用哪兩個骨頭關節連成膠囊，以及半徑與傷害倍率。
 */
export const HIT_PARTS = [
  { part: 'head',  from: 'head',      fromLocal: { x: 0, y: 0.04, z: 0 },  to: 'head',      toLocal: { x: 0, y: 0.40, z: 0 },  radius: 0.24, mult: 2.0, label: '頭部' },
  { part: 'torso', from: 'hips',      fromLocal: { x: 0, y: 0, z: 0 },     to: 'torso',     toLocal: { x: 0, y: 0.60, z: 0 },  radius: 0.27, mult: 1.0, label: '軀幹' },
  { part: 'armR',  from: 'armRUpper', fromLocal: { x: 0, y: 0, z: 0 },     to: 'handR',     toLocal: { x: 0, y: -0.12, z: 0 }, radius: 0.13, mult: 0.65, label: '右臂' },
  { part: 'armL',  from: 'armLUpper', fromLocal: { x: 0, y: 0, z: 0 },     to: 'handL',     toLocal: { x: 0, y: -0.12, z: 0 }, radius: 0.13, mult: 0.65, label: '左臂' },
  { part: 'legR',  from: 'legRUpper', fromLocal: { x: 0, y: 0, z: 0 },     to: 'footR',     toLocal: { x: 0, y: -0.05, z: 0 }, radius: 0.15, mult: 0.75, label: '右腿' },
  { part: 'legL',  from: 'legLUpper', fromLocal: { x: 0, y: 0, z: 0 },     to: 'footL',     toLocal: { x: 0, y: -0.05, z: 0 }, radius: 0.15, mult: 0.75, label: '左腿' },
];

/** 建立一個骨架實例（含每根骨頭的世界矩陣暫存）。 */
export function createRig(loadout, skin) {
  const world = BONES.map(() => mat4());
  return {
    loadout,
    skin: Object.assign({
      skin: '#c99b70', shirt: '#3f5f8a', pants: '#37405a',
      cape: '#8a2b3f', boots: '#4a3a2a', hair: '#2b1f18',
    }, skin || {}),
    world,
    // 給渲染器用的暫存矩陣，避免每幀配置
    _tmp: mat4(),
    _tmp2: mat4(),
    root: mat4(),
  };
}

const _local = mat4();

/**
 * 依 pose 計算所有骨頭的世界矩陣。
 * @param rig    createRig 的結果
 * @param state  { x, y, z, yaw }  角色在世界的位置與朝向
 * @param pose   { boneName: {rx, ry, rz} }，缺的骨頭視為 0
 * @param extra  { lean: 前後傾斜, crouch: 下蹲高度偏移 }
 */
export function poseRig(rig, state, pose, extra = {}) {
  const rootY = (state.y ?? 0) + HIP_HEIGHT - (extra.crouch || 0);
  mCompose(rig.root, state.x, rootY, state.z, extra.lean || 0, state.yaw, extra.roll || 0);

  for (let i = 0; i < BONES.length; i++) {
    const b = BONES[i];
    const p = pose[b.name];
    mCompose(_local, b.offset.x, b.offset.y, b.offset.z,
      p ? (p.rx || 0) : 0, p ? (p.ry || 0) : 0, p ? (p.rz || 0) : 0);
    const parentM = b.parent === null ? rig.root : rig.world[BONE_INDEX.get(b.parent)];
    mMul(rig.world[i], parentM, _local);
  }
  return rig;
}

export function boneWorld(rig, name) {
  return rig.world[BONE_INDEX.get(name)];
}

/** 骨頭區域座標 -> 世界座標。 */
export function bonePoint(rig, name, local) {
  return mTransformPoint(boneWorld(rig, name), local);
}

/** 目前 pose 下每個受擊部位的世界膠囊。 */
export function getHitCapsules(rig, out = []) {
  out.length = 0;
  for (const hp of HIT_PARTS) {
    out.push({
      part: hp.part,
      label: hp.label,
      mult: hp.mult,
      radius: hp.radius,
      a: bonePoint(rig, hp.from, hp.fromLocal),
      b: bonePoint(rig, hp.to, hp.toLocal),
    });
  }
  return out;
}

// --------------------------------------------------------------------------
// 武器的握持變換
// --------------------------------------------------------------------------

const _grip = mat4();
const _gripRot = mat4();

/** 主手武器的世界矩陣：手 -> 握把 -> 劍身沿 +Y 往外。 */
export function getWeaponMatrix(rig) {
  const hand = boneWorld(rig, 'handR');
  // 握在手心，劍尖朝手指方向（-Y），所以先轉 180 度讓劍身沿 +Y 指出去
  mCompose(_gripRot, 0, -0.10, 0.02, Math.PI, 0, 0);
  mMul(_grip, hand, _gripRot);
  return _grip;
}

/** 劍刃線段（世界座標），命中判定用。 */
export function getBladeSegment(rig) {
  const w = getWeaponMatrix(rig);
  const wp = rig.loadout.weapon;
  const base = wp.hilt.length * 0.5;
  return {
    a: mTransformPoint(w, { x: 0, y: base, z: 0 }),
    b: mTransformPoint(w, { x: 0, y: base + wp.blade.length, z: 0 }),
  };
}

const _shieldM = mat4();
const _shieldRot = mat4();
/** 副手盾牌的世界矩陣。 */
export function getShieldMatrix(rig) {
  const hand = boneWorld(rig, 'handL');
  mCompose(_shieldRot, 0, -0.10, 0.06, 0, 0, 0);
  mMul(_shieldM, hand, _shieldRot);
  return _shieldM;
}

// --------------------------------------------------------------------------
// 產生渲染方塊
// --------------------------------------------------------------------------

const _boxM = mat4();
const _offset = mat4();

/**
 * 把骨架 + 裝備轉成渲染器要的方塊列表。
 * @param out   要 push 進去的 renderer
 * @param opts  { flash: 0~1 受擊白光, alpha }
 */
export function drawRig(rig, renderer, opts = {}) {
  const skin = rig.skin;
  const pieces = rig.loadout.pieces;
  const flash = opts.flash || 0;
  const alpha = opts.alpha ?? 1;

  const tintColor = (tint) => {
    switch (tint) {
      case 'skin': return skin.skin;
      case 'shirt': return skin.shirt;
      case 'pants': return skin.pants;
      case 'boots': return skin.boots;
      default: return skin.skin;
    }
  };

  // 1) 身體本體
  for (let i = 0; i < BONES.length; i++) {
    const b = BONES[i];
    mTranslate(_offset, b.center.x, b.center.y, b.center.z);
    mMul(_boxM, rig.world[i], _offset);
    let color = tintColor(b.tint);
    if (flash > 0.01) color = mixHex(color, '#ffffff', flash);
    renderer.pushBox(_boxM, b.size, color, { alpha });
  }

  // 2) 裝備層：套在對應骨頭上，尺寸外擴一點點
  for (const [slot, spec] of Object.entries(ARMOR_SLOTS)) {
    const piece = pieces[slot];
    if (!piece) continue;
    if (piece.durability <= 0) continue; // 打爛的裝備會脫落
    let color = piece.color;
    if (flash > 0.01) color = mixHex(color, '#ffffff', flash * 0.8);
    for (const boneName of spec.bones) {
      const idx = BONE_INDEX.get(boneName);
      if (idx === undefined) continue;
      const b = BONES[idx];
      mTranslate(_offset, b.center.x, b.center.y, b.center.z);
      mMul(_boxM, rig.world[idx], _offset);
      const size = {
        x: b.size.x + spec.inflate.x,
        y: b.size.y + spec.inflate.y,
        z: b.size.z + spec.inflate.z,
      };
      renderer.pushBox(_boxM, size, color, { alpha: alpha * 0.99, outline: piece.trim });
    }
  }

  // 3) 頭盔面甲（讓頭部有辨識度）
  if (pieces.helmet && pieces.helmet.durability > 0) {
    const headM = boneWorld(rig, 'head');
    mCompose(_offset, 0, 0.18, 0.245, 0, 0, 0);
    mMul(_boxM, headM, _offset);
    renderer.pushBox(_boxM, { x: 0.30, y: 0.10, z: 0.06 }, '#15171c', { alpha });

    // 動力裝甲的眼部發光條（動力頭盔的招牌特徵）
    const helmMat = MATERIALS[pieces.helmet.material];
    if (helmMat?.glow) {
      for (const ex of [-0.078, 0.078]) {
        mCompose(_offset, ex, 0.185, 0.262, 0, 0, 0);
        mMul(_boxM, headM, _offset);
        renderer.pushBox(_boxM, { x: 0.085, y: 0.045, z: 0.035 }, helmMat.glow, { alpha, emissive: true });
      }
    }
  }

  // 3b) 胸口反應爐：穿著會發光的胸甲時，畫在胸甲正面
  if (pieces.chestplate && pieces.chestplate.durability > 0) {
    const chestMat = MATERIALS[pieces.chestplate.material];
    if (chestMat?.glow) {
      const torsoM = boneWorld(rig, 'torso');
      mCompose(_offset, 0, 0.44, 0.205, 0, 0, 0);
      mMul(_boxM, torsoM, _offset);
      renderer.pushBox(_boxM, { x: 0.13, y: 0.13, z: 0.035 }, chestMat.glow, { alpha, emissive: true });
      // 外圈框
      mCompose(_offset, 0, 0.44, 0.198, 0, 0, 0);
      mMul(_boxM, torsoM, _offset);
      renderer.pushBox(_boxM, { x: 0.18, y: 0.18, z: 0.03 }, '#22262e', { alpha });
    }
  }

  // 4) 披風（掛在軀幹背面，會隨動作擺動）
  if (skin.cape) {
    const torsoM = boneWorld(rig, 'torso');
    const sway = opts.capeSway || 0;
    mCompose(_offset, 0, 0.34, -0.19, sway, 0, 0);
    mMul(_boxM, torsoM, _offset);
    // 用兩段模擬布料
    const capeM = mat4();
    mCompose(capeM, 0, -0.22, -0.02, 0, 0, 0);
    mMul(capeM, _boxM, capeM);
    renderer.pushBox(capeM, { x: 0.46, y: 0.5, z: 0.05 }, skin.cape, { alpha });
    const capeM2 = mat4();
    mCompose(capeM2, 0, -0.46, -0.06, sway * 1.6, 0, 0);
    mMul(capeM2, _boxM, capeM2);
    const capeM2b = mat4();
    mCompose(capeM2b, 0, -0.2, 0, 0, 0, 0);
    mMul(capeM2b, capeM2, capeM2b);
    renderer.pushBox(capeM2b, { x: 0.42, y: 0.42, z: 0.05 }, mixHex(skin.cape, '#000000', 0.18), { alpha });
  }

  // 5) 主手武器
  drawWeapon(rig, renderer, alpha);

  // 6) 副手盾牌
  drawOffhand(rig, renderer, alpha, flash);
}

function drawWeapon(rig, renderer, alpha) {
  const wp = rig.loadout.weapon;
  const w = getWeaponMatrix(rig);
  const m = mat4();

  // 握把
  mTranslate(m, 0, -wp.hilt.length * 0.25, 0);
  mMul(m, w, m);
  renderer.pushBox(m, { x: wp.hilt.width * 0.6, y: wp.hilt.length, z: wp.hilt.width * 0.6 }, wp.gripColor, { alpha });

  // 劍柄頭
  mTranslate(m, 0, -wp.hilt.length * 0.78, 0);
  mMul(m, w, m);
  renderer.pushBox(m, { x: wp.hilt.width * 0.85, y: wp.hilt.width * 0.7, z: wp.hilt.width * 0.85 }, wp.pommel, { alpha });

  // 護手（十字）
  mTranslate(m, 0, wp.hilt.length * 0.5, 0);
  mMul(m, w, m);
  renderer.pushBox(m, { x: wp.hilt.width * 3.4, y: wp.hilt.width * 0.55, z: wp.hilt.width * 0.8 }, wp.pommel, { alpha });

  // 劍身：分三段做出漸尖的視覺（能量武器整條自發光）
  const base = wp.hilt.length * 0.5;
  const seg = wp.blade.length / 3;
  for (let i = 0; i < 3; i++) {
    const taper = 1 - i * 0.16;
    mTranslate(m, 0, base + seg * (i + 0.5), 0);
    mMul(m, w, m);
    renderer.pushBox(m, {
      x: wp.blade.width * taper,
      y: seg * 1.02,
      z: wp.blade.thick * taper,
    }, wp.color, { alpha, emissive: !!wp.emissiveBlade || i === 2 });
  }
  // 劍尖
  mTranslate(m, 0, base + wp.blade.length + 0.03, 0);
  mMul(m, w, m);
  renderer.pushBox(m, { x: wp.blade.width * 0.45, y: 0.08, z: wp.blade.thick * 0.5 }, wp.color,
    { alpha, emissive: !!wp.emissiveBlade });
}

function drawOffhand(rig, renderer, alpha, flash) {
  const off = rig.loadout.offhand;
  if (off.kind !== 'shield') return;
  const s = getShieldMatrix(rig);
  const m = mat4();
  let color = off.color;
  if (flash > 0.01) color = mixHex(color, '#ffffff', flash * 0.8);

  // 能量盾畫成半透明力場，實體盾維持不透明
  const bodyAlpha = off.energy ? alpha * 0.5 : alpha;

  mTranslate(m, 0, -off.size.y * 0.25, 0.05);
  mMul(m, s, m);
  renderer.pushBox(m, off.size, color,
    { alpha: bodyAlpha, outline: off.energy ? off.boss : '#1c1c22', emissive: !!off.energy });

  // 盾心（能量盾的盾心是掌部發射器，自發光）
  mTranslate(m, 0, -off.size.y * 0.25, 0.05 + off.size.z * 0.6);
  mMul(m, s, m);
  renderer.pushBox(m, { x: off.size.x * 0.3, y: off.size.y * 0.22, z: 0.05 }, off.boss,
    { alpha, emissive: !!off.energy });
}

/** 兩個 hex 顏色線性混合。 */
export function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round((((pa >> 16) & 255) * (1 - t)) + (((pb >> 16) & 255) * t));
  const g = Math.round((((pa >> 8) & 255) * (1 - t)) + (((pb >> 8) & 255) * t));
  const bl = Math.round(((pa & 255) * (1 - t)) + ((pb & 255) * t));
  return '#' + ((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0');
}

export { BONE_INDEX };
