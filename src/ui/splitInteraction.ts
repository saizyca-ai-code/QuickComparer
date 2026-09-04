/**
 * 畫面上的直接操作：拖分割線、旋轉、平移。
 *
 * 分割線用數值滑桿調很難用 —— 比對時眼睛在畫面上，手卻要跑到側欄。
 * 所以靠近分割線按下就抓住它拖動，離線遠的地方按下才是平移，抓住時按住 Alt 改為旋轉。
 *
 * 這裡不碰 Preact，也不直接改 signal —— 它拿到什麼參數、要把新參數交給誰，
 * 都由呼叫端決定。互動的幾何知識與 UI 框架無關，混在元件裡只會讓它不能被測。
 */

import type { Compositor } from '../gl/Compositor'
import type { RenderParams } from '../gl/params'

/** 抓取分割線的容許距離（畫布像素）。 */
export const SPLIT_GRAB_PX = 14

export type DragMode =
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'split' }
  /** 旋轉時鎖定按下當下的支點，中途放開 Alt 也不會讓線突然跳走。 */
  | { kind: 'rotate'; pivot: { x: number; y: number } }

export type Cursor = 'default' | 'grab' | 'grabbing' | 'crosshair' | 'move'

interface Env {
  canvas: HTMLCanvasElement
  compositor: Compositor
  /** 目前的渲染參數。每次互動都重新取，不快取。 */
  params: () => RenderParams
  /** stage 長寬比，沒有素材時為 null。 */
  aspect: () => number | null
  apply: (patch: Partial<RenderParams>) => void
}

export class SplitInteraction {
  #env: Env
  #drag: DragMode | null = null
  /** 最後一次的游標位置，供 Alt 按放時即時更新游標樣式。 */
  #lastPointer: { clientX: number; clientY: number; altKey: boolean } | null = null

  constructor(env: Env) {
    this.#env = env
  }

  get dragging(): boolean {
    return this.#drag !== null
  }

  /** 依目前狀態決定游標，讓「可移動／可旋轉／可平移」看得出來。 */
  cursor(): Cursor {
    const drag = this.#drag
    if (drag) {
      return drag.kind === 'split' ? 'grabbing' : drag.kind === 'rotate' ? 'crosshair' : 'move'
    }
    const pointer = this.#lastPointer
    if (!pointer) return 'default'
    const distance = this.#distanceToSplit(pointer)
    const onLine = distance !== null && distance <= SPLIT_GRAB_PX
    if (!onLine) return 'default'
    return pointer.altKey ? 'crosshair' : 'grab'
  }

  pointerDown(e: PointerEvent): void {
    this.#lastPointer = e
    const distance = this.#distanceToSplit(e)
    const aspect = this.#env.aspect()

    if (distance !== null && distance <= SPLIT_GRAB_PX && aspect !== null) {
      if (e.altKey) {
        const pivot = this.#splitPivot(aspect)
        this.#drag = { kind: 'rotate', pivot }
        this.#rotateAroundPivot(e, pivot)
      } else {
        this.#drag = { kind: 'split' }
        this.#setSplitFromPointer(e)
      }
    } else {
      this.#drag = { kind: 'pan', x: e.clientX, y: e.clientY }
    }
    this.#env.canvas.setPointerCapture(e.pointerId)
  }

