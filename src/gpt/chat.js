#!/usr/bin/env node
// 跟訓練好的 mini-GPT 聊天：node src/gpt/chat.js
import fs from 'node:fs';
import readline from 'node:readline';
import { GPT } from './model.js';
import { CharTokenizer } from './tokenizer.js';
import { respond } from './infer.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const v = process.argv[i + 1];
    args[k] = v && !v.startsWith('--') ? (isNaN(Number(v)) ? v : Number(v)) : true;
  }
}

const modelPath = args.model || 'models/gpt.json';
if (!fs.existsSync(modelPath)) {
  console.error(`找不到模型 ${modelPath}，請先跑：npm run gpt:train`);
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const model = GPT.fromJSON(saved.model);
const tok = CharTokenizer.fromJSON(saved.tokenizer);
const opts = {
  temperature: args.temp ?? 0.6,
  topK: args.topk ?? 0,
  topP: args.topp ?? 0.9,
};

console.log(
  `小方塊 mini-GPT（${(model.numParams / 1000).toFixed(0)}k 參數，${model.cfg.nLayer} 層 Transformer）\n` +
    `它只學過一份很小的中文語料，別期待它很聰明 :)  輸入 exit 離開。\n`
);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('你：');
rl.prompt();
rl.on('line', (line) => {
  const q = line.trim();
  if (!q) return rl.prompt();
  if (q === 'exit' || q === 'quit' || q === '再見') {
    console.log('小方塊：再見，下次見。');
    return rl.close();
  }
  const a = respond(model, tok, q, opts);
  console.log(`小方塊：${a || '（它說不出話）'}\n`);
  rl.prompt();
});
rl.on('close', () => process.exit(0));
