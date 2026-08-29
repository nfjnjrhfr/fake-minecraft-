// 極簡張量自動微分引擎：Transformer 需要的每個運算都自己實作前向與反向。
// 一切都是攤平的 Float64Array + shape，沒有任何外部相依。

export class Tensor {
  constructor(data, shape, requiresGrad = false) {
    this.data = data instanceof Float64Array ? data : Float64Array.from(data);
    this.shape = shape;
    this.requiresGrad = requiresGrad;
    this.grad = null;
    this._parents = [];
    this._backward = null;
  }

  get size() {
    return this.data.length;
  }

  ensureGrad() {
    if (!this.grad) this.grad = new Float64Array(this.data.length);
    return this.grad;
  }

  zeroGrad() {
    if (this.grad) this.grad.fill(0);
  }

  static zeros(shape, requiresGrad = false) {
    const n = shape.reduce((a, b) => a * b, 1);
    return new Tensor(new Float64Array(n), shape, requiresGrad);
  }

  static randn(shape, std, rng, requiresGrad = true) {
    const n = shape.reduce((a, b) => a * b, 1);
    const d = new Float64Array(n);
    for (let i = 0; i < n; i++) d[i] = gauss(rng) * std;
    return new Tensor(d, shape, requiresGrad);
  }

  static filled(shape, v, requiresGrad = true) {
    const n = shape.reduce((a, b) => a * b, 1);
    return new Tensor(new Float64Array(n).fill(v), shape, requiresGrad);
  }
}

function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** 從純量損失往回跑一次反向傳播 */
export function backward(loss) {
  const topo = [];
  const seen = new Set();
  const build = (t) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of t._parents) build(p);
    topo.push(t);
  };
  build(loss);
  loss.ensureGrad()[0] = 1;
  for (let i = topo.length - 1; i >= 0; i--) {
    if (topo[i]._backward) topo[i]._backward();
  }
}

function make(data, shape, parents, backwardFn) {
  const t = new Tensor(data, shape);
  t._parents = parents;
  t._backward = backwardFn;
  return t;
}

/** C = A[m,k] @ B[k,n] */
export function matmul(A, B) {
  const [m, k] = A.shape;
  const n = B.shape[1];
  const out = new Float64Array(m * n);
  const a = A.data;
  const b = B.data;
  for (let i = 0; i < m; i++) {
    const ao = i * k;
    const oo = i * n;
    for (let p = 0; p < k; p++) {
      const av = a[ao + p];
      if (av === 0) continue;
      const bo = p * n;
      for (let j = 0; j < n; j++) out[oo + j] += av * b[bo + j];
    }
  }
  return make(out, [m, n], [A, B], function () {
    const g = this.grad;
    if (!g) return;
    if (A.requiresGrad || A._backward) {
      const ga = A.ensureGrad();
      for (let i = 0; i < m; i++) {
        const oo = i * n;
        const ao = i * k;
        for (let p = 0; p < k; p++) {
          const bo = p * n;
          let s = 0;
          for (let j = 0; j < n; j++) s += g[oo + j] * b[bo + j];
          ga[ao + p] += s;
        }
      }
    }
    if (B.requiresGrad || B._backward) {
      const gb = B.ensureGrad();
      for (let i = 0; i < m; i++) {
        const oo = i * n;
        const ao = i * k;
        for (let p = 0; p < k; p++) {
          const av = a[ao + p];
          if (av === 0) continue;
          const bo = p * n;
          for (let j = 0; j < n; j++) gb[bo + j] += av * g[oo + j];
        }
      }
    }
  });
}

/** C = A[m,k] @ B[n,k]^T —— 用在權重共享的輸出層（lm_head 與詞嵌入共用矩陣） */
export function matmulT(A, B) {
  const [m, k] = A.shape;
  const n = B.shape[0];
  const out = new Float64Array(m * n);
  const a = A.data;
  const b = B.data;
  for (let i = 0; i < m; i++) {
    const ao = i * k;
    const oo = i * n;
    for (let j = 0; j < n; j++) {
      const bo = j * k;
      let s = 0;
      for (let p = 0; p < k; p++) s += a[ao + p] * b[bo + p];
      out[oo + j] = s;
    }
  }
  return make(out, [m, n], [A, B], function () {
    const g = this.grad;
    if (!g) return;
    const ga = A.ensureGrad();
    const gb = B.ensureGrad();
    for (let i = 0; i < m; i++) {
      const oo = i * n;
      const ao = i * k;
      for (let j = 0; j < n; j++) {
        const gv = g[oo + j];
        if (gv === 0) continue;
        const bo = j * k;
        for (let p = 0; p < k; p++) {
          ga[ao + p] += gv * b[bo + p];
          gb[bo + p] += gv * a[ao + p];
        }
      }
    }
  });
}

