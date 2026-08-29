#!/usr/bin/env node
// 知識蒸餾：讓 Claude（老師）大量產生問答，寫成小模型（學生）的訓練語料。
//
//   node src/gpt/distill.js --topics 生活常識,簡單科學 --perTopic 60 --out data/distilled.json
//   node src/gpt/train.js --data data/distilled.txt --steps 4000
//
// 需要 ANTHROPIC_API_KEY（或先跑 ant auth login）。沒有 key 的話，
// src/gpt/knowledge.js 裡已經有一份離線寫好的蒸餾資料可以直接用。
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { betaJSONSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { Q_MARK, A_MARK, QA_PAIRS } from './corpus.js';
import { describeError } from '../claude/session.js';

const DEFAULT_TOPICS = [
  '日常生活常識', '簡單的自然科學', '動物與植物', '時間與季節',
  '身體與健康', '數字與比較', '情緒與禮貌', '電腦與人工智慧',
];

export const PAIR_SCHEMA = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['question', 'answer'],
      },
    },
  },
  required: ['pairs'],
};

export function buildPrompt(topic, count, maxChars, avoid) {
  return `請產生 ${count} 組繁體中文問答，主題是「${topic}」，用途是訓練一個非常小的字元級語言模型。

嚴格遵守這些限制（模型只有幾十萬參數，超過就學不起來）：
- 問題不超過 12 個字，答案不超過 ${maxChars} 個字，答案必須是完整的一句話並以句號結尾。
- 用字要簡單、常見、重複使用；不要專有名詞、不要英文、不要數字符號（要用中文數字）。
- 每一組都要是明確、唯一正確的答案，不要開放式問題。
- 同一件事可以用兩種問法各出一組，幫助模型學到意思而不是背字串。
- 不要重複這些已經有的問題：${avoid.slice(0, 40).join('、')}`;
}

/** 呼叫 Claude 產生一批問答 */
export async function generateBatch(client, { topic, count = 40, maxChars = 20, avoid = [], model = 'claude-opus-5' }) {
  const response = await client.beta.messages.parse({
    model,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: buildPrompt(topic, count, maxChars, avoid) }],
    output_config: { format: betaJSONSchemaOutputFormat(PAIR_SCHEMA) },
  });
  return response.parsed_output?.pairs ?? [];
}

/** 清掉太長、重複、含奇怪字元的資料 —— 蒸餾出來的資料一定要篩過 */
export function cleanPairs(pairs, { maxQ = 14, maxA = 24, existing = new Set() } = {}) {
  const out = [];
  const seen = new Set(existing);
  for (const p of pairs) {
    const q = String(p.question ?? '').trim();
    const a = String(p.answer ?? '').trim();
    if (!q || !a) continue;
    if (q.length > maxQ || a.length > maxA) continue;
    if (/[a-zA-Z0-9]/.test(q + a)) continue; // 字元級模型不需要英數字撐大詞彙表
    if (seen.has(q)) continue;
    seen.add(q);
    out.push([q, a]);
  }
  return out;
}

/** 把問答組寫成訓練用的純文字語料 */
export function pairsToText(pairs, { samples = 20000, seed = 1 } = {}) {
  let s = seed >>> 0;
  const rng = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const lines = [];
  for (let i = 0; i < samples; i++) {
    const [q, a] = pairs[Math.floor(rng() * pairs.length)];
    lines.push(`${Q_MARK}${q}\n${A_MARK}${a}\n`);
  }
  return lines.join('');
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const args = {};
  for (let i = 2; i < process.argv.length; i++) {
    if (process.argv[i].startsWith('--')) {
      const k = process.argv[i].slice(2);
      const v = process.argv[i + 1];
      args[k] = v && !v.startsWith('--') ? (isNaN(Number(v)) ? v : Number(v)) : true;
    }
  }
  const topics = args.topics ? String(args.topics).split(',') : DEFAULT_TOPICS;
  const perTopic = args.perTopic || 40;
  const out = args.out || 'data/distilled.json';
  const client = new Anthropic();
  const existing = new Set(QA_PAIRS.map(([q]) => q));
  const collected = [];

  console.log(`向 Claude 要 ${topics.length} 個主題 × ${perTopic} 組問答…\n`);
  for (const topic of topics) {
    try {
      const raw = await generateBatch(client, {
        topic,
        count: perTopic,
        avoid: [...existing].slice(-40),
      });
      const clean = cleanPairs(raw, { existing });
      clean.forEach(([q]) => existing.add(q));
      collected.push(...clean);
      console.log(`  ${topic}：拿到 ${raw.length} 組，篩選後留下 ${clean.length} 組`);
    } catch (err) {
      console.error(`  ${topic}：失敗 —— ${describeError(err)}`);
    }
  }

  if (!collected.length) {
    console.error('\n沒有拿到任何資料，請確認 API key。');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(collected, null, 1));
  const txt = out.replace(/\.json$/, '') + '.txt';
  fs.writeFileSync(txt, pairsToText([...QA_PAIRS, ...collected], { samples: args.samples || 25000 }));
  console.log(
    `\n共 ${collected.length} 組新問答 → ${out}\n` +
      `合併原有語料後的訓練檔 → ${txt}\n\n接著跑：node src/gpt/train.js --data ${txt} --steps 4000 --block 64`
  );
}
