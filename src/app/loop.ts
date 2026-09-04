/**
 * 互動繪製迴圈。
 *
 * 注意這條路徑量到的 fps 被 vsync 鎖住，且分頁不在前景時 rAF 會停擺 ——
 * 要量餘裕請用除錯面板的 benchmark，它自己掌握時間軸。
 */

import { signal } from '@preact/signals'
import { FrameTimer, HeapMonitor } from '../ui/stats'
import { Renderer } from './Renderer'
import { clockState, log, params, playback, scrubbing } from './state'

let renderer: Renderer | null = null
let running = false

/**
 * benchmark 進行中暫停互動迴圈。
 *
 * 兩者會操作同一批 FrameSource：rAF 迴圈依「時鐘的當前時間」呼叫 advanceTo，
 * 而 benchmark 依自己的時間軸推進。同時跑的話 rAF 會釋放掉 benchmark 正要用的
 * 影格，甚至觸發不該發生的 resync，量出來的數字就不是純粹的解碼與合成成本。
 */
export let paused = false

export const frameTimer = new FrameTimer()
export const heapMonitor = new HeapMonitor()

/** 供片狀態，除錯 HUD 用。更新頻率刻意壓低，不需要每格重繪面板。 */
export const liveStats = signal({ starved: false, bufferedBytes: 0, seeking: false })

const STATS_INTERVAL_MS = 250
let lastStatsAt = 0

export function setPaused(value: boolean): void {
  paused = value
}

export function initRenderer(canvas: HTMLCanvasElement): Renderer {
  renderer?.dispose()
  renderer = new Renderer(canvas)

  // 能力回報要等 Renderer 就緒才問得到，所以放這裡而不是進入點 ——
  // Viewer 的 effect 比進入點的 microtask 晚跑。
  const caps = renderer.compositor.capabilities
  log(`GPU：${caps.renderer}`)
  log(
    caps.halfFloatRenderable
      ? '✅ half-float render target 可用，線性光管線成立'
      : '❌ half-float render target 不可用，已退回 rgba8（線性光合成不正確）',
  )
  if (typeof VideoDecoder === 'undefined') {
    log('❌ 此瀏覽器沒有 WebCodecs，整套架構無法運作')
  }

  return renderer
}

/** 給 UI 用：Renderer 在 Viewer 掛載時才建立，元件可能比它早畫一次。 */
export function rendererOrNull(): Renderer | null {
  return renderer
}

export function currentRenderer(): Renderer {
  if (!renderer) throw new Error('Renderer 尚未初始化')
  return renderer
}

/** 在指定時間取一格並畫出來，不推進時鐘。量測與離線渲染用。 */
export function drawAt(t: number): void {
  const r = currentRenderer()
  r.draw(playback.sampleAt(t), playback.sources, params.peek())
}

export function startLoop(): void {
  if (running) return
  running = true
  requestAnimationFrame(tick)
}

function tick(now: number): void {
  requestAnimationFrame(tick)
  if (paused || !renderer) return

  // 時鐘無論如何都要走。尚未載入任何素材時只是沒東西可畫，
  // 迴圈仍必須繼續轉，否則之後拖進來的檔案永遠不會被繪製。
  const snapshot = playback.update()
  if (playback.hasSource) {
    renderer.draw(snapshot, playback.sources, params.peek())
    frameTimer.mark()
  }
  heapMonitor.sample()

  // 拖動 timeline 期間不要回寫時間，否則滑桿會跟自己打架。
  if (!scrubbing.peek()) {
    const clock = playback.clock
    const previous = clockState.peek()
    if (
      previous.currentTime !== clock.currentTime ||
      previous.playing !== clock.playing ||
      previous.duration !== clock.duration
    ) {
      clockState.value = {
        currentTime: clock.currentTime,
        duration: clock.duration,
        playing: clock.playing,
      }
    }
  }

  if (now - lastStatsAt >= STATS_INTERVAL_MS) {
    lastStatsAt = now
    liveStats.value = {
      starved: snapshot.starved,
      bufferedBytes: snapshot.bufferedBytes,
      seeking: snapshot.seeking,
    }
  }
}