/** X[m,n] + bias[n] */
export function addBias(X, bias) {
  const [m, n] = X.shape;
  const out = new Float64Array(m * n);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) out[i * n + j] = X.data[i * n + j] + bias.data[j];
  }
  return make(out, [m, n], [X, bias], function () {
    const g = this.grad;
    if (!g) return;
    const gx = X.ensureGrad();
    const gb = bias.ensureGrad();
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < n; j++) {
        gx[i * n + j] += g[i * n + j];
        gb[j] += g[i * n + j];
      }
    }
  });
}

/** 殘差連結用的逐元素相加 */
export function add(A, B) {
  const out = new Float64Array(A.size);
  for (let i = 0; i < out.length; i++) out[i] = A.data[i] + B.data[i];
  return make(out, A.shape.slice(), [A, B], function () {
    const g = this.grad;
    if (!g) return;
    const ga = A.ensureGrad();
    const gb = B.ensureGrad();
    for (let i = 0; i < g.length; i++) {
      ga[i] += g[i];
      gb[i] += g[i];
    }
  });
}

const GELU_C = Math.sqrt(2 / Math.PI);

/** GELU 激活（tanh 近似版，GPT 系列用的就是這個） */
export function gelu(X) {
  const n = X.size;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = X.data[i];
    out[i] = 0.5 * x * (1 + Math.tanh(GELU_C * (x + 0.044715 * x * x * x)));
  }
  return make(out, X.shape.slice(), [X], function () {
    const g = this.grad;
    if (!g) return;
    const gx = X.ensureGrad();
    for (let i = 0; i < n; i++) {
      const x = X.data[i];
      const inner = GELU_C * (x + 0.044715 * x * x * x);
      const th = Math.tanh(inner);
      const dInner = GELU_C * (1 + 3 * 0.044715 * x * x);
      gx[i] += g[i] * (0.5 * (1 + th) + 0.5 * x * (1 - th * th) * dInner);
    }
  });
}

/** Layer Normalization：每一列各自標準化，再乘上可學的 gain/bias */
export function layerNorm(X, gain, bias, eps = 1e-5) {
  const [m, n] = X.shape;
  const out = new Float64Array(m * n);
  const mean = new Float64Array(m);
  const rstd = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    const o = i * n;
    let mu = 0;
    for (let j = 0; j < n; j++) mu += X.data[o + j];
    mu /= n;
    let v = 0;
    for (let j = 0; j < n; j++) {
      const d = X.data[o + j] - mu;
      v += d * d;
    }
    v /= n;
    const rs = 1 / Math.sqrt(v + eps);
    mean[i] = mu;
    rstd[i] = rs;
    for (let j = 0; j < n; j++) {
      out[o + j] = (X.data[o + j] - mu) * rs * gain.data[j] + bias.data[j];
    }
  }
  return make(out, [m, n], [X, gain, bias], function () {
    const g = this.grad;
    if (!g) return;
    const gx = X.ensureGrad();
    const gg = gain.ensureGrad();
    const gb = bias.ensureGrad();
    for (let i = 0; i < m; i++) {
      const o = i * n;
      const rs = rstd[i];
      let sumDy = 0;
      let sumDyXhat = 0;
      for (let j = 0; j < n; j++) {
        const xhat = (X.data[o + j] - mean[i]) * rs;
        const dy = g[o + j] * gain.data[j];
        gg[j] += g[o + j] * xhat;
        gb[j] += g[o + j];
        sumDy += dy;
        sumDyXhat += dy * xhat;
      }
      for (let j = 0; j < n; j++) {
        const xhat = (X.data[o + j] - mean[i]) * rs;
        const dy = g[o + j] * gain.data[j];
        gx[o + j] += (rs / n) * (n * dy - sumDy - xhat * sumDyXhat);
      }
    }
  });
}

/** 查表：把 token id 換成向量 */
export function embedding(table, ids) {
  const C = table.shape[1];
  const m = ids.length;
  const out = new Float64Array(m * C);
  for (let i = 0; i < m; i++) {
    const src = ids[i] * C;
    for (let j = 0; j < C; j++) out[i * C + j] = table.data[src + j];
  }
  return make(out, [m, C], [table], function () {
    const g = this.grad;
    if (!g) return;
    const gt = table.ensureGrad();
    for (let i = 0; i < m; i++) {
      const dst = ids[i] * C;
      for (let j = 0; j < C; j++) gt[dst + j] += g[i * C + j];
    }
  });
}

/**
 * 因果多頭自注意力的核心：softmax(QKᵀ/√d + 遮罩) · V
 * q/k/v 形狀都是 [B*T, C]，C = H * hs。遮罩讓每個位置只能看到自己與之前的字。
 */
