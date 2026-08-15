// 連線對戰的同步層：把 transport 與 Match 接起來。
//
// 架構：房主權威（host authoritative）
//   - 房主端跑完整模擬，是唯一的裁判（血量、命中、回合都以他為準）。
//   - 加入者本地照樣完整模擬，讓自己的操作零延遲（本地預測），
//     再依房主送來的快照做誤差修正；對手則用快照插值播放。
//   這樣即使走 BLE（頻寬小、延遲高）也能玩得動。

import {
  MSG, ROUND_STATE, PROTOCOL_VERSION,
  encodeInput, decodeInput, encodeState, decodeState,
  encodeEvent, decodeEvent, encodeLoadout, decodeLoadout,
  encodeHello, decodeHello, encodeRound, decodeRound,
} from './protocol.js';
import { Match, MATCH_MODE } from '../game/match.js';
import { emptyInput, ATTACK_BY_CODE } from '../game/fighter.js';
import { MOVES, moveDuration } from '../game/combat.js';
import { WEAPON_KEYS, OFFHAND_KEYS, LOADOUT_PRESETS } from '../game/equipment.js';
import { lerp, lerpAngle, clamp } from '../core/math.js';

const STATE_RATE = 1 / 20;    // 房主每秒送 20 次狀態
const INPUT_RATE = 1 / 30;    // 加入者每秒送 30 次輸入
const HANDSHAKE_RATE = 0.5;
/** 同一個瞬間動作要重送幾次，用來對抗 BLE / DataChannel 掉包。 */
const ACTION_REPEATS = 3;

