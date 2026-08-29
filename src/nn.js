// 從零手寫的神經網路：矩陣運算、反向傳播、Adam 最佳化。
// 沒有任何外部相依，Node 與瀏覽器都能直接 import。

/** mulberry32：可重現的偽亂數產生器 */
export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 標準常態分佈取樣（Box–Muller） */
export function randn(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const ACT = {
  relu: {
    f: (z) => (z > 0 ? z : 0),
    df: (z, a) => (z > 0 ? 1 : 0),
  },
  tanh: {
    f: (z) => Math.tanh(z),
    df: (z, a) => 1 - a * a,
  },
  linear: {
    f: (z) => z,
    df: () => 1,
  },
};

/**
 * 全連接層。權重以 row-major 存放：W[o * nin + i]
 * 前向與反向都以 batch 為單位處理，X 為攤平的 [B, nin]。
 */
export class Dense {
  constructor(nin, nout, act = 'relu', rng = Math.random) {
    this.nin = nin;
    this.nout = nout;
    this.actName = act;
    this.act = ACT[act];
    if (!this.act) throw new Error(`未知的激活函數: ${act}`);

    this.W = new Float64Array(nout * nin);
    this.b = new Float64Array(nout);
    // He 初始化給 relu，Xavier 給其它
    const scale =
      act === 'relu' ? Math.sqrt(2 / nin) : Math.sqrt(1 / nin);
    for (let k = 0; k < this.W.length; k++) this.W[k] = randn(rng) * scale;

    this.gW = new Float64Array(nout * nin);
    this.gb = new Float64Array(nout);

    // Adam 狀態
    this.mW = new Float64Array(nout * nin);
    this.vW = new Float64Array(nout * nin);
    this.mb = new Float64Array(nout);
    this.vb = new Float64Array(nout);

    // 前向過程的快取（反向傳播需要），依 batch 大小分開存放
    this.cache = new Map();
  }

  /** 依 batch 大小快取暫存區，避免每次呼叫都重新配置記憶體 */
  _buf(B) {
    let c = this.cache.get(B);
    if (!c) {
      c = {
        Z: new Float64Array(B * this.nout),
        A: new Float64Array(B * this.nout),
        dX: new Float64Array(B * this.nin),
        X: null,
      };
      this.cache.set(B, c);
    }
    return c;
  }

  forward(X, B) {
    const { nin, nout, W, b } = this;
    const c = this._buf(B);
    const Z = c.Z;
    const A = c.A;
    const f = this.act.f;
    for (let s = 0; s < B; s++) {
      const xo = s * nin;
      const zo = s * nout;
      for (let o = 0; o < nout; o++) {
        const wo = o * nin;
        let acc = b[o];
        for (let i = 0; i < nin; i++) acc += W[wo + i] * X[xo + i];
        Z[zo + o] = acc;
        A[zo + o] = f(acc);
      }
    }
    c.X = X;
    return A;
  }

  /** dA: 損失對本層輸出的梯度 [B, nout]，回傳對輸入的梯度 [B, nin] */
  backward(dA, B) {
    const { nin, nout, W, gW, gb } = this;
    const c = this._buf(B);
    const { X, Z, A, dX } = c;
    const df = this.act.df;
    dX.fill(0);
    for (let s = 0; s < B; s++) {
      const xo = s * nin;
      const zo = s * nout;
      for (let o = 0; o < nout; o++) {
        const dz = dA[zo + o] * df(Z[zo + o], A[zo + o]);
        if (dz === 0) continue;
        const wo = o * nin;
        gb[o] += dz;
        for (let i = 0; i < nin; i++) {
          gW[wo + i] += dz * X[xo + i];
          dX[xo + i] += dz * W[wo + i];
        }
      }
    }
    return dX;
  }

  zeroGrad() {
    this.gW.fill(0);
    this.gb.fill(0);
  }
}

/** 多層感知器 */
export class MLP {
  constructor(sizes, { hiddenAct = 'relu', outputAct = 'linear', seed = 1, rng } = {}) {
    const r = rng || makeRng(seed);
    this.layers = [];
    for (let i = 0; i < sizes.length - 1; i++) {
      const isLast = i === sizes.length - 2;
      this.layers.push(
        new Dense(sizes[i], sizes[i + 1], isLast ? outputAct : hiddenAct, r)
      );
    }
    this.sizes = sizes.slice();
    this.t = 0; // Adam 的時間步
  }

  get inputSize() {
    return this.sizes[0];
  }

  get outputSize() {
    return this.sizes[this.sizes.length - 1];
  }

  /** X: 攤平的 [B, inputSize]，回傳攤平的 [B, outputSize] */
  forward(X, B = 1) {
    let out = X;
    for (const l of this.layers) out = l.forward(out, B);
    return out;
  }

  /** 單筆預測的方便寫法 */
  predict(x) {
    return this.forward(x, 1);
  }

  backward(dOut, B = 1) {
    let d = dOut;
    for (let i = this.layers.length - 1; i >= 0; i--) d = this.layers[i].backward(d, B);
    return d;
  }

  zeroGrad() {
    for (const l of this.layers) l.zeroGrad();
  }

  /** 全域梯度裁剪，避免 Q 值爆炸 */
  clipGradients(maxNorm) {
    let sum = 0;
    for (const l of this.layers) {
      for (let k = 0; k < l.gW.length; k++) sum += l.gW[k] * l.gW[k];
      for (let k = 0; k < l.gb.length; k++) sum += l.gb[k] * l.gb[k];
    }
    const norm = Math.sqrt(sum);
    if (norm <= maxNorm || norm === 0) return norm;
    const s = maxNorm / norm;
    for (const l of this.layers) {
      for (let k = 0; k < l.gW.length; k++) l.gW[k] *= s;
      for (let k = 0; k < l.gb.length; k++) l.gb[k] *= s;
    }
    return norm;
  }

  /** Adam 更新一步 */
  step(lr = 1e-3, { beta1 = 0.9, beta2 = 0.999, eps = 1e-8 } = {}) {
    this.t++;
    const bc1 = 1 - Math.pow(beta1, this.t);
    const bc2 = 1 - Math.pow(beta2, this.t);
    for (const l of this.layers) {
      adam(l.W, l.gW, l.mW, l.vW, lr, beta1, beta2, eps, bc1, bc2);
      adam(l.b, l.gb, l.mb, l.vb, lr, beta1, beta2, eps, bc1, bc2);
    }
  }

  /** 軟更新（Polyak）：把 other 的權重混入自己，tau=1 等於直接複製 */
  copyFrom(other, tau = 1) {
    for (let i = 0; i < this.layers.length; i++) {
      const a = this.layers[i];
      const b = other.layers[i];
      for (let k = 0; k < a.W.length; k++) a.W[k] = tau * b.W[k] + (1 - tau) * a.W[k];
      for (let k = 0; k < a.b.length; k++) a.b[k] = tau * b.b[k] + (1 - tau) * a.b[k];
    }
  }

  toJSON() {
    return {
      sizes: this.sizes,
      acts: this.layers.map((l) => l.actName),
      t: this.t,
      layers: this.layers.map((l) => ({
        W: Array.from(l.W),
        b: Array.from(l.b),
      })),
    };
  }

  static fromJSON(obj) {
    const net = new MLP(obj.sizes, {
      hiddenAct: obj.acts[0] || 'relu',
      outputAct: obj.acts[obj.acts.length - 1] || 'linear',
    });
    net.t = obj.t || 0;
    obj.layers.forEach((src, i) => {
      net.layers[i].W.set(src.W);
      net.layers[i].b.set(src.b);
    });
    return net;
  }
}

function adam(P, G, M, V, lr, b1, b2, eps, bc1, bc2) {
  for (let k = 0; k < P.length; k++) {
    const g = G[k];
    M[k] = b1 * M[k] + (1 - b1) * g;
    V[k] = b2 * V[k] + (1 - b2) * g * g;
    P[k] -= (lr * (M[k] / bc1)) / (Math.sqrt(V[k] / bc2) + eps);
  }
}

/**
 * Huber 損失（對 DQN 比 MSE 穩定）。
 * 回傳 { loss, grad }，grad 已除以 batch 大小。
 */
export function huber(pred, target, B, delta = 1) {
  const n = pred.length;
  const grad = new Float64Array(n);
  let loss = 0;
  for (let k = 0; k < n; k++) {
    const e = pred[k] - target[k];
    if (Math.abs(e) <= delta) {
      loss += 0.5 * e * e;
      grad[k] = e / B;
    } else {
      loss += delta * (Math.abs(e) - 0.5 * delta);
      grad[k] = (delta * Math.sign(e)) / B;
    }
  }
  return { loss: loss / B, grad };
}
