import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5273 },
  build: { target: 'es2022' },
  // 用 esbuild 直接處理 JSX，不另外掛 preact plugin —— 這個專案沒有用到
  // react 生態的套件，refresh 也用不上（畫面靠 rAF 迴圈重畫）。
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
})
