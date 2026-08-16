// 超智能 NPC。
//
// 設計重點（不是靠作弊，是靠建模）：
//   1. 感知延遲     —— 透過延遲緩衝區看世界，反應時間由難度決定，不會有神反應。
//   2. 對手建模     —— 統計你的出招頻率、接續習慣（n-gram）、距離偏好、格擋率、
//                      被打斷後的反應，越打越懂你。
//   3. 威脅評估     —— 推算對方這一刀什麼時候到，決定招架 / 翻滾 / 搶攻 / 拉開。
//   4. 效用決策     —— 對每個候選動作做一層 rollout，用「預期收益 - 風險」挑最好的。
//   5. 節奏與心理   —— 假動作騙格擋、盾擊破防、體力管理、劣勢時換打法。
//   6. 自適應難度   —— 依血量差距微調反應時間與失誤率，避免一面倒。

import { clamp, lerp, wrapAngle, distXZ, makeRng } from '../core/math.js';
import { MOVES, moveReach, moveDuration, PARRY_WINDOW, DODGE_DURATION } from './combat.js';
import { CODE_BY_ATTACK, emptyInput, BASE_SPEED } from './fighter.js';

/** 難度設定。reaction 是感知延遲（秒），越小越可怕。bounty 是擊敗的掉落金幣：新手 10，每高一階 +10。 */
export const DIFFICULTIES = {
  rookie:   { name: '新手',   reaction: 0.42, noise: 0.55, predict: 0.15, aggression: 0.45, parrySkill: 0.10, mistake: 0.32, adapt: 0.2, bounty: 10 },
  normal:   { name: '普通',   reaction: 0.30, noise: 0.35, predict: 0.35, aggression: 0.55, parrySkill: 0.28, mistake: 0.18, adapt: 0.4, bounty: 20 },
  hard:     { name: '困難',   reaction: 0.21, noise: 0.22, predict: 0.55, aggression: 0.65, parrySkill: 0.48, mistake: 0.10, adapt: 0.6, bounty: 30 },
  master:   { name: '大師',   reaction: 0.15, noise: 0.12, predict: 0.75, aggression: 0.72, parrySkill: 0.68, mistake: 0.05, adapt: 0.8, bounty: 40 },
  singular: { name: '超智能', reaction: 0.10, noise: 0.05, predict: 0.95, aggression: 0.80, parrySkill: 0.88, mistake: 0.015, adapt: 1.0, bounty: 50 },
};

/** 打法性格，會影響效用權重；AI 落後時會自己換。 */
export const STYLES = {
  aggressive: { name: '進攻', pressure: 1.35, patience: 0.55, riskTolerance: 1.3, preferRange: 0.88 },
  balanced:   { name: '均衡', pressure: 1.0, patience: 1.0, riskTolerance: 1.0, preferRange: 1.0 },
  defensive:  { name: '防守', pressure: 0.65, patience: 1.5, riskTolerance: 0.7, preferRange: 1.15 },
  technical:  { name: '技巧', pressure: 0.9, patience: 1.25, riskTolerance: 0.9, preferRange: 1.05 },
};

const ATTACK_KEYS = ['slashR', 'slashL', 'overhead', 'thrust', 'bash'];

/** 對手模型：把觀察到的行為壓成幾張統計表。 */
class OpponentModel {
  constructor() {
    this.moveCount = Object.fromEntries(ATTACK_KEYS.map((k) => [k, 1]));  // 拉普拉斯平滑
    this.total = ATTACK_KEYS.length;
    // n-gram：上一招 -> 下一招
    this.bigram = {};
    for (const a of ATTACK_KEYS) {
      this.bigram[a] = Object.fromEntries(ATTACK_KEYS.map((k) => [k, 0.5]));
    }
    this.lastMove = null;

    this.blockAttempts = 1;
    this.blockSuccess = 0.4;     // 對方擋下我攻擊的比例
    this.dodgeAttempts = 1;
    this.dodgeCount = 0.3;

    this.attackRanges = [];      // 對方出手時的距離，用來抓他的「舒適距離」
    this.avgAttackRange = 2.2;

    this.aggression = 0.5;       // 0~1，最近有多常主動進攻
    this.pressureDecay = 0.995;

    this.timeSinceTheirAttack = 0;
    this.attackIntervals = [];
    this.avgInterval = 1.6;

    this.punishedMe = 0;         // 我出招被反擊的次數
    this.iGotPunished = 0;
  }

