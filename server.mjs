// 最小靜態伺服器（瀏覽器的 ES module 不能用 file:// 載入）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

/** 回傳一個處理靜態檔案的 handler，Claude 版的伺服器也會用到 */
export function makeStaticHandler(baseDir) {
  return function handle(req, res) {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(baseDir, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(baseDir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  };
}

const isMain = process.argv[1] && import.meta.url === `file://${path.resolve(process.argv[1])}`;
if (isMain) {
  const port = Number(process.env.PORT) || 8080;
  http.createServer(makeStaticHandler(root)).listen(port, () =>
    console.log(`打開 http://localhost:${port}`)
  );
}
