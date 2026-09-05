import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5273,
    // 前端與後端在開發期是兩個 port，用 proxy 讓瀏覽器看到的是同源 ——
    // 打包後兩者會真的同源，前端的請求路徑不必因此改寫。
    proxy: {
      '/api': { target: 'http://127.0.0.1:5274', changeOrigin: false },
    },
  },
  build: { target: 'es2022' },
  // 用 esbuild 直接處理 JSX，不另外掛 preact plugin —— 這個專案沒有用到
  // react 生態的套件，refresh 也用不上（畫面靠 rAF 迴圈重畫）。
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
})
