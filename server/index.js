import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { ALLOW_CLIENT_KEY, MODEL, PORT } from './config.js';
import { serverKeyConfigured } from './claude.js';
import { modeCatalog } from './prompts.js';
import { stats } from './sessions.js';
import { chatRouter } from './routes/chat.js';
import { extractRouter } from './routes/extract.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const app = express();

app.use(express.json({ limit: '40mb' }));
app.use(express.static(path.join(here, '..', 'public'), { maxAge: '1h' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    keyReady: serverKeyConfigured(),
    allowClientKey: ALLOW_CLIENT_KEY,
    ...stats(),
  });
});

app.get('/api/modes', (_req, res) => res.json({ modes: modeCatalog() }));

app.use('/api', chatRouter);
app.use('/api', extractRouter);

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: '上傳內容太大，請減少圖片數量或降低解析度。' });
  }
  console.error(err);
  res.status(500).json({ error: err?.message || '伺服器錯誤' });
});

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  app.listen(PORT, () => {
    const key = serverKeyConfigured() ? '已設定' : '未設定（可在網頁上自行輸入）';
    console.log(`\n  SnapMind 拍讀 AI  →  http://localhost:${PORT}`);
    console.log(`  模型：${MODEL}   伺服器金鑰：${key}\n`);
  });
}
