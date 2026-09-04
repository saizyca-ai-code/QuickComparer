/**
 * WebGL2 compositor。
 *
 * 結構刻意做成 layer graph 的雛形而不是「混合兩張圖」的函式：
 *
 *   [sources] → [pane 佈局] → [compare op] → half-float FBO → [output transform] → canvas
 *
 * D001 記錄的判斷是 Text Track / Title / 浮水印遲早要進來，屆時只是在
 * COMPOSITE 與 OUTPUT 之間插入 overlay pass。後期才改結構會很痛，所以現在就分好。
 */

import { GpuTimer } from './GpuTimer'
import { COMPOSITE_SHADER, OUTPUT_SHADER, VERTEX_SHADER } from './shaders'

export type TransferFunction = 'srgb' | 'bt709' | 'linear'
export type Interpolation = 'nearest' | 'bilinear' | 'bicubic'
export type CompareMode = 'single' | 'slider' | 'diff'
export type Layout = 'single' | 'horizontal' | 'vertical' | 'grid'

const TF_CODE: Record<TransferFunction, number> = { srgb: 0, bt709: 1, linear: 2 }
const INTERP_CODE: Record<Interpolation, number> = { nearest: 0, bilinear: 1, bicubic: 2 }
const MODE_CODE: Record<CompareMode, number> = { single: 0, slider: 1, diff: 2 }

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

export interface CompositorCapabilities {
  /** half-float render target 是否可用。不可用則線性光管線無法成立。 */
  halfFloatRenderable: boolean
  /** 實際採用的中間緩衝格式。 */
  intermediateFormat: 'rgba16f' | 'rgba8'
  maxTextureSize: number
  renderer: string
  /** GPU 端計時是否可用。不可用時只能量到 CPU 的指令送出成本。 */
  gpuTimingAvailable: boolean
}

interface Pane {
  /** 畫布像素座標，原點在左下（與 gl_FragCoord 一致）。 */
  x: number
  y: number
  width: number
  height: number
  /** 這個 pane 的比對模式。左右/上下佈局的每個 pane 各自只顯示一邊。 */
  mode: CompareMode
  showSource: 0 | 1
}

export class Compositor {
  #gl: WebGL2RenderingContext
  #canvas: HTMLCanvasElement
  #compositeProgram: WebGLProgram
  #outputProgram: WebGLProgram
  #vao: WebGLVertexArrayObject

  #fbo: WebGLFramebuffer
  #fboTexture: WebGLTexture
  #fboWidth = 0
  #fboHeight = 0

  #capabilities: CompositorCapabilities
  #gpuTimer: GpuTimer
  #timingEnabled = false

  /** 每個來源槽位一個貼圖，重複使用避免每幀配置。 */
  #textures: [WebGLTexture, WebGLTexture]
  #textureSizes: [{ w: number; h: number }, { w: number; h: number }]
  #currentFilter: Interpolation | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      // 不要讓瀏覽器在我們背後多做一次色彩轉換。輸出編碼由 OUTPUT pass 明確負責。
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('此環境無法建立 WebGL2 context')
    this.#gl = gl

    this.#capabilities = this.#detectCapabilities()

    this.#compositeProgram = this.#buildProgram(VERTEX_SHADER, COMPOSITE_SHADER)
    this.#outputProgram = this.#buildProgram(VERTEX_SHADER, OUTPUT_SHADER)

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('無法建立 VAO')
    this.#vao = vao

