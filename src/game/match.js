// 一場對戰：兩名戰士、回合流程、命中結算、特效與運鏡。
// 不直接碰 DOM，畫面由 renderer 負責，UI 由 main.js 讀 match 的狀態。

import { Fighter, checkAttackHit, emptyInput, ARENA_RADIUS } from './fighter.js';
import { FighterAI, DIFFICULTIES } from './ai.js';
import { drawRig, BODY_HEIGHT } from './rig.js';
import { clamp, lerp, lerpAngle, distXZ, makeRng } from '../core/math.js';
import { ROUND_STATE } from '../net/protocol.js';
import { Renderer } from '../core/renderer.js';

export const MATCH_MODE = {
  SOLO: 'solo',      // 單機：玩家 vs 超智能 NPC
  HOST: 'host',      // 連線房主：本地跑完整模擬，權威端
  GUEST: 'guest',    // 連線加入者：本地預測 + 依房主狀態校正
  LOCAL: 'local',    // 同機雙人
  DEMO: 'demo',      // NPC vs NPC（觀戰 / 測試）
};

const SPAWN_DISTANCE = 4.2;

export class Match {
  constructor(opts = {}) {
    this.mode = opts.mode || MATCH_MODE.SOLO;
    this.bestOf = opts.bestOf || 3;
    this.roundTime = opts.roundTime || 99;
    this.rng = makeRng(opts.seed || 12345);

    this.fighters = [
      new Fighter(0, opts.loadouts[0], { name: opts.names?.[0] || '玩家', x: 0, z: -SPAWN_DISTANCE / 2, yaw: 0 }),
      new Fighter(1, opts.loadouts[1], { name: opts.names?.[1] || '對手', x: 0, z: SPAWN_DISTANCE / 2, yaw: Math.PI }),
    ];

    this.ais = [null, null];
    if (this.mode === MATCH_MODE.SOLO) {
      this.ais[1] = new FighterAI(this.fighters[1], {
        difficulty: opts.difficulty || 'hard',
        style: opts.aiStyle || 'balanced',
        seed: opts.seed || 0x5eed,
      });
    } else if (this.mode === MATCH_MODE.DEMO) {
      this.ais[0] = new FighterAI(this.fighters[0], { difficulty: opts.difficulty || 'master', style: 'aggressive', seed: 7 });
      this.ais[1] = new FighterAI(this.fighters[1], { difficulty: opts.difficulty || 'master', style: 'technical', seed: 13 });
    }

    this.inputs = [emptyInput(), emptyInput()];
    this.state = ROUND_STATE.COUNTDOWN;
    this.stateTimer = 3.0;
    this.roundNo = 1;
    this.wins = [0, 0];
    this.timeLeft = this.roundTime;
    this.winner = -1;
    this.matchOver = false;

    // 賞金：單機模式打贏 NPC 掉金幣，金額由難度決定（新手 10，每高一階 +10）
    this.bounty = this.mode === MATCH_MODE.SOLO
      ? (DIFFICULTIES[opts.difficulty]?.bounty || 0) : 0;
    this.coinsEarned = 0;
    this.coinsBanked = false;   // 錢包只結算一次，由 UI 層設定

    // 表現層
    this.particles = [];
    this.floaters = [];
    this.shake = 0;
    this.hitstop = 0;
    this.slowmo = 1;
    this.messages = [];
    this.events = [];         // 這一幀產生的命中事件（給網路層轉發）
    this.log = [];            // 戰鬥紀錄（畫在 UI 上）

    this.camera = {
      pos: { x: 0, y: 3.4, z: -8 },
      target: { x: 0, y: 1.3, z: 0 },
      yaw: 0, axis: 0, offset: 0.6, dist: 8.4, height: 3.4,
    };
    this.time = 0;
    this.resetRound(true);
  }

  get player() { return this.fighters[0]; }
  get enemy() { return this.fighters[1]; }

