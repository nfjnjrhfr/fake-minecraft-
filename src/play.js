#!/usr/bin/env node
// 在終端機觀賞訓練好的 AI 玩：node src/play.js --model models/agent.json
import fs from 'node:fs';
import { MiniCraftEnv } from './env.js';
import { DQNAgent } from './agent.js';

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i].startsWith('--')) {
    const k = process.argv[i].slice(2);
    const v = process.argv[i + 1];
    args[k] = v && !v.startsWith('--') ? (isNaN(Number(v)) ? v : Number(v)) : true;
  }
}

const modelPath = args.model || 'models/agent.json';
if (!fs.existsSync(modelPath)) {
  console.error(`找不到模型 ${modelPath}，請先跑：npm run train`);
  process.exit(1);
}
const agent = DQNAgent.fromJSON(JSON.parse(fs.readFileSync(modelPath, 'utf8')));
const env = new MiniCraftEnv({ seed: args.seed || Date.now() % 1e6 });
const episodes = args.episodes || 3;
const delay = args.delay === undefined ? 80 : args.delay;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let ep = 1; ep <= episodes; ep++) {
  let obs = Float64Array.from(env.reset());
  let total = 0;
  while (!env.done) {
    const out = env.step(agent.act(obs, true));
    obs = Float64Array.from(out.obs);
    total += out.reward;
    if (delay > 0) {
      process.stdout.write('\x1b[2J\x1b[H');
      console.log(`第 ${ep}/${episodes} 回合（貪婪策略，無隨機探索）\n`);
      console.log(env.render());
      console.log(`\n累積獎勵 ${total.toFixed(2)}`);
      await sleep(delay);
    }
  }
  console.log(
    `\n回合 ${ep}：採集分數 ${env.score}／${env.totalOres === 0 ? 0 : '最高 30'}，` +
      `累積獎勵 ${total.toFixed(2)}，結局：${env.lastEvent}\n`
  );
}
