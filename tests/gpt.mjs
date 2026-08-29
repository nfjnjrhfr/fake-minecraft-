// mini-GPT 的測試：每個運算的反向傳播都用數值微分驗證，再確認模型真的學得起來。
import {
  Tensor, matmul, matmulT, addBias, add, gelu, layerNorm,
  embedding, attention, slice, crossEntropy, backward,
} from '../src/gpt/tensor.js';
import { GPT, sampleFrom } from '../src/gpt/model.js';
import { CharTokenizer } from '../src/gpt/tokenizer.js';
import { AdamW, lrSchedule } from '../src/gpt/optim.js';
import { makeRng } from '../src/nn.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
};

const rng = makeRng(4242);
const rnd = (shape) => Tensor.randn(shape, 0.8, rng, true);

/** 對 build() 建出的計算圖做完整的數值梯度檢查 */
function gradCheck(name, inputs, build) {
  for (const t of inputs) t.grad = null;
  const loss = build();
  backward(loss);
  const analytic = inputs.map((t) => Float64Array.from(t.ensureGrad()));

  const eps = 1e-6;
  let worst = 0;
  inputs.forEach((t, ti) => {
    const n = Math.min(t.size, 10);
    for (let k = 0; k < n; k++) {
      const idx = Math.floor((k * t.size) / n);
      const orig = t.data[idx];
      t.data[idx] = orig + eps;
      const lp = build().data[0];
      t.data[idx] = orig - eps;
      const lm = build().data[0];
      t.data[idx] = orig;
      const num = (lp - lm) / (2 * eps);
      const ana = analytic[ti][idx];
      const rel = Math.abs(num - ana) / Math.max(1e-7, Math.abs(num) + Math.abs(ana));
      if (rel > worst) worst = rel;
    }
  });
  check(name, worst < 1e-5, `最大相對誤差 ${worst.toExponential(2)}`);
}

console.log('\n[1] 每個運算的反向傳播 vs 數值梯度');
{
  const A = rnd([4, 5]);
  const Bm = rnd([5, 3]);
  const tgt = Int32Array.from([0, 2, 1, 2]);
  gradCheck('matmul', [A, Bm], () => crossEntropy(matmul(A, Bm), tgt));

  const X = rnd([4, 6]);
  const W = rnd([3, 6]);
  gradCheck('matmulT（權重共享的輸出層）', [X, W], () => crossEntropy(matmulT(X, W), tgt));

  const X2 = rnd([4, 3]);
  const b2 = rnd([3]);
  gradCheck('addBias', [X2, b2], () => crossEntropy(addBias(X2, b2), tgt));

  const P = rnd([4, 3]);
  const Q = rnd([4, 3]);
  gradCheck('add（殘差連結）', [P, Q], () => crossEntropy(add(P, Q), tgt));

  const G = rnd([4, 3]);
  gradCheck('gelu', [G], () => crossEntropy(gelu(G), tgt));

  const L = rnd([4, 3]);
  const gain = rnd([3]);
  const bias = rnd([3]);
  gradCheck('layerNorm', [L, gain, bias], () => crossEntropy(layerNorm(L, gain, bias), tgt));

  const table = rnd([7, 3]);
  const ids = Int32Array.from([5, 1, 1, 3]);
  gradCheck('embedding', [table], () => crossEntropy(embedding(table, ids), tgt));

  const S = rnd([4, 9]);
  gradCheck('slice', [S], () => crossEntropy(slice(S, 3, 3), tgt));

  // 注意力：B=2, T=3, H=2, C=4
  const q = rnd([6, 4]);
  const k = rnd([6, 4]);
  const v = rnd([6, 4]);
  const tgt6 = Int32Array.from([0, 3, 1, 2, 0, 1]);
  gradCheck('attention（因果多頭自注意力）', [q, k, v], () =>
    crossEntropy(attention(q, k, v, 2, 3, 2), tgt6)
  );
}

