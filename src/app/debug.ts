/**
 * 量測與驗證工具。
 *
 * 這些是開發用的東西，不是產品功能：只在除錯面板裡出現，`window.__qc` 也只在
 * dev build 掛上。之所以留著而不是刪掉，是因為 T001 的九項修正裡有好幾項的
 * 回歸驗證靠它們 —— 色彩來回、影格帳目、seek 成本、並行上限，每個 Phase 都要重測。
 */

import { signal } from '@preact/signals'
import { probeDecoderConcurrency, type ProbeResult } from '../core/decoderProbe'
import { yieldToEventLoop } from '../core/scheduling'
import type { SourceDescriptor } from '../gl/params'
import { FrameTimer, SeekRecorder, formatBytes } from '../ui/stats'
import { currentRenderer, drawAt, frameTimer, heapMonitor, setPaused } from './loop'
import { isVideo, log, params, playback, slots } from './state'

export interface BenchmarkResult {
  /** 可持續的播放影格率：完成的相異影格數除以總耗時。 */
  fps: number
  /** 素材的標稱影格率，用來對照 fps 是否足夠。 */
  nominalFps: number
  /** 是否撐得住即時播放。 */
  realtime: boolean
  frames: number
  /** 量測時鎖定的渲染解析度。填充率會直接影響繪製時間，不記下來數字無法比較。 */
  renderWidth: number
  renderHeight: number
  /** CPU 端送出繪製指令的耗時。這不是 GPU 的執行時間。 */
  submitMeanMs: number
  submitP95Ms: number
  /** GPU 實際執行合成的耗時，由 timer query 取得。 */
  gpuMeanMs: number | null
  gpuP95Ms: number | null
  gpuWorstMs: number | null
  /** 因 GPU disjoint 而作廢的量測筆數。 */
  gpuDiscarded: number
  /**
   * 影格帳目是否平衡：每一軌都必須滿足 decoded === dropped + buffered。
   * 不平就代表有 VideoFrame 沒被 close()，那是 GPU 記憶體洩漏。
   */
  frameLedgerBalanced: boolean
  /** 單格等待解碼供片的耗時。 */
  waitMeanMs: number
  waitWorstMs: number
  /**
   * 等待時間佔總時間的比例。
   * 接近 1 代表瓶頸在解碼，接近 0 代表瓶頸在合成 —— 兩者的解法完全不同。
   */
  decodeBoundRatio: number
  /** 有幾格是等到逾時才放行的。 */
  starved: number
  peakBufferedBytes: number
  heapGrowthPerMinute: number
}

/** 等單一影格供片就緒的逾時上限。超過就當作缺格，不無限等下去。 */
const FRAME_WAIT_TIMEOUT_MS = 500

/**
 * 並行解碼探測的路數上限。
 *
 * 不設太高有實際理由：一旦超過硬體解碼器的 session 上限，解碼器會崩潰且不會
 * 自動恢復，後續新建的解碼器也吐不出影格，必須重載頁面。探測本身就有這個風險。
 */
const PROBE_MAX_STREAMS = 12

export const seekRecorder = new SeekRecorder()
export const passthroughResult = signal<string | null>(null)
export const benchmarkResult = signal<BenchmarkResult | null>(null)
export const probeResults = signal<ProbeResult[]>([])
export const busy = signal<string | null>(null)

/**
 * Seek 測試：跳到片長的數個位置並記錄延遲。
 *
 * 量的是「使用者拖了 timeline 之後，多久看到正確畫面」，
 * 所以計時包含回溯 keyframe 與往前解碼的完整成本。
 */
