/**
 * WebGL2 compositor。
 *
 * 它本身不畫東西 —— 畫圖的是 render graph 上的 pass。Compositor 負責的是
 * 那些 pass 共用的資源與知識：GL context、能力偵測、來源貼圖、線性光緩衝、
 * 全螢幕三角形，以及 UI 需要的座標換算。
 *
 *   [sources] → COMPOSITE → half-float 線性緩衝 → (overlay…) → OUTPUT → canvas
 *
 * Text Track / Title / 浮水印是 graph.insert(pass, { before: 'output' })；
 * ACES ODT 是 graph.replace('output', pass)。兩者都不動合成核心。
 */

import { GpuTimer } from './GpuTimer'
import { LinearBuffer, RenderGraph, type PassContext } from './RenderGraph'
import { CompositePass } from './passes/CompositePass'
import { OutputPass } from './passes/OutputPass'
import { fullPane, stageRect } from './layout'
import type { Interpolation, RenderParams, SourceDescriptor } from './params'

export {
  DEFAULT_RENDER_PARAMS,
  type CompareMode,
  type Interpolation,
  type Layout,
  type RenderParams,
  type SourceDescriptor,
  type TransferFunction,
} from './params'
export { type PassContext, type RenderPass } from './RenderGraph'

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

export class Compositor {
  #gl: WebGL2RenderingContext
  #canvas: HTMLCanvasElement
  #vao: WebGLVertexArrayObject

  #graph = new RenderGraph()
  #linear: LinearBuffer

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

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('無法建立 VAO')
    this.#vao = vao

    this.#textures = [this.#createTexture(), this.#createTexture()]
    this.#textureSizes = [
      { w: 0, h: 0 },
      { w: 0, h: 0 },
    ]

    this.#linear = new LinearBuffer(gl, this.#capabilities.halfFloatRenderable)
    this.#graph.append(new CompositePass(gl))
    this.#graph.append(new OutputPass(gl))

    this.#gpuTimer = new GpuTimer(gl)
  }

  /** render graph。插入 overlay 或換掉 output 都從這裡走。 */
  get graph(): RenderGraph {
    return this.#graph
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

  // ------------------------------------------------------------ UI 座標換算

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

    const [rx, ry, rw, rh] = stageRect(fullPane(width, height, params), stageAspect, params)

    // 畫布座標原點在左上，gl_FragCoord 在左下，這裡沿用 shader 的方向。
    const paneY = height - canvasY
    const uvX = (canvasX - rx) / rw
    const uvY = 1 - (paneY - ry) / rh

    const aspect = rw / rh
    return { x: (uvX - 0.5) * aspect, y: uvY - 0.5 }
  }

  /** 分割線在 stage 座標中能移動的半徑，與 shader 的 halfExtent 一致。 */
  splitHalfExtent(stageAspect: number, params: RenderParams): number {
    const pane = fullPane(this.#canvas.width, this.#canvas.height, params)
    const [, , rw, rh] = stageRect(pane, stageAspect, params)
    const aspect = rw / rh
    return (
      Math.abs(Math.cos(params.splitAngle)) * (aspect * 0.5) +
      Math.abs(Math.sin(params.splitAngle)) * 0.5
    )
  }

  /** stage 一個座標單位等於幾個畫布像素。用來把抓取距離換算成像素。 */
  stageUnitInPixels(stageAspect: number, params: RenderParams): number {
    const pane = fullPane(this.#canvas.width, this.#canvas.height, params)
    return stageRect(pane, stageAspect, params)[3]
  }

  // ---------------------------------------------------------------- 繪製

  /**
   * 跑一次 render graph。
   *
   * 兩個槽位都必須有描述 —— 只載入單一素材時，呼叫端應把同一格上傳到兩個槽位，
   * 而不是在這裡用未初始化的貼圖湊數（那會畫出黑畫面卻不報錯，是最難查的一種 bug）。
   */
  render(sources: [SourceDescriptor, SourceDescriptor], params: RenderParams): void {
    const gl = this.#gl
    const width = this.#canvas.width
    const height = this.#canvas.height
    if (width === 0 || height === 0) return

    this.#linear.resize(width, height)
    this.#applyFilter(params.interpolation)

    if (this.#timingEnabled) {
      this.#gpuTimer.poll()
      this.#gpuTimer.begin()
    }

    gl.bindVertexArray(this.#vao)

    const ctx: PassContext = {
      gl,
      width,
      height,
      params,
      sources,
      // stage 的長寬比以 A 為準。A/B 長寬比不同時的處理是 Phase 4 的工作
      // （偵測不一致並提示使用者），不在這裡隱性拉伸。
      stageAspect: sources[0].width / sources[0].height,
      sourceTextures: this.#textures,
      sourceSizes: this.#textureSizes,
      linear: this.#linear,
      drawFullscreen: () => gl.drawArrays(gl.TRIANGLES, 0, 3),
    }

    this.#graph.execute(ctx)

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
    this.#linear.dispose()
    this.#graph.dispose()
    gl.deleteVertexArray(this.#vao)
    this.#gpuTimer.dispose()
  }
}