console.log('\n[2] 整個 GPT 的梯度');
{
  const model = new GPT({ vocabSize: 11, blockSize: 5, nLayer: 2, nHead: 2, nEmbd: 8, seed: 7 });
  const B = 2;
  const T = 4;
  const ids = Int32Array.from([1, 4, 7, 2, 9, 3, 0, 5]);
  const targets = Int32Array.from([4, 7, 2, 6, 3, 0, 5, 1]);
  const build = () => model.forward(ids, B, T, targets).loss;

  for (const p of model.params) p.zeroGrad();
  backward(build());

  // 這裡的梯度量級小到 ~1e-6，差分步長太小反而會被浮點捨入吃掉，所以用 1e-5
  const eps = 1e-5;
  let worst = 0;
  for (const p of model.params) {
    for (let k = 0; k < Math.min(p.size, 4); k++) {
      const idx = Math.floor((k * p.size) / Math.min(p.size, 4));
      const orig = p.data[idx];
      p.data[idx] = orig + eps;
      const lp = build().data[0];
      p.data[idx] = orig - eps;
      const lm = build().data[0];
      p.data[idx] = orig;
      const num = (lp - lm) / (2 * eps);
      // 分母設下限：梯度本身接近 0 時，只要絕對誤差夠小就算通過
      const rel = Math.abs(num - p.grad[idx]) / Math.max(1e-3, Math.abs(num) + Math.abs(p.grad[idx]));
      if (rel > worst) worst = rel;
    }
  }
  check('全部 22 組參數的梯度都正確', worst < 1e-5, `最大相對誤差 ${worst.toExponential(2)}`);

  // 沒訓練前，損失應該接近 ln(vocabSize)（等於亂猜）
  const l0 = build().data[0];
  check('初始損失 ≈ ln(詞彙量)', Math.abs(l0 - Math.log(11)) < 0.35, `${l0.toFixed(3)} vs ${Math.log(11).toFixed(3)}`);
}

console.log('\n[3] 因果遮罩：不能偷看未來');
{
  const model = new GPT({ vocabSize: 9, blockSize: 6, nLayer: 2, nHead: 2, nEmbd: 8, seed: 3 });
  const a = Int32Array.from([1, 2, 3, 4]);
  const b = Int32Array.from([1, 2, 8, 7]); // 只有後面兩個字不同
  const la = model.forward(a, 1, 4).logits;
  const lb = model.forward(b, 1, 4).logits;
  let maxDiff = 0;
  for (let t = 0; t < 2; t++) {
    for (let j = 0; j < 9; j++) {
      maxDiff = Math.max(maxDiff, Math.abs(la.data[t * 9 + j] - lb.data[t * 9 + j]));
    }
  }
  check('改動後面的字不會影響前面位置的輸出', maxDiff < 1e-12, `差異 ${maxDiff.toExponential(1)}`);
}

console.log('\n[4] 分詞器');
{
  const tok = CharTokenizer.fromText('你好，世界！ \nhello');
  const text = '你好，世界！';
  check('編碼→解碼可以還原', tok.decode(tok.encode(text)) === text, `詞彙量 ${tok.vocabSize}`);
  check('詞彙表外的字會被跳過', tok.decode(tok.encode('你X好')) === '你好');
}

console.log('\n[5] 真的學得起來：把一小段文字背下來');
{
  const text = '小方塊世界裡的AI在挖礦。';
  const tok = CharTokenizer.fromText(text);
  const data = tok.encode(text);
  const T = data.length - 1;
  const model = new GPT({ vocabSize: tok.vocabSize, blockSize: T, nLayer: 2, nHead: 2, nEmbd: 32, seed: 11 });
  const opt = new AdamW(model.params, { lr: 0.02, weightDecay: 0 });
  const ids = data.slice(0, T);
  const targets = data.slice(1, T + 1);

  const first = model.trainStep(ids, 1, T, targets);
  let loss = first;
  for (let i = 0; i < 120; i++) {
    loss = model.trainStep(ids, 1, T, targets);
    model.clipGrad(1);
    opt.step(lrSchedule(i, 120, 0.02, 10));
  }
  check('損失從 ln(V) 降到接近 0', loss < 0.05, `${first.toFixed(3)} → ${loss.toFixed(4)}`);

  const out = tok.decode(model.generate([data[0]], { maxNewTokens: T, temperature: 0.05, topK: 1, rng: makeRng(1) }));
  check('能一字不差地背出原句', out === text, `生成「${out}」`);
}

console.log('\n[6] 取樣策略');
{
  const logits = new Float64Array([10, 1, 1, 1, 1]);
  const r = makeRng(5);
  let allTop = true;
  for (let i = 0; i < 50; i++) if (sampleFrom(logits, 1, 0, r) !== 0) allTop = false;
  check('top-k=1 等於永遠選機率最高的', allTop);

  const flat = new Float64Array([1, 1, 1, 1, 1]);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(sampleFrom(flat, 0, 1, r));
  check('機率平均時會取樣到各種結果', seen.size === 5, `取到 ${seen.size} 種`);
}

console.log(`\n總結：${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
