#!/usr/bin/env node
// 量一下模型到底學會多少：把 325 組問答全部問一遍，看回答是否完全正確。
import fs from 'node:fs';
import { GPT } from './model.js';
import { CharTokenizer } from './tokenizer.js';
import { respond } from './infer.js';
import { QA_PAIRS } from './corpus.js';
import { makeRng } from '../nn.js';

const modelPath = process.argv[2] || 'models/gpt.json';
if (!fs.existsSync(modelPath)) {
  console.error(`找不到模型 ${modelPath}，請先跑：npm run gpt:train`);
  process.exit(1);
}
const saved = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const model = GPT.fromJSON(saved.model);
const tok = CharTokenizer.fromJSON(saved.tokenizer);
const rng = makeRng(1);

const groups = new Map();
const label = (q) =>
  /乘/.test(q) ? '乘法' :
  /加|減/.test(q) ? '加減' :
  /哪個大/.test(q) ? '比大小' :
  /後面是什麼|前面是什麼/.test(q) ? '數數' :
  /顏色|什麼的/.test(q) ? '顏色' :
  /挖|礦|岩漿|方塊|地圖|滿分|走幾步/.test(q) ? '方塊世界' :
  /相反/.test(q) ? '反義詞' :
  /怎麼叫|動物|說說/.test(q) ? '動物' :
  /幾個月|幾天|幾小時|幾分鐘|季節|星期|春天|夏天|秋天|冬天|昨天|今天/.test(q) ? '時間' :
  /太陽|月亮|地球|星星|白天|晚上/.test(q) ? '天文' :
  /水|冰|雲|雨|雪|風|火|植物|樹|花|石頭|魚|鳥/.test(q) ? '自然' :
  /眼睛|耳朵|鼻子|嘴巴|手|腳|手指/.test(q) ? '身體' :
  /程式|電腦|模型|參數|訓練|資料|反向傳播|梯度|損失|注意力|強化學習|語言模型|蒸餾|大模型/.test(q) ? 'AI 知識' :
  /台灣|日本|海|河|山|島|海洋|沙漠/.test(q) ? '地理' :
  /餓|渴|累|起床|睡覺|吃飯|馬路|紅燈|綠燈|下雨|天冷|生病|學東西|米飯|水果|蘋果|香蕉/.test(q) ? '生活' :
  '聊天';

let correct = 0;
const wrong = [];
for (const [q, a] of QA_PAIRS) {
  const got = respond(model, tok, q, { temperature: 0.1, topK: 1 });
  const ok = got === a;
  if (ok) correct++;
  else wrong.push([q, a, got]);
  const g = label(q);
  const cur = groups.get(g) || { n: 0, ok: 0 };
  cur.n++;
  if (ok) cur.ok++;
  groups.set(g, cur);
}

console.log(`\n背下來的比例：${correct}/${QA_PAIRS.length}（${((correct / QA_PAIRS.length) * 100).toFixed(1)}%）\n`);
for (const [g, { n, ok }] of [...groups].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${g.padEnd(5)} ${String(ok).padStart(3)}/${String(n).padEnd(3)}  ${((ok / n) * 100).toFixed(0)}%`);
}
if (wrong.length) {
  console.log(`\n答錯的前 10 題：`);
  for (const [q, a, got] of wrong.slice(0, 10)) console.log(`  問：${q}\n    應該：${a}\n    回答：${got}`);
}

console.log('\n沒學過的問題（它一定會亂講，這是資料量的問題）：');
for (const q of ['宇宙是什麼', '幫我寫程式', '今天天氣如何']) {
  console.log(`  問：${q}\n  答：${respond(model, tok, q, { temperature: 0.6, rng })}`);
}
