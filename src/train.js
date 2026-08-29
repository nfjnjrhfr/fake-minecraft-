#!/usr/bin/env node
// 在終端機訓練 agent：node src/train.js --episodes 3000 --out models/agent.json
import fs from 'node:fs';
import path from 'node:path';
import { MiniCraftEnv } from './env.js';
import { DQNAgent } from './agent.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else {
      args[key] = isNaN(Number(next)) ? next : Number(next);
      i++;
    }
  }
  return args;
}

export function evaluate(agent, envOpts, episodes = 20) {
  const env = new MiniCraftEnv({ ...envOpts, seed: 999 });
  let score = 0;
  let reward = 0;
  let deaths = 0;
  let cleared = 0;
  for (let i = 0; i < episodes; i++) {
    let obs = Float64Array.from(env.reset());
    let epR = 0;
    while (!env.done) {
      const out = env.step(agent.act(obs, true));
      obs = Float64Array.from(out.obs);
      epR += out.reward;
    }
    if (env.lastEvent === '掉進岩漿') deaths++;
    if (env.oresLeft === 0) cleared++;
    score += env.score;
    reward += epR;
  }
  return {
    score: score / episodes,
    reward: reward / episodes,
    deathRate: deaths / episodes,
    clearRate: cleared / episodes,
  };
}

export function train({
  episodes = 3000,
  envOpts = {},
  agentOpts = {},
  onEpisode = null,
  log = console.log,
  logEvery = 50,
} = {}) {
  const env = new MiniCraftEnv(envOpts);
  const agent = new DQNAgent(env.obsSize, env.numActions, agentOpts);
  const window = [];
  const history = [];
  const t0 = Date.now();

  for (let ep = 1; ep <= episodes; ep++) {
    let obs = Float64Array.from(env.reset());
    let epReward = 0;
    while (!env.done) {
      const a = agent.act(obs);
      const out = env.step(a);
      const next = Float64Array.from(out.obs);
      agent.remember(obs, a, out.reward, next, out.done);
      agent.maybeLearn();
      obs = next;
      epReward += out.reward;
    }
    window.push(epReward);
    if (window.length > 100) window.shift();
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    const row = {
      episode: ep,
      reward: epReward,
      avgReward: avg,
      score: env.score,
      epsilon: agent.epsilon,
      loss: agent.lastLoss,
      steps: agent.steps,
      died: env.lastEvent === '掉進岩漿',
    };
    history.push(row);
    if (onEpisode) onEpisode(row, agent, env);
    if (log && logEvery && ep % logEvery === 0) {
      const sps = Math.round(agent.steps / ((Date.now() - t0) / 1000));
      log(
        `回合 ${String(ep).padStart(5)} | 100 回合平均獎勵 ${avg.toFixed(2).padStart(7)} | ` +
          `本回合採集 ${String(env.score).padStart(3)} | ε ${agent.epsilon.toFixed(3)} | ` +
          `loss ${agent.lastLoss.toFixed(4)} | ${sps} 步/秒`
      );
    }
  }
  return { agent, env, history };
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const episodes = args.episodes || 2000;
  const envOpts = { seed: args.seed || 12345 };
  if (args.size) {
    envOpts.width = args.size;
    envOpts.height = args.size;
  }
  const agentOpts = { seed: args.seed || 1 };
  if (args.lr) agentOpts.lr = args.lr;

  console.log(`開始訓練：${episodes} 回合（AI 完全靠自己試錯，沒有任何人類示範資料）\n`);
  const { agent } = train({ episodes, envOpts, agentOpts, logEvery: args.logEvery || 50 });

  console.log('\n貪婪策略評估（關閉隨機探索）：');
  const stats = evaluate(agent, envOpts, 50);
  console.log(
    `  平均採集分數 ${stats.score.toFixed(2)} | 平均獎勵 ${stats.reward.toFixed(2)} | ` +
      `全清率 ${(stats.clearRate * 100).toFixed(0)}% | 掉岩漿率 ${(stats.deathRate * 100).toFixed(0)}%`
  );

  const out = args.out || 'models/agent.json';
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // 權重取到小數 6 位就夠了，檔案可以小一半以上
  const round = (k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toFixed(6)) : v);
  fs.writeFileSync(out, JSON.stringify(agent.toJSON(), round));
  console.log(`\n模型已存到 ${out}（${(fs.statSync(out).size / 1024).toFixed(0)} KB）`);
}
