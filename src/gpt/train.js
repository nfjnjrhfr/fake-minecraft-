#!/usr/bin/env node
// 訓練 mini-GPT：node src/gpt/train.js --steps 2500 --out models/gpt.json
import fs from 'node:fs';
import path from 'node:path';
import { GPT } from './model.js';
import { CharTokenizer } from './tokenizer.js';
import { AdamW, lrSchedule } from './optim.js';
import { buildCorpus } from './corpus.js';
import { respond } from './infer.js';
import { makeRng } from '../nn.js';

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) a[k] = true;
    else { a[k] = isNaN(Number(v)) ? v : Number(v); i++; }
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
const steps = args.steps || 2500;
const blockSize = args.block || 48;
const batchSize = args.batch || 8;
const baseLr = args.lr || 3e-3;
const out = args.out || 'models/gpt.json';

const text = args.data ? fs.readFileSync(args.data, 'utf8') : buildCorpus({ samples: args.samples || 9000 });
const tok = CharTokenizer.fromText(text);
const data = tok.encode(text);
const split = Math.floor(data.length * 0.9);
const train = data.subarray(0, split);
const val = data.subarray(split);

const model = new GPT({
  vocabSize: tok.vocabSize,
  blockSize,
  nLayer: args.layers || 3,
  nHead: args.heads || 4,
  nEmbd: args.embd || 64,
  seed: args.seed || 1337,
});
const opt = new AdamW(model.params, { lr: baseLr, weightDecay: 0.01 });
const rng = makeRng(args.seed || 7);

console.log(
  `語料 ${text.length} 字、詞彙表 ${tok.vocabSize} 個字\n` +
    `模型 ${model.cfg.nLayer} 層 × ${model.cfg.nHead} 頭 × ${model.cfg.nEmbd} 維，` +
    `共 ${(model.numParams / 1000).toFixed(0)}k 參數\n` +
    `訓練 ${steps} 步，每步 ${batchSize} × ${blockSize} = ${batchSize * blockSize} 個字\n`
);

function getBatch(source) {
  const ids = new Int32Array(batchSize * blockSize);
  const targets = new Int32Array(batchSize * blockSize);
  for (let b = 0; b < batchSize; b++) {
    const i = Math.floor(rng() * (source.length - blockSize - 1));
    for (let t = 0; t < blockSize; t++) {
      ids[b * blockSize + t] = source[i + t];
      targets[b * blockSize + t] = source[i + t + 1];
    }
  }
  return { ids, targets };
}

function estimateLoss(source, batches = 8) {
  let total = 0;
  for (let i = 0; i < batches; i++) {
    const { ids, targets } = getBatch(source);
    total += model.forward(ids, batchSize, blockSize, targets).loss.data[0];
  }
  return total / batches;
}

const t0 = Date.now();
const history = [];
for (let step = 0; step < steps; step++) {
  const { ids, targets } = getBatch(train);
  const loss = model.trainStep(ids, batchSize, blockSize, targets);
  model.clipGrad(1);
  opt.step(lrSchedule(step, steps, baseLr, Math.min(100, Math.floor(steps / 10))));

  if (step % 100 === 0 || step === steps - 1) {
    const vl = estimateLoss(val, 4);
    const secs = (Date.now() - t0) / 1000;
    history.push({ step, loss, val: vl });
    console.log(
      `步 ${String(step).padStart(5)} | 訓練損失 ${loss.toFixed(4)} | 驗證損失 ${vl.toFixed(4)} | ` +
        `lr ${lrSchedule(step, steps, baseLr, 100).toExponential(2)} | ` +
        `${Math.round(((step + 1) * batchSize * blockSize) / secs)} 字/秒`
    );
  }
  if (step > 0 && step % 500 === 0) {
    console.log(`   ↳ 試講：問「你是誰」→「${respond(model, tok, '你是誰', { temperature: 0.5, rng })}」`);
  }
}

console.log('\n訓練完成，隨便問幾題看看：');
for (const q of ['你好', '你是誰', '挖到鑽石有幾分', '三加四等於多少', '岩漿危險嗎', '天空是什麼顏色']) {
  console.log(`  問：${q}\n  答：${respond(model, tok, q, { temperature: 0.4, rng })}`);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
const round = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(5)) : v);
fs.writeFileSync(
  out,
  JSON.stringify({ model: model.toJSON(), tokenizer: tok.toJSON(), history }, round)
);
console.log(`\n模型已存到 ${out}（${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB）`);
