/**
 * PlaybackController：時鐘與來源之間的橋接層。
 *
 * Phase 0 把這件事寫在繪製迴圈裡，Phase 1 拉出來獨立。理由不是整潔，
 * 而是它必須能被繪製迴圈以外的東西驅動 —— Phase 4 的 timeline 與 AB 剪接、
 * Phase 6 的離線逐幀匯出，都需要「給我時間 t 應該顯示的兩軌影格」這個能力，
 * 而不能仰賴 requestAnimationFrame 的存在。
 *
 * 它補的是 D001 時基解耦留下的缺口：MasterClock 刻意不知道任何來源的存在，
 * 所以時鐘可以瞬間跳到任何位置（逐幀倒退、loop 繞回 0、拖動 timeline），
 * 而來源的緩衝只涵蓋播放頭附近。沒有人負責在跳躍發生時重新 seek 的話，
 * 畫面會停在舊的那一格，而且不會報錯。
 *
 * 這一層不碰 WebGL，也不知道 compositor 的存在。它的輸出是「這一格該用哪些
 * VideoFrame」，貼圖上傳與合成參數是呼叫端的事。
 */

import { MasterClock } from './MasterClock'
import type { FrameSource, SourceFrame } from './FrameSource'

/** 來源槽位。0 是 A，1 是 B。 */
export type Slot = 0 | 1

/**
 * 播放頭跳到緩衝之外多遠才判定為「跳躍」而非「缺格」。
 *
 * 往前小幅超出 bufferedUntil 是解碼跟不上，等它補上就好，重新 seek 只會更慢。
 * 超過這個距離才視為使用者真的跳到別的地方。
 */
const FORWARD_JUMP_THRESHOLD = 1.0

/** 沒有素材時的預設步進速率。 */
const FALLBACK_FPS = 30

/** 某個時間點上兩軌的供片結果。 */
export interface PlaybackSnapshot {
  /** 這次取樣的時間（秒）。 */
  time: number
  /**
   * 各槽位應顯示的影格。null 代表這一格沒有東西可換上，呼叫端應沿用上一格 ——
   * 不是黑掉，也不是跳到別的時間點。
   */
  frames: [SourceFrame | null, SourceFrame | null]
  /**
   * 任一軌正在 seek。此時兩軌的 frames 都會是 null。
   *
   * 兩軌一起凍住是必要的。其一，seek 期間解碼器從 keyframe 一路往目標解，
   * 途中經過的影格是真的，依序畫出來就變成「快轉過去」的閃爍 —— 單 keyframe
   * 的 4K 素材最明顯。其二，兩軌的 seek 不會同時完成，先到的那軌若先更新，
   * 分割線兩側會短暫錯開。
   */
  seeking: boolean
  /** 供片跟不上：有槽位沒拿到影格，或拿到的是已經過期的同一格。 */
  starved: boolean
  /** 兩軌影格緩衝的估計用量（bytes）。 */
  bufferedBytes: number
}

export class PlaybackController {
  readonly clock = new MasterClock()

  #sources: [FrameSource | null, FrameSource | null] = [null, null]
  /** 上一格各槽位實際取用的影格 timestamp，用來分辨「畫面沒動」與「解碼跟不上」。 */
  #lastTimestamp: [number | null, number | null] = [null, null]
  #resyncing = false

  /** 重新對位失敗時的回報管道。失敗多半代表素材本身有問題，不該無聲吞掉。 */
  onError: ((message: string) => void) | null = null

  get sources(): readonly [FrameSource | null, FrameSource | null] {
    return this.#sources
  }

  /** 目前正在 seek。 */
  get seeking(): boolean {
    return this.#sources.some((s) => s !== null && s.stats().seeking)
  }

  /** 有沒有任何素材。 */
  get hasSource(): boolean {
    return this.#sources[0] !== null || this.#sources[1] !== null
  }

  /** 逐幀步進使用的速率。取 A，沒有 A 就取 B。 */
  get frameRate(): number {
    return this.#sources[0]?.info.frameRate ?? this.#sources[1]?.info.frameRate ?? FALLBACK_FPS
  }

  /**
   * 上一次各槽位實際取用的影格時間（秒）。
   *
   * A/B 錯開一格以上就是同步出了問題，這是 T001 最關鍵的一項檢查，
   * 所以取格的結果必須留得住，不能只存在於當下那一幀。
   */
  get lastTimestamps(): readonly [number | null, number | null] {
    return this.#lastTimestamp
  }

  activeSources(): FrameSource[] {
    return this.#sources.filter((s): s is FrameSource => s !== null)
  }

  /**
   * 設定槽位的來源。舊的來源會被關閉，時鐘長度隨之更新。
   *
   * 長度取兩軌較長者。長度不一致的偵測與處理工具是 Phase 4 的工作。
   */
  setSource(slot: Slot, source: FrameSource | null): void {
    this.#sources[slot]?.close()
    this.#sources[slot] = source
    this.#lastTimestamp[slot] = null

    let duration = 0
    for (const s of this.#sources) {
      if (s) duration = Math.max(duration, s.info.duration)
    }
    this.clock.duration = duration
  }

