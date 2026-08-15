// 戰鬥核心：招式時序表、劍刃掃掠命中判定、傷害/格擋/招架結算。
// 全部是純函式或只改傳入的物件，方便在 Node 端跑無畫面模擬測試。

import { clamp, lerp, segSegDistance, v3lerp, v3sub, v3norm, v3dot, wrapAngle, distXZ } from '../core/math.js';

/**
 * 招式表。時間全部是 0~1 的相位，實際秒數 = baseDuration / 攻速。
 * windup:   蓄力（可被打斷、可取消成假動作）
 * active:   刃口有判定的區間
 * 其餘為收招硬直。
 */
export const MOVES = {
  slashR: {
    name: '右橫斬', clip: 'slashR', baseDuration: 0.78,
    active: [0.36, 0.60], feintUntil: 0.32,
    damageMul: 1.0, staminaCost: 15, poiseMul: 1.0,
    advance: 1.6, arc: 'horizontal',
    // 對手在這個水平角度範圍內才可能被掃到（相對攻擊者正面）
    coneDeg: 150,
  },
  slashL: {
    name: '左橫斬', clip: 'slashL', baseDuration: 0.74,
    active: [0.32, 0.56], feintUntil: 0.28,
    damageMul: 0.92, staminaCost: 13, poiseMul: 0.85,
    advance: 1.4, arc: 'horizontal', coneDeg: 150,
  },
  overhead: {
    name: '上段劈', clip: 'overhead', baseDuration: 1.02,
    active: [0.42, 0.64], feintUntil: 0.38,
    damageMul: 1.45, staminaCost: 24, poiseMul: 1.6,
    advance: 2.0, arc: 'vertical', coneDeg: 90,
  },
  thrust: {
    name: '突刺', clip: 'thrust', baseDuration: 0.66,
    active: [0.32, 0.50], feintUntil: 0.28,
    damageMul: 1.15, staminaCost: 14, poiseMul: 0.7,
    advance: 3.0, arc: 'thrust', coneDeg: 55,
  },
  bash: {
    name: '盾擊', clip: 'bash', baseDuration: 0.62,
    active: [0.34, 0.50], feintUntil: 0.30,
    damageMul: 0.25, staminaCost: 18, poiseMul: 2.2,
    advance: 2.2, arc: 'shield', coneDeg: 70,
    weapon: 'shield', guardBreak: true,
  },
};

export const MOVE_KEYS = Object.keys(MOVES);

/** 招架窗口：舉盾後這段時間內擋下攻擊算完美招架。 */
export const PARRY_WINDOW = 0.20;
/** 受擊後的無敵時間，避免同一招連續判定。 */
export const HIT_COOLDOWN = 0.12;
/** 翻滾的無敵區間（相對 0~1 相位）。 */
export const DODGE_IFRAMES = [0.12, 0.52];

export const DODGE_DURATION = 0.62;
export const DODGE_STAMINA = 22;
export const DODGE_SPEED = 7.4;

/** 體力耗盡時的破防硬直。 */
export const EXHAUST_STAGGER = 1.1;

/**
 * 判斷某招在目前相位是不是處於出刃階段。
 */
export function isActivePhase(move, phase) {
  return phase >= move.active[0] && phase <= move.active[1];
}

/**
 * 劍刃掃掠 vs 對手肢體膠囊。
 * 用上一幀與這一幀的刃線做插值取樣，避免高速揮劍穿過去沒判定。
 *
 * @param prevBlade {a,b} 上一幀刃線（世界座標）
 * @param currBlade {a,b} 這一幀刃線
 * @param capsules  getHitCapsules() 的結果
 * @param bladeRadius 刃的半徑（含一點寬容值）
 * @param samples   掃掠取樣段數
 * @returns { part, mult, label, point, depth } 或 null
 */
