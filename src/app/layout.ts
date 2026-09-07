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
  right: boolean
  bottom: boolean
}

/**
 * 右panel 內各區塊的展開狀態。
 *
 * 全部擠在同一欄之後，垂直折疊就不只是整潔問題了 —— 不收起來根本捲不完。
 * 預設把除錯收起來，那是開發用的。
 */
export type SectionState = Record<string, boolean>

const DEFAULT_SECTIONS: SectionState = {
  專案: true,
  素材: true,
  比對: true,
  檢視: true,
  色彩: true,
  除錯: false,
}

interface Stored {
  panels?: Partial<PanelState>
  sections?: SectionState
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Stored) : {}
  } catch {
    return {}
  }
}

const stored = load()

/** 各面板是否展開。 */
export const panels = signal<PanelState>({
  right: stored.panels?.right ?? true,
  bottom: stored.panels?.bottom ?? true,
})

export const sections = signal<SectionState>({ ...DEFAULT_SECTIONS, ...stored.sections })

export function toggleSection(name: string): void {
  sections.value = { ...sections.value, [name]: !isSectionOpen(name) }
}

export function isSectionOpen(name: string): boolean {
  return sections.value[name] ?? true
}

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
  const payload: Stored = { panels: panels.value, sections: sections.value }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 存不了就算了，版面偏好不值得讓 app 掛掉。
  }
})
