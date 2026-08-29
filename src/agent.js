// Double DQN agent：靠自己在環境裡試錯，把經驗存進回放池，
// 反覆用時序差分（TD）誤差修正神經網路 —— 沒有任何人類示範資料。
import { MLP, huber, makeRng } from './nn.js';

const DEFAULTS = {
  hidden: [128, 96],
  lr: 5e-4,
  gamma: 0.97,
  batchSize: 32,
  bufferSize: 50000,
  learnStart: 1000, // 先隨機探索累積經驗
  trainEvery: 2, // 每 N 個環境步做一次梯度更新
  targetSync: 750, // 每 N 次更新同步目標網路
  epsStart: 1.0,
  epsEnd: 0.05,
  epsDecaySteps: 25000,
  gradClip: 5,
  seed: 1,
};

/** 環狀經驗回放池，用 typed array 存以節省記憶體 */
class ReplayBuffer {
  constructor(capacity, obsSize, rng) {
    this.capacity = capacity;
    this.obsSize = obsSize;
    this.rng = rng;
    this.s = new Float32Array(capacity * obsSize);
    this.s2 = new Float32Array(capacity * obsSize);
    this.a = new Uint8Array(capacity);
    this.r = new Float32Array(capacity);
    this.d = new Uint8Array(capacity);
    this.size = 0;
    this.pos = 0;
  }

  add(s, a, r, s2, done) {
    const o = this.pos * this.obsSize;
    this.s.set(s, o);
    this.s2.set(s2, o);
    this.a[this.pos] = a;
    this.r[this.pos] = r;
    this.d[this.pos] = done ? 1 : 0;
    this.pos = (this.pos + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  sample(n, out) {
    for (let k = 0; k < n; k++) {
      const idx = Math.floor(this.rng() * this.size);
      const src = idx * this.obsSize;
      out.s.set(this.s.subarray(src, src + this.obsSize), k * this.obsSize);
      out.s2.set(this.s2.subarray(src, src + this.obsSize), k * this.obsSize);
      out.a[k] = this.a[idx];
      out.r[k] = this.r[idx];
      out.d[k] = this.d[idx];
    }
    return out;
  }
}

export class DQNAgent {
  constructor(obsSize, numActions, opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.obsSize = obsSize;
    this.numActions = numActions;
    this.rng = makeRng(this.cfg.seed);

    const sizes = [obsSize, ...this.cfg.hidden, numActions];
    this.online = new MLP(sizes, { seed: this.cfg.seed });
    this.target = new MLP(sizes, { seed: this.cfg.seed + 1 });
    this.target.copyFrom(this.online, 1);

    this.buffer = new ReplayBuffer(this.cfg.bufferSize, obsSize, this.rng);
    const B = this.cfg.batchSize;
    this.batch = {
      s: new Float64Array(B * obsSize),
      s2: new Float64Array(B * obsSize),
      a: new Uint8Array(B),
      r: new Float32Array(B),
      d: new Uint8Array(B),
    };
    this._target = new Float64Array(B * numActions);
    this._one = new Float64Array(obsSize);

    this.steps = 0;
    this.updates = 0;
    this.lastLoss = 0;
    this.lastQ = null;
  }

  get epsilon() {
    const { epsStart, epsEnd, epsDecaySteps } = this.cfg;
    const t = Math.min(1, this.steps / epsDecaySteps);
    return epsStart + (epsEnd - epsStart) * t;
  }

  /** 回傳目前狀態下每個動作的 Q 值（給視覺化用） */
  qValues(obs) {
    this._one.set(obs);
    const q = this.online.forward(this._one, 1);
    return Float64Array.from(q);
  }

  /** ε-greedy：一部分照經驗走，一部分亂試 —— 探索與利用的平衡 */
  act(obs, greedy = false) {
    const q = this.qValues(obs);
    this.lastQ = q;
    if (!greedy && this.rng() < this.epsilon) {
      return Math.floor(this.rng() * this.numActions);
    }
    let best = 0;
    for (let i = 1; i < this.numActions; i++) if (q[i] > q[best]) best = i;
    return best;
  }

  remember(s, a, r, s2, done) {
    this.buffer.add(s, a, r, s2, done);
    this.steps++;
  }

  get ready() {
    return this.buffer.size >= Math.max(this.cfg.learnStart, this.cfg.batchSize);
  }

  /** 走一步之後呼叫，時機到了才真的做梯度更新 */
  maybeLearn() {
    if (!this.ready) return null;
    if (this.steps % this.cfg.trainEvery !== 0) return null;
    return this.learn();
  }

  /** 一次 Double DQN 更新 */
  learn() {
    const B = this.cfg.batchSize;
    const nA = this.numActions;
    const b = this.buffer.sample(B, this.batch);

    // 1) 線上網路選動作，目標網路評估價值（Double DQN，減少高估）
    const qNextOnline = Float64Array.from(this.online.forward(b.s2, B));
    const qNextTarget = Float64Array.from(this.target.forward(b.s2, B));

    // 2) 線上網路對當前狀態的預測
    const qPred = this.online.forward(b.s, B);
    this._target.set(qPred); // 未選到的動作梯度為 0

    for (let k = 0; k < B; k++) {
      const off = k * nA;
      let bestA = 0;
      for (let i = 1; i < nA; i++) if (qNextOnline[off + i] > qNextOnline[off + bestA]) bestA = i;
      const bootstrap = b.d[k] ? 0 : this.cfg.gamma * qNextTarget[off + bestA];
      this._target[off + b.a[k]] = b.r[k] + bootstrap;
    }

    const { loss, grad } = huber(qPred, this._target, B);
    this.online.zeroGrad();
    this.online.backward(grad, B);
    this.online.clipGradients(this.cfg.gradClip);
    this.online.step(this.cfg.lr);

    this.updates++;
    if (this.updates % this.cfg.targetSync === 0) this.target.copyFrom(this.online, 1);
    this.lastLoss = loss;
    return loss;
  }

  toJSON() {
    return {
      version: 1,
      obsSize: this.obsSize,
      numActions: this.numActions,
      cfg: this.cfg,
      steps: this.steps,
      updates: this.updates,
      net: this.online.toJSON(),
    };
  }

  static fromJSON(obj) {
    const agent = new DQNAgent(obj.obsSize, obj.numActions, obj.cfg);
    agent.online = MLP.fromJSON(obj.net);
    agent.target = MLP.fromJSON(obj.net);
    agent.steps = obj.steps || 0;
    agent.updates = obj.updates || 0;
    return agent;
  }

  loadWeights(obj) {
    const net = MLP.fromJSON(obj.net || obj);
    this.online = net;
    this.target = MLP.fromJSON(obj.net || obj);
    this.steps = obj.steps || this.steps;
    this.updates = obj.updates || this.updates;
  }
}