    this.#textures = [this.#createTexture(), this.#createTexture()]
    this.#textureSizes = [
      { w: 0, h: 0 },
      { w: 0, h: 0 },
    ]

    const fbo = gl.createFramebuffer()
    const fboTexture = gl.createTexture()
    if (!fbo || !fboTexture) throw new Error('無法建立 framebuffer')
    this.#fbo = fbo
    this.#fboTexture = fboTexture

    this.#gpuTimer = new GpuTimer(gl)
  }

  /** GPU 耗時量測。只在 benchmark 期間開啟。 */
  get gpuTimer(): GpuTimer {
    return this.#gpuTimer
  }

  setTimingEnabled(enabled: boolean): void {
    this.#timingEnabled = enabled
  }

  get capabilities(): CompositorCapabilities {
    return this.#capabilities
  }

  /**
   * 偵測 half-float render target 是否真的可用。
   *
   * 只看 extension 字串不夠 —— 有環境會回報支援但實際 framebuffer 不完整。
   * 這裡實際建一個 FBO 檢查 completeness，因為線性光管線的正確性靠它。
   */
  #detectCapabilities(): CompositorCapabilities {
    const gl = this.#gl
    const hasExtension = gl.getExtension('EXT_color_buffer_half_float') !== null
    gl.getExtension('OES_texture_float_linear')

    let renderable = false
    if (hasExtension) {
      const tex = gl.createTexture()
      const fbo = gl.createFramebuffer()
      if (tex && fbo) {
        gl.bindTexture(gl.TEXTURE_2D, tex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 4, 4, 0, gl.RGBA, gl.HALF_FLOAT, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
        renderable = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.deleteFramebuffer(fbo)
        gl.deleteTexture(tex)
      }
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    const renderer = debugInfo
      ? String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER))

    return {
      halfFloatRenderable: renderable,
      intermediateFormat: renderable ? 'rgba16f' : 'rgba8',
      maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      renderer,
      gpuTimingAvailable: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
    }
  }

  #buildProgram(vertexSource: string, fragmentSource: string): WebGLProgram {
    const gl = this.#gl
    const program = gl.createProgram()
    if (!program) throw new Error('無法建立 shader program')

    const vs = this.#compileShader(gl.VERTEX_SHADER, vertexSource)
    const fs = this.#compileShader(gl.FRAGMENT_SHADER, fragmentSource)
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program)
      throw new Error(`shader link 失敗：${log}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    return program
  }

  #compileShader(type: number, source: string): WebGLShader {
    const gl = this.#gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('無法建立 shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader)
      gl.deleteShader(shader)
      throw new Error(`shader 編譯失敗：${log}`)
    }
    return shader
  }

  #createTexture(): WebGLTexture {
    const gl = this.#gl
    const tex = gl.createTexture()
    if (!tex) throw new Error('無法建立貼圖')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    return tex
  }

  /**
   * 把一格 VideoFrame 上傳成貼圖。
   *
   * 這是 D001 那條規則的落點：影格在緩衝裡一直是 NV12，只有在這一刻才變成 RGB。
   * 上傳完成後 VideoFrame 仍由 FrameSource 持有，這裡不負責 close。
   */
  uploadFrame(slot: 0 | 1, frame: VideoFrame): void {
    const gl = this.#gl
    const tex = this.#textures[slot]
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame)
    this.#textureSizes[slot] = { w: frame.displayWidth, h: frame.displayHeight }
  }

  #applyFilter(interpolation: Interpolation): void {
    if (this.#currentFilter === interpolation) return
    const gl = this.#gl
    // bicubic 在 shader 裡自己取樣，底層 filter 必須是 nearest 才不會被二次插值。
    const filter = interpolation === 'bilinear' ? gl.LINEAR : gl.NEAREST
    for (const tex of this.#textures) {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    }
    this.#currentFilter = interpolation
  }

  #ensureFbo(width: number, height: number): void {
    if (this.#fboWidth === width && this.#fboHeight === height) return
    const gl = this.#gl

    gl.bindTexture(gl.TEXTURE_2D, this.#fboTexture)
    if (this.#capabilities.halfFloatRenderable) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null)
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.#fboTexture,
      0,
    )
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)

    this.#fboWidth = width
    this.#fboHeight = height
  }

  /** 依佈局切出 pane。左右／上下佈局的每個 pane 各自顯示單一來源。 */
  #layoutPanes(params: RenderParams, width: number, height: number): Pane[] {
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
  #stageRect(pane: Pane, stageAspect: number, params: RenderParams): [number, number, number, number] {
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

  /**
   * 繪製一幀。
   *
   * 兩個槽位都必須有描述 —— 只載入單一素材時，呼叫端應把同一格上傳到兩個槽位，
   * 而不是在這裡用未初始化的貼圖湊數（那會畫出黑畫面卻不報錯，是最難查的一種 bug）。
   */
  /**
   * 把畫布座標換算成 shader 內的中心化 stage 座標。
   *
   * 分割線的拖曳必須在同一個座標系裡計算，否則角度一旦不是 0，
   * 滑鼠位置和線的位置就會對不上。座標換算的知識屬於 compositor，
   * 不該讓 UI 層自己重算一次長寬比補正。
   *
   * 只支援 single 佈局 —— 分割線只在那裡出現。
   */
  toStageSpace(
    canvasX: number,
    canvasY: number,
    stageAspect: number,
    params: RenderParams,
  ): { x: number; y: number } | null {
    if (params.layout !== 'single') return null

    const width = this.#canvas.width
    const height = this.#canvas.height
    if (width === 0 || height === 0) return null

    const pane: Pane = {
      x: 0,
      y: 0,
      width,
      height,
      mode: params.compareMode,
      showSource: params.showSource,
    }
    const [rx, ry, rw, rh] = this.#stageRect(pane, stageAspect, params)

    // 畫布座標原點在左上，gl_FragCoord 在左下，這裡沿用 shader 的方向。
    const paneY = height - canvasY
    const uvX = (canvasX - rx) / rw
    const uvY = 1 - (paneY - ry) / rh

    const aspect = rw / rh
    return { x: (uvX - 0.5) * aspect, y: uvY - 0.5 }
  }

  /** 分割線在 stage 座標中能移動的半徑，與 shader 的 halfExtent 一致。 */
  splitHalfExtent(stageAspect: number, params: RenderParams): number {
    const width = this.#canvas.width
    const height = this.#canvas.height
    const pane: Pane = {
      x: 0,
      y: 0,
      width,
      height,
      mode: params.compareMode,
      showSource: params.showSource,
    }
    const [, , rw, rh] = this.#stageRect(pane, stageAspect, params)
    const aspect = rw / rh
    return (
      Math.abs(Math.cos(params.splitAngle)) * (aspect * 0.5) +
      Math.abs(Math.sin(params.splitAngle)) * 0.5
    )
  }

  /** stage 一個座標單位等於幾個畫布像素。用來把抓取距離換算成像素。 */
  stageUnitInPixels(stageAspect: number, params: RenderParams): number {
    const pane: Pane = {
      x: 0,
      y: 0,
      width: this.#canvas.width,
      height: this.#canvas.height,
      mode: params.compareMode,
      showSource: params.showSource,
    }
    return this.#stageRect(pane, stageAspect, params)[3]
  }

  render(sources: [SourceDescriptor, SourceDescriptor], params: RenderParams): void {
    const gl = this.#gl
    const width = this.#canvas.width
    const height = this.#canvas.height
    if (width === 0 || height === 0) return

    const texA = sources[0]
    const texB = sources[1]

    this.#ensureFbo(width, height)
    this.#applyFilter(params.interpolation)

    if (this.#timingEnabled) {
      this.#gpuTimer.poll()
      this.#gpuTimer.begin()
    }

    // stage 的長寬比以 A 為準。A/B 長寬比不同時的處理是 Phase 4 的工作
    // （偵測不一致並提示使用者），不在這裡隱性拉伸。
    const stageAspect = texA.width / texA.height

    gl.bindVertexArray(this.#vao)

    // ---- COMPOSITE pass：混合並寫進線性光緩衝 ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbo)
    gl.viewport(0, 0, width, height)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const p = this.#compositeProgram
    gl.useProgram(p)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[0])
    gl.uniform1i(gl.getUniformLocation(p, 'uTexA'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.#textures[1])
    gl.uniform1i(gl.getUniformLocation(p, 'uTexB'), 1)

    const sizeA = this.#textureSizes[0]
    const sizeB = this.#textureSizes[1]
    gl.uniform2f(gl.getUniformLocation(p, 'uSizeA'), sizeA.w || 1, sizeA.h || 1)
    gl.uniform2f(gl.getUniformLocation(p, 'uSizeB'), sizeB.w || 1, sizeB.h || 1)
    gl.uniform1i(gl.getUniformLocation(p, 'uTfA'), TF_CODE[texA.transfer])
    gl.uniform1i(gl.getUniformLocation(p, 'uTfB'), TF_CODE[texB.transfer])
    gl.uniform1i(gl.getUniformLocation(p, 'uInterp'), INTERP_CODE[params.interpolation])
    gl.uniform1f(gl.getUniformLocation(p, 'uSplitPos'), params.splitPos)
    gl.uniform1f(gl.getUniformLocation(p, 'uSplitAngle'), params.splitAngle)
    gl.uniform1f(gl.getUniformLocation(p, 'uSplitWidth'), params.splitWidth)
    gl.uniform1f(gl.getUniformLocation(p, 'uSplitLinePx'), params.splitLinePx)
    gl.uniform1f(gl.getUniformLocation(p, 'uSplitPivotPx'), params.splitPivotPx)
    gl.uniform3f(
      gl.getUniformLocation(p, 'uSplitLineColor'),
      params.splitLineColor[0],
      params.splitLineColor[1],
      params.splitLineColor[2],
    )
    gl.uniform1f(gl.getUniformLocation(p, 'uDiffGain'), params.diffGain)

    const modeLoc = gl.getUniformLocation(p, 'uMode')
    const showLoc = gl.getUniformLocation(p, 'uShowSource')
    const paneLoc = gl.getUniformLocation(p, 'uPaneRect')
    const stageLoc = gl.getUniformLocation(p, 'uStageRect')

    // 每個 pane 一次 draw call，各自帶自己的 scissor 與矩形。
    gl.enable(gl.SCISSOR_TEST)
    for (const pane of this.#layoutPanes(params, width, height)) {
      const rect = this.#stageRect(pane, stageAspect, params)
      gl.scissor(pane.x, pane.y, pane.width, pane.height)
      gl.uniform4f(paneLoc, pane.x, pane.y, pane.width, pane.height)
      gl.uniform4f(stageLoc, rect[0], rect[1], rect[2], rect[3])
      gl.uniform1i(modeLoc, MODE_CODE[pane.mode])
      gl.uniform1i(showLoc, pane.showSource)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    }
    gl.disable(gl.SCISSOR_TEST)

    // ---- OUTPUT pass：線性 → 顯示編碼 ----
    // overlay（Text Track / Title / 浮水印）之後會插在這兩個 pass 之間。
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, width, height)

    const o = this.#outputProgram
    gl.useProgram(o)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.#fboTexture)
    gl.uniform1i(gl.getUniformLocation(o, 'uTex'), 0)
    gl.uniform1i(gl.getUniformLocation(o, 'uOutputTf'), TF_CODE[params.outputTransfer])
    gl.uniform1i(gl.getUniformLocation(o, 'uToneMap'), params.toneMap ? 1 : 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    gl.bindVertexArray(null)

    if (this.#timingEnabled) this.#gpuTimer.end()
  }

  /** 讀回畫布像素，供全黑 diff 驗收使用。 */
  readPixels(): Uint8Array {
    const gl = this.#gl
    const width = this.#canvas.width
    const height = this.#canvas.height
    const pixels = new Uint8Array(width * height * 4)
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  dispose(): void {
    const gl = this.#gl
    for (const tex of this.#textures) gl.deleteTexture(tex)
    gl.deleteTexture(this.#fboTexture)
    gl.deleteFramebuffer(this.#fbo)
    gl.deleteProgram(this.#compositeProgram)
    gl.deleteProgram(this.#outputProgram)
    gl.deleteVertexArray(this.#vao)
    this.#gpuTimer.dispose()
  }
}
