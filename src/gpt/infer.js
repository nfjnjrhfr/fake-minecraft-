// 推論工具：把使用者的問題包成訓練時的格式，讓模型接著寫下去。
import { Q_MARK, A_MARK } from './corpus.js';

export function buildPrompt(question) {
  return `${Q_MARK}${question}\n${A_MARK}`;
}

/** 產生一句回答（生成到換行就停） */
export function respond(model, tok, question, opts = {}) {
  const ids = tok.encode(buildPrompt(question));
  const stopToken = tok.stoi.get('\n') ?? -1;
  const out = model.generate(ids, {
    maxNewTokens: 40,
    temperature: 0.7,
    topK: 0,
    topP: 0.9,
    stopToken,
    ...opts,
  });
  return tok.decode(out.slice(ids.length)).split('\n')[0];
}

/** 看看模型現在覺得下一個字最可能是什麼（拿來做視覺化） */
export function nextTokenProbs(model, tok, text, topN = 8) {
  const ids = tok.encode(text);
  if (ids.length === 0) return [];
  const ctx = ids.slice(Math.max(0, ids.length - model.cfg.blockSize));
  const { logits } = model.forward(ctx, 1, ctx.length);
  const V = model.cfg.vocabSize;
  const off = (ctx.length - 1) * V;
  let maxv = -Infinity;
  for (let j = 0; j < V; j++) if (logits.data[off + j] > maxv) maxv = logits.data[off + j];
  let sum = 0;
  const p = new Float64Array(V);
  for (let j = 0; j < V; j++) {
    p[j] = Math.exp(logits.data[off + j] - maxv);
    sum += p[j];
  }
  const idx = Array.from({ length: V }, (_, i) => i).sort((a, b) => p[b] - p[a]).slice(0, topN);
  return idx.map((i) => ({ char: tok.itos[i], prob: p[i] / sum }));
}
