// MiniCraft：一個 2D 方塊世界。AI 要在這裡自己學會走路、挖礦、躲岩漿。
import { makeRng } from './nn.js';

export const TILE = {
  AIR: 0,
  BEDROCK: 1,
  WOOD: 2,
  STONE: 3,
  DIAMOND: 4,
  LAVA: 5,
};
export const NUM_TILES = 6;
export const TILE_NAMES = ['空氣', '基岩', '木頭', '石頭', '鑽石', '岩漿'];

/** 可挖掘的方塊與它們的價值 */
export const ORE_VALUE = {
  [TILE.WOOD]: 1,
  [TILE.STONE]: 2,
  [TILE.DIAMOND]: 5,
};
const ORES = [TILE.WOOD, TILE.STONE, TILE.DIAMOND];

// 動作：0 上 1 右 2 下 3 左 4 挖掘（挖面向的方塊）
export const ACTIONS = ['上', '右', '下', '左', '挖'];
export const NUM_ACTIONS = ACTIONS.length;
const DIRS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const VIEW = 5; // 以玩家為中心的 5x5 視野
const HALF = (VIEW - 1) / 2;

// 視野 one-hot + 面向 + 背包 + 進度 + 指向最近礦物的「指南針」
export const OBS_SIZE = VIEW * VIEW * NUM_TILES + 4 + 3 + 2 + 3;

const DEFAULTS = {
  width: 12,
  height: 12,
  maxSteps: 200,
  wood: 8,
  stone: 6,
  diamond: 2,
  lava: 6,
  stepCost: 0.02,
  bumpCost: 0.05,
  lavaCost: 5,
  clearBonus: 5,
  shaping: 0.05, // 基於位能的獎勵塑形（不改變最佳策略）
  seed: 12345,
};

