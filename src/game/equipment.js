// 裝備資料表：材質分級、每個部位的護甲、武器種類。
// 全部是純資料 + 純函式，Node 端測試可以直接引用。

/** 護甲材質分級。defense = 傷害減免係數，weight 影響移動與體力。 */
export const MATERIALS = {
  cloth:     { name: '布衣',   color: '#8d7f6a', trim: '#6b5f4d', defense: 0.04, weight: 0.4, durability: 60 },
  leather:   { name: '皮革',   color: '#8a5a35', trim: '#5f3d22', defense: 0.09, weight: 1.0, durability: 120 },
  chainmail: { name: '鎖子甲', color: '#9aa3ad', trim: '#6d747d', defense: 0.15, weight: 1.8, durability: 200 },
  iron:      { name: '鐵',     color: '#c9ced6', trim: '#8a9098', defense: 0.22, weight: 2.6, durability: 300 },
  gold:      { name: '黃金',   color: '#e6c14b', trim: '#a8862a', defense: 0.17, weight: 2.2, durability: 160 },
  diamond:   { name: '鑽石',   color: '#4fe3d0', trim: '#2b9c92', defense: 0.30, weight: 3.0, durability: 520 },
  netherite: { name: '獄髓',   color: '#4a4249', trim: '#2c262c', defense: 0.36, weight: 3.6, durability: 800 },
};

/**
 * 護甲部位。bones = 這件裝備會包住哪些骨頭，inflate = 各軸向外膨脹多少（公尺）。
 * covers = 這件裝備保護哪些受擊部位（受擊部位見 rig.js 的 hitParts）。
 */
export const ARMOR_SLOTS = {
  helmet: {
    name: '頭盔', bones: ['head'], covers: ['head'],
    inflate: { x: 0.06, y: 0.05, z: 0.06 }, share: 0.30, weightMul: 1.0,
  },
  chestplate: {
    name: '胸甲', bones: ['torso'], covers: ['torso'],
    inflate: { x: 0.07, y: 0.03, z: 0.07 }, share: 0.40, weightMul: 1.6,
  },
  pauldrons: {
    name: '護肩', bones: ['armRUpper', 'armLUpper'], covers: ['armR', 'armL'],
    inflate: { x: 0.07, y: 0.02, z: 0.07 }, share: 0.12, weightMul: 0.7,
  },
  vambraces: {
    name: '護臂', bones: ['armRLower', 'armLLower'], covers: ['armR', 'armL'],
    inflate: { x: 0.055, y: 0.02, z: 0.055 }, share: 0.08, weightMul: 0.4,
  },
  gauntlets: {
    name: '手甲', bones: ['handR', 'handL'], covers: ['armR', 'armL'],
    inflate: { x: 0.05, y: 0.04, z: 0.05 }, share: 0.05, weightMul: 0.3,
  },
  belt: {
    name: '腰甲', bones: ['hips'], covers: ['torso'],
    inflate: { x: 0.06, y: 0.03, z: 0.06 }, share: 0.10, weightMul: 0.5,
  },
  leggings: {
    name: '護腿', bones: ['legRUpper', 'legLUpper', 'legRLower', 'legLLower'], covers: ['legR', 'legL'],
    inflate: { x: 0.055, y: 0.02, z: 0.055 }, share: 0.18, weightMul: 1.1,
  },
  boots: {
    name: '靴子', bones: ['footR', 'footL'], covers: ['legR', 'legL'],
    inflate: { x: 0.05, y: 0.04, z: 0.04 }, share: 0.07, weightMul: 0.5,
  },
};