export async function runSeekTest(): Promise<void> {
  const clock = playback.clock
  const duration = clock.duration
  if (duration <= 0) return

  const wasPlaying = clock.playing
  clock.pause()
  seekRecorder.reset()
  busy.value = 'seek 測試'
  log('開始 seek 測試…')

  try {
    const targets = [0.1, 0.5, 0.9, 0.25, 0.75, 0.05, 0.6].map((r) => r * duration)
    for (const target of targets) {
      const latency = await seekRecorder.measure(target, async () => {
        await playback.seekTo(target)
      })
      log(`　seek → ${target.toFixed(2)}s：${latency.toFixed(0)} ms`)
    }
    log(
      `seek 測試完成：平均 ${seekRecorder.mean.toFixed(0)} ms、` +
        `最差 ${seekRecorder.worst.toFixed(0)} ms`,
    )
  } finally {
    busy.value = null
    if (wasPlaying) clock.play()
  }
}

/**
 * 色彩來回驗證。
 *
 * 把同一個來源同時當成 A 和 B，用 diff 模式渲染：結果必須是純黑。
 * 不是黑的話代表「輸入 → 線性 → 輸出」這條路上有東西動了像素，
 * 那麼之後所有的細節差異判讀都不可信。這是 T001 使用者驗收的自動化版本。
 */
export function runPassthroughTest(): void {
  const source = playback.sources[0] ?? playback.sources[1]
  if (!source) return

  const compositor = currentRenderer().compositor
  const sf = source.frameAt(playback.clock.currentTime)
  if (!sf) {
    log('色彩來回：目前沒有可用影格')
    return
  }

  // 兩個槽位上傳同一格。
  compositor.uploadFrame(0, sf.frame)
  compositor.uploadFrame(1, sf.frame)
  const desc: SourceDescriptor = {
    width: sf.frame.displayWidth,
    height: sf.frame.displayHeight,
    transfer: source.info.colorSpace.transfer === 'iec61966-2-1' ? 'srgb' : 'bt709',
  }
  compositor.render([desc, desc], {
    ...params.peek(),
    layout: 'single',
    compareMode: 'diff',
    diffGain: 1,
    toneMap: false,
    zoom: 1,
    pan: { x: 0, y: 0 },
  })

  const pixels = compositor.readPixels()
  let maxDelta = 0
  let nonZero = 0
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i] ?? 0
    const g = pixels[i + 1] ?? 0
    const b = pixels[i + 2] ?? 0
    const worst = Math.max(r, g, b)
    if (worst > 0) nonZero += 1
    if (worst > maxDelta) maxDelta = worst
  }

  const total = pixels.length / 4
  const pct = ((nonZero / total) * 100).toFixed(3)
  const summary = `最大偏差 ${maxDelta}/255、非零像素 ${pct}%`
  passthroughResult.value = summary

  if (maxDelta === 0) {
    log(`色彩來回：✅ 完全無損（${summary}）`)
  } else if (maxDelta <= 1) {
    log(`色彩來回：✅ 僅 8-bit 捨入誤差（${summary}）`)
  } else {
    log(`色彩來回：❌ 管線改變了像素值（${summary}）—— 線性光轉換有問題`)
  }
}

/**
 * 可持續播放率量測。
 *
 * 不用 requestAnimationFrame 的兩個理由：
 *  1. rAF 被 vsync 鎖在顯示器更新率上，量不出「還有多少餘裕」。
 *  2. 分頁不在前景時 rAF 會被暫停，量測直接歸零。
 *
 * 關鍵是每一格都必須「等到真的解出來」才算數。少了這道等待，迴圈會用同一張
 * 舊貼圖狂畫，量出四位數的假 fps —— 那是繪製吞吐量，不是播放能力。
 *
 * 等待與繪製分開計時，因為兩者的瓶頸解法完全不同：等待佔比高要調預讀深度或
 * 換解碼路徑，繪製佔比高才是 shader 與貼圖上傳的問題。
 */