  setDifficulty(key) {
    for (const ai of this.ais) if (ai) ai.setDifficulty(key);
  }

  resetRound(initial = false) {
    const a = this.fighters[0], b = this.fighters[1];
    // 每回合換邊，避免場地優勢
    const flip = this.roundNo % 2 === 0;
    const half = SPAWN_DISTANCE / 2;
    a.reset(0, flip ? half : -half, flip ? Math.PI : 0);
    b.reset(0, flip ? -half : half, flip ? 0 : Math.PI);
    a.updatePose(0, b);
    b.updatePose(0, a);
    this.timeLeft = this.roundTime;
    this.state = ROUND_STATE.COUNTDOWN;
    this.stateTimer = initial ? 3.0 : 2.4;
    this.particles.length = 0;
    this.floaters.length = 0;
    this.winner = -1;
    if (!initial) this.pushMessage(`第 ${this.roundNo} 回合`, '#ffd166');
  }

  pushMessage(text, color = '#fff', duration = 1.6) {
    this.messages.push({ text, color, t: 0, duration });
  }

  pushLog(text) {
    this.log.push({ text, t: this.time });
    if (this.log.length > 6) this.log.shift();
  }

  /** 設定某一方這一幀的輸入（本地玩家 / 網路對手）。 */
  setInput(index, input) {
    Object.assign(this.inputs[index], input);
  }

  /**
   * 主更新。
   * @param dt 真實經過秒數
   */
  update(dt) {
    this.time += dt;

    // 命中頓格（hitstop）：大招命中時凍結幾格，打擊感的來源
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      dt *= 0.06;
    }
    dt *= this.slowmo;

    this.events.length = 0;

    const [a, b] = this.fighters;

    // AI 思考
    for (let i = 0; i < 2; i++) {
      if (this.ais[i]) {
        const foe = this.fighters[1 - i];
        const inp = this.ais[i].think(foe, dt);
        this.inputs[i] = inp;
      }
    }

    switch (this.state) {
      case ROUND_STATE.COUNTDOWN: {
        this.stateTimer -= dt;
        // 倒數時只播待機動作，不能動
        for (let i = 0; i < 2; i++) {
          this.fighters[i].update(emptyInput(), dt, this.fighters[1 - i]);
        }
        if (this.stateTimer <= 0) {
          this.state = ROUND_STATE.FIGHTING;
          this.pushMessage('開始！', '#7bd88f', 1.0);
        }
        break;
      }
      case ROUND_STATE.FIGHTING: {
        this.timeLeft = Math.max(0, this.timeLeft - dt);
        a.update(this.inputs[0], dt, b);
        b.update(this.inputs[1], dt, a);

        // 命中判定（雙方都要檢查，同一幀有可能互砍）
        const e0 = checkAttackHit(a, b);
        const e1 = checkAttackHit(b, a);
        if (e0) this.onHit(e0, a, b);
        if (e1) this.onHit(e1, b, a);

        if (!a.alive || !b.alive || this.timeLeft <= 0) this.endRound();
        break;
      }
      case ROUND_STATE.OVER: {
        this.stateTimer -= dt;
        for (let i = 0; i < 2; i++) {
          this.fighters[i].update(emptyInput(), dt, this.fighters[1 - i]);
        }
        if (this.stateTimer <= 0 && !this.matchOver) {
          this.roundNo++;
          this.resetRound();
        }
        break;
      }
    }

