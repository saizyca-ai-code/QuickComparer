/**
 * Layer-based render graph。
 *
 *   [sources] → COMPOSITE → half-float 線性緩衝 → (overlay…) → OUTPUT → canvas
 *
 * D001 的判斷是 Text Track / Title / 浮水印遲早要進來，而 ACES ODT 也只是把
 * OUTPUT 換掉。Phase 0 已經把這條管線分成兩個 pass，但順序寫死在 render() 裡；
 * 這裡把 pass 變成可增減的節點，讓那兩件事變成「插一個 pass」而不是改結構。
 *
 * 中間緩衝維持 half-float 是硬性的：8-bit 下的線性光混合會在邊界產生假暗帶，
 * 而那正是比對工具最容易被誤讀成畫質差異的東西。
 */

import type { RenderParams, SourceDescriptor } from './params'

/**
 * 線性光工作緩衝。
 *
 * 提供 ping-pong 是為了讓「需要讀回整張畫面」的 pass（Phase 2 的 heatmap、
 * 放大鏡）不必自己配置 FBO。只在真的有 pass 呼叫 swap 時才配置第二張，
 * 4K half-float 一張就要 66 MB，不用就不該占。
 */
export class LinearBuffer {
  #gl: WebGL2RenderingContext
  #halfFloat: boolean
  #width = 0
  #height = 0
  #fbos: [WebGLFramebuffer | null, WebGLFramebuffer | null] = [null, null]
  #textures: [WebGLTexture | null, WebGLTexture | null] = [null, null]
  #index: 0 | 1 = 0

  constructor(gl: WebGL2RenderingContext, halfFloat: boolean) {
    this.#gl = gl
    this.#halfFloat = halfFloat
  }

  get width(): number {
    return this.#width
  }

  get height(): number {
    return this.#height
  }

  /** 目前正在寫入的那張的貼圖。OUTPUT pass 讀它。 */
  get texture(): WebGLTexture {
    const tex = this.#textures[this.#index]
    if (!tex) throw new Error('線性緩衝尚未配置')
    return tex
  }

  resize(width: number, height: number): void {
    if (this.#width === width && this.#height === height) return
    this.#width = width
    this.#height = height
    this.#index = 0
    for (const i of [0, 1] as const) {
      if (this.#textures[i]) this.#allocate(i)
    }
    if (!this.#textures[0]) this.#allocate(0)
  }

  /** 綁定為繪製目標。 */
  bind(): void {
    const gl = this.#gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.#fbos[this.#index])
    gl.viewport(0, 0, this.#width, this.#height)
  }

  /**
   * 換到另一張並回傳剛才寫好的那張。
   *
   * 給需要「讀整張畫面再寫回去」的 pass 用：先 swap 拿到來源貼圖，
   * 再 bind() 把結果寫進另一張。
   */
  swap(): WebGLTexture {
    const previous = this.texture
    this.#index = this.#index === 0 ? 1 : 0
    if (!this.#textures[this.#index]) this.#allocate(this.#index)
    return previous
  }

  #allocate(index: 0 | 1): void {
    const gl = this.#gl
    let tex = this.#textures[index]
    let fbo = this.#fbos[index]
    if (!tex) {
      tex = gl.createTexture()
      if (!tex) throw new Error('無法建立線性緩衝貼圖')
      this.#textures[index] = tex
    }
    if (!fbo) {
      fbo = gl.createFramebuffer()
      if (!fbo) throw new Error('無法建立 framebuffer')
      this.#fbos[index] = fbo
    }

    gl.bindTexture(gl.TEXTURE_2D, tex)
    if (this.#halfFloat) {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA16F, this.#width, this.#height, 0, gl.RGBA, gl.HALF_FLOAT, null,
      )
    } else {
      gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA8, this.#width, this.#height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null,
      )
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  dispose(): void {
    const gl = this.#gl
    for (const tex of this.#textures) if (tex) gl.deleteTexture(tex)
    for (const fbo of this.#fbos) if (fbo) gl.deleteFramebuffer(fbo)
    this.#textures = [null, null]
    this.#fbos = [null, null]
    this.#width = 0
    this.#height = 0
  }
}

/** 一次繪製中所有 pass 共用的東西。 */
export interface PassContext {
  gl: WebGL2RenderingContext
  /** 畫布尺寸（像素）。 */
  width: number
  height: number
  params: RenderParams
  /** 兩個來源槽位的描述。 */
  sources: [SourceDescriptor, SourceDescriptor]
  /** stage 的長寬比，以 A 為準。 */
  stageAspect: number
  /** 來源貼圖與其實際尺寸。 */
  sourceTextures: readonly [WebGLTexture, WebGLTexture]
  sourceSizes: readonly [{ w: number; h: number }, { w: number; h: number }]
  /** 線性光工作緩衝。 */
  linear: LinearBuffer
  /** 畫一個覆蓋整個 viewport 的三角形。VAO 已由 Compositor 綁好。 */
  drawFullscreen(): void
}

export interface RenderPass {
  /** 圖上的識別名稱，插入與移除都靠它。 */
  readonly name: string
  execute(ctx: PassContext): void
  dispose(): void
}

export type InsertPosition = { before: string } | { after: string }

/**
 * pass 的有序集合。
 *
 * 刻意不做自動的相依解析或拓撲排序 —— 這條管線是線性的，順序就是語意，
 * 多一層推導只會讓「為什麼 overlay 跑在 output 後面」變得更難查。
 */
export class RenderGraph {
  #passes: RenderPass[] = []

  get passes(): readonly RenderPass[] {
    return this.#passes
  }

  names(): string[] {
    return this.#passes.map((p) => p.name)
  }

  append(pass: RenderPass): void {
    this.#assertUnique(pass.name)
    this.#passes.push(pass)
  }

  insert(pass: RenderPass, at: InsertPosition): void {
    this.#assertUnique(pass.name)
    const anchor = 'before' in at ? at.before : at.after
    const index = this.#passes.findIndex((p) => p.name === anchor)
    if (index < 0) throw new Error(`render graph 裡沒有名為 ${anchor} 的 pass`)
    this.#passes.splice('before' in at ? index : index + 1, 0, pass)
  }

  /**
   * 就地換掉一個 pass，順序不變。ACES ODT 接進來時換的就是 output。
   *
   * 被換下來的 pass 原樣回傳而**不** dispose：ACES 是可以開關的，換回去時
   * 若 program 已被刪掉就只能重建。誰要留著它、誰負責釋放，由呼叫端決定；
   * 留在圖上的那些則由 dispose() 一併收掉。
   */
  replace(name: string, pass: RenderPass): RenderPass {
    const index = this.#passes.findIndex((p) => p.name === name)
    const previous = this.#passes[index]
    if (index < 0 || !previous) throw new Error(`render graph 裡沒有名為 ${name} 的 pass`)
    this.#passes[index] = pass
    return previous
  }

  /** 移除並回傳，同樣不 dispose。找不到時回傳 null。 */
  remove(name: string): RenderPass | null {
    const index = this.#passes.findIndex((p) => p.name === name)
    if (index < 0) return null
    const [removed] = this.#passes.splice(index, 1)
    return removed ?? null
  }

  execute(ctx: PassContext): void {
    for (const pass of this.#passes) pass.execute(ctx)
  }

  dispose(): void {
    for (const pass of this.#passes) pass.dispose()
    this.#passes = []
  }

  #assertUnique(name: string): void {
    if (this.#passes.some((p) => p.name === name)) {
      throw new Error(`render graph 已經有名為 ${name} 的 pass`)
    }
  }
}
