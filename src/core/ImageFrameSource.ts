/**
 * 靜態圖片的 FrameSource 實作。
 *
 * 存在的理由不只是「工具也要能比對圖片」，更是為了在 Phase 0 就證明 FrameSource
 * 這個介面不是照 mp4 的形狀長出來的。一個沒有解碼器、沒有 keyframe、沒有容器
 * timebase 的來源若能無痛接上，日後的 EXR 序列才有機會只是「再多一個實作」。
 */

import {
  assumedSdrColorSpace,
  type ColorSpaceInfo,
  type FrameSource,
  type FrameSourceInfo,
  type FrameSourceStats,
  type SourceFrame,
} from './FrameSource'

export interface ImageFrameSourceOptions {
  /** 靜態圖在時間軸上的長度（秒）。與影片同軌比對時由呼叫端指定。 */
  duration?: number
  colorSpaceOverride?: ColorSpaceInfo
}

const DEFAULT_DURATION = 10

export class ImageFrameSource implements FrameSource {
  #file: File
  #options: ImageFrameSourceOptions
  #info: FrameSourceInfo | null = null
  /** 唯一的那一格。整個生命週期就它，不需要 ring buffer。 */
  #frame: SourceFrame | null = null

  constructor(file: File, options: ImageFrameSourceOptions = {}) {
    this.#file = file
    this.#options = options
  }

  get info(): FrameSourceInfo {
    if (!this.#info) throw new Error('FrameSource 尚未 open()')
    return this.#info
  }

  async open(): Promise<void> {
    const bitmap = await createImageBitmap(this.#file)

    // 靜態圖沒有容器色彩標記可讀。瀏覽器已經把 PNG/JPEG 解成 sRGB，
    // 所以這裡的 'assumed' 是誠實的：我們確實不知道原始意圖，只知道解出來是什麼。
    const colorSpace: ColorSpaceInfo = this.#options.colorSpaceOverride
      ? { ...this.#options.colorSpaceOverride, origin: 'user-override' }
      : { ...assumedSdrColorSpace(), transfer: 'iec61966-2-1', fullRange: true }

    this.#info = {
      width: bitmap.width,
      height: bitmap.height,
      duration: this.#options.duration ?? DEFAULT_DURATION,
      // 靜態圖沒有影格率。給一個標稱值讓逐幀步進仍然可用。
      frameRate: 30,
      codec: this.#file.type || 'image',
      colorSpace,
    }

    this.#frame = {
      frame: new VideoFrame(bitmap, { timestamp: 0 }),
      timestamp: 0,
    }
    bitmap.close()
  }

  frameAt(_t: number): SourceFrame | null {
    return this.#frame
  }

  advanceTo(_t: number): void {
    // 靜態圖不需要預讀，也沒有過期影格要釋放。
  }

  async seek(_t: number): Promise<void> {
    // 任何時間點都是同一格，seek 沒有成本。
  }

  stats(): FrameSourceStats {
    const info = this.#info
    return {
      buffered: this.#frame ? 1 : 0,
      decoded: this.#frame ? 1 : 0,
      dropped: 0,
      queueSize: 0,
      // 圖片解出來是 RGBA，不是 NV12，每像素 4 bytes。
      estimatedBytes: info && this.#frame ? info.width * info.height * 4 : 0,
      // 靜態圖任何時間點都備妥，永遠不會缺格，也永遠不需要重新 seek。
      seeking: false,
      bufferedFrom: this.#frame ? -Infinity : Infinity,
      bufferedUntil: this.#frame ? Infinity : -Infinity,
    }
  }

  close(): void {
    this.#frame?.frame.close()
    this.#frame = null
  }
}
