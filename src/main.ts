/**
 * Phase 0 技術驗證的進入點。
 *
 * 這是 spike，不是產品骨架 —— UI 直接操作 DOM，沒有狀態管理，沒有後端。
 * 刻意不接服務：檔案用拖放直接拿，讓量到的數字純粹反映
 * 「解碼 + 合成」這條熱路徑，不摻雜 HTTP 供片的變數。
 *
 * 會留到 Phase 1 的是 src/core 與 src/gl 的東西，那些是 D001 定案的架構接口。
 */

import { ImageFrameSource } from './core/ImageFrameSource'
import { MasterClock } from './core/MasterClock'
import { Mp4FrameSource } from './core/Mp4FrameSource'
import { probeDecoderConcurrency, type ProbeResult } from './core/decoderProbe'
import { yieldToEventLoop } from './core/scheduling'
import type { FrameSource } from './core/FrameSource'
import {
  Compositor,
  DEFAULT_RENDER_PARAMS,
  type CompareMode,
  type Interpolation,
  type Layout,
  type RenderParams,
  type SourceDescriptor,
  type TransferFunction,
} from './gl/Compositor'
import { FrameTimer, HeapMonitor, SeekRecorder, formatBytes } from './ui/stats'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`找不到元素 #${id}`)
  return el as T
}

const canvas = $<HTMLCanvasElement>('canvas')
const logEl = $('log')

const compositor = new Compositor(canvas)
const clock = new MasterClock()
const frameTimer = new FrameTimer()
const seekRecorder = new SeekRecorder()
const heapMonitor = new HeapMonitor()

const params: RenderParams = { ...DEFAULT_RENDER_PARAMS, pan: { ...DEFAULT_RENDER_PARAMS.pan } }

/** 兩個來源槽位。第一個拖進來的是 A。 */
const sources: [FrameSource | null, FrameSource | null] = [null, null]
const sourceFiles: [File | null, File | null] = [null, null]
/** 上一幀各槽位實際上傳的影格 timestamp，用來偵測 A/B 是否錯開。 */
const lastUploaded: [number | null, number | null] = [null, null]
/**
 * 各槽位最後一次成功上傳的來源描述。
 *
 * 供片中斷時（seek 進行中、短暫缺格）沿用它，讓貼圖維持上一格的內容，
 * 畫面停住而不是黑掉或跳到別的時間點。
 */
const lastDescriptor: [SourceDescriptor | null, SourceDescriptor | null] = [null, null]

let probeResults: ProbeResult[] = []
let passthroughResult: string | null = null
let benchmarkResult: BenchmarkResult | null = null

function log(message: string): void {
  const time = new Date().toLocaleTimeString('zh-TW', { hour12: false })
  logEl.textContent = `[${time}] ${message}\n${logEl.textContent ?? ''}`
}

// ---------------------------------------------------------------- 載入來源

function isVideo(file: File): boolean {
  return file.type.startsWith('video/') || /\.(mp4|m4v|mov)$/i.test(file.name)
}

async function loadFile(slot: 0 | 1, file: File): Promise<void> {
  sources[slot]?.close()
  sources[slot] = null
  lastUploaded[slot] = null
  lastDescriptor[slot] = null

  const source: FrameSource = isVideo(file)
    ? new Mp4FrameSource(file)
    : new ImageFrameSource(file)

  try {
    await source.open()
  } catch (e) {
    log(`載入 ${file.name} 失敗：${e instanceof Error ? e.message : String(e)}`)
    return
  }

  sources[slot] = source
  sourceFiles[slot] = file

  const info = source.info
  log(
    `${slot === 0 ? 'A' : 'B'} = ${file.name}　${info.width}×${info.height}　` +
      `${info.frameRate.toFixed(2)}fps　${info.duration.toFixed(2)}s　${info.codec}`,
  )

  // 色彩標記缺漏是常態而非例外，特別是 AI 產生的片段。這裡必須講出來，
  // 因為後續所有「細節差異」的判讀都建立在這個假設上。
  if (info.colorSpace.origin === 'assumed') {
    log(`　⚠ ${slot === 0 ? 'A' : 'B'} 沒有色彩標記，已套用 BT.709 假設值`)
  }
  if (info.colorSpace.transfer === 'smpte2084' || info.colorSpace.transfer === 'arib-std-b67') {
    log(`　⚠ ${slot === 0 ? 'A' : 'B'} 是 HDR 素材（${info.colorSpace.transfer}），目前範圍外`)
  }

  syncDuration()
  refreshSourceInfo()
  refreshEnabled()
}

/** 時鐘長度取兩軌較長者。長度不一致的偵測與處理工具是 Phase 4 的工作。 */
function syncDuration(): void {
  let duration = 0
  for (const source of sources) {
    if (source) duration = Math.max(duration, source.info.duration)
  }
  clock.duration = duration
}

async function handleFiles(files: File[]): Promise<void> {
  const accepted = files.filter((f) => isVideo(f) || f.type.startsWith('image/'))
  if (accepted.length === 0) {
    log('沒有可用的檔案。支援 mp4 與圖片。')
    return
  }

  // 兩個一起丟：依序填 A、B。一次丟一個：填第一個空位，都滿了就換掉 B。
  if (accepted.length >= 2) {
    const [a, b] = accepted
    if (a) await loadFile(0, a)
    if (b) await loadFile(1, b)
  } else {
    const file = accepted[0]
    if (!file) return
    const slot: 0 | 1 = sources[0] === null ? 0 : 1
    await loadFile(slot, file)
  }

  $('dropHint').classList.toggle('hidden', sources[0] !== null || sources[1] !== null)
}

