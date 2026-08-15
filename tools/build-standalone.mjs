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
// 開機保險絲：一段「非 module」腳本，放在所有東西之前。
// 1. 立刻用行內樣式漆上深色底 —— 就算 <style> 沒生效、或宿主 reset 蓋過去，
//    使用者也不會面對一片全白。
// 2. 掛 window 全域錯誤處理：主程式是 module，任何語法太新（舊手機瀏覽器）
//    或執行期錯誤都會讓它整包死掉且畫面上什麼都不說。這裡把錯誤畫成
//    看得懂的訊息，白畫面就變成可以回報、可以修的東西。
// 用 String.raw：裡面的 \n 要原封不動送進瀏覽器，被模板字串提前展開的話
// 會把單引號字串折斷，保險絲自己先語法錯誤（就真的發生過）。
const bootstrap = String.raw`<script>
(function () {
  var d = document.documentElement;
  d.style.background = '#070a12';
  if (document.body) document.body.style.background = '#070a12';
  else addEventListener('DOMContentLoaded', function () {
    document.body.style.background = '#070a12';
  });

  var shown = false;
  function showFatal(msg) {
    if (shown) return; shown = true;
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:12px;z-index:99999;background:#12080a;'
      + 'color:#ffd7d7;border:1px solid #a33;border-radius:12px;padding:18px;'
      + 'font:14px/1.7 system-ui,sans-serif;overflow:auto;white-space:pre-wrap;word-break:break-all';
    box.textContent = '遊戲啟動失敗。\n\n通常代表這個瀏覽器版本太舊，跑不動遊戲用到的語法。'
      + '請改用最新版的 Chrome / Edge / Safari 再開一次這個連結。\n\n技術資訊（回報用）：\n' + msg
      + '\n\nUA: ' + navigator.userAgent;
    function mount(){ document.body.appendChild(box); }
    if (document.body) mount(); else addEventListener('DOMContentLoaded', mount);
  }
  addEventListener('error', function (e) {
    showFatal((e.message || '未知錯誤') + (e.filename ? '\n' + e.filename + ':' + e.lineno : ''));
  }, true);
  addEventListener('unhandledrejection', function (e) {
    var r = e.reason || {};
    showFatal((r.message || String(r)));
  });
  // 3 秒後遊戲還沒掛出「已啟動」的旗標，代表 module 連跑都沒跑
  //（例如 module 語法不支援時，有些引擎連 error 事件都不會發）
  setTimeout(function () {
    if (!window.__bladeDuelBooted) {
      showFatal('主程式沒有啟動（3 秒內無回應）。這個瀏覽器可能不支援 ES module，'
        + '或安裝了會攔截腳本的擴充功能。');
    }
  }, 3000);
})();
</scr${''}ipt>`;

const out = `<meta charset="utf-8">
<title>方塊劍鬥</title>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
${bootstrap}
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
