/**
 * mp4 的 FrameSource 實作：WebCodecs VideoDecoder + 影格 ring buffer。
 *
 * 記憶體策略（D001 的核心設計規則）：影格一律維持 VideoFrame 原生形態（硬體解碼
 * 通常是 NV12，4K 約 12.4 MB/幀），只在合成當下才由 compositor 上傳成貼圖。
 * 絕不預先把整段解碼成 RGBA（4K half-float 為 66.4 MB/幀，預讀緩衝會直接爆掉）。
 */

import { demuxMp4, type DemuxedSample, type DemuxResult } from './demux'
import { yieldToEventLoop } from './scheduling'
import {
  assumedSdrColorSpace,
  type ColorSpaceInfo,
  type FrameSource,
  type FrameSourceInfo,
  type FrameSourceStats,
  type SourceFrame,
} from './FrameSource'

/** 預讀深度（影格數）。太淺會來不及供片，太深會吃滿 VRAM —— Phase 0 要量的就是這個平衡點。 */
const DEFAULT_LOOKAHEAD = 16

/**
 * 播放頭「之後」保留的影格數。
 *
 * 逐幀來回檢視是比對工具最核心的操作，若只保留當前那一格，每按一次倒退都要
 * 重新 seek（單 keyframe 檔案要價 50–150ms），操作感會很差。
 * 代價是 4K 每格 12.4 MB，保留 4 格約 50 MB —— 對這個用途值得。
 */
const DEFAULT_HISTORY = 4

/** 解碼器佇列上限，避免一次灌爆解碼器。 */
const MAX_DECODE_QUEUE = 8

/**
 * seek 解到目標的逾時上限。
 *
 * 只有一個 keyframe 的長片段最壞情況要從頭解完整段，所以這個值不能太小；
 * 但也不能沒有上限，否則解碼器出問題時整個 UI 會卡死。
 */
const SEEK_TIMEOUT_MS = 8000

/**
 * 影格與播放頭的最大容許時間差（秒）。
 *
 * 超過這個距離的影格視同「沒有」，讓畫面停在上一格而不是跳到不相干的時間點。
 */
const STALE_TOLERANCE = 0.5

export interface Mp4FrameSourceOptions {
  lookahead?: number
  /** 播放頭之前保留的影格數，供逐幀倒退使用。 */
  history?: number
  /** 覆寫容器的色彩標記。D001 要求的第三項接口。 */
  colorSpaceOverride?: ColorSpaceInfo
}

export class Mp4FrameSource implements FrameSource {
  #file: File
  #options: Mp4FrameSourceOptions
  #demuxed: DemuxResult | null = null
  #decoder: VideoDecoder | null = null
  #info: FrameSourceInfo | null = null

  /** 已解碼、依 timestamp 遞增排序的影格。 */
  #buffer: SourceFrame[] = []
  /** 下一個要送進解碼器的 sample 索引。 */
  #nextSample = 0
  /** seek 世代編號：用來丟棄 flush 之前送出、但在 flush 之後才回來的影格。 */
  #generation = 0
  #playhead = 0

  #decoded = 0
  #dropped = 0
  #error: Error | null = null
  /** seek 進行中。期間不供片，避免中途影格被畫出來造成閃爍。 */
  #seeking = false

  constructor(file: File, options: Mp4FrameSourceOptions = {}) {
    this.#file = file
    this.#options = options
  }

