/**
 * Compositor 的公開型別與預設值。
 *
 * 從 Compositor.ts 拆出來的理由很單純：render graph 的每個 pass 都要讀它，
 * 而 Compositor 又要組裝 pass —— 型別留在 Compositor 裡就會繞成循環相依。
 */

export type TransferFunction = 'srgb' | 'bt709' | 'linear'
export type Interpolation = 'nearest' | 'bilinear' | 'bicubic'
export type CompareMode = 'single' | 'slider' | 'diff'
export type Layout = 'single' | 'horizontal' | 'vertical' | 'grid'

/** 與 shader 內的常數對應。改動這裡必須同步改 shaders.ts。 */
export const TF_CODE: Record<TransferFunction, number> = { srgb: 0, bt709: 1, linear: 2 }
export const INTERP_CODE: Record<Interpolation, number> = { nearest: 0, bilinear: 1, bicubic: 2 }
export const MODE_CODE: Record<CompareMode, number> = { single: 0, slider: 1, diff: 2 }

/**
 * 一個來源槽位的描述。
 *
 * 刻意不帶 WebGLTexture —— 貼圖由 compositor 自己持有並重複使用（每幀重新配置
 * 4K 貼圖會直接吃掉影格預算）。呼叫端用 uploadFrame() 餵資料，用這個描述說明
 * 該怎麼解讀它。
 */
export interface SourceDescriptor {
  width: number
  height: number
  transfer: TransferFunction
}

export interface RenderParams {
  layout: Layout
  compareMode: CompareMode
  /** compareMode 為 'single' 時顯示哪一邊。 */
  showSource: 0 | 1
  /** 分割線位置，0–1。 */
  splitPos: number
  /** 分割線角度（弧度）。這是分割線本身的角度，不是內容旋轉。 */
  splitAngle: number
  /** 分割線的柔化寬度，0 為硬切。 */
  splitWidth: number
  /** 可見分割線的粗細（像素）。0 為不畫。 */
  splitLinePx: number
  /** 分割線顏色，線性光。 */
  splitLineColor: [number, number, number]
  /** 旋轉支點標記的直徑（像素）。0 為不畫。 */
  splitPivotPx: number
  interpolation: Interpolation
  /** 差異模式的放大倍率。 */
  diffGain: number
  /** 顯示端的轉換函數。 */
  outputTransfer: TransferFunction
  /** ACES 近似色調映射。預設關閉 —— 比對工具不該改變使用者看到的像素值。 */
  toneMap: boolean
  zoom: number
  /** 平移，單位為 stage 的比例。 */
  pan: { x: number; y: number }
}

export const DEFAULT_RENDER_PARAMS: RenderParams = {
  layout: 'single',
  compareMode: 'slider',
  showSource: 0,
  splitPos: 0.5,
  splitAngle: 0,
  splitWidth: 0.0015,
  splitLinePx: 1.5,
  // 線性光下的中性淺灰。純白在亮部素材上會看不見，這個值在明暗畫面都還算清楚。
  splitLineColor: [0.75, 0.78, 0.85],
  splitPivotPx: 11,
  // 預設 nearest：比對 upscaler 時，用高品質插值放大原圖等於偷偷幫原圖加分。
  interpolation: 'nearest',
  diffGain: 1,
  outputTransfer: 'srgb',
  toneMap: false,
  zoom: 1,
  pan: { x: 0, y: 0 },
}
