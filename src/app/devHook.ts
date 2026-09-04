/**
 * `window.__qc`：只在 dev build 掛上的除錯入口。
 *
 * 存在的理由是拖放事件沒辦法用程式可靠地模擬，而每個 Phase 都要能重複跑出
 * 同一組數據來對照。產品路徑不從這裡拿任何東西 —— 它是單向的觀測窗。
 */

import {
  benchmarkResult,
  exportMeasurements,
  passthroughResult,
  probeResults,
  runBenchmark,
  runPassthroughTest,
  runProbe,
  runSeekTest,
  seekRecorder,
} from './debug'
import { currentRenderer, drawAt, frameTimer, heapMonitor } from './loop'
import { loadFile, params, playback, slots, transport, updateParams, type Slot } from './state'

const devHook = {
  /** 用 URL 載入素材，取代拖放。 */
  async loadFromUrl(slot: Slot, url: string): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`取不到 ${url}：${response.status}`)
    const blob = await response.blob()
    const name = url.split('/').pop() ?? 'unnamed'
    await loadFile(slot, new File([blob], name, { type: blob.type }))
  },

  /** 對兩軌同時下 seek 並等待供片，用來驗證 A/B 在任意時間點是否對齊。 */
  async seekAll(t: number): Promise<void> {
    await transport.seekTo(t)
    drawAt(t)
  },

  /** 直接驅動一格（推進時鐘 → 重新對位判斷 → 取格 → 繪製），繞過 rAF。 */
  tick() {
    const snapshot = playback.update()
    currentRenderer().draw(snapshot, playback.sources, params.peek())
    return {
      time: snapshot.time,
      shown: [snapshot.frames[0]?.timestamp ?? null, snapshot.frames[1]?.timestamp ?? null],
      seeking: snapshot.seeking,
      starved: snapshot.starved,
    }
  },

  get params() {
    return params.value
  },
  setParams: updateParams,
  get clock() {
    return playback.clock
  },
  playback,
  get compositor() {
    return currentRenderer().compositor
  },

  runSeekTest,
  runPassthroughTest,
  runProbe,
  runBenchmark,
  exportMeasurements,

  snapshot() {
    return {
      fps: frameTimer.fps,
      frameTimeP95Ms: frameTimer.p95,
      frameTimeWorstMs: frameTimer.worst,
      capabilities: currentRenderer().compositor.capabilities,
      renderGraph: currentRenderer().compositor.graph.names(),
      sources: slots.value.map((s) => s?.info ?? null),
      stats: playback.sources.map((s) => s?.stats() ?? null),
      lastTimestamps: [...playback.lastTimestamps],
      seek: { meanMs: seekRecorder.mean, worstMs: seekRecorder.worst },
      heapGrowthPerMinute: heapMonitor.growthPerMinute,
      passthrough: passthroughResult.value,
      benchmark: benchmarkResult.value,
      probe: probeResults.value,
    }
  },
}

;(window as unknown as { __qc: typeof devHook }).__qc = devHook
