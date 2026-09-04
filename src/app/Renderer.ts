/**
 * 把 PlaybackController 的取格結果畫到畫布上。
 *
 * 這一層只做「貼圖上傳 + 合成」，不決定要畫哪一格 —— 那是 PlaybackController 的事。
 * 分成兩層的實際好處是 Phase 6 的離線匯出可以用同一個 Renderer 配上自己的時間軸，
 * 不必把互動用的補位邏輯一起拖進去。
 */

import { Compositor } from '../gl/Compositor'
import type { SourceDescriptor, TransferFunction } from '../gl/params'
import type { PlaybackSnapshot } from '../core/PlaybackController'
import type { FrameSource } from '../core/FrameSource'

function transferOf(source: FrameSource): TransferFunction {
  const tf = source.info.colorSpace.transfer
  if (tf === 'iec61966-2-1') return 'srgb'
  if (tf === 'bt709' || tf === 'smpte170m') return 'bt709'
  return 'srgb'
}

export class Renderer {
  readonly compositor: Compositor
  #canvas: HTMLCanvasElement

  /**
   * 各槽位最後一次成功上傳的來源描述。
   *
   * 供片中斷時（seek 進行中、短暫缺格）沿用它，讓貼圖維持上一格的內容，
   * 畫面停住而不是黑掉或跳到別的時間點。
   */
  #lastDescriptor: [SourceDescriptor | null, SourceDescriptor | null] = [null, null]

  /**
   * 量測期間鎖定的渲染解析度。
   *
   * 平常畫布跟著版面走，但那讓量測結果無法比較 —— 視窗大小一變，填充率就變，
   * 數字失去意義。更糟的是側邊欄收起時畫布可能只剩幾百像素寬，成本會嚴重低估。
   */
  lockedSize: { width: number; height: number } | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
    this.compositor = new Compositor(canvas)
  }

  /** 換素材時呼叫，免得新素材的第一格還沒到就先畫出舊素材的殘影。 */
  resetSlot(slot: 0 | 1): void {
    this.#lastDescriptor[slot] = null
  }

  draw(snapshot: PlaybackSnapshot, sources: readonly (FrameSource | null)[], params: Parameters<Compositor['render']>[1]): void {
    this.#resizeCanvas()

    const descriptors: [SourceDescriptor | null, SourceDescriptor | null] = [null, null]

    for (const slot of [0, 1] as const) {
      const source = sources[slot]
      if (!source) {
        this.#lastDescriptor[slot] = null
        continue
      }

      const sf = snapshot.frames[slot]
      if (!sf) {
        descriptors[slot] = this.#lastDescriptor[slot]
        continue
      }

      this.compositor.uploadFrame(slot, sf.frame)
      const descriptor: SourceDescriptor = {
        width: sf.frame.displayWidth,
        height: sf.frame.displayHeight,
        transfer: transferOf(source),
      }
      descriptors[slot] = descriptor
      this.#lastDescriptor[slot] = descriptor
    }

    const pair = this.#mirrorSingleSource(descriptors, snapshot)
    if (pair) this.compositor.render(pair, params)
  }

  /**
   * 補齊缺席的槽位。
   *
   * 只有一邊時，把那一格同時上傳到另一個槽位，讓 slider 與 diff 在單素材狀態下
   * 仍是有意義的（diff 會是純黑，正好是自我檢查）。
   *
   * 鏡射的那一側只在有新影格時才更新貼圖。seek 期間 frames 是 null，兩側就一起
   * 停在上一格 —— 若這裡自己去 frameAt 取，被凍住的那側會對上一個還在往目標解的
   * 中途影格，分割線兩邊就錯開了。
   */
  #mirrorSingleSource(
    descriptors: [SourceDescriptor | null, SourceDescriptor | null],
    snapshot: PlaybackSnapshot,
  ): [SourceDescriptor, SourceDescriptor] | null {
    const a = descriptors[0]
    const b = descriptors[1]
    if (a && b) return [a, b]

    const presentSlot: 0 | 1 = a ? 0 : 1
    const present = a ?? b
    if (!present) return null

    const sf = snapshot.frames[presentSlot]
    if (sf) {
      const emptySlot: 0 | 1 = presentSlot === 0 ? 1 : 0
      this.compositor.uploadFrame(emptySlot, sf.frame)
    }
    return [present, present]
  }

  #resizeCanvas(): void {
    const canvas = this.#canvas
    let width: number
    let height: number

    if (this.lockedSize) {
      width = this.lockedSize.width
      height = this.lockedSize.height
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

  dispose(): void {
    this.compositor.dispose()
  }
}
