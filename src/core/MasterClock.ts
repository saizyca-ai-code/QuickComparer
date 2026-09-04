/**
 * MasterClock：播放的唯一時間權威。
 *
 * D001 的第二項架構約束：時基與容器解耦。這個時鐘不知道任何 mp4 timescale、
 * 不從任何一軌的解碼進度推導時間。EXR 序列沒有內嵌 timebase，只有編號檔案加上
 * 宣告的 fps；只有把時間權威放在容器之外，日後才可能讓 mp4 與 EXR 同軌播放。
 *
 * 目前以 performance.now() 自由運行。Phase 4 加入音訊後，會改為在有音訊時
 * 以 AudioContext.currentTime 為權威、視訊從屬（音訊斷裂比視訊掉幀明顯得多）。
 * 屆時只需替換此類別的時間來源，呼叫端不受影響。
 */

export interface ClockState {
  /** 秒。 */
  currentTime: number
  playing: boolean
  /** 播放速率，1 為正常速度。 */
  rate: number
  /** 秒。播放到此處會依 loop 設定回頭或停止。 */
  duration: number
  loop: boolean
}

export class MasterClock {
  #currentTime = 0
  #playing = false
  #rate = 1
  #duration = 0
  #loop = true
  /** 上一次 tick 的 performance.now()，未播放時為 null。 */
  #lastTick: number | null = null

  get currentTime(): number {
    return this.#currentTime
  }

  get playing(): boolean {
    return this.#playing
  }

  get rate(): number {
    return this.#rate
  }

  set rate(v: number) {
    this.#rate = v
  }

  get duration(): number {
    return this.#duration
  }

  set duration(v: number) {
    this.#duration = Math.max(0, v)
    if (this.#currentTime > this.#duration) this.#currentTime = this.#duration
  }

  get loop(): boolean {
    return this.#loop
  }

  set loop(v: boolean) {
    this.#loop = v
  }

  play(): void {
    if (this.#playing) return
    this.#playing = true
    this.#lastTick = performance.now()
  }

  pause(): void {
    this.#playing = false
    this.#lastTick = null
  }

  toggle(): void {
    if (this.#playing) this.pause()
    else this.play()
  }

  /** 直接設定時間。不觸發任何解碼，seek 由呼叫端決定要不要對各來源下達。 */
  setTime(t: number): void {
    this.#currentTime = clamp(t, 0, this.#duration)
    this.#lastTick = performance.now()
  }

  /**
   * 依 fps 步進整數格。逐幀檢查是比對工具的核心操作之一，
   * 所以必須是時鐘的一級功能，而不是靠 setTime 加一個估算值。
   */
  step(frames: number, fps: number): void {
    if (fps <= 0) return
    const frameIndex = Math.round(this.#currentTime * fps) + frames
    this.setTime(frameIndex / fps)
  }

  /** 每次 render 前呼叫，推進時間。回傳本次前進的秒數。 */
  tick(): number {
    if (!this.#playing) return 0
    const now = performance.now()
    const last = this.#lastTick ?? now
    this.#lastTick = now

    const delta = ((now - last) / 1000) * this.#rate
    let next = this.#currentTime + delta

    if (this.#duration > 0 && next >= this.#duration) {
      if (this.#loop) {
        next = next % this.#duration
      } else {
        next = this.#duration
        this.pause()
      }
    }

    this.#currentTime = next
    return delta
  }

  state(): ClockState {
    return {
      currentTime: this.#currentTime,
      playing: this.#playing,
      rate: this.#rate,
      duration: this.#duration,
      loop: this.#loop,
    }
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