// ---------------------------------------------------------------- 繪製迴圈

function transferOf(source: FrameSource): TransferFunction {
  const tf = source.info.colorSpace.transfer
  if (tf === 'iec61966-2-1') return 'srgb'
  if (tf === 'bt709' || tf === 'smpte170m') return 'bt709'
  return 'srgb'
}

/**
 * 補齊缺席的槽位。
 *
 * 兩邊都有就直接回傳；只有一邊時，把那一格同時上傳到另一個槽位，
 * 讓 slider 與 diff 在單素材狀態下仍是有意義的（diff 會是純黑，正好是自我檢查）。
 */
function fillSingleSource(
  descriptors: [SourceDescriptor | null, SourceDescriptor | null],
  t: number,
): [SourceDescriptor, SourceDescriptor] | null {
  const a = descriptors[0]
  const b = descriptors[1]
  if (a && b) return [a, b]

  const presentSlot: 0 | 1 = a ? 0 : 1
  const present = a ?? b
  const source = sources[presentSlot]
  if (!present || !source) return null

  const sf = source.frameAt(t)
  if (!sf) return null

  const emptySlot: 0 | 1 = presentSlot === 0 ? 1 : 0
  compositor.uploadFrame(emptySlot, sf.frame)
  return [present, present]
}

/**
 * benchmark 期間鎖定的渲染解析度。
 *
 * 平常畫布跟著版面走，但那讓量測結果無法比較 —— 視窗大小一變，
 * 填充率就變，數字失去意義。更糟的是側邊欄收起時畫布可能只剩幾百像素寬，
 * 量出來的繪製成本會嚴重低估。
 */
let lockedRenderSize: { width: number; height: number } | null = null

function resizeCanvas(): void {
  let width: number
  let height: number

  if (lockedRenderSize) {
    width = lockedRenderSize.width
    height = lockedRenderSize.height
  } else {
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    width = Math.max(1, Math.round(rect.width * dpr))
    height = Math.max(1, Math.round(rect.height * dpr))
  }

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
}

/**
 * 播放頭跳到緩衝之外多遠才判定為「跳躍」而非「缺格」。
 *
 * 往前小幅超出 bufferedUntil 是解碼跟不上，等它補上就好，重新 seek 只會更慢。
 * 超過這個距離才視為使用者真的跳到別的地方。
 */
const FORWARD_JUMP_THRESHOLD = 1.0

let resyncing = false

/**
 * benchmark 進行中暫停互動繪製迴圈。
 *
 * 兩者會操作同一批 FrameSource：rAF 迴圈依「時鐘的當前時間」呼叫 advanceTo，
 * 而 benchmark 依自己的時間軸推進。同時跑的話 rAF 會釋放掉 benchmark 正要用的
 * 影格，甚至觸發不該發生的 resync，量出來的數字就不是純粹的解碼與合成成本。
 */
let interactiveLoopPaused = false

/**
 * 時鐘與來源之間的橋接。
 *
 * MasterClock 刻意不知道任何來源的存在（D001 的時基解耦），但這帶來一個缺口：
 * 時鐘可以瞬間跳到任何位置 —— 逐幀倒退、loop 繞回 0、拖動 timeline ——
 * 而來源的緩衝只涵蓋播放頭附近。沒有人負責在跳躍發生時重新 seek 的話，
 * 畫面會停在舊的那一格，而且不報錯。
 *
 * 這個函式就是那個橋。判斷依據是「需要的時間點在不在緩衝範圍內」，
 * 而不是去猜使用者做了什麼操作。
 */
function needsResync(t: number): boolean {
  for (const source of sources) {
    if (!source) continue
    const st = source.stats()
    // 往回退到已釋放的影格之前。
    if (t < st.bufferedFrom) return true
    // 往前跳得太遠，等解碼追上不切實際。
    if (t > st.bufferedUntil + FORWARD_JUMP_THRESHOLD) return true
  }
  return false
}

async function resyncTo(t: number): Promise<void> {
  if (resyncing) return
  resyncing = true
  try {
    await Promise.all(
      sources.filter((s): s is FrameSource => s !== null).map((s) => s.seek(t)),
    )
  } catch (e) {
    log(`重新對位失敗：${e instanceof Error ? e.message : String(e)}`)
  } finally {
    resyncing = false
  }
}

/**
 * 互動繪製迴圈。
 *
 * 注意這條路徑量到的 fps 被 vsync 鎖住，且分頁不在前景時 rAF 會停擺。
 * 要量餘裕請用 runBenchmark()。
 */
function render(): void {
  if (interactiveLoopPaused) {
    requestAnimationFrame(render)
    return
  }

  clock.tick()

  // 尚未載入任何素材時只是沒東西可畫，迴圈仍必須繼續轉，
  // 否則之後拖進來的檔案永遠不會被繪製。
  if (sources[0] !== null || sources[1] !== null) {
    const t = clock.currentTime
    if (!resyncing && needsResync(t)) void resyncTo(t)
    renderAt(t)
    frameTimer.mark()
  }

  heapMonitor.sample()
  refreshTransport()
  refreshPerfStats()

  requestAnimationFrame(render)
}

