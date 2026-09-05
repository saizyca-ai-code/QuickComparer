/**
 * 專案資料夾與本機服務的狀態。
 *
 * 服務是選用的：拖放路徑完全不經過它。所以這裡的每個動作失敗時都只記一筆訊息，
 * 不阻斷 UI —— 使用者永遠可以退回拖放。
 */

import { signal } from '@preact/signals'
import * as api from './api'
import { log } from './state'

export const serviceHealth = signal<api.HealthInfo | null>(null)
export const serviceError = signal<string | null>(null)
export const projectPath = signal<string | null>(null)
export const mediaItems = signal<api.MediaEntry[]>([])
/** 已取得的 metadata，key 是相對路徑。清單很長時不會全部先 probe。 */
export const mediaProbes = signal<Record<string, api.ProbeInfo>>({})
export const busy = signal(false)

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 啟動時問一次服務在不在。不在也只是少了專案資料夾功能。 */
export async function checkService(): Promise<void> {
  try {
    const info = await api.health()
    serviceHealth.value = info
    serviceError.value = null
    if (info.ffprobeError) log(`⚠ 服務找不到 ffprobe：${info.ffprobeError}`)
    await refreshProject()
  } catch (e) {
    serviceHealth.value = null
    serviceError.value = describe(e)
  }
}

export async function refreshProject(): Promise<void> {
  try {
    const info = await api.getProject()
    projectPath.value = info.path
    if (info.path && info.exists) await refreshMedia()
    else mediaItems.value = []
  } catch (e) {
    serviceError.value = describe(e)
  }
}

export async function chooseProject(path: string): Promise<void> {
  busy.value = true
  try {
    const info = await api.setProject(path)
    projectPath.value = info.path
    serviceError.value = null
    log(`專案資料夾：${info.path}`)
    await refreshMedia()
  } catch (e) {
    serviceError.value = describe(e)
    log(`設定專案資料夾失敗：${describe(e)}`)
  } finally {
    busy.value = false
  }
}

export async function refreshMedia(): Promise<void> {
  try {
    mediaItems.value = await api.listMedia()
    mediaProbes.value = {}
  } catch (e) {
    mediaItems.value = []
    serviceError.value = describe(e)
  }
}

/**
 * 取得單一素材的 metadata。
 *
 * 只在使用者展開某一項時才呼叫 —— keyframe 計數要掃過整個檔案的 packet，
 * 對 25 MB 的 4K 素材是幾百毫秒，整個清單一次 probe 會卡住。
 */
export async function probeItem(relPath: string): Promise<api.ProbeInfo | null> {
  const cached = mediaProbes.value[relPath]
  if (cached) return cached
  try {
    const info = await api.probeMedia(relPath)
    mediaProbes.value = { ...mediaProbes.value, [relPath]: info }
    for (const warning of info.warnings ?? []) log(`⚠ ${relPath}：${warning}`)
    return info
  } catch (e) {
    log(`讀取 ${relPath} 的 metadata 失敗：${describe(e)}`)
    return null
  }
}
