// 無相依的測試：用數值梯度驗證反向傳播，並確認 agent 真的學得起來。
import { MLP, huber, makeRng } from '../src/nn.js';
import { MiniCraftEnv, TILE, OBS_SIZE, NUM_ACTIONS } from '../src/env.js';
import { DQNAgent } from '../src/agent.js';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

console.log('\n[1] 反向傳播 vs 數值梯度');
{
  const rng = makeRng(7);
  const net = new MLP([4, 6, 5, 3], { seed: 11 });
  const B = 3;
  const X = new Float64Array(B * 4);
  for (let i = 0; i < X.length; i++) X[i] = rng() * 2 - 1;
  const Y = new Float64Array(B * 3);
  for (let i = 0; i < Y.length; i++) Y[i] = rng() * 2 - 1;

  const lossOf = () => huber(Float64Array.from(net.forward(X, B)), Y, B).loss;

  const pred = net.forward(X, B);
  const { grad } = huber(Float64Array.from(pred), Y, B);
  net.zeroGrad();
  net.backward(grad, B);

  const eps = 1e-6;
  let worst = 0;
  for (const layer of net.layers) {
    for (const [P, G] of [[layer.W, layer.gW], [layer.b, layer.gb]]) {
      for (let k = 0; k < Math.min(P.length, 12); k++) {
        const orig = P[k];
        P[k] = orig + eps;
        const lp = lossOf();
        P[k] = orig - eps;
        const lm = lossOf();
        P[k] = orig;
        const numeric = (lp - lm) / (2 * eps);
        const diff = Math.abs(numeric - G[k]) / Math.max(1e-6, Math.abs(numeric) + Math.abs(G[k]));
        if (diff > worst) worst = diff;
      }
    }
  }
  check('所有參數的解析梯度與數值梯度相符', worst < 1e-5, `最大相對誤差 ${worst.toExponential(2)}`);
}

console.log('\n[2] 神經網路能擬合非線性函數（XOR）');
{
  const net = new MLP([2, 8, 1], { seed: 3 });
  const X = new Float64Array([0, 0, 0, 1, 1, 0, 1, 1]);
  const Y = new Float64Array([0, 1, 1, 0]);
  let loss = 1;
  for (let i = 0; i < 3000; i++) {
    const pred = Float64Array.from(net.forward(X, 4));
    const h = huber(pred, Y, 4);
    loss = h.loss;
    net.zeroGrad();
    net.backward(h.grad, 4);
    net.step(0.02);
  }
  const out = net.forward(X, 4);
  const ok = out[0] < 0.3 && out[1] > 0.7 && out[2] > 0.7 && out[3] < 0.3;
  check('XOR 學會了', ok, `loss=${loss.toFixed(5)} out=[${Array.from(out).map((v) => v.toFixed(2))}]`);
}

console.log('\n[3] 環境規則');
{
  const env = new MiniCraftEnv({ seed: 42, shaping: 0 });
  check('觀測維度正確', env.observe().length === OBS_SIZE, `${OBS_SIZE} 維`);
  check('動作數正確', env.numActions === NUM_ACTIONS);

  // 手動擺一個鑽石在右邊，面向它挖掉
  const e2 = new MiniCraftEnv({ seed: 1, shaping: 0 });
  e2.set(e2.px + 1, e2.py, TILE.DIAMOND);
  e2.facing = 1;
  const before = e2.oresLeft;
  const r = e2.step(4);
  check('挖到鑽石有 +5 獎勵', Math.abs(r.reward - (5 - 0.02)) < 1e-9, `reward=${r.reward.toFixed(2)}`);
  check('方塊被挖掉了', e2.get(e2.px + 1, e2.py) === TILE.AIR && e2.oresLeft === before - 1);

  const e3 = new MiniCraftEnv({ seed: 5, shaping: 0 });
  e3.set(e3.px, e3.py - 1, TILE.LAVA);
  const r3 = e3.step(0);
  check('踩進岩漿會扣分並結束回合', r3.done && r3.reward < -4, `reward=${r3.reward.toFixed(2)}`);

  const e4 = new MiniCraftEnv({ seed: 9, shaping: 0, maxSteps: 3 });
  e4.step(4);
  e4.step(4);
  const r4 = e4.step(4);
  check('達到步數上限會結束回合', r4.done);
}

console.log('\n[4] Agent 自我學習（比隨機亂走好）');
{
  // 為了讓測試在數十秒內跑完，用小地圖、短回合、小網路。
  // 所有亂數都有固定 seed，結果可完全重現。
  const envOpts = {
    seed: 2, width: 8, height: 8, wood: 3, stone: 2, diamond: 1, lava: 2, maxSteps: 50,
  };
  const env = new MiniCraftEnv(envOpts);
  const agent = new DQNAgent(env.obsSize, env.numActions, {
    seed: 4,
    hidden: [48, 48],
    epsDecaySteps: 3000,
    learnStart: 300,
    bufferSize: 20000,
  });

  const scoreOf = (policy, n) => {
    const e = new MiniCraftEnv({ ...envOpts, seed: 777 });
    let total = 0;
    for (let i = 0; i < n; i++) {
      let obs = Float64Array.from(e.reset());
      while (!e.done) obs = Float64Array.from(e.step(policy(obs)).obs);
      total += e.score;
    }
    return total / n;
  };

  const rr = makeRng(31);
  const randomScore = scoreOf(() => Math.floor(rr() * env.numActions), 40);

  for (let ep = 0; ep < 350; ep++) {
    let obs = Float64Array.from(env.reset());
    while (!env.done) {
      const a = agent.act(obs);
      const out = env.step(a);
      const next = Float64Array.from(out.obs);
      agent.remember(obs, a, out.reward, next, out.done);
      agent.maybeLearn();
      obs = next;
    }
  }

  const trained = scoreOf((o) => agent.act(o, true), 40);
  check(
    '訓練後的平均採集分數明顯高於隨機策略',
    trained > randomScore * 1.5,
    `隨機 ${randomScore.toFixed(2)} → 學習後 ${trained.toFixed(2)}`
  );
}

console.log('\n[5] 存檔／讀檔');
{
  const agent = new DQNAgent(OBS_SIZE, NUM_ACTIONS, { seed: 8, hidden: [32] });
  const env = new MiniCraftEnv({ seed: 6 });
  const obs = Float64Array.from(env.observe());
  const before = agent.qValues(obs);
  const clone = DQNAgent.fromJSON(JSON.parse(JSON.stringify(agent.toJSON())));
  const after = clone.qValues(obs);
  let same = true;
  for (let i = 0; i < before.length; i++) if (Math.abs(before[i] - after[i]) > 1e-12) same = false;
  check('序列化後 Q 值完全一致', same);
}

console.log(`\n總結：${pass} 通過，${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