  pointerMove(e: PointerEvent): void {
    this.#lastPointer = e
    const drag = this.#drag
    if (!drag) return

    if (drag.kind === 'split') {
      this.#setSplitFromPointer(e)
    } else if (drag.kind === 'rotate') {
      this.#rotateAroundPivot(e, drag.pivot)
    } else {
      const params = this.#env.params()
      const rect = this.#env.canvas.getBoundingClientRect()
      this.#env.apply({
        pan: {
          x: params.pan.x + (e.clientX - drag.x) / rect.width / params.zoom,
          y: params.pan.y - (e.clientY - drag.y) / rect.height / params.zoom,
        },
      })
      this.#drag = { kind: 'pan', x: e.clientX, y: e.clientY }
    }
  }

  pointerUp(e: PointerEvent): void {
    this.#drag = null
    this.#lastPointer = e
    this.#env.canvas.releasePointerCapture(e.pointerId)
  }

  pointerLeave(): void {
    if (!this.#drag) this.#lastPointer = null
  }

  /** Alt 按放時沿用上一個游標位置重算，不必等使用者移動滑鼠。 */
  setAltKey(altKey: boolean): void {
    if (this.#lastPointer) this.#lastPointer = { ...this.#lastPointer, altKey }
  }

  wheelZoom(deltaY: number): void {
    const params = this.#env.params()
    const factor = Math.exp(-deltaY * 0.0015)
    this.#env.apply({ zoom: Math.min(8, Math.max(0.1, params.zoom * factor)) })
  }

  // ---------------------------------------------------------------- 幾何

  #toCanvasPixels(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const canvas = this.#env.canvas
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY }
  }

  #stageAt(e: { clientX: number; clientY: number }): { x: number; y: number } | null {
    const aspect = this.#env.aspect()
    if (aspect === null) return null
    const px = this.#toCanvasPixels(e)
    return this.#env.compositor.toStageSpace(px.x, px.y, aspect, this.#env.params())
  }

  /** 游標到分割線的距離（畫布像素）。不在 slider 模式或算不出來時回傳 null。 */
  #distanceToSplit(e: { clientX: number; clientY: number }): number | null {
    const params = this.#env.params()
    if (params.layout !== 'single' || params.compareMode !== 'slider') return null
    const aspect = this.#env.aspect()
    if (aspect === null) return null

    const stage = this.#stageAt(e)
    if (!stage) return null

    const compositor = this.#env.compositor
    const normal = { x: Math.cos(params.splitAngle), y: Math.sin(params.splitAngle) }
    const halfExtent = compositor.splitHalfExtent(aspect, params)
    const offset = (params.splitPos * 2 - 1) * halfExtent
    const d = stage.x * normal.x + stage.y * normal.y - offset

    return Math.abs(d) * compositor.stageUnitInPixels(aspect, params)
  }

  #setSplitFromPointer(e: { clientX: number; clientY: number }): void {
    const aspect = this.#env.aspect()
    if (aspect === null) return
    const stage = this.#stageAt(e)
    if (!stage) return

    const params = this.#env.params()
    const halfExtent = this.#env.compositor.splitHalfExtent(aspect, params)
    if (halfExtent === 0) return

    const projected =
      stage.x * Math.cos(params.splitAngle) + stage.y * Math.sin(params.splitAngle)
    this.#env.apply({ splitPos: clamp01((projected / halfExtent + 1) / 2) })
  }

  /** 分割線上離畫面中心最近的那一點，也就是旋轉支點。與 shader 畫的圓環同一點。 */
  #splitPivot(aspect: number): { x: number; y: number } {
    const params = this.#env.params()
    const halfExtent = this.#env.compositor.splitHalfExtent(aspect, params)
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
  #rotateAroundPivot(
    e: { clientX: number; clientY: number },
    pivot: { x: number; y: number },
  ): void {
    const aspect = this.#env.aspect()
    if (aspect === null) return
    const stage = this.#stageAt(e)
    if (!stage) return

    const dx = stage.x - pivot.x
    const dy = stage.y - pivot.y
    if (dx === 0 && dy === 0) return

    // splitAngle 是法線方向，使用者的直覺是「線跟著游標指」，所以加 90 度。
    const splitAngle = Math.atan2(dy, dx) + Math.PI / 2

    // 重算 splitPos，讓線維持通過支點。
    const rotated = { ...this.#env.params(), splitAngle }
    const halfExtent = this.#env.compositor.splitHalfExtent(aspect, rotated)
    if (halfExtent <= 0) {
      this.#env.apply({ splitAngle })
      return
    }
    const projected = pivot.x * Math.cos(splitAngle) + pivot.y * Math.sin(splitAngle)
    this.#env.apply({ splitAngle, splitPos: clamp01((projected / halfExtent + 1) / 2) })
  }
}

/**
 * 分割角度換算成滑桿用的度數。
 *
 * 分割線是 180 度週期的（轉半圈就回到同一條線），所以正規化到 (-90, 90]
 * 才能對上滑桿的範圍，也避免拖過頭時數值突然跳到另一端。
 */
export function normalizedSplitDegrees(splitAngle: number): number {
  const degrees = (splitAngle * 180) / Math.PI
  let normalized = ((degrees % 180) + 180) % 180
  if (normalized > 90) normalized -= 180
  return normalized
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
