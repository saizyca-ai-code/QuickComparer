/**
 * COMPOSITE pass：把 A/B 依 pane 佈局與比對模式混合，寫進線性光緩衝。
 *
 * 這是圖的第一個節點，也是唯一會讀來源貼圖的節點。之後的 overlay 與 output
 * 都只看線性緩衝 —— 這個分界就是「合成核心不必為了 Text Track 或 ACES 改動」
 * 的來源。
 */

import { buildProgram, uniformLocations } from '../glUtils'
import { layoutPanes, stageRect } from '../layout'
import { INTERP_CODE, MODE_CODE, TF_CODE } from '../params'
import { COMPOSITE_SHADER, VERTEX_SHADER } from '../shaders'
import type { PassContext, RenderPass } from '../RenderGraph'

const UNIFORMS = [
  'uTexA', 'uTexB', 'uSizeA', 'uSizeB', 'uTfA', 'uTfB', 'uInterp',
  'uSplitPos', 'uSplitAngle', 'uSplitWidth', 'uSplitLinePx', 'uSplitPivotPx',
  'uSplitLineColor', 'uDiffGain', 'uMode', 'uShowSource', 'uPaneRect', 'uStageRect',
] as const

export class CompositePass implements RenderPass {
  readonly name = 'composite'

  #gl: WebGL2RenderingContext
  #program: WebGLProgram
  #u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl
    this.#program = buildProgram(gl, VERTEX_SHADER, COMPOSITE_SHADER)
    this.#u = uniformLocations(gl, this.#program, UNIFORMS)
  }

  execute(ctx: PassContext): void {
    const gl = ctx.gl
    const u = this.#u
    const { params, sources } = ctx

    ctx.linear.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.#program)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, ctx.sourceTextures[0])
    gl.uniform1i(u.uTexA, 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, ctx.sourceTextures[1])
    gl.uniform1i(u.uTexB, 1)

    const sizeA = ctx.sourceSizes[0]
    const sizeB = ctx.sourceSizes[1]
    gl.uniform2f(u.uSizeA, sizeA.w || 1, sizeA.h || 1)
    gl.uniform2f(u.uSizeB, sizeB.w || 1, sizeB.h || 1)
    gl.uniform1i(u.uTfA, TF_CODE[sources[0].transfer])
    gl.uniform1i(u.uTfB, TF_CODE[sources[1].transfer])
    gl.uniform1i(u.uInterp, INTERP_CODE[params.interpolation])
    gl.uniform1f(u.uSplitPos, params.splitPos)
    gl.uniform1f(u.uSplitAngle, params.splitAngle)
    gl.uniform1f(u.uSplitWidth, params.splitWidth)
    gl.uniform1f(u.uSplitLinePx, params.splitLinePx)
    gl.uniform1f(u.uSplitPivotPx, params.splitPivotPx)
    gl.uniform3f(
      u.uSplitLineColor,
      params.splitLineColor[0],
      params.splitLineColor[1],
      params.splitLineColor[2],
    )
    gl.uniform1f(u.uDiffGain, params.diffGain)

    // 每個 pane 一次 draw call，各自帶自己的 scissor 與矩形。
    gl.enable(gl.SCISSOR_TEST)
    for (const pane of layoutPanes(params, ctx.width, ctx.height)) {
      const rect = stageRect(pane, ctx.stageAspect, params)
      gl.scissor(pane.x, pane.y, pane.width, pane.height)
      gl.uniform4f(u.uPaneRect, pane.x, pane.y, pane.width, pane.height)
      gl.uniform4f(u.uStageRect, rect[0], rect[1], rect[2], rect[3])
      gl.uniform1i(u.uMode, MODE_CODE[pane.mode])
      gl.uniform1i(u.uShowSource, pane.showSource)
      ctx.drawFullscreen()
    }
    gl.disable(gl.SCISSOR_TEST)
  }

  dispose(): void {
    this.#gl.deleteProgram(this.#program)
  }
}