  // -------------------------------------------------------------- 傳輸控制

  play(): void {
    this.clock.play()
  }

  pause(): void {
    this.clock.pause()
  }

  toggle(): void {
    this.clock.toggle()
  }

  /**
   * 逐幀步進。
   *
   * 只設定時鐘，實際的補位交給 update() 的重新對位判斷 —— 往前一格通常直接命中
   * 緩衝，往回一格則命中 FrameSource 保留的歷史格，兩種情況都不需要 seek。
   * 只有退超過保留範圍時才會觸發真正的 seek。
   */
  step(frames: number): void {
    this.pause()
    this.clock.step(frames, this.frameRate)
  }

  /**
   * 拖動時的時間設定：只動時鐘，不對解碼器下 seek。
   *
   * 逐格 seek 會讓拖動變成一連串 flush，反而看不到東西。放開後再以
   * commitScrub() 對齊。
   */
  scrubTo(t: number): void {
    this.clock.setTime(t)
  }

  /** 拖動結束，把解碼器對到目前的播放頭。 */
  async commitScrub(): Promise<void> {
    await this.seekTo(this.clock.currentTime)
  }

  /** 跳轉：設定時鐘並讓兩軌都解到該處。 */
  async seekTo(t: number): Promise<void> {
    this.clock.setTime(t)
    await this.#seekSources(this.clock.currentTime)
  }

  // -------------------------------------------------------------- 取格

  /**
   * 推進時鐘並取得這一格。互動繪製迴圈每格呼叫一次。
   *
   * 重新對位在這裡發動，判斷依據是「需要的時間點在不在緩衝範圍內」，
   * 而不是去猜使用者做了什麼操作 —— 逐幀倒退、loop 繞回、拖動 timeline
   * 在來源看來是同一件事，沒有理由分開處理。
   */
  update(): PlaybackSnapshot {
    this.clock.tick()
    const t = this.clock.currentTime
    if (!this.#resyncing && this.#needsResync(t)) void this.#resyncTo(t)
    return this.sampleAt(t)
  }

  /**
   * 在指定時間取一格，不推進時鐘、不觸發重新對位。
   *
   * 供量測與（Phase 6 的）離線匯出使用：那些場合自己掌握時間軸，
   * 由呼叫端決定何時 seek，不該被互動用的補位邏輯插手。
   */
  sampleAt(t: number): PlaybackSnapshot {
    const frames: [SourceFrame | null, SourceFrame | null] = [null, null]
    const seeking = this.seeking
    let starved = false
    let bufferedBytes = 0

    for (const slot of [0, 1] as const) {
      const source = this.#sources[slot]
      if (!source) continue

      source.advanceTo(t)
      bufferedBytes += source.stats().estimatedBytes

      const sf = seeking ? null : source.frameAt(t)
      if (!sf) {
        starved = true
        continue
      }

      // frameAt 在解碼跟不上時會回傳舊的那一格，畫面等於卡住 ——
      // 光看回傳值分不出「這一格本來就該持續顯示」和「新的還沒解出來」。
      if (
        this.#lastTimestamp[slot] !== null &&
        sf.timestamp === this.#lastTimestamp[slot] &&
        t > sf.timestamp
      ) {
        const frameDuration = 1 / (source.info.frameRate || FALLBACK_FPS)
        if (t - sf.timestamp > frameDuration * 1.5) starved = true
      }

      frames[slot] = sf
      this.#lastTimestamp[slot] = sf.timestamp
    }

    return { time: t, frames, seeking, starved, bufferedBytes }
  }

  /** 兩軌是否都已備妥時間 t 的影格。量測時用來確保每一格都是真的解出來的。 */
  readyAt(t: number): boolean {
    return this.activeSources().every((s) => s.stats().bufferedUntil >= t)
  }

  /** 只推進來源的預讀與釋放，不取格。等待供片時使用。 */
  advanceTo(t: number): void {
    for (const source of this.#sources) source?.advanceTo(t)
  }

  /** 釋放兩軌。 */
  close(): void {
    this.setSource(0, null)
    this.setSource(1, null)
  }

  // -------------------------------------------------------------- 內部

  #needsResync(t: number): boolean {
    for (const source of this.#sources) {
      if (!source) continue
      const st = source.stats()
      // 往回退到已釋放的影格之前。
      if (t < st.bufferedFrom) return true
      // 往前跳得太遠，等解碼追上不切實際。
      if (t > st.bufferedUntil + FORWARD_JUMP_THRESHOLD) return true
    }
    return false
  }

  async #resyncTo(t: number): Promise<void> {
    if (this.#resyncing) return
    this.#resyncing = true
    try {
      await this.#seekSources(t)
    } finally {
      this.#resyncing = false
    }
  }

  async #seekSources(t: number): Promise<void> {
    try {
      await Promise.all(this.activeSources().map((s) => s.seek(t)))
    } catch (e) {
      this.onError?.(`重新對位失敗：${e instanceof Error ? e.message : String(e)}`)
    }
  }
}
