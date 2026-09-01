/**
 * 把 vite build 的產物壓成「單一 HTML 檔」。
 *
 * 為什麼需要這個：
 *   dist/index.html 用的是 <script type="module" src="./assets/xxx.js">，
 *   而瀏覽器對 file:// 下的 module script 有 CORS 限制，會直接擋掉，
 *   所以雙擊 dist/index.html 只會看到黑畫面。
 *
 *   把 JS 內嵌成 inline module 就沒有任何外部請求，file:// 可以正常執行。
 *
 * 用法：npm run build:single  →  產出 TitanSlash.html（雙擊即玩）
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const indexPath = join(dist, 'index.html');

if (!existsSync(indexPath)) {
  console.error('找不到 dist/index.html —— 請先執行 vite build');
  process.exit(1);
}

let html = readFileSync(indexPath, 'utf8');

// 內嵌所有外部 JS
html = html.replace(
  /<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g,
  (_match, src) => {
    const file = join(dist, src.replace(/^\.?\//, ''));
    if (!existsSync(file)) {
      console.warn(`略過找不到的檔案：${src}`);
      return '';
    }
    // 程式碼裡若出現 </script> 會提前結束標籤，必須跳脫
    const js = readFileSync(file, 'utf8').replace(/<\/script>/gi, '<\\/script>');
    return `<script type="module">\n${js}\n</script>`;
  },
);

// 內嵌所有外部 CSS
html = html.replace(
  /<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g,
  (_match, href) => {
    const file = join(dist, href.replace(/^\.?\//, ''));
    if (!existsSync(file)) {
      console.warn(`略過找不到的檔案：${href}`);
      return '';
    }
    return `<style>\n${readFileSync(file, 'utf8')}\n</style>`;
  },
);

const outPath = join(root, 'TitanSlash.html');
writeFileSync(outPath, html, 'utf8');

const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log(`✓ 已產出單一檔案：TitanSlash.html（${kb} kB）`);
console.log('  直接雙擊即可離線遊玩，也可以整個檔案傳給別人。');