/** 武器：reach 是刃長，各動作的時間單位是秒。 */
export const WEAPONS = {
  dagger: {
    name: '匕首', kind: 'dagger',
    blade: { length: 0.42, width: 0.05, thick: 0.018 },
    hilt: { length: 0.14, width: 0.055 },
    damage: 11, weight: 0.5, guard: 0.35,
    speed: 1.45,           // 動作播放倍率，越高越快
    poise: 0.35,           // 命中時造成的硬直權重
    color: '#c9ced6', gripColor: '#5a4433', pommel: '#d9b44a',
    moves: ['slashR', 'slashL', 'thrust', 'thrust'],
  },
  sword: {
    name: '鐵劍', kind: 'sword',
    blade: { length: 0.82, width: 0.075, thick: 0.024 },
    hilt: { length: 0.2, width: 0.07 },
    damage: 18, weight: 1.2, guard: 0.6,
    speed: 1.0, poise: 0.6,
    color: '#d5dae2', gripColor: '#4d3a2a', pommel: '#c9a227',
    moves: ['slashR', 'slashL', 'overhead', 'thrust'],
  },
  longsword: {
    name: '長劍', kind: 'longsword',
    blade: { length: 1.02, width: 0.08, thick: 0.026 },
    hilt: { length: 0.26, width: 0.075 },
    damage: 22, weight: 1.8, guard: 0.7,
    speed: 0.88, poise: 0.8,
    color: '#dfe6ef', gripColor: '#3b2f4a', pommel: '#b9c3d0',
    moves: ['slashR', 'slashL', 'overhead', 'thrust'],
  },
  greatsword: {
    name: '巨劍', kind: 'greatsword',
    blade: { length: 1.25, width: 0.115, thick: 0.034 },
    hilt: { length: 0.32, width: 0.085 },
    damage: 31, weight: 3.2, guard: 0.85,
    speed: 0.68, poise: 1.3,
    color: '#b9c2cc', gripColor: '#2f2622', pommel: '#8b6a2f',
    moves: ['slashR', 'slashL', 'overhead'],
  },
  rapier: {
    name: '細劍', kind: 'rapier',
    blade: { length: 0.95, width: 0.038, thick: 0.02 },
    hilt: { length: 0.18, width: 0.09 },
    damage: 15, weight: 0.8, guard: 0.5,
    speed: 1.25, poise: 0.4,
    color: '#e8edf5', gripColor: '#6a2233', pommel: '#d0d6de',
    moves: ['thrust', 'thrust', 'slashR', 'slashL'],
  },
  netheriteBlade: {
    name: '獄髓劍', kind: 'sword',
    blade: { length: 0.9, width: 0.085, thick: 0.028 },
    hilt: { length: 0.22, width: 0.075 },
    damage: 26, weight: 1.6, guard: 0.75,
    speed: 1.0, poise: 0.9,
    color: '#5b5159', gripColor: '#2a2226', pommel: '#e0762f',
    moves: ['slashR', 'slashL', 'overhead', 'thrust'],
  },
};

/** 副手：盾牌與空手。 */
export const OFFHANDS = {
  none:      { name: '空手', kind: 'none', block: 0, weight: 0, stability: 0 },
  buckler:   { name: '小圓盾', kind: 'shield', block: 0.55, weight: 0.9, stability: 0.5,
               size: { x: 0.42, y: 0.42, z: 0.07 }, color: '#8a5a35', boss: '#c9ced6' },
  kite:      { name: '鳶盾',   kind: 'shield', block: 0.75, weight: 1.9, stability: 0.8,
               size: { x: 0.5, y: 0.78, z: 0.08 }, color: '#3f5f8a', boss: '#d9b44a' },
  tower:     { name: '塔盾',   kind: 'shield', block: 0.9, weight: 3.4, stability: 1.0,
               size: { x: 0.58, y: 1.0, z: 0.09 }, color: '#4a4a52', boss: '#c9ced6' },
};

