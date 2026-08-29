// 給 Claude 用的工具：讓它能實際操作這個 repo 裡的另外兩個 AI。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { betaTool } from '@anthropic-ai/sdk/helpers/beta/json-schema';
import { MiniCraftEnv } from '../env.js';
import { DQNAgent } from '../agent.js';
import { GPT } from '../gpt/model.js';
import { CharTokenizer } from '../gpt/tokenizer.js';
import { respond } from '../gpt/infer.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// 模型檔不小，第一次用到才載入
let dqn = null;
let gpt = null;

function loadDqn() {
  if (dqn) return dqn;
  const p = path.join(REPO_ROOT, 'models/agent.json');
  if (!fs.existsSync(p)) throw new Error('找不到 models/agent.json，請先跑 npm run train');
  dqn = DQNAgent.fromJSON(JSON.parse(fs.readFileSync(p, 'utf8')));
  return dqn;
}

function loadGpt() {
  if (gpt) return gpt;
  const p = path.join(REPO_ROOT, 'models/gpt.json');
  if (!fs.existsSync(p)) throw new Error('找不到 models/gpt.json，請先跑 npm run gpt:train');
  const saved = JSON.parse(fs.readFileSync(p, 'utf8'));
  gpt = { model: GPT.fromJSON(saved.model), tok: CharTokenizer.fromJSON(saved.tokenizer) };
  return gpt;
}

export const playMinicraft = betaTool({
  name: 'play_minicraft',
  description:
    '讓這個 repo 裡用強化學習訓練出來的挖礦 AI 實際玩幾回合方塊世界，回傳每回合的採集分數、' +
    '結局，以及最後一回合結束時的地圖。想知道那個 AI 現在有多強、或想示範它怎麼玩時使用。',
  inputSchema: {
    type: 'object',
    properties: {
      episodes: { type: 'integer', minimum: 1, maximum: 10, description: '要玩幾回合，預設 3' },
      seed: { type: 'integer', description: '亂數種子，同一個種子會得到同一批地圖' },
    },
    required: [],
    additionalProperties: false,
  },
  run: async ({ episodes = 3, seed }) => {
    const agent = loadDqn();
    const env = new MiniCraftEnv({ seed: seed ?? (Date.now() % 100000) });
    const lines = [];
    let total = 0;
    for (let ep = 1; ep <= episodes; ep++) {
      let obs = Float64Array.from(env.reset());
      let reward = 0;
      while (!env.done) {
        // 保留一點點隨機性，避免純貪婪策略在原地繞圈
        const a = Math.random() < 0.02
          ? Math.floor(Math.random() * env.numActions)
          : agent.act(obs, true);
        const out = env.step(a);
        obs = Float64Array.from(out.obs);
        reward += out.reward;
      }
      total += env.score;
      lines.push(
        `第 ${ep} 回合：採集 ${env.score}/${env.maxScore} 分（木 ${env.inventory.wood} 石 ${env.inventory.stone} ` +
          `鑽 ${env.inventory.diamond}），累積獎勵 ${reward.toFixed(2)}，結局：${env.lastEvent}`
      );
    }
    lines.push(`\n平均採集 ${(total / episodes).toFixed(1)} 分。最後一回合結束時的地圖：\n`);
    lines.push(env.render());
    lines.push('\n圖例：# 基岩　· 空地　W 木頭　S 石頭　D 鑽石　~ 岩漿　@ AI');
    return lines.join('\n');
  },
});

export const askMiniGpt = betaTool({
  name: 'ask_mini_gpt',
  description:
    '把問題丟給這個 repo 裡從零手寫、只有 50 萬參數的 mini-GPT，回傳它的答案。' +
    '它只學過 584 組中文問答（由 Claude 蒸餾出來的），問到範圍外會胡言亂語——' +
    '想展示小模型的能耐或極限時使用。',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '要問它的問題' },
      temperature: { type: 'number', minimum: 0, maximum: 2, description: '取樣溫度，預設 0.5' },
    },
    required: ['question'],
    additionalProperties: false,
  },
  run: async ({ question, temperature = 0.5 }) => {
    const { model, tok } = loadGpt();
    const answer = respond(model, tok, question, { temperature });
    return answer ? `小方塊回答：${answer}` : '小方塊什麼都沒說出來。';
  },
});

export const readProjectFile = betaTool({
  name: 'read_project_file',
  description:
    '讀取這個 repo 裡的一個檔案（只能讀 repo 內的檔案）。想引用實際程式碼來回答問題時使用。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相對於 repo 根目錄的路徑，例如 src/gpt/model.js' },
      maxChars: { type: 'integer', minimum: 200, maximum: 40000, description: '最多讀幾個字，預設 8000' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  run: async ({ path: rel, maxChars = 8000 }) => {
    const full = path.resolve(REPO_ROOT, rel);
    if (full !== REPO_ROOT && !full.startsWith(REPO_ROOT + path.sep)) {
      return `拒絕讀取：${rel} 在 repo 之外。`;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return `找不到檔案：${rel}`;
    const text = fs.readFileSync(full, 'utf8');
    const clipped = text.length > maxChars;
    return `${rel}（${text.length} 字${clipped ? `，只顯示前 ${maxChars} 字` : ''}）：\n\n` +
      text.slice(0, maxChars);
  },
});

export const ALL_TOOLS = [playMinicraft, askMiniGpt, readProjectFile];

export const SYSTEM_PROMPT = `你是這個開源專案的助手，專案裡有三個 AI，全部住在同一個 repo：

1. MiniCraft AI：手寫的多層感知器 + Double DQN 強化學習，在 12x12 方塊世界裡自己學會挖礦、
   躲岩漿。零外部相依，程式碼在 src/nn.js、src/env.js、src/agent.js。
2. 小方塊 mini-GPT：從零手寫的 Transformer 語言模型（50 萬參數、4 層、字元級分詞），
   程式碼在 src/gpt/。它的訓練語料是由 Claude 寫出來的 584 組問答（知識蒸餾），
   所以它會的東西就是那些，問到範圍外一定胡言亂語。
3. 你自己（Claude）：透過 Anthropic API 提供這個聊天介面，程式碼在 src/claude/。

你可以用工具實際去跑前兩個 AI，也可以讀 repo 裡的原始碼來回答問題。
請用使用者的語言回答（預設繁體中文），講重點、不要客套話。
談到那兩個小模型時要誠實：它們很小、能力有限，不要誇大。`;
