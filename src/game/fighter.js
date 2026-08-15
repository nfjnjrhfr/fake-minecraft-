// 戰士實體：狀態機（待機/移動/攻擊/格擋/翻滾/硬直/死亡）、物理、姿勢合成。
// 這一層完全不碰 DOM，Node 端可以直接跑整場模擬。

import {
  clamp, lerp, wrapAngle, turnToward, distXZ, v3lerp,
} from '../core/math.js';
import {
  createRig, poseRig, getBladeSegment, getHitCapsules, HIP_HEIGHT, BODY_HEIGHT,
} from './rig.js';
import {
  MOVES, moveDuration, moveReach, isActivePhase, sweepBladeHit, resolveHit,
  DODGE_DURATION, DODGE_STAMINA, DODGE_SPEED, DODGE_IFRAMES, PARRY_WINDOW, canFeint,
} from './combat.js';
import {
  CLIPS, sampleClip, blendPose, addPose, POSE_GUARD, POSE_BLOCK, POSE_HURT, POSE_DOWN,
  walkPose, walkBob, idlePose, advanceWalkPhase,
} from './animation.js';
import { buildLoadout } from './equipment.js';

export const ARENA_RADIUS = 11.5;
export const BASE_SPEED = 3.5;
export const GRAVITY = 22;
export const JUMP_SPEED = 6.4;

/** 空白輸入，netcode 與 AI 都以這個為模板。 */
export function emptyInput() {
  return {
    moveX: 0, moveZ: 0,   // 世界座標的移動意圖（-1~1）
    attack: 0,            // 0=無，1=右斬 2=左斬 3=上劈 4=突刺 5=盾擊
    block: false,
    dodge: false,
    jump: false,
  };
}

export const ATTACK_BY_CODE = [null, 'slashR', 'slashL', 'overhead', 'thrust', 'bash'];
export const CODE_BY_ATTACK = { slashR: 1, slashL: 2, overhead: 3, thrust: 4, bash: 5 };

export class Fighter {
  constructor(id, loadoutConfig, opts = {}) {
    this.id = id;
    this.name = opts.name || `戰士${id}`;
    this.loadout = buildLoadout(loadoutConfig);
    this.rig = createRig(this.loadout, loadoutConfig.skin);

    this.x = opts.x || 0;
    this.y = 0;
    this.z = opts.z || 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = opts.yaw || 0;

    this.health = this.loadout.maxHealth;
    this.stamina = this.loadout.maxStamina;

    this.action = null;       // { key, move, elapsed, duration, hasHit, charging }
    this.blocking = false;
    this.blockTimer = 99;     // 舉盾後經過的秒數（招架窗口用）
    this.stagger = 0;
    this.staggerFrom = null;
    this.dodge = null;        // { elapsed, dirX, dirZ }
    this.grounded = true;

    this.walkPhase = 0;
    this.speedBlend = 0;
    this.time = 0;
    this.flash = 0;
    this.dead = false;
    this.deathTimer = 0;
    this.lastHitTime = -99;

    this.pose = {};
    this._poseA = {};
    this._poseB = {};
    this.capsules = [];
    this.prevBlade = null;
    this.blade = null;

    // 統計，結算畫面用
    this.stats = { hits: 0, blocked: 0, parries: 0, damageDealt: 0, damageTaken: 0, headshots: 0 };
  }

  get alive() { return this.health > 0; }

  /** 這名戰士現在能不能下新指令。 */
  get canAct() {
    return this.alive && this.stagger <= 0 && !this.dodge && !this.action;
  }

  /** 目前招式的相位 0~1。 */
  get actionPhase() {
    return this.action ? clamp(this.action.elapsed / this.action.duration, 0, 1) : 0;
  }

  /** 翻滾無敵中？ */
  get invulnerable() {
    if (!this.dodge) return false;
    const p = this.dodge.elapsed / DODGE_DURATION;
    return p >= DODGE_IFRAMES[0] && p <= DODGE_IFRAMES[1];
  }

  reset(x, z, yaw) {
    this.x = x; this.z = z; this.y = 0; this.yaw = yaw;
    this.vx = this.vy = this.vz = 0;
    this.health = this.loadout.maxHealth;
    this.stamina = this.loadout.maxStamina;
    this.action = null;
    this.blocking = false;
    this.blockTimer = 99;
    this.stagger = 0;
    this.dodge = null;
    this.dead = false;
    this.deathTimer = 0;
    this.flash = 0;
    for (const p of Object.values(this.loadout.pieces)) p.durability = p.maxDurability;
    this.stats = { hits: 0, blocked: 0, parries: 0, damageDealt: 0, damageTaken: 0, headshots: 0 };
  }