    this.updateEffects(dt);
    this.updateCamera(dt);
  }

  /** 由網路層把房主算出來的事件塞進來播特效。 */
  applyRemoteEvent(ev) {
    this.spawnHitEffects(ev);
  }

  onHit(ev, attacker, defender) {
    this.events.push(ev);
    this.spawnHitEffects(ev);

    // 讓 AI 學到這次交手的結果
    for (const ai of this.ais) if (ai) ai.notify(ev);

    if (ev.parried) {
      this.pushLog(`${defender.name} 完美招架！`);
      this.hitstop = 0.14;
      this.shake = Math.max(this.shake, 0.5);
    } else if (ev.guardBreak) {
      this.pushLog(`${defender.name} 被破防！`);
      this.hitstop = 0.12;
      this.shake = Math.max(this.shake, 0.7);
    } else if (ev.blocked) {
      this.pushLog(`${defender.name} 擋下 ${ev.label}`);
      this.hitstop = 0.05;
      this.shake = Math.max(this.shake, 0.22);
    } else {
      this.pushLog(`${attacker.name} 命中 ${defender.name} 的${ev.label} -${Math.round(ev.damage)}`);
      this.hitstop = ev.critical ? 0.13 : 0.07;
      this.shake = Math.max(this.shake, ev.critical ? 0.85 : 0.45);
    }
    if (ev.armorBroken) this.pushLog(`${defender.name} 的裝備碎裂了`);
    if (ev.lethal) {
      this.hitstop = 0.25;
      this.shake = 1.1;
    }
  }

  spawnHitEffects(ev) {
    const p = ev.point || { x: 0, y: 1, z: 0 };
    const n = ev.parried ? 26 : ev.blocked ? 16 : 22;
    const color = ev.parried ? '#ffe066' : ev.blocked ? '#9fd3ff' : (ev.critical ? '#ff6b6b' : '#ff9f43');
    for (let i = 0; i < n; i++) {
      const sp = 2.2 + this.rng() * 5.5;
      const th = this.rng() * Math.PI * 2;
      const ph = (this.rng() - 0.3) * Math.PI;
      this.particles.push({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(th) * Math.cos(ph) * sp,
        vy: Math.sin(ph) * sp + 1.5,
        vz: Math.sin(th) * Math.cos(ph) * sp,
        life: 0.35 + this.rng() * 0.45,
        age: 0,
        r: 0.018 + this.rng() * 0.032,
        color,
      });
    }
    let text, tcolor;
    if (ev.parried) { text = '招架!'; tcolor = '#ffe066'; }
    else if (ev.guardBreak) { text = '破防!'; tcolor = '#ff6b6b'; }
    else if (ev.blocked) { text = `擋下 ${Math.round(ev.damage)}`; tcolor = '#9fd3ff'; }
    else if (ev.critical) { text = `爆擊 ${Math.round(ev.damage)}`; tcolor = '#ff6b6b'; }
    else { text = `${Math.round(ev.damage)}`; tcolor = '#ffffff'; }
    this.floaters.push({
      x: p.x, y: p.y + 0.25, z: p.z, text, color: tcolor,
      age: 0, life: 1.1, size: ev.critical || ev.parried ? 30 : 22,
    });
  }

  endRound() {
    const [a, b] = this.fighters;
    let winner;
    if (!a.alive && !b.alive) winner = -1;
    else if (!a.alive) winner = 1;
    else if (!b.alive) winner = 0;
    else winner = a.health === b.health ? -1 : (a.health > b.health ? 0 : 1);

    this.winner = winner;
    if (winner >= 0) this.wins[winner]++;
    this.state = ROUND_STATE.OVER;
    this.stateTimer = 3.2;

    // 玩家擊敗 NPC -> 從倒下的 NPC 身上掉金幣
    if (winner === 0 && this.bounty > 0) {
      this.coinsEarned += this.bounty;
      this.spawnCoinDrop(b, this.bounty);
      this.pushLog(`${b.name} 掉落了 ${this.bounty} 金幣`);
    }

    if (winner < 0) this.pushMessage('平手', '#cbd5e1', 2.2);
    else this.pushMessage(`${this.fighters[winner].name} 獲勝`, winner === 0 ? '#7bd88f' : '#ff6b6b', 2.2);

    const needed = Math.ceil(this.bestOf / 2);
    if (this.wins[0] >= needed || this.wins[1] >= needed) {
      this.matchOver = true;
      this.finalWinner = this.wins[0] >= needed ? 0 : 1;
      this.stateTimer = 99;
    }
  }

  /** 金幣從倒下的角色身上噴出來：一枚 10 元，越高階噴越多枚。 */
  spawnCoinDrop(fromFighter, amount) {
    const coins = Math.max(1, Math.round(amount / 10));
    for (let i = 0; i < coins * 3; i++) {
      const th = this.rng() * Math.PI * 2;
      const sp = 1.2 + this.rng() * 2.4;
      this.particles.push({
        x: fromFighter.x, y: 1.0 + this.rng() * 0.4, z: fromFighter.z,
        vx: Math.cos(th) * sp,
        vy: 3.2 + this.rng() * 2.6,
        vz: Math.sin(th) * sp,
        life: 1.3 + this.rng() * 0.7,
        age: 0,
        r: 0.05 + this.rng() * 0.03,
        color: this.rng() < 0.7 ? '#ffd54a' : '#ffedb0',
      });
    }
    this.floaters.push({
      x: fromFighter.x, y: 1.9, z: fromFighter.z,
      text: `+${amount} 金幣`, color: '#ffd54a',
      age: 0, life: 1.8, size: 30,
    });
  }

  updateEffects(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) { this.particles.splice(i, 1); continue; }
      p.vy -= 16 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.02) { p.y = 0.02; p.vy *= -0.35; p.vx *= 0.6; p.vz *= 0.6; }
    }
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.age += dt;
      if (f.age >= f.life) { this.floaters.splice(i, 1); continue; }
      f.y += dt * 0.9;
    }
    for (let i = this.messages.length - 1; i >= 0; i--) {
      this.messages[i].t += dt;
      if (this.messages[i].t >= this.messages[i].duration) this.messages.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 2.6);
  }

  updateCamera(dt) {
    const [a, b] = this.fighters;
    const midX = (a.x + b.x) / 2, midZ = (a.z + b.z) / 2;
    const sep = distXZ(a, b);

    // 相機掛在「玩家 -> 對手」的反方向，讓玩家永遠在畫面近端
    const anchor = this.mode === MATCH_MODE.GUEST ? b : a;
    const other = anchor === a ? b : a;
    const wantYaw = Math.atan2(other.x - anchor.x, other.z - anchor.z);

    const cam = this.camera;
    cam.axis = lerpAngle(cam.axis ?? wantYaw, wantYaw, Math.min(1, dt * 3.2));
    const wantDist = clamp(7.0 + sep * 0.5, 7.0, 11.0);
    cam.dist = lerp(cam.dist, wantDist, Math.min(1, dt * 2.4));
    cam.height = lerp(cam.height, 3.2 + sep * 0.12, Math.min(1, dt * 2.4));

    // 鏡頭看向兩人中點偏錨點一點
    const tx = lerp(midX, anchor.x, 0.22);
    const tz = lerp(midZ, anchor.z, 0.22);
    cam.target.x = lerp(cam.target.x, tx, Math.min(1, dt * 5));
    cam.target.z = lerp(cam.target.z, tz, Math.min(1, dt * 5));
    cam.target.y = lerp(cam.target.y, 1.5 + (a.y + b.y) * 0.3, Math.min(1, dt * 5));

    // 相機偏離「兩人連線」的角度。正後方會讓對手完全被自己擋住，
    // 所以貼身時把鏡頭甩到接近側面，拉開後再收回背後視角。
    // 目標是兩人在畫面上的橫向間距大約 SEPARATION 公尺。
    const SEPARATION = 1.35;
    const wantOffset = Math.asin(clamp(SEPARATION / Math.max(sep, 0.5), 0, 0.84));
    cam.offset = lerp(cam.offset ?? wantOffset, clamp(wantOffset, 0.38, 1.0), Math.min(1, dt * 1.8));

    const camAngle = cam.axis + Math.PI + cam.offset;
    const shake = this.shake * this.shake;

    cam.pos.x = cam.target.x + Math.sin(camAngle) * cam.dist + (this.rng() - 0.5) * shake * 0.9;
    cam.pos.z = cam.target.z + Math.cos(camAngle) * cam.dist + (this.rng() - 0.5) * shake * 0.9;
    cam.pos.y = cam.height + (this.rng() - 0.5) * shake * 0.7;

    // 給操作用的「畫面前方」：實際從相機看向目標的水平角度，
    // 這樣按 W 就是往畫面深處走，跟看到的一致。
    cam.yaw = Math.atan2(cam.target.x - cam.pos.x, cam.target.z - cam.pos.z);
  }

  /** 把整場畫出來。 */
  render(renderer) {
    renderer.begin();
    renderer.setCamera(this.camera.pos, this.camera.target);

    drawArena(renderer);

    for (const f of this.fighters) {
      renderer.pushShadow(f.x, f.z, 0.55 - f.y * 0.08, clamp(0.36 - f.y * 0.05, 0.08, 0.4));
      drawRig(f.rig, renderer, {
        flash: f.flash,
        alpha: 1,
        capeSway: f.renderExtras?.capeSway || 0,
      });
    }

    for (const p of this.particles) {
      const k = 1 - p.age / p.life;
      renderer.pushPoint(p, p.r * (0.4 + k), p.color, k);
    }
    for (const f of this.floaters) {
      const k = 1 - f.age / f.life;
      renderer.pushLabel({ x: f.x, y: f.y, z: f.z }, f.text, f.color,
        f.size * (0.8 + k * 0.35), Math.min(1, k * 2.2));
    }

    renderer.end({
      skyTop: '#060a14', skyMid: '#16243c', skyBottom: '#31212c',
      groundSize: 60, groundStep: 3,
    });
  }
}

