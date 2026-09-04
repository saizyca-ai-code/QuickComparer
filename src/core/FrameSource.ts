/**
 * FrameSource：所有素材來源的統一介面。
 *
 * 這是 D001 列為硬性架構約束的第一項接口。mp4（WebCodecs）與日後的 EXR 序列
 * （WASM 解碼）解碼路徑完全不同，但都必須收斂到這個介面，讓 compositor 與
 * timeline 不需要知道素材的容器形式。
 *
 * 兩項相關約束也體現在這裡：
 *  - 時基與容器解耦：所有時間一律使用「秒」，由 MasterClock 驅動，不使用容器的 timescale。
 *  - 色彩 metadata 可外部覆寫：colorSpace 是可被呼叫端取代的資料，而非唯讀的容器事實。
 */

/** 色彩描述。容器標記經常缺漏或錯誤（特別是 AI 產生的片段），所以每一項都可能是 null。 */
export interface ColorSpaceInfo {
  /** 色域原色，如 'bt709'、'smpte170m'。null 代表容器未標記。 */
  primaries: string | null
  /** 轉換函數（gamma），如 'bt709'、'iec61966-2-1'（sRGB）。null 代表容器未標記。 */
  transfer: string | null
  /** YUV 矩陣，如 'bt709'、'smpte170m'。null 代表容器未標記。 */
  matrix: string | null
  /** true = full range (0-255)，false = limited range (16-235)，null = 未標記。 */
  fullRange: boolean | null
  /** 這份描述的來源，用來讓使用者知道有多少是猜的。 */
  origin: 'container' | 'assumed' | 'user-override'
}

/** 容器沒給任何色彩標記時的假設值。SDR 影片的實務預設。 */
export function assumedSdrColorSpace(): ColorSpaceInfo {
  return {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    fullRange: false,
    origin: 'assumed',
  }
}

export interface FrameSourceInfo {
  width: number
  height: number
  /** 秒。 */
  duration: number
  /** 標稱影格率。EXR 序列沒有內嵌 timebase，會由呼叫端宣告。 */
  frameRate: number
  colorSpace: ColorSpaceInfo
  /** 除錯用的編碼描述，如 'avc1.640028'。 */
  codec: string
}

/**
 * 一個已解出、可供合成的影格。
 *
 * frame 的擁有權屬於 FrameSource；呼叫端不得自行 close()。這是 D001 記錄的
 * OOM 風險來源 —— VideoFrame 佔的是 GPU 記憶體，釋放時機必須集中管理。
 */
export interface SourceFrame {
  frame: VideoFrame
  /** 秒。 */
  timestamp: number
}

export interface FrameSource {
  readonly info: FrameSourceInfo

  /** 開啟並準備解碼。必須在其他呼叫之前完成。 */
  open(): Promise<void>

  /**
   * 取得時間 t（秒）當下應顯示的影格，即 timestamp <= t 之中最接近的一格。
   * 尚未解到時回傳 null，呼叫端應沿用上一格而非阻塞。
   */
  frameAt(t: number): SourceFrame | null

  /**
   * 告知來源播放頭位置，讓它預讀後續影格並釋放已過期的影格。
   * 每次 render 都應呼叫。
   */
  advanceTo(t: number): void

  /** 跳轉。會清空既有緩衝並自 t 之前最近的 keyframe 重新解碼。 */
  seek(t: number): Promise<void>

  /** 目前緩衝狀態，供 HUD 與效能量測使用。 */
  stats(): FrameSourceStats

  /** 釋放所有資源，包含尚未使用的 VideoFrame。 */
  close(): void
}

export interface FrameSourceStats {
  /** 目前持有的已解碼影格數。 */
  buffered: number
  /** 累計解碼影格數。 */
  decoded: number
  /** 因為播放頭已越過而被釋放的影格數。 */
  dropped: number
  /** 解碼器佇列長度。持續成長代表解碼跟不上播放。 */
  queueSize: number
  /** 估計的影格緩衝記憶體用量（bytes），以 NV12 計。 */
  estimatedBytes: number
  /**
   * 目前緩衝中最早的影格時間（秒）。
   *
   * 播放頭退到這之前就代表需要的影格已經被釋放，必須重新 seek。
   * 沒有時間概念的來源（例如靜態圖）回傳 -Infinity。
   */
  bufferedFrom: number
  /**
   * 目前已備妥的最新影格時間（秒）。
   *
   * 這是判斷供片健康度的唯一可靠依據：小於播放頭就代表正在缺格，
   * 而 frameAt() 這時仍會回傳舊的那一格，光看它分不出「畫面沒動」和「解碼跟不上」。
   * 沒有時間概念的來源（例如靜態圖）回傳 Infinity。
   */
  bufferedUntil: number
  /**
   * 是否正在 seek。
   *
   * seek 期間解碼器會從 keyframe 一路解到目標，中途的影格雖然真實存在，
   * 但依序畫出來會變成「快轉過去」的閃爍。呼叫端應在此期間沿用上一格。
   */
  seeking: boolean
}
