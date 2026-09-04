/**
 * Pane 佈局與 stage 幾何。
 *
 * 從 Compositor 拆出來的理由是它有兩個使用者：合成 pass 需要它來決定每個 pane
 * 畫什麼，UI 需要它把滑鼠座標換算回 stage 空間（分割線的拖曳）。兩邊算出來的
 * 幾何一旦不一致，滑鼠位置就會和線對不上，而且只在角度不是 0 時才看得出來。
 */

import type { CompareMode, RenderParams } from './params'

export interface Pane {
  /** 畫布像素座標，原點在左下（與 gl_FragCoord 一致）。 */
  x: number
  y: number
  width: number
  height: number
  /** 這個 pane 的比對模式。左右／上下佈局的每個 pane 各自只顯示一邊。 */
  mode: CompareMode
  showSource: 0 | 1
}

/** 依佈局切出 pane。左右／上下佈局的每個 pane 各自顯示單一來源。 */
export function layoutPanes(params: RenderParams, width: number, height: number): Pane[] {
  switch (params.layout) {
    case 'horizontal':
      return [
        { x: 0, y: 0, width: width / 2, height, mode: 'single', showSource: 0 },
        { x: width / 2, y: 0, width: width / 2, height, mode: 'single', showSource: 1 },
      ]
    case 'vertical':
      // 上半顯示 A：畫布原點在左下，所以 A 的 y 是上半段。
      return [
        { x: 0, y: height / 2, width, height: height / 2, mode: 'single', showSource: 0 },
        { x: 0, y: 0, width, height: height / 2, mode: 'single', showSource: 1 },
      ]
    case 'grid':
      // Phase 0 只有兩個來源，grid 先以 2x2 的前兩格呈現，
      // 用來量測多 pane 的繪製成本；實際的多來源 grid 是 Phase 2 的工作。
      return [
        { x: 0, y: height / 2, width: width / 2, height: height / 2, mode: 'single', showSource: 0 },
        { x: width / 2, y: height / 2, width: width / 2, height: height / 2, mode: 'single', showSource: 1 },
        { x: 0, y: 0, width: width / 2, height: height / 2, mode: 'diff', showSource: 0 },
        { x: width / 2, y: 0, width: width / 2, height: height / 2, mode: 'slider', showSource: 0 },
      ]
    case 'single':
    default:
      return [
        { x: 0, y: 0, width, height, mode: params.compareMode, showSource: params.showSource },
      ]
  }
}

/**
 * 計算 stage 在 pane 內的顯示矩形（contain + zoom + pan）。
 *
 * zoom 與 pan 對 A/B 一起套用。做細節比對時「兩邊同步放大到同一個區域」
 * 比 slider 本身更常用，所以它屬於 stage 層級而不是單一來源的屬性。
 */
export function stageRect(
  pane: Pane,
  stageAspect: number,
  params: RenderParams,
): [number, number, number, number] {
  const paneAspect = pane.width / pane.height
  let w: number
  let h: number
  if (paneAspect > stageAspect) {
    h = pane.height
    w = h * stageAspect
  } else {
    w = pane.width
    h = w / stageAspect
  }

  w *= params.zoom
  h *= params.zoom

  const x = (pane.width - w) / 2 + params.pan.x * w
  const y = (pane.height - h) / 2 + params.pan.y * h

  return [x, y, w, h]
}

/** 整個畫布當成單一 pane。UI 的座標換算只在 single 佈局下有意義。 */
export function fullPane(width: number, height: number, params: RenderParams): Pane {
  return { x: 0, y: 0, width, height, mode: params.compareMode, showSource: params.showSource }
}