/** 預設載入的幾套配裝，選單直接用。 */
export const LOADOUT_PRESETS = {
  knight: {
    name: '重裝騎士',
    armor: { helmet: 'iron', chestplate: 'iron', pauldrons: 'iron', vambraces: 'chainmail',
             gauntlets: 'iron', belt: 'chainmail', leggings: 'iron', boots: 'iron' },
    weapon: 'sword', offhand: 'kite',
    skin: { skin: '#c99b70', shirt: '#3f5f8a', pants: '#37405a', cape: '#8a2b3f' },
  },
  duelist: {
    name: '決鬥家',
    armor: { helmet: 'leather', chestplate: 'chainmail', pauldrons: 'leather', vambraces: 'leather',
             gauntlets: 'leather', belt: 'leather', leggings: 'leather', boots: 'leather' },
    weapon: 'rapier', offhand: 'buckler',
    skin: { skin: '#e0b98f', shirt: '#6a2233', pants: '#2b2b33', cape: '#d9b44a' },
  },
  berserker: {
    name: '狂戰士',
    armor: { helmet: 'none', chestplate: 'leather', pauldrons: 'iron', vambraces: 'iron',
             gauntlets: 'leather', belt: 'leather', leggings: 'cloth', boots: 'leather' },
    weapon: 'greatsword', offhand: 'none',
    skin: { skin: '#b8825c', shirt: '#5a2f22', pants: '#4a3a28', cape: '#2f2622' },
  },
  shadow: {
    name: '暗影刺客',
    armor: { helmet: 'leather', chestplate: 'leather', pauldrons: 'cloth', vambraces: 'leather',
             gauntlets: 'leather', belt: 'cloth', leggings: 'leather', boots: 'leather' },
    weapon: 'dagger', offhand: 'buckler',
    skin: { skin: '#a8845f', shirt: '#22242e', pants: '#1b1d24', cape: '#3a2f4a' },
  },
  netherlord: {
    name: '獄髓領主',
    armor: { helmet: 'netherite', chestplate: 'netherite', pauldrons: 'netherite', vambraces: 'netherite',
             gauntlets: 'netherite', belt: 'netherite', leggings: 'netherite', boots: 'netherite' },
    weapon: 'netheriteBlade', offhand: 'tower',
    skin: { skin: '#8a6a4a', shirt: '#2c262c', pants: '#241f24', cape: '#e0762f' },
  },
  champion: {
    name: '鑽石鬥士',
    armor: { helmet: 'diamond', chestplate: 'diamond', pauldrons: 'diamond', vambraces: 'iron',
             gauntlets: 'iron', belt: 'iron', leggings: 'diamond', boots: 'diamond' },
    weapon: 'longsword', offhand: 'kite',
    skin: { skin: '#d6a97e', shirt: '#2e6a63', pants: '#26424a', cape: '#4fe3d0' },
  },
};

/**
 * 把一組配裝算成戰鬥數值。
 * 回傳每個受擊部位的減傷、總重量、移動與體力修正。
 */
export function buildLoadout(config) {
  const armor = config.armor || {};
  const weapon = WEAPONS[config.weapon] || WEAPONS.sword;
  const offhand = OFFHANDS[config.offhand] || OFFHANDS.none;

  const partDefense = { head: 0, torso: 0, armR: 0, armL: 0, legR: 0, legL: 0 };
  const pieces = {};
  let armorWeight = 0;

  for (const [slot, spec] of Object.entries(ARMOR_SLOTS)) {
    const matKey = armor[slot];
    if (!matKey || matKey === 'none') continue;
    const mat = MATERIALS[matKey];
    if (!mat) continue;
    pieces[slot] = {
      slot, material: matKey, color: mat.color, trim: mat.trim,
      durability: mat.durability, maxDurability: mat.durability,
    };
    armorWeight += mat.weight * spec.weightMul;
    for (const part of spec.covers) {
      // 同部位多件裝備採遞減疊加，避免堆滿變成無敵
      partDefense[part] = 1 - (1 - partDefense[part]) * (1 - mat.defense);
    }
  }

  const totalWeight = armorWeight + weapon.weight + offhand.weight;
  // 重量 -> 移動/體力修正（重甲慢但耐打）
  const moveMul = Math.max(0.55, 1.12 - totalWeight * 0.030);
  const staminaMul = Math.max(0.55, 1.10 - totalWeight * 0.026);
  const attackSpeed = weapon.speed * Math.max(0.7, 1.06 - totalWeight * 0.014);

  return {
    config: { ...config },
    weapon, offhand, pieces, partDefense,
    weight: totalWeight,
    moveMul, staminaMul, attackSpeed,
    maxHealth: 100,
    maxStamina: 100,
    // 總體防禦力，只拿來顯示
    ratingDefense: Math.round(
      (partDefense.head * 0.30 + partDefense.torso * 0.40 +
       (partDefense.armR + partDefense.armL) * 0.06 +
       (partDefense.legR + partDefense.legL) * 0.09) * 100),
    ratingOffense: Math.round(weapon.damage * weapon.speed),
  };
}

/** 選單用：列出所有可選材質（含「無」）。 */
export const MATERIAL_KEYS = ['none', ...Object.keys(MATERIALS)];
export const WEAPON_KEYS = Object.keys(WEAPONS);
export const OFFHAND_KEYS = Object.keys(OFFHANDS);
