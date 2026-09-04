/**
 * 進入點。
 *
 * Phase 0 的 main.ts 是 spike：直接操作 DOM、沒有狀態管理、除錯掛勾寫死在裡面。
 * 這裡改成 Preact 元件骨架，狀態集中在 src/app/state.ts。
 */

import { render } from 'preact'
import { App } from './ui/App'
import './ui/styles.css'

const root = document.getElementById('app')
if (!root) throw new Error('找不到 #app')

render(<App />, root)

// 除錯掛勾只在 dev build 存在，不進產品。
if (import.meta.env.DEV) {
  void import('./app/devHook')
}
