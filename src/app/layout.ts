/**
 * 版面狀態：面板折疊與全螢幕。
 *
 * 存在 localStorage 而不是專案檔 —— 這是個人偏好，不該跟著專案跑到別台機器。
 * 讀寫都包在 try 裡：無痕視窗與被停用的儲存空間都會讓它拋，而版面偏好丟失
 * 不該讓整個 app 起不來。
 */

import { signal, effect } from '@preact/signals'

const STORAGE_KEY = 'qc.layout'

export interface PanelState {
  left: boolean
  right: boolean
  bottom: boolean
}

function load(): PanelState {
  const fallback: PanelState = { left: true, right: true, bottom: true }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as Partial<PanelState>
    return {
      left: parsed.left ?? fallback.left,
      right: parsed.right ?? fallback.right,
      bottom: parsed.bottom ?? fallback.bottom,
    }
  } catch {
    return fallback
  }
}

/** 各面板是否展開。 */
export const panels = signal<PanelState>(load())

/**
 * 全螢幕檢視：隱藏三個面板，不呼叫瀏覽器的 fullscreen。
 *
 * 比對時常要對照別的視窗，真正的全螢幕反而礙事；保留視窗框，只是把面板收掉。
 */
export const viewerFullscreen = signal(false)

export function togglePanel(which: keyof PanelState): void {
  panels.value = { ...panels.value, [which]: !panels.value[which] }
}

export function toggleFullscreen(): void {
  viewerFullscreen.value = !viewerFullscreen.value
}

export function exitFullscreen(): void {
  viewerFullscreen.value = false
}

effect(() => {
  const state = panels.value
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存不了就算了，版面偏好不值得讓 app 掛掉。
  }
})