  /** 嘗試起手一招，成功回傳 true。 */
  startAttack(key) {
    const move = MOVES[key];
    if (!move || !this.canAct) return false;
    if (move.weapon === 'shield' && this.loadout.offhand.kind !== 'shield') return false;
    const cost = move.staminaCost * (2 - this.loadout.staminaMul);
    if (this.stamina < cost * 0.5) return false; // 體力太低揮不動
    this.stamina -= cost;
    this.blocking = false;
    this.action = {
      key, move,
      elapsed: 0,
      duration: moveDuration(move, this.loadout),
      hasHit: false,
      hitIds: new Set(),
    };
    return true;
  }

  /** 假動作：在蓄力階段取消攻擊（消耗少量體力）。 */
  feint() {
    if (!this.action) return false;
    if (!canFeint(this.action.move, this.actionPhase)) return false;
    this.action = null;
    this.stamina -= 4;
    return true;
  }

  startDodge(dirX, dirZ) {
    if (!this.alive || this.dodge || this.stagger > 0) return false;
    if (this.stamina < DODGE_STAMINA) return false;
    // 攻擊出刃後就不能取消成翻滾
    if (this.action && this.actionPhase > this.action.move.feintUntil) return false;
    this.stamina -= DODGE_STAMINA;
    this.action = null;
    this.blocking = false;
    let dx = dirX, dz = dirZ;
    if (!dx && !dz) { dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw); } // 沒方向就往後翻
    const len = Math.hypot(dx, dz) || 1;
    this.dodge = { elapsed: 0, dirX: dx / len, dirZ: dz / len };
    return true;
  }

  /**
   * 主更新。
   * @param input  emptyInput() 形狀的輸入
   * @param dt     秒
   * @param target 對手（用來自動面向；可為 null）
   */
  update(input, dt, target) {
    this.time += dt;
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 5);

    if (!this.alive) {
      this.dead = true;
      this.deathTimer += dt;
      this.vx *= 0.85; this.vz *= 0.85;
      this.integrate(dt, target);
      this.updatePose(dt, target);
      return;
    }

    // --- 硬直 ---
    if (this.stagger > 0) {
      this.stagger = Math.max(0, this.stagger - dt);
      this.vx *= 0.86; this.vz *= 0.86;
      this.blocking = false;
      this.integrate(dt, target);
      this.faceTarget(target, dt, 3.0);
      this.updatePose(dt, target);
      this.regenStamina(dt, 0.5);
      return;
    }

    // --- 翻滾 ---
    if (this.dodge) {
      this.dodge.elapsed += dt;
      const p = this.dodge.elapsed / DODGE_DURATION;
      if (p >= 1) {
        this.dodge = null;
      } else {
        const speed = DODGE_SPEED * (1 - p * p) * this.loadout.moveMul;
        this.vx = this.dodge.dirX * speed;
        this.vz = this.dodge.dirZ * speed;
        this.integrate(dt, target);
        this.faceTarget(target, dt, 2.0);
        this.updatePose(dt, target);
        return;
      }
    }

    // --- 新指令 ---
    if (input.dodge) {
      if (this.startDodge(input.moveX, input.moveZ)) {
        this.updatePose(dt, target);
        return;
      }
    }
    if (input.attack) {
      const key = ATTACK_BY_CODE[input.attack];
      if (key) this.startAttack(key);
    }

    // --- 格擋 ---
    const wantBlock = !!input.block && !this.action && this.stamina > 4;
    if (wantBlock && !this.blocking) this.blockTimer = 0;
    else if (wantBlock) this.blockTimer += dt;
    this.blocking = wantBlock;
    if (!wantBlock) this.blockTimer = 99;

    // --- 攻擊推進 ---
    let moveScale = 1;
    if (this.action) {
      const a = this.action;
      a.elapsed += dt;
      const phase = this.actionPhase;
      moveScale = 0.18; // 揮劍時幾乎不能自由移動
      // 揮擊瞬間會自然往前踏一步
      if (phase > a.move.feintUntil && phase < a.move.active[1]) {
        const push = a.move.advance * dt * 3.0;
        this.vx += Math.sin(this.yaw) * push;
        this.vz += Math.cos(this.yaw) * push;
      }
      if (phase >= 1) this.action = null;
    }

    // --- 移動 ---
    const speed = BASE_SPEED * this.loadout.moveMul *
      (this.blocking ? 0.45 : 1) * moveScale *
      (this.stamina < 12 ? 0.7 : 1);

    let mx = input.moveX, mz = input.moveZ;
    const mlen = Math.hypot(mx, mz);
    if (mlen > 1) { mx /= mlen; mz /= mlen; }
    const intent = Math.min(1, mlen);

    // 側移/後退比前進慢（有面向對手時）
    let dirPenalty = 1;
    if (target && intent > 0.01) {
      const toT = Math.atan2(target.x - this.x, target.z - this.z);
      const moveAng = Math.atan2(mx, mz);
      const rel = Math.abs(wrapAngle(moveAng - toT));
      dirPenalty = lerp(1, 0.62, clamp(rel / Math.PI, 0, 1));
    }

    const accel = 26 * dt;
    const targetVx = mx * speed * dirPenalty;
    const targetVz = mz * speed * dirPenalty;
    this.vx += (targetVx - this.vx) * Math.min(1, accel);
    this.vz += (targetVz - this.vz) * Math.min(1, accel);

    // --- 跳躍 ---
    if (input.jump && this.grounded && this.stamina > 10) {
      this.vy = JUMP_SPEED;
      this.grounded = false;
      this.stamina -= 8;
    }

    this.speedBlend = lerp(this.speedBlend, clamp(Math.hypot(this.vx, this.vz) / (BASE_SPEED * 0.9), 0, 1), dt * 9);
    this.walkPhase = advanceWalkPhase(this.walkPhase, this.speedBlend, dt);

    this.integrate(dt, target);
    this.faceTarget(target, dt, this.blocking ? 5.5 : 7.0, mx, mz);
    this.regenStamina(dt, this.blocking ? 0.35 : (this.action ? 0.2 : 1));
    this.updatePose(dt, target);
  }

  regenStamina(dt, scale) {
    const rate = 17 * this.loadout.staminaMul * scale;
    this.stamina = Math.min(this.loadout.maxStamina, this.stamina + rate * dt);
  }

  faceTarget(target, dt, rate, mx = 0, mz = 0) {
    let want;
    if (target && target.alive) {
      want = Math.atan2(target.x - this.x, target.z - this.z);
    } else if (mx || mz) {
      want = Math.atan2(mx, mz);
    } else return;
    this.yaw = turnToward(this.yaw, want, rate * dt);
  }

  integrate(dt, target) {
    // 垂直
    if (!this.grounded || this.y > 0 || this.vy !== 0) {
      this.vy -= GRAVITY * dt;
      this.y += this.vy * dt;
      if (this.y <= 0) { this.y = 0; this.vy = 0; this.grounded = true; }
      else this.grounded = false;
    }

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // 地面摩擦
    const fr = this.grounded ? Math.pow(0.0016, dt) : Math.pow(0.4, dt);
    this.vx *= fr; this.vz *= fr;

    // 場地邊界（圓形競技場）
    const d = Math.hypot(this.x, this.z);
    if (d > ARENA_RADIUS) {
      const s = ARENA_RADIUS / d;
      this.x *= s; this.z *= s;
      this.vx *= 0.3; this.vz *= 0.3;
    }

    // 角色互相推開，避免重疊
    if (target) {
      const dx = this.x - target.x, dz = this.z - target.z;
      const dist = Math.hypot(dx, dz);
      const minDist = 1.28;
      if (dist < minDist && dist > 1e-4) {
        const push = (minDist - dist) * 0.5;
        this.x += (dx / dist) * push;
        this.z += (dz / dist) * push;
      } else if (dist <= 1e-4) {
        this.x += 0.05;
      }
    }
  }

  /** 合成這一幀的姿勢並更新骨架世界矩陣。 */
  updatePose(dt, target) {
    let pose;

    if (!this.alive) {
      pose = blendPose(POSE_GUARD, POSE_DOWN, clamp(this.deathTimer * 2.4, 0, 1), this._poseA);
    } else if (this.stagger > 0) {
      const k = clamp(this.stagger * 1.6, 0, 1);
      pose = blendPose(POSE_GUARD, POSE_HURT, k, this._poseA);
    } else if (this.dodge) {
      pose = sampleClip(CLIPS.dodge, this.dodge.elapsed / DODGE_DURATION);
    } else if (this.action) {
      const clip = CLIPS[this.action.move.clip];
      pose = sampleClip(clip, this.actionPhase);
    } else {
      const base = this.blocking ? POSE_BLOCK : POSE_GUARD;
      // 走路只影響下半身與軀幹，上半身維持架式
      if (this.speedBlend > 0.02) {
        const wp = walkPose(this.walkPhase, this.speedBlend, this._poseB);
        pose = Object.assign({}, base);
        for (const k of ['legRUpper', 'legLUpper', 'legRLower', 'legLLower', 'footR', 'footL']) {
          if (wp[k]) pose[k] = wp[k];
        }
        // 軀幹與髖部把架式和走路混起來
        pose.hips = addSingle(base.hips, wp.hips, 1);
        pose.torso = addSingle(base.torso, wp.torso, 1);
        pose.armRUpper = addSingle(base.armRUpper, { rx: Math.sin(this.walkPhase * Math.PI * 2) * 0.12 * this.speedBlend }, 1);
        pose.armLUpper = addSingle(base.armLUpper, { rx: -Math.sin(this.walkPhase * Math.PI * 2) * 0.12 * this.speedBlend }, 1);
      } else {
        pose = addPose(base, idlePose(this.time, this._poseB), 1, this._poseA);
      }
    }

    this.pose = pose;

    const bob = this.speedBlend > 0.02 && !this.action && !this.dodge
      ? walkBob(this.walkPhase, this.speedBlend) : 0;
    const crouch = this.dodge ? Math.sin(clamp(this.dodge.elapsed / DODGE_DURATION, 0, 1) * Math.PI) * 0.45 : 0;
    const lean = this.dodge ? Math.sin(clamp(this.dodge.elapsed / DODGE_DURATION, 0, 1) * Math.PI) * 0.35 : 0;

    poseRig(this.rig, this, pose, { crouch: crouch - bob, lean });

    this.prevBlade = this.blade;
    this.blade = getBladeSegment(this.rig);
    this.capsules = getHitCapsules(this.rig, this.capsules);
    this.renderExtras = { crouch, lean, capeSway: -this.speedBlend * 0.5 - (this.vy > 0 ? 0.3 : 0) };
  }

  /** 目前武器的最遠攻擊距離（AI 用）。 */
  bestReach() {
    let r = 0;
    for (const key of this.loadout.weapon.moves) {
      const m = MOVES[key];
      if (m) r = Math.max(r, moveReach(m, this.loadout));
    }
    return r;
  }
}

