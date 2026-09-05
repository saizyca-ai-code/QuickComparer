/**
 * 應用狀態。
 *
 * 只有一份，用 signal 讓 UI 跟著動。繪製迴圈讀的是 peek()，不訂閱 ——
 * 它每格都會重畫，訂閱只會白白多跑一次相依追蹤。
 *
 * 這裡刻意不放任何 DOM 或 WebGL 的東西：PlaybackController 決定「這一格是哪些
 * 影格」，Renderer 決定「怎麼畫」，兩者都不需要知道 UI 長什麼樣。
 */

import { signal, type Signal } from '@preact/signals'
import { ImageFrameSource } from '../core/ImageFrameSource'
import { Mp4FrameSource } from '../core/Mp4FrameSource'
import { PlaybackController } from '../core/PlaybackController'
import type { FrameSource, FrameSourceInfo } from '../core/FrameSource'
import { FileByteSource, HttpByteSource, type ByteSource } from '../core/ByteSource'
import { fileUrl, type MediaEntry } from './api'
import { DEFAULT_RENDER_PARAMS, type RenderParams } from '../gl/params'

export type Slot = 0 | 1

/** 一個素材槽的顯示狀態。FrameSource 本身歸 PlaybackController 管。 */
export interface SlotState {
  name: string
  /**
   * 位元組來源。並行解碼探測需要重新開一份解碼器，不能共用既有的，
   * 所以要留著它而不是只留 FrameSource。
   */
  bytes: ByteSource
  /** 這份素材從哪來。專案資料夾來的會帶相對路徑，供之後的專案存檔引用。 */
  origin: 'drop' | 'project'
  relPath: string | null
  info: FrameSourceInfo
}

export const playback = new PlaybackController()

export const params: Signal<RenderParams> = signal({
  ...DEFAULT_RENDER_PARAMS,
  pan: { ...DEFAULT_RENDER_PARAMS.pan },
})

export const slots: Signal<[SlotState | null, SlotState | null]> = signal([null, null])

/** 時鐘狀態的快照。繪製迴圈每格更新，傳輸控制列讀它。 */
export const clockState = signal({ currentTime: 0, duration: 0, playing: false })

/** 拖動 timeline 期間不要讓時鐘回頭覆蓋滑桿位置。 */
export const scrubbing = signal(false)

/** 除錯面板是否展開。量測工具與 HUD 都在裡面。 */
export const debugOpen = signal(false)

/** 訊息紀錄，最新的在前面。 */
export const messages = signal<string[]>([])

export function log(message: string): void {
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false })
  messages.value = [`[${time}] ${message}`, ...messages.value].slice(0, 200)
}

/**
 * 把時鐘的真實狀態同步到 signal。
 *
 * 繪製迴圈每格會做一次，但傳輸操作也必須自己叫一次 —— 否則 rAF 被瀏覽器
 * 降頻或暫停時（分頁不在前景就會），按了播放、拖了 timeline 都是畫面上沒反應。
 */
export function syncClockState(): void {
  const clock = playback.clock
  clockState.value = {
    currentTime: clock.currentTime,
    duration: clock.duration,
    playing: clock.playing,
  }
}

/** 傳輸控制。包一層只為了每次操作後把時鐘狀態同步給 UI。 */
export const transport = {
  toggle(): void {
    playback.toggle()
    syncClockState()
  },
  step(frames: number): void {
    playback.step(frames)
    syncClockState()
  },
  scrubTo(t: number): void {
    playback.scrubTo(t)
    syncClockState()
  },
  async commitScrub(): Promise<void> {
    await playback.commitScrub()
    syncClockState()
  },
  async seekTo(t: number): Promise<void> {
    await playback.seekTo(t)
    syncClockState()
  },
}

/** 局部更新渲染參數。pan 這種巢狀值要自己給完整物件。 */
export function updateParams(patch: Partial<RenderParams>): void {
  params.value = { ...params.value, ...patch }
}

export function hasAnySource(): boolean {
  const [a, b] = slots.value
  return a !== null || b !== null
}

/** 目前 stage 的長寬比，以 A 為準。沒有素材時回傳 null。 */
export function stageAspect(): number | null {
  const [a, b] = slots.value
  const info = a?.info ?? b?.info
  if (!info) return null
  return info.width / info.height
}

