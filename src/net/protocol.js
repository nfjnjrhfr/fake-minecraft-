// 對戰封包協定。
// 目標是塞得進 BLE 預設 20 bytes 的 MTU，所有欄位都量化過。
// 上層再套一層分片（fragment），超過 MTU 的訊息會自動切開重組。

export const PROTOCOL_VERSION = 4;   // v4: 動力裝甲材質 + 無披風哨兵

export const MSG = {
  HELLO: 0x01,
  LOADOUT: 0x02,
  READY: 0x03,
  START: 0x04,
  INPUT: 0x10,
  STATE: 0x11,
  EVENT: 0x12,
  ROUND: 0x13,
  PING: 0x20,
  PONG: 0x21,
  BYE: 0x2f,
};

/** BLE 保守值：ATT MTU 23 - 3 bytes header = 20。 */
export const DEFAULT_MTU = 20;

// ---------------------------------------------------------------------------
// 量化工具
// ---------------------------------------------------------------------------

const POS_SCALE = 200;   // 公尺 -> 0.5 公分
const clampI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

export function packAngle(rad) {
  let a = rad % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return Math.round(a / (Math.PI * 2) * 255) & 255;
}
export function unpackAngle(b) {
  return (b / 255) * Math.PI * 2;
}

/**
 * 輸入封包：把移動方向壓成 16 個方位 + 強度，按鍵壓成 bitmask。
 * [type, seq, dir, buttons]  共 4 bytes
 *
 * buttons 的最高兩位是「動作流水號」。攻擊 / 翻滾 / 跳躍都是只存在一幀的
 * 瞬間輸入，而封包是定頻送的，沒有這個流水號的話會出兩種問題：
 *   1. 按鍵剛好落在兩次送出之間 -> 這一招整個消失
 *   2. 連線不可靠（BLE、UDP 式的 DataChannel）掉包 -> 一樣消失
 * 有了流水號，同一個動作就可以安全地重送好幾次：收端只認流水號有變的那次，
 * 重複的直接忽略，所以「重送」不會變成「連按」。
 */
