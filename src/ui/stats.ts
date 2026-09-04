/**
 * Phase 0 的量測工具。
 *
 * T001 要的是數據，不是感覺。這裡收集的每一項都對應驗收清單上的一條：
 * fps、VRAM 估算、seek 延遲、記憶體是否隨時間持續成長。
 */

export class FrameTimer {
  #samples: number[] = []
  #capacity: number
  #last: number | null = null

  constructor(capacity = 120) {
    this.#capacity = capacity
  }

  /** 以「距離上次呼叫的間隔」記一筆。用於自由運行的繪製迴圈。 */
  mark(): void {
    const now = performance.now()
    if (this.#last !== null) {
      this.push(now - this.#last)
    }
    this.#last = now
  }

  /**
   * 直接記入一段已量好的耗時。
   *
   * benchmark 需要把「等待解碼」和「繪製」分開計時，用 mark() 的間隔量法會把
   * 兩者混在一起，分不出瓶頸在哪一端。
   */
  push(ms: number): void {
    this.#samples.push(ms)
    if (this.#samples.length > this.#capacity) this.#samples.shift()
  }

  reset(): void {
    this.#samples = []
    this.#last = null
  }

  get fps(): number {
    const avg = this.mean
    return avg > 0 ? 1000 / avg : 0
  }

  get mean(): number {
    if (this.#samples.length === 0) return 0
    let sum = 0
    for (const s of this.#samples) sum += s
    return sum / this.#samples.length
  }

  /**
   * 第 95 百分位的影格時間。
   *
   * 平均值會把卡頓藏起來 —— 60fps 的平均配上偶發的 200ms 停頓，
   * 使用者感受到的是後者。比對工具的卡頓特別明顯，所以要盯 p95。
   */
  get p95(): number {
    if (this.#samples.length === 0) return 0
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    return sorted[idx] ?? 0
  }

  get worst(): number {
    if (this.#samples.length === 0) return 0
    return Math.max(...this.#samples)
  }
}

export interface SeekMeasurement {
  target: number
  latencyMs: number
}

export class SeekRecorder {
  #measurements: SeekMeasurement[] = []

  async measure(target: number, seek: () => Promise<void>): Promise<number> {
    const started = performance.now()
    await seek()
    const latency = performance.now() - started
    this.#measurements.push({ target, latencyMs: latency })
    if (this.#measurements.length > 50) this.#measurements.shift()
    return latency
  }

  get last(): number {
    return this.#measurements[this.#measurements.length - 1]?.latencyMs ?? 0
  }

  get mean(): number {
    if (this.#measurements.length === 0) return 0
    let sum = 0
    for (const m of this.#measurements) sum += m.latencyMs
    return sum / this.#measurements.length
  }

  get worst(): number {
    if (this.#measurements.length === 0) return 0
    return Math.max(...this.#measurements.map((m) => m.latencyMs))
  }

  get count(): number {
    return this.#measurements.length
  }

  all(): SeekMeasurement[] {
    return [...this.#measurements]
  }

  reset(): void {
    this.#measurements = []
  }
}

/**
 * JS 堆的取樣。
 *
 * 注意這量不到 VideoFrame 佔的 GPU 記憶體 —— 那部分只能靠 NV12 公式估算，
 * 由 FrameSource.stats() 提供。這裡的用途是回答另一個問題：
 * 長時間播放時 JS 端有沒有洩漏。performance.memory 是 Chromium 專屬。
 */
export interface HeapSample {
  timestamp: number
  usedBytes: number
}

interface PerformanceWithMemory extends Performance {
  memory?: { usedJSHeapSize: number }
}

export class HeapMonitor {
  #samples: HeapSample[] = []
  #started = performance.now()

  get available(): boolean {
    return (performance as PerformanceWithMemory).memory !== undefined
  }

  sample(): void {
    const memory = (performance as PerformanceWithMemory).memory
    if (!memory) return
    this.#samples.push({
      timestamp: (performance.now() - this.#started) / 1000,
      usedBytes: memory.usedJSHeapSize,
    })
    if (this.#samples.length > 600) this.#samples.shift()
  }

  get current(): number {
    return this.#samples[this.#samples.length - 1]?.usedBytes ?? 0
  }

  /**
   * 每分鐘的成長趨勢（bytes）。
   * 持續為正代表有洩漏，多半是 VideoFrame 沒有被 close。
   */
  get growthPerMinute(): number {
    if (this.#samples.length < 10) return 0
    const first = this.#samples[0]
    const last = this.#samples[this.#samples.length - 1]
    if (!first || !last) return 0
    const seconds = last.timestamp - first.timestamp
    if (seconds < 1) return 0
    return ((last.usedBytes - first.usedBytes) / seconds) * 60
  }

  all(): HeapSample[] {
    return [...this.#samples]
  }

  reset(): void {
    this.#samples = []
    this.#started = performance.now()
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}