  /** 對方起手一招。 */
  observeAttack(key, range) {
    if (!this.moveCount[key]) this.moveCount[key] = 1;
    this.moveCount[key] += 1;
    this.total += 1;
    if (this.lastMove) {
      this.bigram[this.lastMove][key] = (this.bigram[this.lastMove][key] || 0) + 1;
    }
    this.lastMove = key;

    this.attackRanges.push(range);
    if (this.attackRanges.length > 24) this.attackRanges.shift();
    this.avgAttackRange = this.attackRanges.reduce((a, b) => a + b, 0) / this.attackRanges.length;

    if (this.timeSinceTheirAttack > 0.15) {
      this.attackIntervals.push(this.timeSinceTheirAttack);
      if (this.attackIntervals.length > 16) this.attackIntervals.shift();
      this.avgInterval = this.attackIntervals.reduce((a, b) => a + b, 0) / this.attackIntervals.length;
    }
    this.timeSinceTheirAttack = 0;
    this.aggression = clamp(this.aggression + 0.09, 0, 1);
  }

  observeBlock(blocked) {
    this.blockAttempts += 1;
    if (blocked) this.blockSuccess += 1;
  }

  observeDodge() {
    this.dodgeAttempts += 1;
    this.dodgeCount += 1;
  }

  tick(dt) {
    this.timeSinceTheirAttack += dt;
    this.aggression *= Math.pow(this.pressureDecay, dt * 60);
  }

  /** 對方下一招最可能是什麼（結合整體頻率與接續習慣）。 */
  predictNext() {
    const dist = {};
    let sum = 0;
    for (const k of ATTACK_KEYS) {
      const base = this.moveCount[k] / this.total;
      const cond = this.lastMove
        ? this.bigram[this.lastMove][k] / Object.values(this.bigram[this.lastMove]).reduce((a, b) => a + b, 0)
        : base;
      const p = base * 0.4 + cond * 0.6;
      dist[k] = p;
      sum += p;
    }
    for (const k of ATTACK_KEYS) dist[k] /= (sum || 1);
    return dist;
  }

  get blockRate() { return clamp(this.blockSuccess / this.blockAttempts, 0, 1); }
  get dodgeRate() { return clamp(this.dodgeCount / this.dodgeAttempts, 0, 1); }

  /** 對方現在「該出手了」的機率（依他自己的節奏推算）。 */
  attackImminence() {
    const r = this.timeSinceTheirAttack / Math.max(0.3, this.avgInterval);
    return clamp(r, 0, 1.5);
  }
}

export class FighterAI {
  constructor(fighter, opts = {}) {
    this.fighter = fighter;
    this.difficulty = DIFFICULTIES[opts.difficulty] || DIFFICULTIES.hard;
    this.style = STYLES[opts.style] || STYLES.balanced;
    this.baseStyleKey = opts.style || 'balanced';
    this.rng = makeRng(opts.seed || 0x5eed);
    this.model = new OpponentModel();

    this.perception = [];        // 感知延遲緩衝
    this.decisionTimer = 0;
    this.decisionInterval = 0.06;
    this.input = emptyInput();

    this.plan = { kind: 'neutral', until: 0 };
    this.time = 0;
    this.strafeDir = 1;
    this.strafeTimer = 0;
    this.feintPending = null;
    this.lastOppAction = null;
    this.commitCooldown = 0;
    this.blockHold = 0;
    this.adaptiveBoost = 0;      // 自適應難度：落後時 > 0

    this.debug = { intent: '待機', threat: 0, predicted: null, confidence: 0 };
  }

  setDifficulty(key) {
    if (DIFFICULTIES[key]) this.difficulty = DIFFICULTIES[key];
  }

  /** 有效反應時間（含自適應調整）。 */
  get reactionTime() {
    const d = this.difficulty;
    return Math.max(0.05, d.reaction * (1 - this.adaptiveBoost * 0.35 * d.adapt));
  }