export function encodeInput(seq, input, actionCounter = 0) {
  const buf = new Uint8Array(4);
  buf[0] = MSG.INPUT;
  buf[1] = seq & 255;

  const mag = Math.min(1, Math.hypot(input.moveX, input.moveZ));
  let dirByte = 0;
  if (mag > 0.08) {
    const ang = Math.atan2(input.moveX, input.moveZ);
    const sector = Math.round(((ang + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * 16) % 16;
    const magQ = Math.min(3, Math.round(mag * 3));   // 0~3
    dirByte = 0x80 | (sector << 2) | magQ;
  }
  buf[2] = dirByte;

  let btn = input.attack & 0x07;                 // 0~5
  if (input.block) btn |= 0x08;
  if (input.dodge) btn |= 0x10;
  if (input.jump) btn |= 0x20;
  btn |= (actionCounter & 0x03) << 6;
  buf[3] = btn;
  return buf;
}

/**
 * @returns { seq, actionCounter } —— 呼叫端要自己比對 actionCounter，
 *          相同就代表這是重送，瞬間動作不可以再套用一次。
 */
export function decodeInput(buf, out) {
  const seq = buf[1];
  const dirByte = buf[2];
  const btn = buf[3];
  if (dirByte & 0x80) {
    const sector = (dirByte >> 2) & 0x0f;
    const magQ = dirByte & 0x03;
    const ang = (sector / 16) * Math.PI * 2;
    const mag = magQ / 3;
    out.moveX = Math.sin(ang) * mag;
    out.moveZ = Math.cos(ang) * mag;
  } else {
    out.moveX = 0; out.moveZ = 0;
  }
  out.attack = btn & 0x07;
  out.block = !!(btn & 0x08);
  out.dodge = !!(btn & 0x10);
  out.jump = !!(btn & 0x20);
  return { seq, actionCounter: (btn >> 6) & 0x03 };
}

/**
 * 狀態快照（host -> guest）。
 * header 2 bytes + 每位戰士 9 bytes = 20 bytes。
 *
 * 每位戰士：
 *   x:int16, z:int16, yaw:u8, hp:u8, sp:u8, flags:u8, action:u8
 *   flags: bit0 blocking, bit1 dodging, bit2 staggered, bit3 dead, bit4 airborne
 *   action: 高 3 bits = 招式代碼, 低 5 bits = 相位(0~31)
 */
export function encodeState(tick, fighters) {
  const buf = new Uint8Array(2 + fighters.length * 9);
  const view = new DataView(buf.buffer);
  buf[0] = MSG.STATE;
  buf[1] = tick & 255;
  let o = 2;
  for (const f of fighters) {
    view.setInt16(o, clampI16(f.x * POS_SCALE), true); o += 2;
    view.setInt16(o, clampI16(f.z * POS_SCALE), true); o += 2;
    buf[o++] = packAngle(f.yaw);
    buf[o++] = Math.max(0, Math.min(255, Math.round(f.health * 2)));
    buf[o++] = Math.max(0, Math.min(255, Math.round(f.stamina * 2)));
    let flags = 0;
    if (f.blocking) flags |= 1;
    if (f.dodge) flags |= 2;
    if (f.stagger > 0) flags |= 4;
    if (!f.alive) flags |= 8;
    if (f.y > 0.02) flags |= 16;
    buf[o++] = flags;
    const code = f.action ? (ATTACK_CODES[f.action.key] || 0) : 0;
    const phase = f.action ? Math.min(31, Math.round(f.actionPhase * 31)) : 0;
    buf[o++] = (code << 5) | phase;
  }
  return buf;
}

export function decodeState(buf, count = 2) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tick = buf[1];
  const out = [];
  let o = 2;
  for (let i = 0; i < count; i++) {
    if (o + 9 > buf.length) break;
    const x = view.getInt16(o, true) / POS_SCALE; o += 2;
    const z = view.getInt16(o, true) / POS_SCALE; o += 2;
    const yaw = unpackAngle(buf[o++]);
    const health = buf[o++] / 2;
    const stamina = buf[o++] / 2;
    const flags = buf[o++];
    const act = buf[o++];
    out.push({
      x, z, yaw, health, stamina,
      blocking: !!(flags & 1),
      dodging: !!(flags & 2),
      staggered: !!(flags & 4),
      dead: !!(flags & 8),
      airborne: !!(flags & 16),
      actionKey: ATTACK_NAMES[act >> 5] || null,
      actionPhase: (act & 31) / 31,
    });
  }
  return { tick, fighters: out };
}

export const ATTACK_CODES = { slashR: 1, slashL: 2, overhead: 3, thrust: 4, bash: 5 };
export const ATTACK_NAMES = [null, 'slashR', 'slashL', 'overhead', 'thrust', 'bash'];

/**
 * 命中事件（host -> guest），只給表現層播特效用。
 * [type, defender, partIdx, flags, damage, x_i16, y_u8, z_i16]  = 11 bytes
 */
const PARTS = ['head', 'torso', 'armR', 'armL', 'legR', 'legL'];
export function encodeEvent(ev) {
  const buf = new Uint8Array(11);
  const view = new DataView(buf.buffer);
  buf[0] = MSG.EVENT;
  buf[1] = ev.defender & 255;
  buf[2] = Math.max(0, PARTS.indexOf(ev.part));
  let flags = 0;
  if (ev.blocked) flags |= 1;
  if (ev.parried) flags |= 2;
  if (ev.critical) flags |= 4;
  if (ev.guardBreak) flags |= 8;
  if (ev.lethal) flags |= 16;
  buf[3] = flags;
  buf[4] = Math.min(255, Math.round(ev.damage * 2));
  view.setInt16(5, clampI16((ev.point?.x || 0) * POS_SCALE), true);
  buf[7] = Math.max(0, Math.min(255, Math.round((ev.point?.y || 0) * 80)));
  view.setInt16(8, clampI16((ev.point?.z || 0) * POS_SCALE), true);
  buf[10] = 0;
  return buf;
}

export function decodeEvent(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = buf[3];
  return {
    type: 'hit',
    defender: buf[1],
    part: PARTS[buf[2]] || 'torso',
    blocked: !!(flags & 1),
    parried: !!(flags & 2),
    critical: !!(flags & 4),
    guardBreak: !!(flags & 8),
    lethal: !!(flags & 16),
    damage: buf[4] / 2,
    point: {
      x: view.getInt16(5, true) / POS_SCALE,
      y: buf[7] / 80,
      z: view.getInt16(8, true) / POS_SCALE,
    },
  };
}

// ---------------------------------------------------------------------------
// 配裝同步
// ---------------------------------------------------------------------------

// 新材質一律「往後append」：封包裡存的是索引，改動既有順序會讓
// 新舊版本互相解讀成錯的材質。
const MAT_LIST = ['none', 'cloth', 'leather', 'chainmail', 'iron', 'gold', 'diamond', 'netherite',
  'powerRed', 'powerGold'];

/**
 * 「沒有披風」的哨兵色。封包的顏色欄位是固定 3 bytes，沒辦法表達「無」，
 * 而 #010101 這種顏色實際上選不出來，拿來當哨兵最安全。
 * 沒有這個的話，鋼鐵俠（無披風）同步到對面會長出一件灰披風。
 */
const NO_CAPE = '#010101';
const SLOT_LIST = ['helmet', 'chestplate', 'pauldrons', 'vambraces', 'gauntlets', 'belt', 'leggings', 'boots'];

/** 配裝封包：8 護甲 + 武器 + 副手 + 4 組顏色 + 名字。 */
export function encodeLoadout(playerId, cfg, weaponKeys, offhandKeys, name = '') {
  const nameBytes = new TextEncoder().encode(name.slice(0, 12));
  const buf = new Uint8Array(13 + 12 + 1 + nameBytes.length);
  buf[0] = MSG.LOADOUT;
  buf[1] = playerId & 255;
  for (let i = 0; i < SLOT_LIST.length; i++) {
    const mat = (cfg.armor || {})[SLOT_LIST[i]] || 'none';
    buf[2 + i] = Math.max(0, MAT_LIST.indexOf(mat));
  }
  buf[10] = Math.max(0, weaponKeys.indexOf(cfg.weapon));
  buf[11] = Math.max(0, offhandKeys.indexOf(cfg.offhand));
  buf[12] = PROTOCOL_VERSION;
  const skin = cfg.skin || {};
  const colors = [skin.skin, skin.shirt, skin.pants, skin.cape || NO_CAPE];
  let o = 13;
  for (const c of colors) {
    const v = parseInt((c || '#888888').slice(1), 16);
    buf[o++] = (v >> 16) & 255;
    buf[o++] = (v >> 8) & 255;
    buf[o++] = v & 255;
  }
  buf[o++] = nameBytes.length;
  buf.set(nameBytes, o);
  return buf;
}

export function decodeLoadout(buf, weaponKeys, offhandKeys) {
  const armor = {};
  for (let i = 0; i < SLOT_LIST.length; i++) {
    const mat = MAT_LIST[buf[2 + i]] || 'none';
    if (mat !== 'none') armor[SLOT_LIST[i]] = mat;
  }
  const hex = (o) => '#' + [buf[o], buf[o + 1], buf[o + 2]]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
  const nameLen = buf[25] || 0;
  const name = nameLen ? new TextDecoder().decode(buf.subarray(26, 26 + nameLen)) : '';
  return {
    playerId: buf[1],
    version: buf[12],
    name,
    config: {
      armor,
      weapon: weaponKeys[buf[10]] || weaponKeys[0],
      offhand: offhandKeys[buf[11]] || offhandKeys[0],
      skin: {
        skin: hex(13), shirt: hex(16), pants: hex(19),
        cape: hex(22) === NO_CAPE ? '' : hex(22),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 分片：讓任意長度的訊息能過 20 bytes 的管道
// ---------------------------------------------------------------------------

const FRAG_MAGIC = 0xf0;

/** 把一則訊息切成數個 <= mtu 的片段。 */
export function fragment(msg, mtu = DEFAULT_MTU) {
  if (msg.length <= mtu) return [msg];
  const chunkSize = mtu - 3;                    // magic + idx + count
  const count = Math.ceil(msg.length / chunkSize);
  const out = [];
  for (let i = 0; i < count; i++) {
    const part = msg.subarray(i * chunkSize, Math.min(msg.length, (i + 1) * chunkSize));
    const frame = new Uint8Array(3 + part.length);
    frame[0] = FRAG_MAGIC;
    frame[1] = i;
    frame[2] = count;
    frame.set(part, 3);
    out.push(frame);
  }
  return out;
}

/** 分片重組器。餵進每個收到的片段，完整時回傳訊息，否則 null。 */
export class Reassembler {
  constructor() { this.parts = []; this.expect = 0; }
  push(frame) {
    if (frame[0] !== FRAG_MAGIC) return frame;   // 沒分片就直接放行
    const idx = frame[1], count = frame[2];
    if (idx === 0) { this.parts = []; this.expect = count; }
    this.parts[idx] = frame.subarray(3);
    if (this.parts.filter(Boolean).length !== this.expect || this.expect === 0) return null;
    const total = this.parts.reduce((a, p) => a + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    this.parts = []; this.expect = 0;
    return out;
  }
}

/** 握手封包。 */
export function encodeHello(role, seed) {
  const buf = new Uint8Array(5);
  const view = new DataView(buf.buffer);
  buf[0] = MSG.HELLO;
  buf[1] = PROTOCOL_VERSION;
  buf[2] = role;              // 0 = host, 1 = guest
  view.setUint16(3, seed & 0xffff, true);
  return buf;
}

export function decodeHello(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { version: buf[1], role: buf[2], seed: view.getUint16(3, true) };
}

export function encodeRound(state, roundNo, winner, timeLeft) {
  return new Uint8Array([MSG.ROUND, state, roundNo, winner & 255, Math.min(255, Math.round(timeLeft))]);
}

export function decodeRound(buf) {
  return { state: buf[1], roundNo: buf[2], winner: buf[3], timeLeft: buf[4] };
}

export const ROUND_STATE = { WAITING: 0, COUNTDOWN: 1, FIGHTING: 2, OVER: 3 };
