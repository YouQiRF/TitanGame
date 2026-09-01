import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑：讓打包結果不綁死在網站根目錄，也才可能直接用 file:// 開啟
  base: './',
  build: {
    outDir: 'dist',
    assetsInlineLimit: 1024 * 1024,
  },
});
