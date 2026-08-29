// mini-GPT：跟 GPT 系列同一套架構，只是尺寸小很多。
//   token 嵌入 + 位置嵌入 → N 個 Transformer 區塊 → LayerNorm → 預測下一個字
// 每個區塊：x = x + 注意力(LN(x))；x = x + 前饋(LN(x))（Pre-LN 殘差）
import {
  Tensor, matmul, matmulT, addBias, add, gelu, layerNorm,
  embedding, attention, slice, crossEntropy, backward,
} from './tensor.js';
import { makeRng } from '../nn.js';

export class GPT {
  constructor({ vocabSize, blockSize = 64, nLayer = 4, nHead = 4, nEmbd = 96, seed = 1337 }) {
    const rng = makeRng(seed);
    const C = nEmbd;
    this.cfg = { vocabSize, blockSize, nLayer, nHead, nEmbd };
    if (C % nHead !== 0) throw new Error('nEmbd 必須能被 nHead 整除');

    // GPT-2 的初始化：常態分佈 std=0.02
    this.wte = Tensor.randn([vocabSize, C], 0.02, rng); // 詞嵌入（也當作輸出層，權重共享）
    this.wpe = Tensor.randn([blockSize, C], 0.02, rng); // 位置嵌入
    this.blocks = [];
    for (let i = 0; i < nLayer; i++) {
      this.blocks.push({
        ln1g: Tensor.filled([C], 1),
        ln1b: Tensor.zeros([C], true),
        qkvW: Tensor.randn([C, 3 * C], 0.02, rng),
        qkvB: Tensor.zeros([3 * C], true),
        projW: Tensor.randn([C, C], 0.02 / Math.sqrt(2 * nLayer), rng), // 殘差路徑要縮小
        projB: Tensor.zeros([C], true),
        ln2g: Tensor.filled([C], 1),
        ln2b: Tensor.zeros([C], true),
        fcW: Tensor.randn([C, 4 * C], 0.02, rng),
        fcB: Tensor.zeros([4 * C], true),
        fcProjW: Tensor.randn([4 * C, C], 0.02 / Math.sqrt(2 * nLayer), rng),
        fcProjB: Tensor.zeros([C], true),
      });
    }
    this.lnfg = Tensor.filled([C], 1);
    this.lnfb = Tensor.zeros([C], true);

    this.params = [this.wte, this.wpe, this.lnfg, this.lnfb];
    for (const b of this.blocks) this.params.push(...Object.values(b));
    for (const p of this.params) p.requiresGrad = true;
  }

  get numParams() {
    return this.params.reduce((s, p) => s + p.size, 0);
  }

  /**
   * ids: Int32Array/陣列，長度 B*T 的 token id
   * 回傳 logits [B*T, vocabSize]；有給 targets 就順便算損失
   */
  forward(ids, B, T, targets = null) {
    const { nHead, nEmbd } = this.cfg;
    const posIds = new Int32Array(B * T);
    for (let b = 0; b < B; b++) for (let t = 0; t < T; t++) posIds[b * T + t] = t;

    let x = add(embedding(this.wte, ids), embedding(this.wpe, posIds));

    for (const blk of this.blocks) {
      // --- 多頭自注意力 ---
      const h1 = layerNorm(x, blk.ln1g, blk.ln1b);
      const qkv = addBias(matmul(h1, blk.qkvW), blk.qkvB);
      const q = slice(qkv, 0, nEmbd);
      const k = slice(qkv, nEmbd, nEmbd);
      const v = slice(qkv, 2 * nEmbd, nEmbd);
      const attn = attention(q, k, v, B, T, nHead);
      x = add(x, addBias(matmul(attn, blk.projW), blk.projB));

      // --- 前饋網路 ---
      const h2 = layerNorm(x, blk.ln2g, blk.ln2b);
      const ff = gelu(addBias(matmul(h2, blk.fcW), blk.fcB));
      x = add(x, addBias(matmul(ff, blk.fcProjW), blk.fcProjB));
    }

    const hf = layerNorm(x, this.lnfg, this.lnfb);
    const logits = matmulT(hf, this.wte); // 與詞嵌入共享權重
    if (!targets) return { logits, loss: null };
    return { logits, loss: crossEntropy(logits, targets) };
  }