export function sweepBladeHit(prevBlade, currBlade, capsules, bladeRadius, samples = 4) {
  let best = null;
  for (let s = 0; s <= samples; s++) {
    const t = s / samples;
    const a = v3lerp(prevBlade.a, currBlade.a, t);
    const b = v3lerp(prevBlade.b, currBlade.b, t);
    for (const cap of capsules) {
      const d = segSegDistance(a, b, cap.a, cap.b);
      const reach = cap.radius + bladeRadius;
      if (d < reach) {
        const depth = reach - d;
        // 同一幀打到多個部位時，取傷害倍率最高的（頭 > 軀幹 > 四肢）
        if (!best || cap.mult > best.mult || (cap.mult === best.mult && depth > best.depth)) {
          best = {
            part: cap.part,
            label: cap.label,
            mult: cap.mult,
            depth,
            point: { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5, z: (a.z + b.z) * 0.5 },
            // 命中點取刃線上比較靠近肢體的一端
            tip: b,
          };
        }
      }
    }
    if (best) break; // 掃到就停，取最早接觸的時間點
  }
  return best;
}

/**
 * 攻擊是否從防守者的正面來（決定盾牌擋不擋得住）。
 * @param defenderYaw 防守者朝向
 * @param attackDirWorld 從防守者指向攻擊者的方向
 * @param coneDeg 防禦有效角度（總角度）
 */
export function isFrontal(defenderYaw, defenderPos, attackerPos, coneDeg = 140) {
  const toAttacker = Math.atan2(attackerPos.x - defenderPos.x, attackerPos.z - defenderPos.z);
  const diff = Math.abs(wrapAngle(toAttacker - defenderYaw));
  return diff <= (coneDeg * Math.PI / 180) / 2;
}

/** 有效防禦係數：有盾用盾，沒盾用武器本身的 guard（用劍身格擋）。 */
export function guardValue(loadout) {
  if (loadout.offhand.kind === 'shield') return loadout.offhand.block;
  return loadout.weapon.guard * 0.6;
}

export function guardStability(loadout) {
  if (loadout.offhand.kind === 'shield') return loadout.offhand.stability;
  return 0.3;
}

/**
 * 結算一次命中。會直接修改 defender 的血量/體力/裝備耐久。
 * @returns 事件物件，交給表現層播特效
 */