// ---------------------------------------------------------------- 面板更新

function refreshSourceInfo(): void {
  const rows: string[] = []
  for (let slot = 0; slot < 2; slot += 1) {
    const source = sources[slot]
    const label = slot === 0 ? 'A' : 'B'
    if (!source) {
      rows.push(`<tr><td>${label}</td><td style="color:var(--dim)">—</td></tr>`)
      continue
    }
    const info = source.info
    const cs = info.colorSpace
    const originClass = cs.origin === 'assumed' ? 'warn' : 'ok'
    const originText =
      cs.origin === 'container' ? '容器' : cs.origin === 'assumed' ? '假設' : '覆寫'
    rows.push(
      `<tr><td>${label} 解析度</td><td>${info.width}×${info.height}</td></tr>` +
        `<tr><td>${label} fps</td><td>${info.frameRate.toFixed(2)}</td></tr>` +
        `<tr><td>${label} 色彩</td><td class="${originClass}">${cs.transfer ?? '?'} · ${originText}</td></tr>`,
    )
  }

  // A/B 解析度不同時明確標示，這正是 upscale 比對的常態。
  const a = sources[0]
  const b = sources[1]
  if (a && b) {
    const sameSize = a.info.width === b.info.width && a.info.height === b.info.height
    if (!sameSize) {
      rows.push(
        `<tr><td>對齊</td><td class="warn">解析度不同，較小者以 ${params.interpolation} 放大</td></tr>`,
      )
    }
    const fpsDelta = Math.abs(a.info.frameRate - b.info.frameRate)
    if (fpsDelta > 0.01) {
      rows.push(`<tr><td>fps</td><td class="warn">兩軌不一致，Phase 4 處理</td></tr>`)
    }
  }

  $('sourceInfo').innerHTML = rows.join('')
}