export function isVideo(bytes: { mimeType: string; name: string }): boolean {
  return bytes.mimeType.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(bytes.name)
}

export function isSupported(file: File): boolean {
  return isVideo({ mimeType: file.type, name: file.name }) || file.type.startsWith('image/')
}

/** 拖放進來的檔案。 */
export async function loadFile(slot: Slot, file: File): Promise<void> {
  await loadBytes(slot, new FileByteSource(file), 'drop', null)
}

/** 專案資料夾裡的素材，經本機服務以 byte-range 供應。 */
export async function loadFromProject(slot: Slot, entry: MediaEntry): Promise<void> {
  let bytes: HttpByteSource
  try {
    bytes = await HttpByteSource.open(fileUrl(entry.rel_path), {
      name: entry.name,
      mimeType: entry.kind === 'video' ? 'video/mp4' : 'image/*',
    })
  } catch (e) {
    log(`從服務取得 ${entry.name} 失敗：${e instanceof Error ? e.message : String(e)}`)
    return
  }
  await loadBytes(slot, bytes, 'project', entry.rel_path)
}

async function loadBytes(
  slot: Slot,
  bytes: ByteSource,
  origin: 'drop' | 'project',
  relPath: string | null,
): Promise<void> {
  playback.setSource(slot, null)
  setSlot(slot, null)

  const source: FrameSource = isVideo(bytes)
    ? new Mp4FrameSource(bytes)
    : new ImageFrameSource(bytes)

  try {
    await source.open()
  } catch (e) {
    log(`載入 ${bytes.name} 失敗：${e instanceof Error ? e.message : String(e)}`)
    return
  }

  playback.setSource(slot, source)
  setSlot(slot, { name: bytes.name, bytes, origin, relPath, info: source.info })
  syncClockState()

  const info = source.info
  const label = slot === 0 ? 'A' : 'B'
  log(
    `${label} = ${bytes.name}　${info.width}×${info.height}　` +
      `${info.frameRate.toFixed(2)}fps　${info.duration.toFixed(2)}s　${info.codec}`,
  )

  // 色彩標記缺漏是常態而非例外，特別是 AI 產生的片段。這裡必須講出來，
  // 因為後續所有「細節差異」的判讀都建立在這個假設上。
  if (info.colorSpace.origin === 'assumed') {
    log(`　⚠ ${label} 沒有色彩標記，已套用 BT.709 假設值`)
  }
  if (info.colorSpace.transfer === 'smpte2084' || info.colorSpace.transfer === 'arib-std-b67') {
    log(`　⚠ ${label} 是 HDR 素材（${info.colorSpace.transfer}），目前範圍外`)
  }
}

/** 拖進來的檔案：兩個一起丟依序填 A、B；一次一個填第一個空位，都滿了就換掉 B。 */
export async function acceptFiles(files: File[]): Promise<void> {
  const accepted = files.filter(isSupported)
  if (accepted.length === 0) {
    log('沒有可用的檔案。支援 mp4 與圖片。')
    return
  }

  if (accepted.length >= 2) {
    const [a, b] = accepted
    if (a) await loadFile(0, a)
    if (b) await loadFile(1, b)
    return
  }

  const file = accepted[0]
  if (!file) return
  await loadFile(slots.value[0] === null ? 0 : 1, file)
}

export function clearSlot(slot: Slot): void {
  playback.setSource(slot, null)
  setSlot(slot, null)
  syncClockState()
  log(`${slot === 0 ? 'A' : 'B'} 已清除`)
}

/**
 * single view 的 A/B 切換。
 *
 * 只換顯示哪一邊，不碰時鐘 —— 切換的用途就是「同一個時間點，兩邊長什麼樣」，
 * 播放頭一動就白切了。
 */
export function showSide(side: Slot): void {
  updateParams({ compareMode: 'single', showSource: side })
}

export function toggleSide(): void {
  showSide(params.value.showSource === 0 ? 1 : 0)
}

function setSlot(slot: Slot, state: SlotState | null): void {
  const next: [SlotState | null, SlotState | null] = [...slots.value]
  next[slot] = state
  slots.value = next
}

playback.onError = log