export function resolveHit(attacker, defender, hit, move, opts = {}) {
  const aLoad = attacker.loadout;
  const dLoad = defender.loadout;
  const weapon = move.weapon === 'shield' ? null : aLoad.weapon;

  const baseDamage = weapon ? weapon.damage : 6;
  const charge = opts.charge ?? 1;

  let damage = baseDamage * move.damageMul * hit.mult * charge;

  const event = {
    type: 'hit',
    part: hit.part,
    label: hit.label,
    point: hit.point,
    attacker: attacker.id,
    defender: defender.id,
    blocked: false,
    parried: false,
    critical: hit.part === 'head',
    guardBreak: false,
    damage: 0,
    staggerTime: 0,
  };

  // --- 招架 / 格擋 ---
  const frontal = isFrontal(defender.yaw, defender, attacker, 150);
  if (defender.blocking && frontal) {
    if (defender.blockTimer <= PARRY_WINDOW) {
      // 完美招架：完全免傷，攻擊者被彈開
      event.parried = true;
      event.damage = 0;
      defender.stamina = Math.min(dLoad.maxStamina, defender.stamina + 12);
      attacker.stagger = Math.max(attacker.stagger, 0.75 + move.poiseMul * 0.18);
      attacker.staggerFrom = 'parry';
      attacker.action = null;
      return event;
    }
    // 一般格擋：吃傷害減免，體力照扣
    const g = guardValue(dLoad);
    const stability = guardStability(dLoad);
    const staminaHit = damage * (1.05 - stability * 0.45) * (move.guardBreak ? 2.2 : 1);
    defender.stamina -= staminaHit;
    damage *= (1 - g);
    event.blocked = true;

    if (defender.stamina <= 0) {
      // 體力被打空 -> 破防
      defender.stamina = 0;
      defender.blocking = false;
      defender.stagger = Math.max(defender.stagger, EXHAUST_STAGGER);
      defender.staggerFrom = 'guardBreak';
      event.guardBreak = true;
      damage *= 1.35;
    } else {
      // 擋住了就不再吃硬直
      damage *= 0.55;
    }
  }

  // --- 護甲減免 ---
  const partDef = dLoad.partDefense[hit.part] || 0;
  const piecesHit = armorPiecesCovering(dLoad, hit.part);
  let effectiveDef = partDef;
  if (piecesHit.length) {
    // 裝備破損後保護力下降
    let worst = 0;
    for (const p of piecesHit) worst += p.durability / p.maxDurability;
    worst /= piecesHit.length;
    effectiveDef *= clamp(0.35 + worst * 0.65, 0, 1);
  }
  damage *= (1 - effectiveDef);

  // 頭部暴擊額外加成（護甲擋掉一部分）
  if (event.critical && !event.blocked) damage *= 1.15;

  damage = Math.max(1, damage);
  defender.health -= damage;
  event.damage = damage;

  // --- 裝備耐久 ---
  for (const p of piecesHit) {
    p.durability = Math.max(0, p.durability - damage * 0.55);
    if (p.durability === 0) event.armorBroken = p.slot;
  }

  // --- 硬直 ---
  if (!event.blocked || event.guardBreak) {
    const poise = move.poiseMul * (weapon ? weapon.poise : 1.2);
    const resist = 1 / (1 + dLoad.weight * 0.075);
    const stagger = clamp(poise * 0.42 * resist * (event.critical ? 1.3 : 1), 0.14, 1.4);
    defender.stagger = Math.max(defender.stagger, stagger);
    defender.staggerFrom = 'hit';
    defender.action = null;
    defender.blocking = false;
    event.staggerTime = stagger;

    // 擊退
    const dx = defender.x - attacker.x, dz = defender.z - attacker.z;
    const len = Math.hypot(dx, dz) || 1;
    const kb = (0.9 + move.poiseMul * 0.5) * resist;
    defender.vx += (dx / len) * kb;
    defender.vz += (dz / len) * kb;
  }

  if (defender.health <= 0) {
    defender.health = 0;
    event.lethal = true;
  }
  return event;
}

/** 找出保護指定部位、而且還沒壞掉的裝備。 */
export function armorPiecesCovering(loadout, part) {
  const out = [];
  for (const piece of Object.values(loadout.pieces)) {
    const spec = ARMOR_COVER[piece.slot];
    if (spec && spec.includes(part) && piece.durability > 0) out.push(piece);
  }
  return out;
}

// 從 equipment.js 的 ARMOR_SLOTS 攤平出來的快取（避免每次命中都跑物件遍歷）
const ARMOR_COVER = {
  helmet: ['head'],
  chestplate: ['torso'],
  pauldrons: ['armR', 'armL'],
  vambraces: ['armR', 'armL'],
  gauntlets: ['armR', 'armL'],
  belt: ['torso'],
  leggings: ['legR', 'legL'],
  boots: ['legR', 'legL'],
};

/** 這一招的實際秒數。 */
export function moveDuration(move, loadout) {
  return move.baseDuration / Math.max(0.35, loadout.attackSpeed);
}

/** 這一招大概能打到多遠（AI 用來抓距離）。 */
export function moveReach(move, loadout) {
  const w = loadout.weapon;
  const armReach = 0.75;
  const base = armReach + w.blade.length + w.hilt.length * 0.5;
  if (move.arc === 'thrust') return base * 1.12 + 0.35;
  if (move.arc === 'shield') return 1.15;
  if (move.arc === 'vertical') return base * 0.92;
  return base * 0.98;
}

/** 招式是否還能被取消成假動作。 */
export function canFeint(move, phase) {
  return phase < move.feintUntil;
}