function refreshPerfStats(): void {
  const caps = compositor.capabilities
  const statsA = sources[0]?.stats()
  const statsB = sources[1]?.stats()
  const bufferedBytes = (statsA?.estimatedBytes ?? 0) + (statsB?.estimatedBytes ?? 0)
  const queueTotal = (statsA?.queueSize ?? 0) + (statsB?.queueSize ?? 0)

  const fps = frameTimer.fps
  const fpsClass = fps >= 55 ? 'ok' : fps >= 28 ? 'warn' : 'bad'
  const p95 = frameTimer.p95

  // A/B 錯開一幀以上就是同步出問題，這是 T001 最關鍵的一項。
  const tsA = lastUploaded[0]
  const tsB = lastUploaded[1]
  let syncText = '—'
  let syncClass = ''
  if (tsA !== null && tsB !== null) {
    const deltaMs = Math.abs(tsA - tsB) * 1000
    const frameMs = 1000 / Math.max(1, sources[0]?.info.frameRate ?? 30)
    syncText = `${deltaMs.toFixed(1)} ms`
    syncClass = deltaMs <= frameMs * 0.5 ? 'ok' : deltaMs <= frameMs * 1.5 ? 'warn' : 'bad'
  }

  const growth = heapMonitor.growthPerMinute
  const growthClass = growth > 20 * 1024 * 1024 ? 'bad' : growth > 5 * 1024 * 1024 ? 'warn' : 'ok'

  const rows = [
    ['fps', `<span class="${fpsClass}">${fps.toFixed(1)}</span>`],
    ['影格時間 p95', `${p95.toFixed(1)} ms`],
    ['最差影格', `${frameTimer.worst.toFixed(1)} ms`],
    ['A/B 時間差', `<span class="${syncClass}">${syncText}</span>`],
    ['緩衝影格', `${statsA?.buffered ?? 0} / ${statsB?.buffered ?? 0}`],
    ['緩衝估算 (NV12)', formatBytes(bufferedBytes)],
    ['解碼佇列', String(queueTotal)],
    ['已釋放影格', String((statsA?.dropped ?? 0) + (statsB?.dropped ?? 0))],
    [
      'seek 延遲',
      seekRecorder.count > 0
        ? `${seekRecorder.mean.toFixed(0)} / ${seekRecorder.worst.toFixed(0)} ms`
        : '—',
    ],
    [
      '中間緩衝',
      caps.halfFloatRenderable
        ? '<span class="ok">rgba16f</span>'
        : '<span class="bad">rgba8（線性光不成立）</span>',
    ],
  ]

  if (heapMonitor.available) {
    rows.push(['JS heap', formatBytes(heapMonitor.current)])
    rows.push([
      'heap 成長',
      `<span class="${growthClass}">${formatBytes(Math.max(0, growth))}/min</span>`,
    ])
  }

  $('perfStats').innerHTML = rows
    .map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`)
    .join('')
}

let scrubbing = false

function refreshTransport(): void {
  const duration = clock.duration
  $<HTMLSpanElement>('timeLabel').textContent =
    duration > 0 ? `${clock.currentTime.toFixed(3)} / ${duration.toFixed(3)} s` : '— / —'
  if (!scrubbing && duration > 0) {
    $<HTMLInputElement>('scrub').value = String((clock.currentTime / duration) * 1000)
  }
  $<HTMLButtonElement>('playBtn').textContent = clock.playing ? '暫停' : '播放'
}

function refreshEnabled(): void {
  const has = sources[0] !== null || sources[1] !== null
  for (const id of [
    'playBtn', 'stepBack', 'stepFwd', 'scrub', 'seekTest', 'passthroughTest', 'benchBtn',
  ]) {
    $<HTMLButtonElement>(id).disabled = !has
  }
  // 並行探測需要真的影片，圖片沒有解碼器可測。
  const hasVideo = sourceFiles.some((f) => f !== null && isVideo(f))
  $<HTMLButtonElement>('probeBtn').disabled = !hasVideo
}

// ---------------------------------------------------------------- 驗證動作

/**
 * Seek 測試：跳到片長的數個位置並記錄延遲。
 *
 * 量的是「使用者拖了 timeline 之後，多久看到正確畫面」，
 * 所以計時包含回溯 keyframe 與往前解碼的完整成本。
 */
async function runSeekTest(): Promise<void> {
  const duration = clock.duration
  if (duration <= 0) return

  const wasPlaying = clock.playing
  clock.pause()
  seekRecorder.reset()
  log('開始 seek 測試…')

  const targets = [0.1, 0.5, 0.9, 0.25, 0.75, 0.05, 0.6].map((r) => r * duration)
  for (const target of targets) {
    const latency = await seekRecorder.measure(target, async () => {
      clock.setTime(target)
      await Promise.all(sources.filter((s): s is FrameSource => s !== null).map((s) => s.seek(target)))
    })
    log(`　seek → ${target.toFixed(2)}s：${latency.toFixed(0)} ms`)
  }

  log(`seek 測試完成：平均 ${seekRecorder.mean.toFixed(0)} ms、最差 ${seekRecorder.worst.toFixed(0)} ms`)
  if (wasPlaying) clock.play()
}

/**
 * 色彩來回驗證。
 *
 * 把同一個來源同時當成 A 和 B，用 diff 模式渲染：結果必須是純黑。
 * 不是黑的話代表「輸入 → 線性 → 輸出」這條路上有東西動了像素，
 * 那麼之後所有的細節差異判讀都不可信。這是 T001 使用者驗收的自動化版本。
 */
function runPassthroughTest(): void {
  const source = sources[0] ?? sources[1]
  if (!source) return

  const saved = { ...params }
  params.layout = 'single'
  params.compareMode = 'diff'
  params.diffGain = 1
  params.toneMap = false
  params.zoom = 1
  params.pan = { x: 0, y: 0 }

  const sf = source.frameAt(clock.currentTime)
  if (!sf) {
    log('色彩來回：目前沒有可用影格')
    Object.assign(params, saved)
    return
  }

  // 兩個槽位上傳同一格。
  compositor.uploadFrame(0, sf.frame)
  compositor.uploadFrame(1, sf.frame)
  const tf = transferOf(source)
  const desc: SourceDescriptor = {
    width: sf.frame.displayWidth,
    height: sf.frame.displayHeight,
    transfer: tf,
  }
  compositor.render([desc, desc], params)

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

  Object.assign(params, saved)

  const total = pixels.length / 4
  const pct = ((nonZero / total) * 100).toFixed(3)
  passthroughResult = `最大偏差 ${maxDelta}/255、非零像素 ${pct}%`

  if (maxDelta === 0) {
    log(`色彩來回：✅ 完全無損（${passthroughResult}）`)
  } else if (maxDelta <= 1) {
    log(`色彩來回：✅ 僅 8-bit 捨入誤差（${passthroughResult}）`)
  } else {
    log(`色彩來回：❌ 管線改變了像素值（${passthroughResult}）—— 線性光轉換有問題`)
  }
}

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

/**
 * 可持續播放率量測。
 *
 * 不用 requestAnimationFrame 的兩個理由：
 *  1. rAF 被 vsync 鎖在顯示器更新率上，量不出「還有多少餘裕」——
 *     而 Phase 0 要回答的是餘裕夠不夠，不是能不能剛好畫滿 60Hz。
 *  2. 分頁不在前景時 rAF 會被暫停，量測直接歸零。
 *
 * 關鍵是每一格都必須「等到真的解出來」才算數。少了這道等待，迴圈會用同一張
 * 舊貼圖狂畫，量出四位數的假 fps —— 那是繪製吞吐量，不是播放能力。
 *
 * 等待與繪製分開計時，因為兩者的瓶頸解法完全不同：等待佔比高要調預讀深度或
 * 換解碼路徑，繪製佔比高才是 shader 與貼圖上傳的問題。
 *
 * 每格結束呼叫 gl.finish() 強制 GPU 完成，所以繪製時間是保守上限：
 * 真實播放會管線化，實際只會更好。
 */
async function runBenchmark(
  durationMs = 5000,
  renderSize: { width: number; height: number } = { width: 2560, height: 1440 },
): Promise<BenchmarkResult | null> {
  const a = sources[0]
  const b = sources[1]
  const primary = a ?? b
  if (!primary) return null

  const active = [a, b].filter((s): s is FrameSource => s !== null)
  const wasPlaying = clock.playing
  clock.pause()
  interactiveLoopPaused = true
  lockedRenderSize = renderSize

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
  // 計時要等暖機結束才開，否則第一批查詢會帶著十幾毫秒的初始化成本進統計，
  // 讓平均值被單一離群值拉高到比 p95 還大。
  for (let i = 0; i < 8; i += 1) renderAt(i * step)
  await Promise.all(active.map((s) => s.seek(0)))
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
    while (!allReadyAt(active, t)) {
      if (performance.now() - waitStart > FRAME_WAIT_TIMEOUT_MS) {
        timedOut = true
        break
      }
      for (const s of active) s.advanceTo(t)
      await yieldToEventLoop()
    }
    const waited = performance.now() - waitStart
    waitTotalMs += waited
    waitWorstMs = Math.max(waitWorstMs, waited)
    if (timedOut) starved += 1

    const renderStart = performance.now()
    const info = renderAt(t)
    const renderMs = performance.now() - renderStart

    renderTotalMs += renderMs
    renderTimer.push(renderMs)
    frames += 1
    peakBufferedBytes = Math.max(peakBufferedBytes, info.bufferedBytes)

    t += step
    if (t >= primary.info.duration) {
      t = 0
      await Promise.all(active.map((s) => s.seek(0)))
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
  lockedRenderSize = null
  interactiveLoopPaused = false
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
  benchmarkResult = result
  return result
}

/** 兩軌是否都已備妥時間 t 的影格。 */
function allReadyAt(active: FrameSource[], t: number): boolean {
  for (const source of active) {
    if (source.stats().bufferedUntil < t) return false
  }
  return true
}

/** 在指定時間繪製一格，回傳這一格的供片狀況。benchmark 與互動迴圈共用同一條路徑。 */
function renderAt(t: number): { starved: boolean; bufferedBytes: number } {
  resizeCanvas()

  const descriptors: [SourceDescriptor | null, SourceDescriptor | null] = [null, null]
  let starved = false
  let bufferedBytes = 0

  // 任一軌正在 seek 就兩軌都凍住。
  //
  // 兩個理由。其一，seek 期間解碼器從 keyframe 一路往目標解，途中經過的影格是
  // 真的，畫出來就變成「快轉過去」的閃爍 —— 單 keyframe 的 4K 素材最明顯。
  // 其二，兩軌的 seek 不會同時完成，先到的那軌若先更新，A/B 會短暫錯開，
  // 分割線兩側就對不上了。
  const anySeeking = sources.some((s) => s !== null && s.stats().seeking)

  for (const slot of [0, 1] as const) {
    const source = sources[slot]
    if (!source) continue

    source.advanceTo(t)
    const sf = anySeeking ? null : source.frameAt(t)
    bufferedBytes += source.stats().estimatedBytes

    if (!sf) {
      // 沒有可用影格：保留上一次上傳的貼圖與描述，畫面停住。
      starved = true
      descriptors[slot] = lastDescriptor[slot]
      continue
    }
    // 解碼跟不上時 frameAt 會回傳舊的那一格，畫面等於卡住。
    if (lastUploaded[slot] !== null && sf.timestamp === lastUploaded[slot] && t > sf.timestamp) {
      const frameDuration = 1 / (source.info.frameRate || 30)
      if (t - sf.timestamp > frameDuration * 1.5) starved = true
    }

    compositor.uploadFrame(slot, sf.frame)
    lastUploaded[slot] = sf.timestamp
    const descriptor: SourceDescriptor = {
      width: sf.frame.displayWidth,
      height: sf.frame.displayHeight,
      transfer: transferOf(source),
    }
    descriptors[slot] = descriptor
    lastDescriptor[slot] = descriptor
  }

  const pair = fillSingleSource(descriptors, t)
  if (pair) compositor.render(pair, params)

  return { starved, bufferedBytes }
}

async function runProbe(): Promise<void> {
  const file = sourceFiles.find((f) => f !== null && isVideo(f))
  if (!file) return

  const wasPlaying = clock.playing
  clock.pause()

  const btn = $<HTMLButtonElement>('probeBtn')
  btn.disabled = true
  probeResults = []
  log('開始並行解碼探測（每輪 2 秒）…')

  try {
    probeResults = await probeDecoderConcurrency(file, {
      maxStreams: PROBE_MAX_STREAMS,
      durationMs: 2000,
      onProgress: (r) => {
        const mark = r.realtime ? '✅' : '❌'
        log(
          `　${r.streams} 路：合計 ${r.totalFps.toFixed(1)}fps、` +
            `每路 ${r.perStreamFps.toFixed(1)}fps ${mark}`,
        )
      },
    })

    const lastGood = [...probeResults].reverse().find((r) => r.realtime)
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
    btn.disabled = false
    if (wasPlaying) clock.play()
  }
}

/** 把量測結果存成 JSON，貼回 T001 的執行紀錄用。 */
function exportMeasurements(): void {
  const payload = {
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    compositor: compositor.capabilities,
    sources: sources.map((s, i) =>
      s
        ? {
            slot: i === 0 ? 'A' : 'B',
            name: sourceFiles[i]?.name ?? null,
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
    buffers: sources.map((s) => s?.stats() ?? null),
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
    passthrough: passthroughResult,
    benchmark: benchmarkResult,
    decoderConcurrency: probeResults,
    renderParams: params,
  }

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `quickcomparer-phase0-${Date.now()}.json`
  a.click()
  URL.revokeObjectURL(url)
  log('已匯出量測 JSON')
}

// ---------------------------------------------------------------- 事件綁定

document.addEventListener('dragover', (e) => {
  e.preventDefault()
  document.body.classList.add('dragging')
})
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget === null) document.body.classList.remove('dragging')
})
document.addEventListener('drop', (e) => {
  e.preventDefault()
  document.body.classList.remove('dragging')
  void handleFiles(Array.from(e.dataTransfer?.files ?? []))
})

$('playBtn').addEventListener('click', () => clock.toggle())
$('stepBack').addEventListener('click', () => stepFrames(-1))
$('stepFwd').addEventListener('click', () => stepFrames(1))

/**
 * 逐幀步進。
 *
 * 只設定時鐘，實際的補位交給 render 迴圈的 needsResync —— 往前一格通常直接命中
 * 緩衝，往回一格則命中 advanceTo 保留的歷史格，兩種情況都不需要 seek。
 * 只有退超過保留範圍時才會觸發真正的 seek。
 */
function stepFrames(n: number): void {
  clock.pause()
  const fps = sources[0]?.info.frameRate ?? sources[1]?.info.frameRate ?? 30
  clock.step(n, fps)
}

const scrub = $<HTMLInputElement>('scrub')
scrub.addEventListener('pointerdown', () => {
  scrubbing = true
})
scrub.addEventListener('pointerup', () => {
  scrubbing = false
})
scrub.addEventListener('input', () => {
  const duration = clock.duration
  if (duration <= 0) return
  const target = (Number(scrub.value) / 1000) * duration
  clock.setTime(target)
  // 拖動時不逐格 seek 解碼器 —— 那會讓拖動變成一連串 flush。
  // 放開後才對齊，這也是 Phase 2 要做的 scrub 策略雛形。
})
scrub.addEventListener('change', () => {
  const target = clock.currentTime
  void Promise.all(
    sources.filter((s): s is FrameSource => s !== null).map((s) => s.seek(target)),
  )
})

$<HTMLSelectElement>('layout').addEventListener('change', (e) => {
  params.layout = (e.target as HTMLSelectElement).value as Layout
})
$<HTMLSelectElement>('compareMode').addEventListener('change', (e) => {
  params.compareMode = (e.target as HTMLSelectElement).value as CompareMode
})
$<HTMLSelectElement>('interp').addEventListener('change', (e) => {
  params.interpolation = (e.target as HTMLSelectElement).value as Interpolation
  refreshSourceInfo()
})
$<HTMLSelectElement>('outputTf').addEventListener('change', (e) => {
  params.outputTransfer = (e.target as HTMLSelectElement).value as TransferFunction
})
$<HTMLInputElement>('toneMap').addEventListener('change', (e) => {
  params.toneMap = (e.target as HTMLInputElement).checked
})
$<HTMLInputElement>('splitPos').addEventListener('input', (e) => {
  params.splitPos = Number((e.target as HTMLInputElement).value)
})
$<HTMLInputElement>('splitAngle').addEventListener('input', (e) => {
  params.splitAngle = (Number((e.target as HTMLInputElement).value) * Math.PI) / 180
})
$<HTMLInputElement>('diffGain').addEventListener('input', (e) => {
  params.diffGain = Number((e.target as HTMLInputElement).value)
})
$<HTMLInputElement>('zoom').addEventListener('input', (e) => {
  params.zoom = Number((e.target as HTMLInputElement).value) / 100
})
$('resetView').addEventListener('click', () => {
  params.zoom = 1
  params.pan = { x: 0, y: 0 }
  $<HTMLInputElement>('zoom').value = '100'
})

$('seekTest').addEventListener('click', () => void runSeekTest())
$('passthroughTest').addEventListener('click', runPassthroughTest)
$('benchBtn').addEventListener('click', () => void runBenchmark())
$('probeBtn').addEventListener('click', () => void runProbe())
$('exportBtn').addEventListener('click', exportMeasurements)

// 滾輪縮放、拖曳平移。A/B 同步套用 —— 細節比對時這比 slider 本身更常用。
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    const factor = Math.exp(-e.deltaY * 0.0015)
    params.zoom = Math.min(8, Math.max(0.1, params.zoom * factor))
    $<HTMLInputElement>('zoom').value = String(Math.round(params.zoom * 100))
  },
  { passive: false },
)

/**
 * 畫面上的直接操作。
 *
 * 分割線用數值滑桿調很難用 —— 比對時眼睛在畫面上，手卻要跑到側欄。
 * 所以：靠近分割線按下就抓住它拖動，離線遠的地方按下才是平移。
 * 抓住時按住 Alt 改為旋轉角度。
 */

/** 抓取分割線的容許距離（畫布像素）。 */
const SPLIT_GRAB_PX = 14

type DragMode =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'split' }
  /** 旋轉時鎖定按下當下的支點，中途放開 Alt 也不會讓線突然跳走。 */
  | { kind: 'rotate'; pivot: { x: number; y: number } }

let drag: DragMode | null = null
/** 最後一次的游標位置，供 Alt 按放時即時更新游標樣式。 */
let lastPointer: PointerEvent | null = null

/** 目前 stage 的長寬比。分割線的座標換算需要它。 */
function currentStageAspect(): number | null {
  const source = sources[0] ?? sources[1]
  if (!source) return null
  return source.info.width / source.info.height
}

/** 把滑鼠事件換算成畫布像素座標。 */
function toCanvasPixels(e: PointerEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
}

/** 游標到分割線的距離（畫布像素）。不在 slider 模式或算不出來時回傳 null。 */
function distanceToSplit(e: PointerEvent): number | null {
  if (params.layout !== 'single' || params.compareMode !== 'slider') return null
  const aspect = currentStageAspect()
  if (aspect === null) return null

  const px = toCanvasPixels(e)
  const stage = compositor.toStageSpace(px.x, px.y, aspect, params)
  if (!stage) return null

  const normal = { x: Math.cos(params.splitAngle), y: Math.sin(params.splitAngle) }
  const halfExtent = compositor.splitHalfExtent(aspect, params)
  const offset = (params.splitPos * 2 - 1) * halfExtent
  const d = stage.x * normal.x + stage.y * normal.y - offset

  return Math.abs(d) * compositor.stageUnitInPixels(aspect, params)
}

/** 依游標位置設定分割線位置。 */
function setSplitFromPointer(e: PointerEvent): void {
  const aspect = currentStageAspect()
  if (aspect === null) return
  const px = toCanvasPixels(e)
  const stage = compositor.toStageSpace(px.x, px.y, aspect, params)
  if (!stage) return

  const normal = { x: Math.cos(params.splitAngle), y: Math.sin(params.splitAngle) }
  const halfExtent = compositor.splitHalfExtent(aspect, params)
  if (halfExtent === 0) return

  const projected = stage.x * normal.x + stage.y * normal.y
  params.splitPos = Math.min(1, Math.max(0, (projected / halfExtent + 1) / 2))
  $<HTMLInputElement>('splitPos').value = String(params.splitPos)
}

/** 分割線上離畫面中心最近的那一點，也就是旋轉支點。與 shader 畫的圓環同一點。 */
function splitPivot(aspect: number): { x: number; y: number } {
  const halfExtent = compositor.splitHalfExtent(aspect, params)
  const offset = (params.splitPos * 2 - 1) * halfExtent
  return {
    x: Math.cos(params.splitAngle) * offset,
    y: Math.sin(params.splitAngle) * offset,
  }
}

/**
 * 繞著支點旋轉分割線。
 *
 * 直接用「游標相對畫面中心的方位」當角度的話，線會在旋轉時同時滑走 ——
 * 因為 splitPos 是「離畫面中心的距離」，角度一變，同樣的距離就落在別的位置。
 * 改成鎖定支點：轉完之後重算 splitPos，讓線仍然通過原本那一點。
 *
 * 狀態仍然只有 splitPos 與 splitAngle 兩個值，支點只是互動當下算出來的，
 * 不會進入儲存的參數，所以之後設 keyframe 不受影響。
 */
function rotateAroundPivot(e: PointerEvent, pivot: { x: number; y: number }): void {
  const aspect = currentStageAspect()
  if (aspect === null) return
  const px = toCanvasPixels(e)
  const stage = compositor.toStageSpace(px.x, px.y, aspect, params)
  if (!stage) return

  const dx = stage.x - pivot.x
  const dy = stage.y - pivot.y
  if (dx === 0 && dy === 0) return

  // splitAngle 是法線方向，使用者的直覺是「線跟著游標指」，所以加 90 度。
  params.splitAngle = Math.atan2(dy, dx) + Math.PI / 2

  // 重算 splitPos，讓線維持通過支點。
  const halfExtent = compositor.splitHalfExtent(aspect, params)
  if (halfExtent > 0) {
    const projected = pivot.x * Math.cos(params.splitAngle) + pivot.y * Math.sin(params.splitAngle)
    params.splitPos = Math.min(1, Math.max(0, (projected / halfExtent + 1) / 2))
    $<HTMLInputElement>('splitPos').value = String(params.splitPos)
  }

  $<HTMLInputElement>('splitAngle').value = String(Math.round(normalizedSplitDegrees()))
}

/**
 * 分割角度換算成滑桿用的度數。
 *
 * 分割線是 180 度週期的（轉半圈就回到同一條線），所以正規化到 (-90, 90]
 * 才能對上滑桿的範圍，也避免拖過頭時數值突然跳到另一端。
 */
function normalizedSplitDegrees(): number {
  const degrees = (params.splitAngle * 180) / Math.PI
  let normalized = ((degrees % 180) + 180) % 180
  if (normalized > 90) normalized -= 180
  return normalized
}

/** 依目前狀態決定游標，讓「可移動／可旋轉／可平移」看得出來。 */
function updateCursor(e: PointerEvent | null): void {
  if (drag) {
    canvas.style.cursor =
      drag.kind === 'split' ? 'grabbing' : drag.kind === 'rotate' ? 'crosshair' : 'move'
    return
  }
  if (!e) return
  const distance = distanceToSplit(e)
  const onLine = distance !== null && distance <= SPLIT_GRAB_PX
  canvas.style.cursor = onLine ? (e.altKey ? 'crosshair' : 'grab') : 'default'
}

canvas.addEventListener('pointerdown', (e) => {
  lastPointer = e
  const distance = distanceToSplit(e)
  const aspect = currentStageAspect()

  if (distance !== null && distance <= SPLIT_GRAB_PX && aspect !== null) {
    if (e.altKey) {
      drag = { kind: 'rotate', pivot: splitPivot(aspect) }
      rotateAroundPivot(e, drag.pivot)
    } else {
      drag = { kind: 'split' }
      setSplitFromPointer(e)
    }
  } else {
    drag = { kind: 'pan', x: e.clientX, y: e.clientY }
  }
  updateCursor(e)
  canvas.setPointerCapture(e.pointerId)
})

canvas.addEventListener('pointermove', (e) => {
  lastPointer = e

  if (!drag) {
    updateCursor(e)
    return
  }

  if (drag.kind === 'split') {
    setSplitFromPointer(e)
  } else if (drag.kind === 'rotate') {
    rotateAroundPivot(e, drag.pivot)
  } else {
    const rect = canvas.getBoundingClientRect()
    params.pan.x += (e.clientX - drag.x) / rect.width / params.zoom
    params.pan.y -= (e.clientY - drag.y) / rect.height / params.zoom
    drag = { kind: 'pan', x: e.clientX, y: e.clientY }
  }
})

canvas.addEventListener('pointerup', (e) => {
  drag = null
  updateCursor(e)
  canvas.releasePointerCapture(e.pointerId)
})

canvas.addEventListener('pointerleave', () => {
  if (!drag) canvas.style.cursor = 'default'
})

// 按放 Alt 時即時反映游標，不必等使用者移動滑鼠才看得出模式變了。
for (const type of ['keydown', 'keyup'] as const) {
  document.addEventListener(type, (e) => {
    if (e.key === 'Alt') updateCursor(lastPointer)
  })
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
  switch (e.key) {
    case ' ':
      e.preventDefault()
      clock.toggle()
      break
    case 'ArrowLeft':
      e.preventDefault()
      stepFrames(-1)
      break
    case 'ArrowRight':
      e.preventDefault()
      stepFrames(1)
      break
    case 's':
    case 'S':
      params.compareMode = 'single'
      params.showSource = params.showSource === 0 ? 1 : 0
      $<HTMLSelectElement>('compareMode').value = 'single'
      break
  }
})

// ---------------------------------------------------------------- 除錯掛勾

/**
 * 讓自動化驗證能繞過拖放載入素材。
 *
 * 拖放事件沒辦法用程式可靠地模擬，而 Phase 0 的重點就是要能重複跑出數據。
 * 這是 spike 專用的東西，不會進 Phase 1 的產品骨架。
 */
interface DebugHook {
  loadFromUrl(slot: 0 | 1, url: string): Promise<void>
  /** 對兩軌同時下 seek 並等待供片，用來驗證 A/B 在任意時間點是否對齊。 */
  seekAll(t: number): Promise<void>
  params: RenderParams
  clock: MasterClock
  runSeekTest(): Promise<void>
  runPassthroughTest(): void
  runProbe(): Promise<void>
  runBenchmark(
    durationMs?: number,
    renderSize?: { width: number; height: number },
  ): Promise<BenchmarkResult | null>
  snapshot(): unknown
}

const debugHook: DebugHook = {
  async loadFromUrl(slot, url) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`取不到 ${url}：${response.status}`)
    const blob = await response.blob()
    const name = url.split('/').pop() ?? 'unnamed'
    await loadFile(slot, new File([blob], name, { type: blob.type }))
    $('dropHint').classList.add('hidden')
  },
  async seekAll(t) {
    clock.setTime(t)
    await Promise.all(
      sources.filter((s): s is FrameSource => s !== null).map((s) => s.seek(t)),
    )
    renderAt(t)
  },
  params,
  clock,
  runSeekTest,
  runPassthroughTest,
  runProbe,
  runBenchmark,
  snapshot: () => ({
    fps: frameTimer.fps,
    frameTimeP95Ms: frameTimer.p95,
    frameTimeWorstMs: frameTimer.worst,
    capabilities: compositor.capabilities,
    sources: sources.map((s) => (s ? s.info : null)),
    stats: sources.map((s) => s?.stats() ?? null),
    lastUploaded: [...lastUploaded],
    seek: { meanMs: seekRecorder.mean, worstMs: seekRecorder.worst },
    heapGrowthPerMinute: heapMonitor.growthPerMinute,
    passthrough: passthroughResult,
    benchmark: benchmarkResult,
    probe: probeResults,
  }),
}

;(window as unknown as { __qc: DebugHook }).__qc = debugHook

// ---------------------------------------------------------------- 啟動

const caps = compositor.capabilities
log(`GPU：${caps.renderer}`)
log(
  caps.halfFloatRenderable
    ? '✅ half-float render target 可用，線性光管線成立'
    : '❌ half-float render target 不可用，已退回 rgba8（線性光合成不正確）',
)
if (typeof VideoDecoder === 'undefined') {
  log('❌ 此瀏覽器沒有 WebCodecs，整套架構無法驗證')
}

refreshPerfStats()
requestAnimationFrame(render)
