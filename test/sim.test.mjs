// 無畫面模擬測試：直接跑戰鬥核心，驗證骨架、命中判定、AI 與封包編解碼。
// 執行：node test/sim.test.mjs

import { Match, MATCH_MODE } from '../src/game/match.js';
import { Fighter, checkAttackHit, emptyInput } from '../src/game/fighter.js';
import { LOADOUT_PRESETS, buildLoadout } from '../src/game/equipment.js';
import { FighterAI, DIFFICULTIES } from '../src/game/ai.js';
import { poseRig, getHitCapsules, getBladeSegment, BONES } from '../src/game/rig.js';
import { MOVES, moveReach, sweepBladeHit, resolveHit } from '../src/game/combat.js';
import {
  encodeInput, decodeInput, encodeState, decodeState, encodeEvent, decodeEvent,
  encodeLoadout, decodeLoadout, fragment, Reassembler, DEFAULT_MTU,
} from '../src/net/protocol.js';
import { WEAPON_KEYS, OFFHAND_KEYS } from '../src/game/equipment.js';

let passed = 0, failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    results.push(`  ❌ ${name}\n     ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '斷言失敗');
}
function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) > tol) throw new Error(`${msg || ''} 期望 ${b}±${tol}，實得 ${a}`);
}

console.log('\n=== 劍鬥模擬測試 ===\n');

// ---------------------------------------------------------------------------
console.log('骨架 / 裝備');
// ---------------------------------------------------------------------------

test('配裝計算出合理的防禦與重量', () => {
  const l = buildLoadout(LOADOUT_PRESETS.knight);
  assert(l.weight > 5, `重裝騎士應該很重，實得 ${l.weight}`);
  assert(l.partDefense.torso > 0.2, '胸甲要有明顯減傷');
  assert(l.partDefense.head > 0.1, '頭盔要有減傷');
  assert(l.moveMul > 0.5 && l.moveMul < 1.1, `移動修正超出合理範圍：${l.moveMul}`);
  assert(Object.keys(l.pieces).length === 8, '騎士應該有 8 件護甲');
});

test('無護甲配裝不會壞掉', () => {
  const l = buildLoadout({ armor: {}, weapon: 'dagger', offhand: 'none' });
  assert(l.partDefense.torso === 0, '沒穿甲就不該有減傷');
  assert(l.moveMul > 0.9, '輕裝應該跑很快');
});

test('骨架擺出姿勢後所有骨頭都有有效矩陣', () => {
  const f = new Fighter(0, LOADOUT_PRESETS.knight);
  f.updatePose(0.016, null);
  assert(f.rig.world.length === BONES.length, '骨頭數量不符');
  for (let i = 0; i < BONES.length; i++) {
    for (const v of f.rig.world[i]) assert(Number.isFinite(v), `骨頭 ${BONES[i].name} 矩陣有 NaN`);
  }
});

test('站立時腳底貼地、頭在合理高度', () => {
  const f = new Fighter(0, LOADOUT_PRESETS.knight);
  f.updatePose(0.016, null);
  const caps = getHitCapsules(f.rig);
  const foot = caps.find((c) => c.part === 'legR');
  const head = caps.find((c) => c.part === 'head');
  assertClose(foot.b.y, 0.05, 0.25, '腳應該接近地面');
  assert(head.b.y > 1.9 && head.b.y < 2.5, `頭頂高度異常：${head.b.y}`);
});

test('六個受擊部位都存在且不重疊在原點', () => {
  const f = new Fighter(0, LOADOUT_PRESETS.duelist);
  f.updatePose(0.016, null);
  const caps = getHitCapsules(f.rig);
  assert(caps.length === 6, `應該有 6 個部位，實得 ${caps.length}`);
  const parts = new Set(caps.map((c) => c.part));
  for (const p of ['head', 'torso', 'armR', 'armL', 'legR', 'legL']) {
    assert(parts.has(p), `缺少部位 ${p}`);
  }
  // 左右手要真的分在兩邊
  const ar = caps.find((c) => c.part === 'armR');
  const al = caps.find((c) => c.part === 'armL');
  assert(Math.abs(ar.a.x - al.a.x) > 0.3, '左右手應該分開');
});

test('劍刃線段長度符合武器設定', () => {
  const f = new Fighter(0, { ...LOADOUT_PRESETS.knight, weapon: 'greatsword' });
  f.updatePose(0.016, null);
  const blade = getBladeSegment(f.rig);
  const len = Math.hypot(blade.b.x - blade.a.x, blade.b.y - blade.a.y, blade.b.z - blade.a.z);
  assertClose(len, MOVES.slashR ? 1.25 : 1.25, 0.02, '刃長應該等於 blade.length');
});

// ---------------------------------------------------------------------------
console.log('戰鬥');
// ---------------------------------------------------------------------------

test('揮劍會打中正前方的對手', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 1.5, yaw: Math.PI });
  a.updatePose(0, b); b.updatePose(0, a);

  a.startAttack('slashR');
  let hit = null;
  for (let i = 0; i < 120 && !hit; i++) {
    const inp = emptyInput();
    a.update(inp, 1 / 60, b);
    b.update(inp, 1 / 60, a);
    hit = checkAttackHit(a, b);
  }
  assert(hit, '正前方 1.5 公尺的對手應該要被砍到');
  assert(hit.damage > 0, '應該造成傷害');
  assert(b.health < 100, `對手血量應該下降，實得 ${b.health}`);
});

test('距離太遠會揮空', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 6.5, yaw: Math.PI });
  a.updatePose(0, null); b.updatePose(0, null);
  a.startAttack('slashR');
  let hit = null;
  for (let i = 0; i < 100 && !hit; i++) {
    a.update(emptyInput(), 1 / 60, null);   // 不追蹤目標，避免自動走近
    b.updatePose(1 / 60, null);
    hit = checkAttackHit(a, b);
  }
  assert(!hit, '6.5 公尺外不該被砍到');
  assert(b.health === 100, '對手不該掉血');
});

test('每一招只會判定一次', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 1.4, yaw: Math.PI });
  a.updatePose(0, b); b.updatePose(0, a);
  a.startAttack('overhead');
  let hits = 0;
  for (let i = 0; i < 150; i++) {
    a.update(emptyInput(), 1 / 60, b);
    b.update(emptyInput(), 1 / 60, a);
    if (checkAttackHit(a, b)) hits++;
  }
  assert(hits === 1, `一次揮擊只該命中一次，實得 ${hits}`);
});

test('頭部傷害高於腿部', () => {
  const mk = () => [
    new Fighter(0, { armor: {}, weapon: 'sword', offhand: 'none' }, { x: 0, z: 0, yaw: 0 }),
    new Fighter(1, { armor: {}, weapon: 'sword', offhand: 'none' }, { x: 0, z: 1.3, yaw: Math.PI }),
  ];
  const dmg = {};
  for (const part of ['head', 'legR']) {
    const [a, b] = mk();
    a.updatePose(0, b); b.updatePose(0, a);
    const caps = getHitCapsules(b.rig);
    const cap = caps.find((c) => c.part === part);
    const before = b.health;
    // 直接呼叫結算，跳過幾何，只驗傷害倍率
    resolveHit(a, b, { part, label: part, mult: cap.mult, point: cap.a }, MOVES.slashR, {});
    dmg[part] = before - b.health;
  }
  assert(dmg.head > dmg.legR, `頭部應該比腿痛：頭 ${dmg.head.toFixed(1)} vs 腿 ${dmg.legR.toFixed(1)}`);
});

test('護甲確實減傷', () => {
  const naked = new Fighter(1, { armor: {}, weapon: 'sword', offhand: 'none' });
  const armored = new Fighter(1, LOADOUT_PRESETS.netherlord);
  const attacker = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
  const hit = { part: 'torso', label: '軀幹', mult: 1.0, point: { x: 0, y: 1, z: 0 } };
  resolveHit(attacker, naked, hit, MOVES.slashR, {});
  resolveHit(attacker, armored, hit, MOVES.slashR, {});
  const dNaked = 100 - naked.health;
  const dArmored = 100 - armored.health;
  assert(dArmored < dNaked * 0.8, `獄髓全套應該明顯減傷：${dArmored.toFixed(1)} vs ${dNaked.toFixed(1)}`);
});

test('格擋會減傷、完美招架完全免傷', () => {
  const mkPair = () => {
    const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
    const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 1.3, yaw: Math.PI });
    return [a, b];
  };
  const hit = { part: 'torso', label: '軀幹', mult: 1.0, point: { x: 0, y: 1, z: 0.6 } };

  const [a1, b1] = mkPair();
  const e1 = resolveHit(a1, b1, hit, MOVES.slashR, {});
  const plain = e1.damage;

  const [a2, b2] = mkPair();
  b2.blocking = true; b2.blockTimer = 1.0;   // 早就舉著盾 = 一般格擋
  const e2 = resolveHit(a2, b2, hit, MOVES.slashR, {});
  assert(e2.blocked, '應該判定為格擋');
  assert(e2.damage < plain, `格擋要減傷：${e2.damage.toFixed(1)} vs ${plain.toFixed(1)}`);

  const [a3, b3] = mkPair();
  b3.blocking = true; b3.blockTimer = 0.05;  // 剛舉盾 = 招架窗口
  const e3 = resolveHit(a3, b3, hit, MOVES.slashR, {});
  assert(e3.parried, '應該判定為招架');
  assert(e3.damage === 0, '招架應該完全免傷');
  assert(a3.stagger > 0, '招架後攻擊方應該被彈開');
});

test('背後攻擊擋不住', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: -1.3, yaw: 0 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });  // 背對 a
  b.blocking = true; b.blockTimer = 0.05;
  const e = resolveHit(a, b, { part: 'torso', label: '軀幹', mult: 1, point: { x: 0, y: 1, z: 0 } }, MOVES.slashR, {});
  assert(!e.parried && !e.blocked, '從背後打不該被擋下');
  assert(e.damage > 0, '應該吃滿傷害');
});

test('翻滾無敵時間內不會被打到', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: 0, yaw: 0 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 1.3, yaw: Math.PI });
  a.updatePose(0, b); b.updatePose(0, a);
  b.startDodge(0, 1);
  b.dodge.elapsed = 0.2;   // 落在無敵區間
  assert(b.invulnerable, '此時應該是無敵的');
  a.startAttack('slashR');
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) {
    a.update(emptyInput(), 1 / 60, b);
    hit = checkAttackHit(a, b);
    if (b.dodge) b.dodge.elapsed = 0.2;   // 凍在無敵區間
    b.updatePose(1 / 60, a);
  }
  assert(!hit, '無敵時不該被判定命中');
});

test('體力會限制連續攻擊', () => {
  const f = new Fighter(0, LOADOUT_PRESETS.berserker);
  let count = 0;
  for (let i = 0; i < 12; i++) {
    if (f.startAttack('overhead')) { count++; f.action = null; }
  }
  assert(count < 12, `體力應該撐不住 12 次巨劍重砍，實得 ${count}`);
  assert(f.stamina < 30, `體力應該見底，實得 ${f.stamina.toFixed(1)}`);
});

test('假動作只能在蓄力階段取消', () => {
  const f = new Fighter(0, LOADOUT_PRESETS.knight);
  f.startAttack('overhead');
  f.action.elapsed = 0.01;
  assert(f.feint(), '蓄力初期應該可以取消');
  f.startAttack('overhead');
  f.action.elapsed = f.action.duration * 0.9;
  assert(!f.feint(), '收招階段不該能取消');
});

// ---------------------------------------------------------------------------
console.log('AI');
// ---------------------------------------------------------------------------

test('AI 會產生合法輸入', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: -2 });
  const b = new Fighter(1, LOADOUT_PRESETS.duelist, { x: 0, z: 2 });
  a.updatePose(0, b); b.updatePose(0, a);
  const ai = new FighterAI(b, { difficulty: 'singular' });
  for (let i = 0; i < 240; i++) {
    const inp = ai.think(a, 1 / 60);
    assert(Number.isFinite(inp.moveX) && Number.isFinite(inp.moveZ), 'AI 移動輸入出現 NaN');
    assert(inp.attack >= 0 && inp.attack <= 5, `AI 送出非法攻擊代碼 ${inp.attack}`);
    b.update(inp, 1 / 60, a);
    a.update(emptyInput(), 1 / 60, b);
  }
});

test('AI 會主動接近站著不動的對手並打出傷害', () => {
  const m = new Match({
    mode: MATCH_MODE.SOLO,
    loadouts: [LOADOUT_PRESETS.knight, LOADOUT_PRESETS.duelist],
    difficulty: 'master',
    roundTime: 30,
  });
  for (let i = 0; i < 60 * 25; i++) {
    m.setInput(0, emptyInput());     // 玩家完全不動
    m.update(1 / 60);
    if (!m.player.alive) break;
  }
  assert(m.player.health < 100, `AI 25 秒內應該要打到不動的玩家，玩家還剩 ${m.player.health.toFixed(1)}`);
});

test('高難度 AI 明顯強過新手 AI', () => {
  const runDuel = (d0, d1, seed) => {
    const m = new Match({
      mode: MATCH_MODE.DEMO,
      loadouts: [LOADOUT_PRESETS.knight, LOADOUT_PRESETS.knight],
      roundTime: 60, bestOf: 1, seed,
    });
    m.ais[0].setDifficulty(d0);
    m.ais[1].setDifficulty(d1);
    for (let i = 0; i < 60 * 60 && m.state !== 3; i++) m.update(1 / 60);
    return m.fighters[0].health - m.fighters[1].health;
  };
  let score = 0;
  for (let s = 0; s < 5; s++) score += runDuel('singular', 'rookie', 1000 + s * 77);
  assert(score > 0, `超智能對新手應該整體佔優，實得血量差 ${score.toFixed(1)}`);
});

test('AI 會學習對手的出招習慣', () => {
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 2 });
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: -2 });
  const ai = new FighterAI(b, { difficulty: 'singular' });
  // 讓對手一直只用突刺
  for (let i = 0; i < 30; i++) ai.model.observeAttack('thrust', 2.0);
  const pred = ai.model.predictNext();
  const top = Object.entries(pred).sort((x, y) => y[1] - x[1])[0][0];
  assert(top === 'thrust', `AI 應該預測到對手愛突刺，實得 ${top}`);
  assert(pred.thrust > 0.5, `信心度應該夠高，實得 ${pred.thrust.toFixed(2)}`);
});

test('AI 感知有延遲，不會瞬間反應', () => {
  const a = new Fighter(0, LOADOUT_PRESETS.knight, { x: 0, z: -2 });
  const b = new Fighter(1, LOADOUT_PRESETS.knight, { x: 0, z: 2 });
  const ai = new FighterAI(b, { difficulty: 'rookie' });   // 反應 0.42 秒
  for (let i = 0; i < 20; i++) ai.think(a, 1 / 60);        // 累積 0.33 秒歷史
  a.x = 99;                                                 // 對手瞬移
  ai.think(a, 1 / 60);
  const p = ai.perceived();
  assert(Math.abs(p.x) < 50, `新手 AI 不該立刻看到瞬移後的位置（看到 x=${p.x}）`);
});

test('所有難度都能跑完一場不崩', () => {
  for (const key of Object.keys(DIFFICULTIES)) {
    const m = new Match({
      mode: MATCH_MODE.SOLO,
      loadouts: [LOADOUT_PRESETS.champion, LOADOUT_PRESETS.shadow],
      difficulty: key, roundTime: 20, bestOf: 1,
    });
    for (let i = 0; i < 60 * 25; i++) {
      m.setInput(0, { moveX: Math.sin(i / 30), moveZ: Math.cos(i / 40), attack: i % 90 === 0 ? 1 : 0, block: i % 200 < 40, dodge: false, jump: false });
      m.update(1 / 60);
    }
    for (const f of m.fighters) {
      assert(Number.isFinite(f.x) && Number.isFinite(f.health), `難度 ${key} 產生了 NaN 狀態`);
    }
  }
});

// ---------------------------------------------------------------------------
console.log('回合流程');
// ---------------------------------------------------------------------------

test('一整場三戰兩勝會正常結束', () => {
  const m = new Match({
    mode: MATCH_MODE.DEMO,
    loadouts: [LOADOUT_PRESETS.berserker, LOADOUT_PRESETS.shadow],
    roundTime: 25, bestOf: 3, seed: 4242,
  });
  let guard = 0;
  while (!m.matchOver && guard < 60 * 60 * 5) { m.update(1 / 60); guard++; }
  assert(m.matchOver, '五分鐘內應該分出勝負');
  assert(m.wins[0] === 2 || m.wins[1] === 2, `三戰兩勝比數異常：${m.wins}`);
  assert(m.finalWinner === 0 || m.finalWinner === 1, '應該有最終勝者');
});

test('回合結束後雙方會復原', () => {
  const m = new Match({
    mode: MATCH_MODE.DEMO,
    loadouts: [LOADOUT_PRESETS.knight, LOADOUT_PRESETS.knight],
    roundTime: 8, bestOf: 5, seed: 99,
  });
  for (let i = 0; i < 60 * 15; i++) m.update(1 / 60);
  assert(m.roundNo >= 2, '應該至少進到第二回合');
  if (m.state === 2) {
    assert(m.fighters[0].health > 0 && m.fighters[1].health > 0, '新回合應該滿血開打');
  }
});

// ---------------------------------------------------------------------------
console.log('連線協定');
// ---------------------------------------------------------------------------

test('輸入封包來回一致', () => {
  const input = { moveX: 0.7, moveZ: -0.7, attack: 3, block: true, dodge: false, jump: true };
  const buf = encodeInput(42, input);
  assert(buf.length === 4, `輸入封包應該是 4 bytes，實得 ${buf.length}`);
  const out = emptyInput();
  const seq = decodeInput(buf, out);
  assert(seq === 42, '序號不符');
  assert(out.attack === 3, '攻擊代碼不符');
  assert(out.block === true && out.jump === true && out.dodge === false, '按鍵不符');
  assertClose(Math.atan2(out.moveX, out.moveZ), Math.atan2(0.7, -0.7), 0.25, '移動方向誤差過大');
});

test('狀態封包塞得進 BLE 的 20 bytes', () => {
  const fs = [
    new Fighter(0, LOADOUT_PRESETS.knight, { x: 3.5, z: -2.25, yaw: 1.2 }),
    new Fighter(1, LOADOUT_PRESETS.duelist, { x: -1.5, z: 4.0, yaw: 3.0 }),
  ];
  fs[0].health = 63.5; fs[0].stamina = 41; fs[0].blocking = true;
  const buf = encodeState(17, fs);
  assert(buf.length <= DEFAULT_MTU, `狀態封包 ${buf.length} bytes 超過 MTU ${DEFAULT_MTU}`);
  const dec = decodeState(buf, 2);
  assert(dec.tick === 17, 'tick 不符');
  assertClose(dec.fighters[0].x, 3.5, 0.02, 'x 量化誤差過大');
  assertClose(dec.fighters[0].z, -2.25, 0.02, 'z 量化誤差過大');
  assertClose(dec.fighters[0].yaw, 1.2, 0.05, 'yaw 量化誤差過大');
  assertClose(dec.fighters[0].health, 63.5, 0.5, '血量量化誤差過大');
  assert(dec.fighters[0].blocking === true, '格擋旗標遺失');
  assertClose(dec.fighters[1].z, 4.0, 0.02, '第二位戰士座標錯誤');
});

test('命中事件封包來回一致', () => {
  const ev = {
    defender: 1, part: 'head', blocked: false, parried: false, critical: true,
    guardBreak: false, lethal: true, damage: 37.5, point: { x: 1.25, y: 1.9, z: -3.5 },
  };
  const dec = decodeEvent(encodeEvent(ev));
  assert(dec.part === 'head', '部位不符');
  assert(dec.critical && dec.lethal && !dec.blocked, '旗標不符');
  assertClose(dec.damage, 37.5, 0.5, '傷害不符');
  assertClose(dec.point.x, 1.25, 0.02, '命中點 x 不符');
  assertClose(dec.point.z, -3.5, 0.02, '命中點 z 不符');
});

test('配裝封包完整同步（含顏色與名字）', () => {
  const cfg = LOADOUT_PRESETS.netherlord;
  const buf = encodeLoadout(1, cfg, WEAPON_KEYS, OFFHAND_KEYS, '獄髓王');
  const dec = decodeLoadout(buf, WEAPON_KEYS, OFFHAND_KEYS);
  assert(dec.config.weapon === cfg.weapon, `武器不符：${dec.config.weapon}`);
  assert(dec.config.offhand === cfg.offhand, '副手不符');
  assert(dec.config.armor.chestplate === 'netherite', '胸甲材質不符');
  assert(Object.keys(dec.config.armor).length === 8, '護甲件數不符');
  assert(dec.config.skin.cape === cfg.skin.cape.toLowerCase(), `披風顏色不符：${dec.config.skin.cape}`);
  assert(dec.name === '獄髓王', `名字不符：${dec.name}`);
  // 解碼後要能真的建出配裝
  const l = buildLoadout(dec.config);
  assert(l.partDefense.torso > 0.3, '重建的配裝防禦不對');
});

test('超過 MTU 的訊息能分片重組', () => {
  const cfg = LOADOUT_PRESETS.champion;
  const msg = encodeLoadout(0, cfg, WEAPON_KEYS, OFFHAND_KEYS, '鑽石鬥士');
  assert(msg.length > DEFAULT_MTU, '這個測試需要一則超過 MTU 的訊息');
  const parts = fragment(msg, DEFAULT_MTU);
  assert(parts.length > 1, '應該被切成多片');
  for (const p of parts) assert(p.length <= DEFAULT_MTU, `分片 ${p.length} bytes 超過 MTU`);
  const re = new Reassembler();
  let out = null;
  for (const p of parts) out = re.push(p) || out;
  assert(out, '重組失敗');
  assert(out.length === msg.length, `重組長度不符：${out.length} vs ${msg.length}`);
  for (let i = 0; i < msg.length; i++) assert(out[i] === msg[i], `第 ${i} byte 不符`);
});

test('沒分片的小訊息直接放行', () => {
  const re = new Reassembler();
  const small = encodeInput(1, emptyInput());
  const out = re.push(small);
  assert(out === small, '小訊息應該原樣通過');
});

// ---------------------------------------------------------------------------
console.log('\n' + results.join('\n'));
console.log(`\n總計：${passed} 通過 / ${failed} 失敗\n`);
process.exit(failed ? 1 : 0);