  /** 記錄一份對手快照，之後依延遲讀取。 */
  observe(opponent, dt) {
    this.time += dt;
    this.perception.push({
      t: this.time,
      x: opponent.x, z: opponent.z, y: opponent.y, yaw: opponent.yaw,
      health: opponent.health, stamina: opponent.stamina,
      blocking: opponent.blocking,
      staggered: opponent.stagger > 0,
      dodging: !!opponent.dodge,
      actionKey: opponent.action ? opponent.action.key : null,
      actionPhase: opponent.actionPhase,
      actionDuration: opponent.action ? opponent.action.duration : 0,
      alive: opponent.alive,
    });
    // 只留 1.5 秒
    while (this.perception.length > 2 && this.time - this.perception[0].t > 1.5) {
      this.perception.shift();
    }
    this.model.tick(dt);

    // 即時事件（起手偵測用實際狀態，但決策仍受延遲限制）
    const key = opponent.action ? opponent.action.key : null;
    if (key && key !== this.lastOppAction) {
      this.model.observeAttack(key, distXZ(this.fighter, opponent));
    }
    this.lastOppAction = key;
  }

  /** 讀取「延遲後」的世界。 */
  perceived() {
    const target = this.time - this.reactionTime;
    let best = this.perception[0];
    for (const p of this.perception) {
      if (p.t <= target) best = p;
      else break;
    }
    return best || this.perception[this.perception.length - 1];
  }

  /**
   * 主思考迴圈，回傳這一幀要送給 Fighter.update 的輸入。
   */
  think(opponent, dt) {
    const me = this.fighter;
    this.opponentLoadout = opponent.loadout; // 對手的武器長度是看得見的資訊
    this.observe(opponent, dt);

    const inp = this.input;
    inp.attack = 0;
    inp.dodge = false;
    inp.jump = false;
    // block 與移動是連續量，先沿用上一幀再視情況覆寫

    if (!me.alive || !opponent.alive) {
      inp.moveX = inp.moveZ = 0;
      inp.block = false;
      return inp;
    }

    // 自適應難度：落後越多越兇
    const hpDiff = (opponent.health / opponent.loadout.maxHealth) - (me.health / me.loadout.maxHealth);
    this.adaptiveBoost = clamp(hpDiff, 0, 1);

    // 落後時自動改打法
    if (hpDiff > 0.28) this.style = STYLES.aggressive;
    else if (hpDiff < -0.3) this.style = STYLES.defensive;
    else this.style = STYLES[this.baseStyleKey] || STYLES.balanced;

    this.commitCooldown = Math.max(0, this.commitCooldown - dt);
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 0.8 + this.rng() * 1.4;
      this.strafeDir = this.rng() < 0.5 ? -1 : 1;
    }

    const p = this.perceived();
    if (!p) return inp;

    const dist = Math.hypot(p.x - me.x, p.z - me.z);
    const threat = this.assessThreat(p, dist);
    this.debug.threat = threat.level;

    // 動作已經送出去就不能反悔（除了可取消的蓄力）
    if (me.action) {
      this.handleOngoingAttack(inp, p, dist, threat);
      return inp;
    }
    if (me.dodge || me.stagger > 0) {
      inp.block = false;
      inp.moveX = inp.moveZ = 0;
      return inp;
    }

    this.decisionTimer -= dt;
    if (this.decisionTimer > 0 && this.plan.until > this.time) {
      this.executePlan(inp, p, dist, threat);
      return inp;
    }
    this.decisionTimer = this.decisionInterval;