/** performance.now()，Node 端測試也能用。 */
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class NetSession {
  /**
   * @param transport 已連上的傳輸層
   * @param isHost    true = 房主
   * @param localCfg  本地配裝
   */
  constructor(transport, isHost, localCfg, opts = {}) {
    this.transport = transport;
    this.isHost = isHost;
    this.localCfg = localCfg;
    this.localName = opts.name || (isHost ? '房主' : '挑戰者');
    this.remoteCfg = null;
    this.remoteName = null;
    this.match = null;
    this.seed = opts.seed || ((Math.random() * 65535) | 0);

    this.inputSeq = 0;
    // 瞬間動作的暫存：按鍵可能落在兩次送出之間，先鎖住再送
    this.pendingAction = { attack: 0, dodge: false, jump: false };
    this.hasPending = false;
    this.actionCounter = 0;
    this.actionRepeats = 0;
    this.lastRemoteActionCounter = -1;
    this.stateAcc = 0;
    this.inputAcc = 0;
    this.handshakeAcc = 0;
    this.lastHandshakeReply = 0;
    this.ready = false;
    this.peerReady = false;
    this.lastRemoteInput = emptyInput();
    this.snapshot = null;
    this.snapshotAge = 0;
    this.pingMs = 0;
    this.lastPingSent = 0;
    this.onReady = () => {};
    this.onStatus = () => {};
    this.bestOf = opts.bestOf || 3;
    this.roundTime = opts.roundTime || 99;

    transport.onMessage = (bytes) => this.handleMessage(bytes);
  }

  /** 我在 match.fighters 裡的索引。 */
  get localIndex() { return this.isHost ? 0 : 1; }
  get remoteIndex() { return this.isHost ? 1 : 0; }

  start() {
    this.sendHandshake();
  }

  sendHandshake() {
    this.transport.send(encodeHello(this.isHost ? 0 : 1, this.seed));
    this.transport.send(encodeLoadout(this.localIndex, this.localCfg,
      WEAPON_KEYS, OFFHAND_KEYS, this.localName));
  }

  handleMessage(bytes) {
    const type = bytes[0];
    switch (type) {
      case MSG.HELLO: {
        const h = decodeHello(bytes);
        if (h.version !== PROTOCOL_VERSION) {
          this.onStatus('error', `協定版本不符（對方 v${h.version}，我方 v${PROTOCOL_VERSION}），請更新到同一版`);
          return;
        }
        // 房主的種子為準，確保兩邊的隨機一致
        if (!this.isHost) this.seed = h.seed;
        break;
      }
      case MSG.LOADOUT: {
        const l = decodeLoadout(bytes, WEAPON_KEYS, OFFHAND_KEYS);
        this.remoteCfg = l.config;
        this.remoteName = l.name || (this.isHost ? '挑戰者' : '房主');
        this.peerReady = true;
        // 對方收到我們的握手了嗎？不知道 —— 我們自己的第一份握手可能在對方
        // 連上之前就送出去了，也可能被 BLE 掉包。所以每次收到對方的配裝就回敬
        // 一次自己的，直到對方也配對成功不再重送為止。
        const now = nowMs();
        if (now - this.lastHandshakeReply > 350) {
          this.lastHandshakeReply = now;
          this.sendHandshake();
        }
        this.tryCreateMatch();
        break;
      }
      case MSG.INPUT: {
        if (!this.isHost || !this.match) break;
        const { actionCounter } = decodeInput(bytes, this.lastRemoteInput);
        // 流水號沒變 = 這是同一個動作的重送，移動與格擋照收，
        // 但攻擊 / 翻滾 / 跳躍不能再觸發一次
        if (actionCounter === this.lastRemoteActionCounter) {
          this.lastRemoteInput.attack = 0;
          this.lastRemoteInput.dodge = false;
          this.lastRemoteInput.jump = false;
        } else {
          this.lastRemoteActionCounter = actionCounter;
        }
        this.match.setInput(this.remoteIndex, this.lastRemoteInput);
        break;
      }
      case MSG.STATE: {
        if (this.isHost || !this.match) break;
        this.snapshot = decodeState(bytes, 2);
        this.snapshotAge = 0;
        break;
      }
      case MSG.EVENT: {
        if (this.isHost || !this.match) break;
        this.match.applyRemoteEvent(decodeEvent(bytes));
        break;
      }
      case MSG.ROUND: {
        if (this.isHost || !this.match) break;
        this.applyRoundSync(decodeRound(bytes));
        break;
      }
      case MSG.PING:
        this.transport.send(new Uint8Array([MSG.PONG, bytes[1], bytes[2]]));
        break;
      case MSG.PONG: {
        const sent = (bytes[1] << 8) | bytes[2];
        const now = (nowMs() | 0) & 0xffff;
        this.pingMs = (now - sent + 65536) % 65536;
        break;
      }
      case MSG.BYE:
        this.onStatus('disconnected', '對方離開了');
        break;
    }
  }

  tryCreateMatch() {
    if (this.match || !this.remoteCfg) return;
    const loadouts = this.isHost
      ? [this.localCfg, this.remoteCfg]
      : [this.remoteCfg, this.localCfg];
    const names = this.isHost
      ? [this.localName, this.remoteName]
      : [this.remoteName, this.localName];

    this.match = new Match({
      mode: this.isHost ? MATCH_MODE.HOST : MATCH_MODE.GUEST,
      loadouts, names,
      bestOf: this.bestOf,
      roundTime: this.roundTime,
      seed: this.seed,
    });
    this.ready = true;
    this.onReady(this.match);
    this.onStatus('connected', `已配對：${this.remoteName}`);
  }

  /**
   * 每幀呼叫。
   * @param localInput 本地玩家這一幀的輸入
   */
  update(localInput, dt) {
    if (!this.match) {
      // 還沒配對成功就持續重送握手（BLE 可能掉包）
      this.handshakeAcc += dt;
      if (this.handshakeAcc >= HANDSHAKE_RATE) {
        this.handshakeAcc = 0;
        this.sendHandshake();
      }
      return;
    }

    this.match.setInput(this.localIndex, localInput);

    if (this.isHost) {
      this.match.update(dt);
      // 廣播命中事件（先送，讓對方特效不落後）
      for (const ev of this.match.events) this.transport.send(encodeEvent(ev));
      this.stateAcc += dt;
      if (this.stateAcc >= STATE_RATE) {
        this.stateAcc = 0;
        this.transport.send(encodeState(this.match.time * 60, this.match.fighters));
        this.transport.send(encodeRound(
          this.match.state, this.match.roundNo,
          this.match.winner < 0 ? 255 : this.match.winner,
          this.match.timeLeft));
      }
    } else {
      // 加入者：先本地模擬（預測），再往房主的快照修正
      this.match.update(dt);
      this.snapshotAge += dt;
      if (this.snapshot) this.reconcile(dt);

      this.latchAction(localInput);
      this.inputAcc += dt;
      if (this.inputAcc >= INPUT_RATE) {
        this.inputAcc = 0;
        this.sendInput(localInput);
      }
    }

    // 每秒量一次延遲
    if (this.match.time - this.lastPingSent > 1.0) {
      this.lastPingSent = this.match.time;
      const t = (nowMs() | 0) & 0xffff;
      this.transport.send(new Uint8Array([MSG.PING, (t >> 8) & 255, t & 255]));
    }
  }

  /**
   * 把這一幀的瞬間動作鎖起來，等下一次送出。
   * 畫面在跑 60fps 但封包只有 30Hz，不鎖的話有一半的按鍵會直接掉。
   */
  latchAction(input) {
    if (input.attack) { this.pendingAction.attack = input.attack; this.hasPending = true; }
    if (input.dodge) { this.pendingAction.dodge = true; this.hasPending = true; }
    if (input.jump) { this.pendingAction.jump = true; this.hasPending = true; }
  }

  /** 送出一份輸入：移動與格擋用當下的值，瞬間動作用鎖住的值。 */
  sendInput(localInput) {
    const payload = {
      moveX: localInput.moveX,
      moveZ: localInput.moveZ,
      block: localInput.block,
      attack: 0, dodge: false, jump: false,
    };

    if (this.hasPending && this.actionRepeats === 0) {
      // 新動作：換一個流水號，並排定重送次數對抗掉包
      this.actionCounter = (this.actionCounter + 1) & 0x03;
      this.actionRepeats = ACTION_REPEATS;
    }
    if (this.actionRepeats > 0) {
      payload.attack = this.pendingAction.attack;
      payload.dodge = this.pendingAction.dodge;
      payload.jump = this.pendingAction.jump;
      this.actionRepeats--;
      if (this.actionRepeats === 0) {
        this.pendingAction.attack = 0;
        this.pendingAction.dodge = false;
        this.pendingAction.jump = false;
        this.hasPending = false;
      }
    }

    this.transport.send(encodeInput(this.inputSeq++, payload, this.actionCounter));
  }

  /** 用房主的快照修正本地狀態。 */
  reconcile(dt) {
    const snap = this.snapshot;
    if (!snap) return;
    const me = this.match.fighters[this.localIndex];
    const foe = this.match.fighters[this.remoteIndex];
    const sMe = snap.fighters[this.localIndex];
    const sFoe = snap.fighters[this.remoteIndex];
    if (!sMe || !sFoe) return;

    // --- 自己：位置做軟修正，數值直接聽房主的 ---
    const err = Math.hypot(me.x - sMe.x, me.z - sMe.z);
    if (err > 1.6) {
      // 差太多代表預測完全跑掉了，直接拉回去
      me.x = sMe.x; me.z = sMe.z;
    } else if (err > 0.04) {
      const k = Math.min(1, dt * 6);
      me.x = lerp(me.x, sMe.x, k);
      me.z = lerp(me.z, sMe.z, k);
    }
    me.health = sMe.health;
    me.stamina = sMe.stamina;
    if (sMe.dead && me.alive) me.health = 0;

    // --- 對手：完全依快照播放 ---
    const k = Math.min(1, dt * 14);
    foe.x = lerp(foe.x, sFoe.x, k);
    foe.z = lerp(foe.z, sFoe.z, k);
    foe.yaw = lerpAngle(foe.yaw, sFoe.yaw, Math.min(1, dt * 12));
    foe.health = sFoe.health;
    foe.stamina = sFoe.stamina;
    foe.blocking = sFoe.blocking;
    if (sFoe.staggered && foe.stagger <= 0) foe.stagger = 0.25;
    if (!sFoe.staggered) foe.stagger = Math.min(foe.stagger, 0.1);

    applyRemoteAction(foe, sFoe);
    applyRemoteDodge(foe, sFoe);
  }

  applyRoundSync(r) {
    const m = this.match;
    if (!m) return;
    m.roundNo = r.roundNo;
    m.timeLeft = r.timeLeft;
    if (r.state !== m.state) {
      // 回合狀態改變時同步過去，並補上本地的表現（倒數、勝負字幕）
      if (r.state === ROUND_STATE.COUNTDOWN && m.state !== ROUND_STATE.COUNTDOWN) {
        m.resetRound();
      } else if (r.state === ROUND_STATE.OVER && m.state !== ROUND_STATE.OVER) {
        m.winner = r.winner === 255 ? -1 : r.winner;
        m.state = ROUND_STATE.OVER;
        m.stateTimer = 3.2;
        if (m.winner >= 0) {
          m.wins[m.winner]++;
          m.pushMessage(`${m.fighters[m.winner].name} 獲勝`,
            m.winner === this.localIndex ? '#7bd88f' : '#ff6b6b', 2.2);
        } else {
          m.pushMessage('平手', '#cbd5e1', 2.2);
        }
      } else {
        m.state = r.state;
      }
    }
  }

  close() {
    try { this.transport.send(new Uint8Array([MSG.BYE])); } catch { /* 已離線 */ }
    this.transport.close();
  }
}