function addSingle(a, b, w) {
  a = a || {}; b = b || {};
  return {
    rx: (a.rx || 0) + (b.rx || 0) * w,
    ry: (a.ry || 0) + (b.ry || 0) * w,
    rz: (a.rz || 0) + (b.rz || 0) * w,
  };
}

/**
 * 檢查 attacker 這一幀有沒有砍中 defender。
 * 需要在雙方 updatePose 之後呼叫。
 * @returns 命中事件或 null
 */
export function checkAttackHit(attacker, defender) {
  const a = attacker.action;
  if (!a || a.hasHit || !attacker.alive) return null;
  const phase = attacker.actionPhase;
  if (!isActivePhase(a.move, phase)) return null;
  if (!defender.alive || defender.invulnerable) return null;

  // 距離先做粗篩，省掉大部分的線段運算
  const reach = moveReach(a.move, attacker.loadout) + 0.6;
  if (distXZ(attacker, defender) > reach) return null;

  let hit;
  if (a.move.weapon === 'shield') {
    // 盾擊用盾牌前方的短線段當判定
    const shieldSeg = shieldSegment(attacker);
    hit = sweepBladeHit(shieldSeg, shieldSeg, defender.capsules, 0.22, 1);
  } else {
    const prev = attacker.prevBlade || attacker.blade;
    hit = sweepBladeHit(prev, attacker.blade, defender.capsules,
      attacker.loadout.weapon.blade.width * 0.5 + 0.05, 5);
  }
  if (!hit) return null;

  a.hasHit = true;
  const event = resolveHit(attacker, defender, hit, a.move, { charge: 1 });

  // 統計
  if (event.parried) {
    defender.stats.parries++;
  } else if (event.blocked) {
    defender.stats.blocked++;
    attacker.stats.hits++;
  } else {
    attacker.stats.hits++;
    if (event.critical) attacker.stats.headshots++;
  }
  attacker.stats.damageDealt += event.damage;
  defender.stats.damageTaken += event.damage;
  if (event.damage > 0) defender.flash = 1;

  return event;
}

function shieldSegment(f) {
  const forwardX = Math.sin(f.yaw), forwardZ = Math.cos(f.yaw);
  const y = f.y + 1.25;
  return {
    a: { x: f.x + forwardX * 0.35, y, z: f.z + forwardZ * 0.35 },
    b: { x: f.x + forwardX * 1.0, y, z: f.z + forwardZ * 1.0 },
  };
}