export class MiniCraftEnv {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.rng = makeRng(this.cfg.seed);
    this.obsSize = OBS_SIZE;
    this.numActions = NUM_ACTIONS;
    this._obs = new Float64Array(OBS_SIZE);
    this.reset();
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.cfg.width || y >= this.cfg.height) return TILE.BEDROCK;
    return this.grid[y * this.cfg.width + x];
  }

  set(x, y, t) {
    this.grid[y * this.cfg.width + x] = t;
  }

  /** 每一回合都重新生成地圖，AI 必須學到通則而不是背答案 */
  reset() {
    const { width, height } = this.cfg;
    this.grid = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        this.set(x, y, edge ? TILE.BEDROCK : TILE.AIR);
      }
    }
    const free = [];
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) free.push([x, y]);
    shuffle(free, this.rng);

    let p = 0;
    const place = (n, tile) => {
      for (let i = 0; i < n && p < free.length; i++, p++) this.set(free[p][0], free[p][1], tile);
    };
    place(this.cfg.wood, TILE.WOOD);
    place(this.cfg.stone, TILE.STONE);
    place(this.cfg.diamond, TILE.DIAMOND);
    place(this.cfg.lava, TILE.LAVA);

    const spot = free[p++];
    this.px = spot[0];
    this.py = spot[1];
    this.facing = Math.floor(this.rng() * 4);
    this.steps = 0;
    this.done = false;
    this.inventory = { wood: 0, stone: 0, diamond: 0 };
    this.score = 0;
    this.oresLeft = this.cfg.wood + this.cfg.stone + this.cfg.diamond;
    this.totalOres = this.oresLeft;
    this.lastEvent = 'start';
    this._prevDist = this.nearestOreDist();
    return this.observe();
  }

  /**
   * 找出最近的礦物：回傳曼哈頓距離與相對方向。
   * 視野只有 5x5，若沒有這個「指南針」，遠處的礦物對 AI 來說等於不存在，
   * 狀態就不具馬可夫性，再怎麼訓練也只能亂走。
   */
  nearestOre() {
    let best = Infinity;
    let bx = 0;
    let by = 0;
    const { width, height } = this.cfg;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const t = this.get(x, y);
        if (ORE_VALUE[t] === undefined) continue;
        const d = Math.abs(x - this.px) + Math.abs(y - this.py);
        if (d < best) {
          best = d;
          bx = x - this.px;
          by = y - this.py;
        }
      }
    }
    if (best === Infinity) return { d: 0, dx: 0, dy: 0 };
    return { d: best, dx: bx, dy: by };
  }

  nearestOreDist() {
    return this.nearestOre().d;
  }

  /** 觀測：以自己為中心的視野 one-hot + 面向 + 背包 + 進度 */
  observe() {
    const o = this._obs;
    o.fill(0);
    let k = 0;
    for (let dy = -HALF; dy <= HALF; dy++) {
      for (let dx = -HALF; dx <= HALF; dx++) {
        o[k + this.get(this.px + dx, this.py + dy)] = 1;
        k += NUM_TILES;
      }
    }
    o[k + this.facing] = 1;
    k += 4;
    o[k++] = this.inventory.wood / Math.max(1, this.cfg.wood);
    o[k++] = this.inventory.stone / Math.max(1, this.cfg.stone);
    o[k++] = this.inventory.diamond / Math.max(1, this.cfg.diamond);
    o[k++] = 1 - this.steps / this.cfg.maxSteps;
    o[k++] = this.oresLeft / Math.max(1, this.totalOres);
    const ore = this.nearestOre();
    const norm = Math.max(1, ore.d);
    o[k++] = ore.dx / norm;
    o[k++] = ore.dy / norm;
    o[k++] = ore.d / (this.cfg.width + this.cfg.height);
    return o;
  }

  step(action) {
    if (this.done) throw new Error('回合已結束，請先呼叫 reset()');
    const cfg = this.cfg;
    let reward = -cfg.stepCost;
    this.steps++;
    this.lastEvent = '';

    if (action === 4) {
      // 挖掘面向的方塊
      const [dx, dy] = DIRS[this.facing];
      const tx = this.px + dx;
      const ty = this.py + dy;
      const t = this.get(tx, ty);
      const value = ORE_VALUE[t];
      if (value !== undefined) {
        reward += value;
        this.score += value;
        this.set(tx, ty, TILE.AIR);
        this.oresLeft--;
        if (t === TILE.WOOD) this.inventory.wood++;
        else if (t === TILE.STONE) this.inventory.stone++;
        else this.inventory.diamond++;
        this.lastEvent = `挖到${TILE_NAMES[t]}`;
      } else {
        reward -= cfg.bumpCost; // 對著空氣揮鎬子
        this.lastEvent = '空揮';
      }
    } else {
      this.facing = action;
      const [dx, dy] = DIRS[action];
      const tx = this.px + dx;
      const ty = this.py + dy;
      const t = this.get(tx, ty);
      if (t === TILE.AIR) {
        this.px = tx;
        this.py = ty;
        this.lastEvent = '移動';
      } else if (t === TILE.LAVA) {
        this.px = tx;
        this.py = ty;
        reward -= cfg.lavaCost;
        this.done = true;
        this.lastEvent = '掉進岩漿';
      } else {
        reward -= cfg.bumpCost; // 撞到方塊
        this.lastEvent = '撞牆';
      }
    }

    if (!this.done && this.oresLeft === 0) {
      reward += cfg.clearBonus;
      this.done = true;
      this.lastEvent = '全部挖完';
    }
    if (!this.done && this.steps >= cfg.maxSteps) {
      this.done = true;
      this.lastEvent = '時間到';
    }

    // 位能塑形：靠近礦物給一點點甜頭，加速學習又不改變最佳策略
    if (cfg.shaping > 0) {
      const d = this.done ? 0 : this.nearestOreDist();
      reward += cfg.shaping * (this._prevDist - d);
      this._prevDist = d;
    }

    return { obs: this.observe(), reward, done: this.done, event: this.lastEvent };
  }

  /** 終端機用的 ASCII 畫面 */
  render() {
    const chars = ['·', '#', 'W', 'S', 'D', '~'];
    const lines = [];
    for (let y = 0; y < this.cfg.height; y++) {
      let row = '';
      for (let x = 0; x < this.cfg.width; x++) {
        row += x === this.px && y === this.py ? '@' : chars[this.get(x, y)];
        row += ' ';
      }
      lines.push(row);
    }
    lines.push(
      `步數 ${this.steps}/${this.cfg.maxSteps}  分數 ${this.score}  ` +
        `木 ${this.inventory.wood} 石 ${this.inventory.stone} 鑽 ${this.inventory.diamond}  ${this.lastEvent}`
    );
    return lines.join('\n');
  }
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