export function attention(q, k, v, B, T, H) {
  const C = q.shape[1];
  const hs = C / H;
  const scale = 1 / Math.sqrt(hs);
  const out = new Float64Array(B * T * C);
  const probs = new Float64Array(B * H * T * T); // 反向傳播要用
  const qd = q.data;
  const kd = k.data;
  const vd = v.data;

  for (let b = 0; b < B; b++) {
    for (let h = 0; h < H; h++) {
      const pBase = ((b * H + h) * T) * T;
      for (let t = 0; t < T; t++) {
        const qo = (b * T + t) * C + h * hs;
        let maxv = -Infinity;
        const row = new Float64Array(t + 1);
        for (let s = 0; s <= t; s++) {
          const ko = (b * T + s) * C + h * hs;
          let dot = 0;
          for (let d = 0; d < hs; d++) dot += qd[qo + d] * kd[ko + d];
          dot *= scale;
          row[s] = dot;
          if (dot > maxv) maxv = dot;
        }
        let sum = 0;
        for (let s = 0; s <= t; s++) {
          row[s] = Math.exp(row[s] - maxv);
          sum += row[s];
        }
        const oo = (b * T + t) * C + h * hs;
        for (let s = 0; s <= t; s++) {
          const p = row[s] / sum;
          probs[pBase + t * T + s] = p;
          const vo = (b * T + s) * C + h * hs;
          for (let d = 0; d < hs; d++) out[oo + d] += p * vd[vo + d];
        }
      }
    }
  }

  return make(out, [B * T, C], [q, k, v], function () {
    const g = this.grad;
    if (!g) return;
    const gq = q.ensureGrad();
    const gk = k.ensureGrad();
    const gv = v.ensureGrad();
    for (let b = 0; b < B; b++) {
      for (let h = 0; h < H; h++) {
        const pBase = ((b * H + h) * T) * T;
        for (let t = 0; t < T; t++) {
          const oo = (b * T + t) * C + h * hs;
          const dp = new Float64Array(t + 1);
          // dV 與 dprobs
          for (let s = 0; s <= t; s++) {
            const p = probs[pBase + t * T + s];
            const vo = (b * T + s) * C + h * hs;
            let acc = 0;
            for (let d = 0; d < hs; d++) {
              gv[vo + d] += p * g[oo + d];
              acc += g[oo + d] * vd[vo + d];
            }
            dp[s] = acc;
          }
          // softmax 的反向
          let dot = 0;
          for (let s = 0; s <= t; s++) dot += dp[s] * probs[pBase + t * T + s];
          const qo = (b * T + t) * C + h * hs;
          for (let s = 0; s <= t; s++) {
            const p = probs[pBase + t * T + s];
            const ds = p * (dp[s] - dot) * scale;
            const ko = (b * T + s) * C + h * hs;
            for (let d = 0; d < hs; d++) {
              gq[qo + d] += ds * kd[ko + d];
              gk[ko + d] += ds * qd[qo + d];
            }
          }
        }
      }
    }
  });
}

/** 取出 [m, C] 中每列的一段（把 qkv 一次算出來後切成三份） */
export function slice(X, start, len) {
  const [m, n] = X.shape;
  const out = new Float64Array(m * len);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < len; j++) out[i * len + j] = X.data[i * n + start + j];
  }
  return make(out, [m, len], [X], function () {
    const g = this.grad;
    if (!g) return;
    const gx = X.ensureGrad();
    for (let i = 0; i < m; i++) {
      for (let j = 0; j < len; j++) gx[i * n + start + j] += g[i * len + j];
    }
  });
}

/** 交叉熵損失（softmax + 負對數似然），對所有位置取平均 */
export function crossEntropy(logits, targets) {
  const [m, V] = logits.shape;
  const probs = new Float64Array(m * V);
  let loss = 0;
  for (let i = 0; i < m; i++) {
    const o = i * V;
    let maxv = -Infinity;
    for (let j = 0; j < V; j++) if (logits.data[o + j] > maxv) maxv = logits.data[o + j];
    let sum = 0;
    for (let j = 0; j < V; j++) {
      const e = Math.exp(logits.data[o + j] - maxv);
      probs[o + j] = e;
      sum += e;
    }
    for (let j = 0; j < V; j++) probs[o + j] /= sum;
    loss -= Math.log(Math.max(probs[o + targets[i]], 1e-12));
  }
  loss /= m;
  const out = make(new Float64Array([loss]), [1], [logits], function () {
    const g = this.grad;
    if (!g) return;
    const gl = logits.ensureGrad();
    const s = g[0] / m;
    for (let i = 0; i < m; i++) {
      const o = i * V;
      for (let j = 0; j < V; j++) gl[o + j] += s * probs[o + j];
      gl[o + targets[i]] -= s;
    }
  });
  out.probs = probs;
  return out;
}