/** 把快照裡的招式狀態套到遠端角色身上，讓動作正確播放。 */
function applyRemoteAction(f, snap) {
  const key = snap.actionKey;
  if (!key) {
    // 對方已經收招了；本地還在播就讓它自然播完，避免動作被切斷抽動
    if (f.action && f.actionPhase > 0.85) f.action = null;
    return;
  }
  const move = MOVES[key];
  if (!move) return;
  const duration = moveDuration(move, f.loadout);
  if (!f.action || f.action.key !== key) {
    f.action = { key, move, elapsed: snap.actionPhase * duration, duration, hasHit: false, hitIds: new Set() };
  } else {
    // 已經在播同一招：往快照的相位靠攏，但不倒退（倒退會看起來在抖）
    const target = snap.actionPhase * duration;
    if (target > f.action.elapsed) {
      f.action.elapsed = lerp(f.action.elapsed, target, 0.5);
    }
  }
}

function applyRemoteDodge(f, snap) {
  if (snap.dodging && !f.dodge) {
    const dx = -Math.sin(f.yaw), dz = -Math.cos(f.yaw);
    f.dodge = { elapsed: 0, dirX: dx, dirZ: dz };
  } else if (!snap.dodging && f.dodge && f.dodge.elapsed > 0.4) {
    f.dodge = null;
  }
}

/** 給 UI 用的連線狀態摘要。 */
export function sessionInfo(session) {
  if (!session) return null;
  const t = session.transport;
  return {
    role: session.isHost ? '房主' : '挑戰者',
    status: t.status,
    ping: session.pingMs,
    sent: t.stats.sent,
    received: t.stats.received,
    drops: t.stats.drops,
    remote: session.remoteName,
  };
}