/** 競技場：圓形石台（貼地平面）+ 邊界火把柱（方塊）。 */
function drawArena(renderer) {
  const R = ARENA_RADIUS;

  // 地板一律用貼地多邊形畫，不進畫家排序，永遠在角色之下
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, R + 0.9, 48), '#232838');
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, R, 48), '#454f66', { y: 0.001 });
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, R - 0.7, 48), '#515c76', { y: 0.002 });
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, 3.2, 40), '#5b6a88', { y: 0.003 });
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, 2.9, 40), '#4d5771', { y: 0.004 });
  renderer.pushGroundPoly(Renderer.circlePoints(0, 0, 1.35, 32), '#6d7ea1', { y: 0.005 });

  // 兩條開場站位線
  for (const sign of [-1, 1]) {
    renderer.pushGroundPoly([
      { x: -1.5, z: sign * 2.1 - 0.06 }, { x: 1.5, z: sign * 2.1 - 0.06 },
      { x: 1.5, z: sign * 2.1 + 0.06 }, { x: -1.5, z: sign * 2.1 + 0.06 },
    ], '#7e8fb5', { y: 0.006, alpha: 0.65 });
  }

  // 邊界火把柱：小方塊，畫家排序不會出問題
  const m = new Float32Array(16);
  const setT = (x, y, z) => {
    m.fill(0); m[0] = m[5] = m[10] = m[15] = 1;
    m[12] = x; m[13] = y; m[14] = z;
  };
  const posts = 14;
  for (let i = 0; i < posts; i++) {
    const ang = (i / posts) * Math.PI * 2;
    const px = Math.sin(ang) * (R + 0.5);
    const pz = Math.cos(ang) * (R + 0.5);
    setT(px, 0.95, pz);
    renderer.pushBox(m, { x: 0.30, y: 1.9, z: 0.30 }, '#59493c');
    setT(px, 2.02, pz);
    renderer.pushBox(m, { x: 0.24, y: 0.26, z: 0.24 }, '#ffb347', { emissive: true });
    // 柱底的石墩，讓邊界更清楚
    setT(px, 0.14, pz);
    renderer.pushBox(m, { x: 0.52, y: 0.28, z: 0.52 }, '#3d4459');
  }
}