export async function runBenchmark(
  durationMs = 5000,
  renderSize: { width: number; height: number } = { width: 2560, height: 1440 },
): Promise<BenchmarkResult | null> {
  const active = playback.activeSources()
  const primary = active[0]
  if (!primary) return null

  const renderer = currentRenderer()
  const compositor = renderer.compositor
  const clock = playback.clock
  const wasPlaying = clock.playing
  clock.pause()
  setPaused(true)
  renderer.lockedSize = renderSize
  busy.value = 'benchmark'

  const nominalFps = primary.info.frameRate || 30
  const step = 1 / nominalFps
  const renderTimer = new FrameTimer(20_000)
  heapMonitor.reset()

  let frames = 0
  let starved = 0
  let peakBufferedBytes = 0
  let waitTotalMs = 0
  let waitWorstMs = 0
  let renderTotalMs = 0

  // 暖機：把 shader 編譯、首次貼圖配置與 FBO 建立排除在成績之外。
  // 計時要等暖機結束才開，否則第一批查詢會帶著十幾毫秒的初始化成本進統計。
  for (let i = 0; i < 8; i += 1) drawAt(i * step)
  await playback.seekTo(0)
  compositor.gpuTimer.reset()
  compositor.setTimingEnabled(true)

  log(
    `benchmark 開始（${(durationMs / 1000).toFixed(0)}s、素材 ` +
      `${primary.info.width}×${primary.info.height}、輸出 ` +
      `${renderSize.width}×${renderSize.height}、標稱 ${nominalFps.toFixed(2)}fps）…`,
  )

  const started = performance.now()
  let t = 0

  while (performance.now() - started < durationMs) {
    // 等到兩軌都備妥這個時間點的影格。
    const waitStart = performance.now()
    let timedOut = false
    while (!playback.readyAt(t)) {
      if (performance.now() - waitStart > FRAME_WAIT_TIMEOUT_MS) {
        timedOut = true
        break
      }
      playback.advanceTo(t)
      await yieldToEventLoop()
    }
    const waited = performance.now() - waitStart
    waitTotalMs += waited
    waitWorstMs = Math.max(waitWorstMs, waited)
    if (timedOut) starved += 1

    const renderStart = performance.now()
    const snapshot = playback.sampleAt(t)
    renderer.draw(snapshot, playback.sources, params.peek())
    const renderMs = performance.now() - renderStart

    renderTotalMs += renderMs
    renderTimer.push(renderMs)
    frames += 1
    peakBufferedBytes = Math.max(peakBufferedBytes, snapshot.bufferedBytes)

    t += step
    if (t >= primary.info.duration) {
      t = 0
      await playback.seekTo(0)
    }

    await yieldToEventLoop()
    heapMonitor.sample()
  }

  const elapsed = (performance.now() - started) / 1000

  // 收尾：timer query 的結果會晚幾幀才回來，多輪詢幾次把在飛的取回。
  for (let i = 0; i < 10; i += 1) {
    compositor.gpuTimer.poll()
    await yieldToEventLoop()
  }
  compositor.setTimingEnabled(false)
  renderer.lockedSize = null
  setPaused(false)
  busy.value = null
  if (wasPlaying) clock.play()

  const gpu = compositor.gpuTimer
  const fps = frames / elapsed
  const busyMs = waitTotalMs + renderTotalMs
  const result: BenchmarkResult = {
    fps,
    nominalFps,
    realtime: fps >= nominalFps * 0.95,
    frames,
    renderWidth: renderSize.width,
    renderHeight: renderSize.height,
    submitMeanMs: renderTimer.mean,
    submitP95Ms: renderTimer.p95,
    gpuMeanMs: gpu.count > 0 ? gpu.mean : null,
    gpuP95Ms: gpu.count > 0 ? gpu.p95 : null,
    gpuWorstMs: gpu.count > 0 ? gpu.worst : null,
    gpuDiscarded: gpu.discarded,
    waitMeanMs: frames > 0 ? waitTotalMs / frames : 0,
    waitWorstMs,
    decodeBoundRatio: busyMs > 0 ? waitTotalMs / busyMs : 0,
    starved,
    peakBufferedBytes,
    heapGrowthPerMinute: heapMonitor.growthPerMinute,
    frameLedgerBalanced: active.every((s) => {
      const st = s.stats()
      return st.decoded === st.dropped + st.buffered
    }),
  }

  const gpuText =
    result.gpuMeanMs !== null
      ? `GPU ${result.gpuMeanMs.toFixed(3)}ms（p95 ${result.gpuP95Ms?.toFixed(3)}）`
      : 'GPU 無法量測'
  log(
    `benchmark：${fps.toFixed(1)} fps（標稱 ${nominalFps.toFixed(0)}）` +
      `${result.realtime ? ' ✅' : ' ❌'}　` +
      `${gpuText}、送出 ${result.submitMeanMs.toFixed(2)}ms、` +
      `等待 ${result.waitMeanMs.toFixed(2)}ms、` +
      `解碼佔比 ${(result.decodeBoundRatio * 100).toFixed(0)}%、` +
      `逾時 ${starved}、峰值緩衝 ${formatBytes(peakBufferedBytes)}、` +
      `影格帳目 ${result.frameLedgerBalanced ? '平衡 ✅' : '不平 ❌（有影格未釋放）'}`,
  )
  benchmarkResult.value = result
  return result
}