  get info(): FrameSourceInfo {
    if (!this.#info) throw new Error('FrameSource 尚未 open()')
    return this.#info
  }

  async open(): Promise<void> {
    const demuxed = await demuxMp4(this.#file)
    this.#demuxed = demuxed

    const support = await VideoDecoder.isConfigSupported(demuxed.config)
    if (!support.supported) {
      throw new Error(`此環境不支援解碼 ${demuxed.codec}`)
    }

    this.#info = {
      width: demuxed.width,
      height: demuxed.height,
      duration: demuxed.duration,
      frameRate: demuxed.frameRate,
      codec: demuxed.codec,
      colorSpace: this.#resolveColorSpace(demuxed.colorSpace),
    }

    this.#createDecoder()
    this.#pump()
  }

  /**
   * 容器標記缺漏時補上假設值，但保留 origin 讓 UI 能顯示「這是猜的」。
   * 使用者覆寫優先於容器標記。
   */
  #resolveColorSpace(fromContainer: ColorSpaceInfo): ColorSpaceInfo {
    if (this.#options.colorSpaceOverride) {
      return { ...this.#options.colorSpaceOverride, origin: 'user-override' }
    }
    const assumed = assumedSdrColorSpace()
    const anyKnown =
      fromContainer.primaries !== null ||
      fromContainer.transfer !== null ||
      fromContainer.matrix !== null
    return {
      primaries: fromContainer.primaries ?? assumed.primaries,
      transfer: fromContainer.transfer ?? assumed.transfer,
      matrix: fromContainer.matrix ?? assumed.matrix,
      fullRange: fromContainer.fullRange ?? assumed.fullRange,
      origin: anyKnown ? 'container' : 'assumed',
    }
  }

  #createDecoder(): void {
    const demuxed = this.#demuxed
    if (!demuxed) throw new Error('FrameSource 尚未 open()')

    const generationAtCreate = this.#generation
    this.#decoder = new VideoDecoder({
      output: (frame) => {
        // flush 之前送進去的影格可能晚於 seek 才吐出來，必須丟棄，否則會插進錯誤的時間點。
        if (this.#generation !== generationAtCreate) {
          frame.close()
          return
        }
        this.#decoded += 1
        this.#insertFrame({ frame, timestamp: frame.timestamp / 1e6 })
      },
      error: (e) => {
        this.#error = e instanceof Error ? e : new Error(String(e))
      },
    })
    this.#decoder.configure(demuxed.config)
  }

  /** 依 timestamp 插入緩衝並維持排序。B-frame 會讓輸出順序非遞增，不能只用 push。 */
  #insertFrame(sf: SourceFrame): void {
    const buf = this.#buffer
    let i = buf.length
    while (i > 0) {
      const prev = buf[i - 1]
      if (prev && prev.timestamp <= sf.timestamp) break
      i -= 1
    }
    buf.splice(i, 0, sf)
  }

  /** 補滿預讀緩衝。 */
  #pump(): void {
    const demuxed = this.#demuxed
    const decoder = this.#decoder
    if (!demuxed || !decoder || decoder.state !== 'configured') return

    const lookahead = this.#options.lookahead ?? DEFAULT_LOOKAHEAD

    // 預讀深度只算「播放頭之後」的影格。用整個緩衝長度會把為了逐幀倒退保留的
    // 歷史格算進去，等於偷偷縮短預讀，播放時就會開始缺格。
    let ahead = 0
    for (const sf of this.#buffer) {
      if (sf.timestamp >= this.#playhead) ahead += 1
    }

    while (
      ahead < lookahead &&
      decoder.decodeQueueSize < MAX_DECODE_QUEUE &&
      this.#nextSample < demuxed.samples.length
    ) {
      ahead += 1
      const sample = demuxed.samples[this.#nextSample]
      if (!sample) break
      this.#nextSample += 1
      decoder.decode(toChunk(sample))
    }
  }

  frameAt(t: number): SourceFrame | null {
    let found: SourceFrame | null = null
    for (const sf of this.#buffer) {
      if (sf.timestamp > t) break
      found = sf
    }

    if (found) {
      // 找到的影格離 t 太遠就不能用。
      //
      // seek 進行中緩衝裡只剩重新解碼的起點附近（可能是片頭），此時「最新且早於 t
      // 的影格」在技術上存在但內容完全不相干，畫面會閃一下別的時間點。
      // 回傳 null 讓呼叫端沿用上一格，畫面會停住而不是亂跳。
      // 播放時的短暫缺格仍在容許範圍內，會照常顯示稍舊的那一格。
      return t - found.timestamp <= STALE_TOLERANCE ? found : null
    }

    // 播放頭還在第一格之前（例如 B 軌的首格帶有位移），給最早的一格而不是空畫面，
    // 但同樣要求它就在附近。
    const earliest = this.#buffer[0]
    if (earliest && earliest.timestamp - t <= STALE_TOLERANCE) return earliest
    return null
  }

  advanceTo(t: number): void {
    this.#playhead = t

    // 釋放已經用不到的影格。這是 D001 標記的 OOM 主因，必須每幀都做。
    //
    // 但不是只留當前那一格：往前多留 history 格，讓逐幀倒退能直接命中緩衝，
    // 不必為了退一格而重新 seek。
    let current = 0
    for (let i = 0; i < this.#buffer.length; i += 1) {
      const sf = this.#buffer[i]
      if (!sf || sf.timestamp > t) break
      current = i
    }
    const keepFrom = Math.max(0, current - (this.#options.history ?? DEFAULT_HISTORY))

    for (let i = 0; i < keepFrom; i += 1) {
      const sf = this.#buffer[i]
      if (sf) {
        sf.frame.close()
        this.#dropped += 1
      }
    }
    if (keepFrom > 0) this.#buffer = this.#buffer.slice(keepFrom)

    this.#pump()
  }

  async seek(t: number): Promise<void> {
    const demuxed = this.#demuxed
    if (!demuxed) throw new Error('FrameSource 尚未 open()')

    const target = Math.max(0, Math.min(t, demuxed.duration))

    // 標記 seek 中。單 keyframe 的 4K 素材要從頭解到目標，途中會經過大量影格，
    // 其中落在容許距離內的若被畫出來，看起來就是快轉閃爍。
    this.#seeking = true

    // 世代 +1，讓還在飛的影格在回來時被丟棄。
    this.#generation += 1
    this.#releaseBuffer()

    const decoder = this.#decoder
    if (decoder && decoder.state !== 'closed') {
      decoder.close()
    }
    this.#createDecoder()

    this.#nextSample = this.#keyframeIndexBefore(target)
    this.#playhead = target
    this.#pump()

    // 必須一路解到目標時間，不能只等「第一格」。
    //
    // 只有一個 keyframe 的檔案（AI 生成與匯出的片段非常常見 —— 實測
    // be_mokey_after_v1.mp4 整支 193 格只有 1 個 keyframe）跳到片尾要從頭解完整段。
    // 若在第一格就回報完成，seek 會「成功」但畫面停在片頭，而且完全不報錯。
    try {
      await this.#decodeUntil(target)
    } finally {
      this.#seeking = false
    }
  }

  /** 找出 target 之前最近的 keyframe。往回解是唯一能取得正確畫面的方式。 */
  #keyframeIndexBefore(target: number): number {
    const demuxed = this.#demuxed
    if (!demuxed) return 0
    let result = 0
    for (const idx of demuxed.keyframeIndices) {
      const sample = demuxed.samples[idx]
      if (!sample || sample.timestamp > target) break
      result = idx
    }
    return result
  }

  /**
   * 從目前的解碼位置一路解到 target。
   *
   * 每一輪都呼叫 advanceTo(target) 把早於目標的影格釋放掉，緩衝才不會塞滿而讓
   * pump 停住 —— 這是「解過去再丟掉」得以持續推進的關鍵。
   */
  async #decodeUntil(target: number): Promise<void> {
    const demuxed = this.#demuxed
    if (!demuxed) return

    const deadline = performance.now() + SEEK_TIMEOUT_MS

    while (performance.now() < deadline) {
      if (this.#error) throw this.#error

      // 釋放過期影格並補送樣本。
      this.advanceTo(target)

      const newest = this.#buffer[this.#buffer.length - 1]
      if (newest && newest.timestamp >= target) return

      const decoder = this.#decoder
      const exhausted =
        this.#nextSample >= demuxed.samples.length && (decoder?.decodeQueueSize ?? 0) === 0

      if (exhausted) {
        // 檔尾：B-frame 重排會讓解碼器扣住最後幾格，必須 flush 才吐得出來。
        if (decoder && decoder.state === 'configured') {
          await decoder.flush().catch(() => undefined)
        }
        return
      }

      await yieldToEventLoop()
    }
  }

  stats(): FrameSourceStats {
    const info = this.#info
    // NV12：每像素 1.5 bytes。這是硬體解碼路徑的實際佔用，用來對照 D001 的估算。
    const bytesPerFrame = info ? info.width * info.height * 1.5 : 0
    const newest = this.#buffer[this.#buffer.length - 1]
    const oldest = this.#buffer[0]
    return {
      buffered: this.#buffer.length,
      decoded: this.#decoded,
      dropped: this.#dropped,
      queueSize: this.#decoder?.decodeQueueSize ?? 0,
      estimatedBytes: this.#buffer.length * bytesPerFrame,
      seeking: this.#seeking,
      bufferedFrom: oldest ? oldest.timestamp : Infinity,
      bufferedUntil: newest ? newest.timestamp : -Infinity,
    }
  }

  /** 目前播放頭。供 HUD 顯示緩衝相對位置。 */
  get playhead(): number {
    return this.#playhead
  }

  get lastError(): Error | null {
    return this.#error
  }

  /**
   * 釋放整個緩衝。
   *
   * 這裡也要計入 #dropped，讓 `decoded === dropped + buffered` 成為恆真的不變式。
   * 少算 seek 釋放掉的影格會讓帳目對不起來，而 VideoFrame 洩漏正是靠這個等式抓的
   * —— 帳目不平就代表有影格沒被 close()。
   */
  #releaseBuffer(): void {
    for (const sf of this.#buffer) {
      sf.frame.close()
      this.#dropped += 1
    }
    this.#buffer = []
  }

  close(): void {
    this.#generation += 1
    this.#releaseBuffer()
    const decoder = this.#decoder
    if (decoder && decoder.state !== 'closed') decoder.close()
    this.#decoder = null
  }
}

function toChunk(sample: DemuxedSample): EncodedVideoChunk {
  return new EncodedVideoChunk({
    type: sample.isKeyframe ? 'key' : 'delta',
    timestamp: Math.round(sample.timestamp * 1e6),
    duration: Math.round(sample.duration * 1e6),
    data: sample.data,
  })
}