  /** 前向 + 反向，回傳這一批資料的損失值 */
  trainStep(ids, B, T, targets) {
    for (const p of this.params) p.zeroGrad();
    const { loss } = this.forward(ids, B, T, targets);
    backward(loss);
    return loss.data[0];
  }

  /** 全域梯度裁剪 */
  clipGrad(maxNorm) {
    let sum = 0;
    for (const p of this.params) {
      if (!p.grad) continue;
      for (let i = 0; i < p.grad.length; i++) sum += p.grad[i] * p.grad[i];
    }
    const norm = Math.sqrt(sum);
    if (norm > maxNorm && norm > 0) {
      const s = maxNorm / norm;
      for (const p of this.params) {
        if (!p.grad) continue;
        for (let i = 0; i < p.grad.length; i++) p.grad[i] *= s;
      }
    }
    return norm;
  }

  /**
   * 自迴歸生成：每次把目前的文字餵進去，取最後一個位置的機率分佈，
   * 依 temperature / top-k / top-p 取樣一個字，接到後面，再重來。
   */
  generate(ids, { maxNewTokens = 60, temperature = 0.8, topK = 0, topP = 0.9, rng = Math.random, stopToken = -1 } = {}) {
    const { blockSize, vocabSize } = this.cfg;
    let seq = Array.from(ids);
    for (let n = 0; n < maxNewTokens; n++) {
      const ctx = seq.slice(Math.max(0, seq.length - blockSize));
      const T = ctx.length;
      const { logits } = this.forward(Int32Array.from(ctx), 1, T);
      const off = (T - 1) * vocabSize;
      const row = new Float64Array(vocabSize);
      for (let j = 0; j < vocabSize; j++) row[j] = logits.data[off + j] / Math.max(1e-6, temperature);
      const next = sampleFrom(row, topK, topP, rng);
      seq.push(next);
      if (next === stopToken) break;
    }
    return seq;
  }

  toJSON() {
    return {
      cfg: this.cfg,
      params: this.params.map((p) => ({ shape: p.shape, data: Array.from(p.data) })),
    };
  }

  static fromJSON(obj) {
    const m = new GPT({ ...obj.cfg, seed: 1 });
    obj.params.forEach((src, i) => m.params[i].data.set(src.data));
    return m;
  }
}

/** temperature / top-k / top-p（nucleus）取樣 */
export function sampleFrom(logits, topK = 0, topP = 0, rng = Math.random) {
  const V = logits.length;
  let maxv = -Infinity;
  for (let i = 0; i < V; i++) if (logits[i] > maxv) maxv = logits[i];
  const probs = new Float64Array(V);
  let sum = 0;
  for (let i = 0; i < V; i++) {
    probs[i] = Math.exp(logits[i] - maxv);
    sum += probs[i];
  }
  for (let i = 0; i < V; i++) probs[i] /= sum;

  let idx = Array.from({ length: V }, (_, i) => i);
  idx.sort((a, b) => probs[b] - probs[a]);
  if (topK > 0) idx = idx.slice(0, topK);
  if (topP > 0 && topP < 1) {
    const keep = [];
    let acc = 0;
    for (const i of idx) {
      keep.push(i);
      acc += probs[i];
      if (acc >= topP) break;
    }
    idx = keep;
  }
  let total = 0;
  for (const i of idx) total += probs[i];
  let r = rng() * total;
  for (const i of idx) {
    r -= probs[i];
    if (r <= 0) return i;
  }
  return idx[idx.length - 1];
}