export async function runProbe(): Promise<void> {
  const file = slots.value.find((s) => s !== null && isVideo(s.file))?.file
  if (!file) return

  const clock = playback.clock
  const wasPlaying = clock.playing
  clock.pause()
  probeResults.value = []
  busy.value = '並行解碼探測'
  log('開始並行解碼探測（每輪 2 秒）…')

  try {
    const results = await probeDecoderConcurrency(file, {
      maxStreams: PROBE_MAX_STREAMS,
      durationMs: 2000,
      onProgress: (r) => {
        log(
          `　${r.streams} 路：合計 ${r.totalFps.toFixed(1)}fps、` +
            `每路 ${r.perStreamFps.toFixed(1)}fps ${r.realtime ? '✅' : '❌'}`,
        )
      },
    })
    probeResults.value = results

    const lastGood = [...results].reverse().find((r) => r.realtime)
    const hitCap = lastGood?.streams === PROBE_MAX_STREAMS

    // 全部都通過時代表撞到的是測試上限，不是硬體上限。這兩者必須講清楚，
    // 否則會把「至少 N 路」誤讀成「最多 N 路」，Grid 的規格就會訂錯。
    log(
      !lastGood
        ? '探測完成：連 1 路都無法即時解碼'
        : hitCap
          ? `探測完成：至少 ${lastGood.streams} 路可即時解碼（已達測試上限，實際上限更高）`
          : `探測完成：此環境可即時解 ${lastGood.streams} 路 ${file.name}，再多會掉幀`,
    )
  } catch (e) {
    log(`探測失敗：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    busy.value = null
    if (wasPlaying) clock.play()
  }
}

/** 把量測結果存成 JSON，貼回 Task 的執行紀錄用。 */
export function exportMeasurements(): void {
  const payload = {
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    compositor: currentRenderer().compositor.capabilities,
    renderGraph: currentRenderer().compositor.graph.names(),
    sources: slots.value.map((s, i) =>
      s
        ? {
            slot: i === 0 ? 'A' : 'B',
            name: s.name,
            width: s.info.width,
            height: s.info.height,
            frameRate: s.info.frameRate,
            duration: s.info.duration,
            codec: s.info.codec,
            colorSpace: s.info.colorSpace,
          }
        : null,
    ),
    playback: {
      fps: frameTimer.fps,
      frameTimeMeanMs: frameTimer.mean,
      frameTimeP95Ms: frameTimer.p95,
      frameTimeWorstMs: frameTimer.worst,
    },
    buffers: playback.sources.map((s) => s?.stats() ?? null),
    seek: {
      meanMs: seekRecorder.mean,
      worstMs: seekRecorder.worst,
      measurements: seekRecorder.all(),
    },
    heap: {
      available: heapMonitor.available,
      currentBytes: heapMonitor.current,
      growthBytesPerMinute: heapMonitor.growthPerMinute,
    },
    passthrough: passthroughResult.value,
    benchmark: benchmarkResult.value,
    decoderConcurrency: probeResults.value,
    renderParams: params.value,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `quickcomparer-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
  log('已匯出量測 JSON')
}
