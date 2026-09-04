/**
 * GPU 端的耗時量測。
 *
 * 為什麼不能用 gl.finish()：Chromium 把 WebGL 指令送到獨立的 GPU 行程執行，
 * finish() 只保證指令離開了 renderer 行程的 command buffer，不保證 GPU 做完。
 * 實測 64×64 與 7680×4320 用 finish() 量到的時間完全相同（約 0.32ms），
 * 那個數字是 JS 與 IPC 的開銷，跟填充率無關 —— 拿它當效能依據會得到錯誤結論。
 *
 * EXT_disjoint_timer_query_webgl2 量的是 GPU 實際執行時間，而且是非同步的：
 * 送出查詢後不會卡住管線，結果在數幀之後才取回。
 */

interface TimerExtension {
  TIME_ELAPSED_EXT: number
  GPU_DISJOINT_EXT: number
}

/** 同時在飛的查詢上限。結果通常延遲 2–3 幀回來，多備幾個避免每幀都要新建。 */
const POOL_SIZE = 8

export class GpuTimer {
  #gl: WebGL2RenderingContext
  #ext: TimerExtension | null
  #pool: WebGLQuery[] = []
  #inFlight: WebGLQuery[] = []
  #active: WebGLQuery | null = null
  #samples: number[] = []
  #capacity: number
  /** GPU 發生 disjoint（例如電源狀態改變）時，那批結果不可信，必須丟掉。 */
  #discarded = 0

  constructor(gl: WebGL2RenderingContext, capacity = 2000) {
    this.#gl = gl
    this.#capacity = capacity
    this.#ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null
  }

  get available(): boolean {
    return this.#ext !== null
  }

  get discarded(): number {
    return this.#discarded
  }

  begin(): void {
    const ext = this.#ext
    if (!ext || this.#active) return
    // 池子空了就先不量這一幀，別為了量測而配置資源。
    const query = this.#pool.pop() ?? (this.#inFlight.length < POOL_SIZE ? this.#gl.createQuery() : null)
    if (!query) return
    this.#gl.beginQuery(ext.TIME_ELAPSED_EXT, query)
    this.#active = query
  }

  end(): void {
    const ext = this.#ext
    if (!ext || !this.#active) return
    this.#gl.endQuery(ext.TIME_ELAPSED_EXT)
    this.#inFlight.push(this.#active)
    this.#active = null
  }

  /** 收回已完成的查詢結果。每幀呼叫一次，成本很低。 */
  poll(): void {
    const gl = this.#gl
    const ext = this.#ext
    if (!ext) return

    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean
    const remaining: WebGLQuery[] = []

    for (const query of this.#inFlight) {
      const done = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean
      if (!done) {
        remaining.push(query)
        continue
      }
      if (disjoint) {
        this.#discarded += 1
      } else {
        const nanoseconds = gl.getQueryParameter(query, gl.QUERY_RESULT) as number
        this.#samples.push(nanoseconds / 1e6)
        if (this.#samples.length > this.#capacity) this.#samples.shift()
      }
      this.#pool.push(query)
    }

    this.#inFlight = remaining
  }

  get count(): number {
    return this.#samples.length
  }

  get mean(): number {
    if (this.#samples.length === 0) return 0
    let sum = 0
    for (const s of this.#samples) sum += s
    return sum / this.#samples.length
  }

  get p95(): number {
    if (this.#samples.length === 0) return 0
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
    return sorted[idx] ?? 0
  }

  get worst(): number {
    return this.#samples.length === 0 ? 0 : Math.max(...this.#samples)
  }

  reset(): void {
    this.#samples = []
    this.#discarded = 0
  }

  dispose(): void {
    for (const query of [...this.#pool, ...this.#inFlight]) {
      this.#gl.deleteQuery(query)
    }
    this.#pool = []
    this.#inFlight = []
  }
}
