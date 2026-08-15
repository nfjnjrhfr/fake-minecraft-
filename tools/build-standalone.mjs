// 把整個遊戲打包成單一自包含的 HTML 檔。
//
// 用途：分享 / 離線遊玩 / 丟到任何靜態空間，以及貼到只吃單檔的環境
// （例如 Artifact 這種禁止對外請求的沙箱）。
//
// 做法很土但夠用：ES 模組本來就沒有循環相依，照拓撲順序接起來、
// 把 import / export 關鍵字拿掉就是一份合法的腳本。
// 每個模組的識別字都不重複（模組自己的暫存變數都有前綴），所以直接攤平不會撞名。
//
// 執行：node tools/build-standalone.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 依相依關係排好的模組順序。 */
const MODULES = [
  'src/core/math.js',
  'src/core/renderer.js',
  'src/game/equipment.js',
  'src/game/rig.js',
  'src/game/animation.js',
  'src/game/combat.js',
  'src/game/fighter.js',
  'src/net/protocol.js',
  'src/game/ai.js',
  'src/game/match.js',
  'src/net/transport.js',
  'src/net/netgame.js',
  'src/main.js',
];

/** 拿掉模組語法，留下純粹的宣告。 */
function stripModuleSyntax(code) {
  return code
    // import { a, b } from './x.js';  （可能跨多行，但不會包含分號）
    .replace(/^import\b[^;]*;/gm, '')
    // export { a, b };  這種再匯出語句直接刪掉，留著會變成重複宣告
    .replace(/^export\s*\{[^}]*\}\s*;?/gm, '')
    // export const / function / class ... -> 去掉 export 前綴
    .replace(/^export\s+(const|let|var|function|class|async)\b/gm, '$1');
}

/** 檢查攤平之後有沒有頂層識別字撞名，有的話直接讓建置失敗。 */
function findCollisions(modules) {
  const seen = new Map();
  const collisions = [];
  const declRe = /^(?:export\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const { path, code } of modules) {
    for (const m of code.matchAll(declRe)) {
      const name = m[1];
      if (seen.has(name)) collisions.push(`${name}（${seen.get(name)} 與 ${path}）`);
      else seen.set(name, path);
    }
  }
  return collisions;
}

const sources = [];
for (const path of MODULES) {
  sources.push({ path, code: await readFile(join(ROOT, path), 'utf8') });
}

const collisions = findCollisions(sources);
if (collisions.length) {
  console.error('建置失敗：攤平後有重複的頂層宣告\n  ' + collisions.join('\n  '));
  process.exit(1);
}

const bundle = sources
  .map(({ path, code }) =>
    `// ${'='.repeat(72)}\n// ${path}\n// ${'='.repeat(72)}\n\n${stripModuleSyntax(code).trim()}\n`)
  .join('\n');

const css = await readFile(join(ROOT, 'style.css'), 'utf8');
const html = await readFile(join(ROOT, 'index.html'), 'utf8');

// 從 index.html 取出 <body> 的內容，外殼與樣式重新組。
const bodyMatch = html.match(/<body>([\s\S]*?)<script\s+type="module"/);
if (!bodyMatch) throw new Error('在 index.html 裡找不到 <body> 內容');
const body = bodyMatch[1].trim();

// charset 必須排在最前面：這份檔案可能被靜態伺服器以沒有 charset 的
// Content-Type 送出，瀏覽器就會用 latin-1 解碼，中文全部變亂碼。
const out = `<meta charset="utf-8">
<title>方塊劍鬥</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<style>
${css.trim()}
</style>

${body}

<script type="module">
${bundle}
</script>
`;

await mkdir(join(ROOT, 'dist'), { recursive: true });
const outPath = join(ROOT, 'dist', 'blade-duel.html');
await writeFile(outPath, out, 'utf8');

const kb = (out.length / 1024).toFixed(1);
console.log(`已產生 dist/blade-duel.html（${kb} KB，${MODULES.length} 個模組）`);