    this.plan = this.choosePlan(p, dist, threat, opponent);
    this.executePlan(inp, p, dist, threat);
    return inp;
  }

  /**
   * 推算對手這一刀什麼時候會到、有多痛。
   */
  assessThreat(p, dist) {
    const me = this.fighter;
    const out = { level: 0, timeToImpact: 99, move: null, key: null, incoming: false };

    if (p.actionKey) {
      const move = MOVES[p.actionKey];
      if (move) {
        const dur = p.actionDuration || moveDuration(move, { attackSpeed: 1 });
        const impactPhase = (move.active[0] + move.active[1]) * 0.5;
        const tti = (impactPhase - p.actionPhase) * dur;
        const reach = moveReach(move, this.opponentLoadout ||
          { weapon: { blade: { length: 0.85 }, hilt: { length: 0.2 } } });
        out.key = p.actionKey;
        out.move = move;
        out.timeToImpact = tti;
        out.incoming = tti > -0.12 && dist < reach + 1.4;
        if (out.incoming) {
          const distFactor = clamp(1.6 - dist / (reach + 0.6), 0, 1);
          out.level = clamp(move.damageMul * distFactor * 1.1, 0, 1.6);
        }
      }
    }

    if (!out.incoming) {
      // 沒有實際動作時，用節奏模型預判「他快出手了」
      const imminence = this.model.attackImminence();
      const inRange = dist < this.model.avgAttackRange + 0.6;
      out.level = inRange ? imminence * 0.45 * this.difficulty.predict : 0;
      out.predictedKey = this.pickTop(this.model.predictNext());
      this.debug.predicted = out.predictedKey;
    }
    return out;
  }

  pickTop(dist) {
    let best = null, bv = -1;
    for (const [k, v] of Object.entries(dist)) {
      if (v > bv) { bv = v; best = k; }
    }
    this.debug.confidence = bv;
    return best;
  }

  /**
   * 選一個計畫。這裡是「效用 + 一層 rollout」的核心。
   */
  choosePlan(p, dist, threat, opponent) {
    const me = this.fighter;
    const d = this.difficulty;
    const st = this.style;
    const now = this.time;
    const staminaRatio = me.stamina / me.loadout.maxStamina;
    const hpRatio = me.health / me.loadout.maxHealth;

    // 偶爾故意失誤，讓 AI 不是完美機器
    if (this.rng() < d.mistake) {
      return { kind: this.rng() < 0.5 ? 'circle' : 'approach', until: now + 0.25 + this.rng() * 0.35 };
    }

    const candidates = [];

    // ---- 防禦類 ----
    if (threat.incoming) {
      const tti = threat.timeToImpact;
      // 招架：算好時間點才舉盾，早舉會變成普通格擋
      const canParry = me.loadout.offhand.kind === 'shield' || true;
      if (canParry) {
        // 想在命中瞬間讓 blockTimer 落在招架窗口內
        const idealDelay = Math.max(0, tti - PARRY_WINDOW * 0.5);
        const timingErr = Math.abs(idealDelay) + (1 - d.parrySkill) * 0.25;
        const parryScore = (14 * d.parrySkill) / (1 + timingErr * 6) * st.riskTolerance;
        candidates.push({ kind: 'parry', score: parryScore, until: now + Math.max(0.12, tti + 0.2), tti });
      }
      // 普通格擋：穩但耗體力
      candidates.push({
        kind: 'block',
        score: (7 + threat.level * 4) * (staminaRatio > 0.3 ? 1 : 0.3) * st.patience,
        until: now + Math.max(0.15, tti + 0.15),
      });
      // 翻滾：對重招最有效
      const heavy = threat.move && threat.move.damageMul > 1.2;
      candidates.push({
        kind: 'dodge',
        score: (heavy ? 12 : 6.5) * (me.stamina > 28 ? 1 : 0.15) *
               (tti > 0.12 && tti < 0.55 ? 1 : 0.25) * (1 - st.pressure * 0.15),
        until: now + DODGE_DURATION,
      });
      // 後撤到刀外
      candidates.push({
        kind: 'retreat',
        score: 5.5 * st.patience * (tti > 0.18 ? 1 : 0.3),
        until: now + 0.3,
      });
      // 搶攻：對手蓄力很慢的重招時可以打斷
      if (threat.move && threat.timeToImpact > 0.28 && me.stamina > 30) {
        candidates.push({ kind: 'interrupt', score: 8 * st.pressure * d.predict, until: now + 0.4 });
      }
    }

    // ---- 進攻類 ----
    const oppVulnerable = p.staggered || (p.actionKey && p.actionPhase > MOVES[p.actionKey]?.active[1]);
    if (oppVulnerable) {
      // 對手硬直 / 收招 -> 全力懲罰
      candidates.push({ kind: 'punish', score: 22 * st.pressure, until: now + 0.5 });
    }

    if (!threat.incoming || threat.timeToImpact > 0.45) {
      const atkScore = this.scoreAttack(p, dist, staminaRatio);
      if (atkScore.best) {
        candidates.push({
          kind: 'attack', move: atkScore.best, score: atkScore.score, until: now + 0.5,
        });
      }
      // 假動作：對手很愛擋就騙他
      if (this.model.blockRate > 0.45 && me.stamina > 40 && dist < me.bestReach() + 0.4) {
        candidates.push({ kind: 'feint', score: 9 * this.model.blockRate * d.predict * st.pressure, until: now + 0.7 });
      }
      // 盾擊破防
      if (me.loadout.offhand.kind === 'shield' && this.model.blockRate > 0.5 && dist < 1.5) {
        candidates.push({ kind: 'bash', score: 11 * this.model.blockRate, until: now + 0.5 });
      }
    }

    // ---- 走位類 ----
    const idealRange = me.bestReach() * st.preferRange;
    const rangeErr = dist - idealRange;
    candidates.push({
      kind: rangeErr > 0.35 ? 'approach' : (rangeErr < -0.7 ? 'retreat' : 'circle'),
      score: 4.2 + Math.abs(rangeErr) * 1.6,
      until: now + 0.22,
    });

    // 體力不夠就拉開回氣
    if (staminaRatio < 0.28) {
      candidates.push({ kind: 'recover', score: 13 * (1 - staminaRatio), until: now + 0.5 });
    }
    // 血量落後且對手強勢時更保守
    if (hpRatio < 0.3 && this.model.aggression > 0.5) {
      candidates.push({ kind: 'retreat', score: 6, until: now + 0.35 });
    }

    // 加上一點雜訊，避免行為完全機械化
    for (const c of candidates) {
      c.score *= 1 + (this.rng() - 0.5) * 2 * d.noise;
    }
    candidates.sort((a, b) => b.score - a.score);
    const chosen = candidates[0] || { kind: 'circle', until: now + 0.3 };
    this.debug.intent = PLAN_LABELS[chosen.kind] || chosen.kind;
    return chosen;
  }

  /**
   * 對每個可用招式做一層 rollout：預期傷害 - 被反擊的風險。
   */
  scoreAttack(p, dist, staminaRatio) {
    const me = this.fighter;
    const d = this.difficulty;
    const st = this.style;
    const blockRate = this.model.blockRate;
    const dodgeRate = this.model.dodgeRate;

    let best = null, bestScore = -Infinity;

    for (const key of me.loadout.weapon.moves) {
      const move = MOVES[key];
      if (!move) continue;
      if (move.weapon === 'shield' && me.loadout.offhand.kind !== 'shield') continue;

      const reach = moveReach(move, me.loadout);
      const dur = moveDuration(move, me.loadout);
      const cost = move.staminaCost * (2 - me.loadout.staminaMul);
      if (me.stamina < cost) continue;

      // 距離適配度：太遠打空、太近也會揮空
      const windupTime = move.active[0] * dur;
      // 出招期間雙方會靠近，把推進距離算進去
      const closing = move.advance * 0.18;
      const effDist = dist - closing;
      const fit = 1 - clamp(Math.abs(effDist - reach * 0.85) / (reach * 0.7), 0, 1);
      if (fit <= 0.02) continue;

      // 預期傷害
      const dmg = me.loadout.weapon.damage * move.damageMul;
      // 對手擋下的機率（他愛擋 + 他現在正在擋）
      const pBlock = clamp(blockRate * 0.8 + (p.blocking ? 0.5 : 0), 0, 0.95);
      const pDodge = clamp(dodgeRate * 0.6, 0, 0.6);
      const expected = dmg * fit * (1 - pBlock * 0.7) * (1 - pDodge * 0.8);

      // 風險：招越慢，被對手趁隙反擊的機率越高
      const oppThreatRate = this.model.attackImminence();
      const risk = dur * (0.55 + oppThreatRate * 0.9) * 9 / st.riskTolerance;

      // 重招在對手快出手時特別危險
      const commitPenalty = move.damageMul > 1.2 ? oppThreatRate * 6 : 0;

      let score = expected * 1.35 * st.pressure - risk - commitPenalty;
      score *= (staminaRatio > 0.45 ? 1 : 0.6);

      // 進攻慾望（難度越高越懂得找機會）
      score += d.aggression * 3 * fit;

      // 這招最近常被招架就少用
      if (this.punishHistory && this.punishHistory[key]) score -= this.punishHistory[key] * 2.5;

      if (score > bestScore) { bestScore = score; best = key; }
    }
    return { best, score: bestScore };
  }

  /** 攻擊已經送出後的處理：假動作取消、追擊。 */
  handleOngoingAttack(inp, p, dist, threat) {
    const me = this.fighter;
    inp.block = false;
    inp.moveX = inp.moveZ = 0;

    // 假動作：對手已經舉盾就取消，等他放下再打
    if (this.feintPending && me.action) {
      const phase = me.actionPhase;
      if (phase > this.feintPending.at) {
        if (p.blocking || this.rng() < 0.7) {
          me.feint();
          this.plan = { kind: 'punishFeint', until: this.time + 0.45 };
          this.debug.intent = '假動作騙招';
        }
        this.feintPending = null;
      }
      return;
    }

    // 已經出刃了就往前推一點，確保打得到
    const phase = me.actionPhase;
    const move = me.action.move;
    if (phase < move.active[0] && dist > moveReach(move, me.loadout) * 0.8) {
      const toX = p.x - me.x, toZ = p.z - me.z;
      const len = Math.hypot(toX, toZ) || 1;
      inp.moveX = toX / len; inp.moveZ = toZ / len;
    }

    // 蓄力階段發現對方要反擊 -> 取消保命
    if (threat.incoming && threat.timeToImpact < 0.2 && phase < move.feintUntil
        && this.rng() < this.difficulty.predict) {
      me.feint();
      this.debug.intent = '取消攻擊';
    }
  }

  /** 把計畫轉成實際輸入。 */
  executePlan(inp, p, dist, threat) {
    const me = this.fighter;
    const toX = p.x - me.x, toZ = p.z - me.z;
    const len = Math.hypot(toX, toZ) || 1;
    const fx = toX / len, fz = toZ / len;         // 朝向對手
    const sx = -fz, sz = fx;                       // 側向

    inp.moveX = 0; inp.moveZ = 0;
    inp.block = false;
    inp.dodge = false;
    inp.attack = 0;

    switch (this.plan.kind) {
      case 'parry': {
        // 精準時機舉盾：太早舉就變普通格擋了
        const tti = threat.timeToImpact ?? this.plan.tti ?? 0.2;
        const skill = this.difficulty.parrySkill;
        const jitter = (this.rng() - 0.5) * 0.16 * (1 - skill);
        if (tti + jitter <= PARRY_WINDOW * 0.9) inp.block = true;
        else inp.moveX = -fx * 0.25, inp.moveZ = -fz * 0.25;
        break;
      }
      case 'block':
        inp.block = true;
        inp.moveX = -fx * 0.15; inp.moveZ = -fz * 0.15;
        break;
      case 'dodge': {
        // 往側後方翻，順便繞到側面
        const dx = sx * this.strafeDir * 0.85 - fx * 0.5;
        const dz = sz * this.strafeDir * 0.85 - fz * 0.5;
        inp.moveX = dx; inp.moveZ = dz;
        inp.dodge = true;
        break;
      }
      case 'retreat':
      case 'recover':
        inp.moveX = -fx + sx * this.strafeDir * 0.5;
        inp.moveZ = -fz + sz * this.strafeDir * 0.5;
        inp.block = this.plan.kind === 'recover' ? false : (me.stamina > 25);
        break;
      case 'approach':
        inp.moveX = fx; inp.moveZ = fz;
        break;
      case 'circle':
        inp.moveX = sx * this.strafeDir + fx * 0.18;
        inp.moveZ = sz * this.strafeDir + fz * 0.18;
        break;
      case 'punish':
      case 'punishFeint': {
        // 挑最快的招懲罰
        const key = this.fastestUsableMove();
        if (dist > moveReach(MOVES[key], me.loadout) * 0.85) {
          inp.moveX = fx; inp.moveZ = fz;
        }
        if (dist < moveReach(MOVES[key], me.loadout) + 0.25 && this.commitCooldown <= 0) {
          inp.attack = CODE_BY_ATTACK[key];
          this.commitCooldown = 0.15;
        }
        break;
      }
      case 'interrupt': {
        const key = this.fastestUsableMove();
        inp.moveX = fx * 0.8; inp.moveZ = fz * 0.8;
        if (dist < moveReach(MOVES[key], me.loadout) + 0.2 && this.commitCooldown <= 0) {
          inp.attack = CODE_BY_ATTACK[key];
          this.commitCooldown = 0.2;
        }
        break;
      }
      case 'bash':
        if (dist > 1.3) { inp.moveX = fx; inp.moveZ = fz; }
        else if (this.commitCooldown <= 0) {
          inp.attack = CODE_BY_ATTACK.bash;
          this.commitCooldown = 0.3;
        }
        break;
      case 'feint': {
        const key = this.plan.move || 'overhead';
        if (this.commitCooldown <= 0) {
          inp.attack = CODE_BY_ATTACK[key] || CODE_BY_ATTACK.slashR;
          this.feintPending = { at: (MOVES[key]?.feintUntil || 0.3) * 0.75 };
          this.commitCooldown = 0.5;
        }
        break;
      }
      case 'attack': {
        const key = this.plan.move;
        const move = MOVES[key];
        const reach = moveReach(move, me.loadout);
        if (dist > reach * 0.95) {
          inp.moveX = fx; inp.moveZ = fz;
        }
        if (dist <= reach + 0.15 && this.commitCooldown <= 0) {
          inp.attack = CODE_BY_ATTACK[key];
          this.commitCooldown = 0.18;
        }
        break;
      }
      default:
        inp.moveX = sx * this.strafeDir * 0.6;
        inp.moveZ = sz * this.strafeDir * 0.6;
    }

    // 場地邊界迴避：快撞牆就往場中心修正
    const r = Math.hypot(me.x, me.z);
    if (r > 9.6) {
      const inX = -me.x / (r || 1), inZ = -me.z / (r || 1);
      inp.moveX = inp.moveX * 0.4 + inX * 0.9;
      inp.moveZ = inp.moveZ * 0.4 + inZ * 0.9;
    }
  }

  fastestUsableMove() {
    const me = this.fighter;
    let best = 'slashL', bestDur = Infinity;
    for (const key of me.loadout.weapon.moves) {
      const move = MOVES[key];
      if (!move) continue;
      const cost = move.staminaCost * (2 - me.loadout.staminaMul);
      if (me.stamina < cost) continue;
      const dur = moveDuration(move, me.loadout) * move.active[0];
      if (dur < bestDur) { bestDur = dur; best = key; }
    }
    return best;
  }

  /** 由外部在事件發生時回饋，讓 AI 學得更快。 */
  notify(event) {
    if (!event) return;
    const me = this.fighter;
    if (event.attacker === me.id) {
      this.model.observeBlock(event.blocked || event.parried);
      if (event.parried) {
        this.punishHistory = this.punishHistory || {};
        const k = me.action ? me.action.key : null;
        if (k) this.punishHistory[k] = (this.punishHistory[k] || 0) + 1;
        this.model.iGotPunished++;
      }
    } else if (event.defender === me.id) {
      if (!event.blocked && !event.parried) this.model.punishedMe++;
    }
  }
}

const PLAN_LABELS = {
  parry: '瞄準招架', block: '格擋', dodge: '翻滾迴避', retreat: '拉開距離',
  recover: '回復體力', approach: '進逼', circle: '繞步', punish: '抓破綻反擊',
  punishFeint: '騙招後反擊', interrupt: '搶攻打斷', bash: '盾擊破防',
  feint: '假動作', attack: '進攻',
};
