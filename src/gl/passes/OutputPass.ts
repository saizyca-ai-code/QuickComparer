/**
 * OUTPUT pass：線性光 → 顯示編碼，畫到 canvas。
 *
 * 圖的最後一個節點。ACES ODT 接進來時換掉的就是它（`graph.replace('output', …)`），
 * 合成核心與 overlay 完全不動 —— 這是 D001「線性光地基先行、ACES 疊上」的落點。
 */

import { buildProgram, uniformLocations } from '../glUtils'
import { TF_CODE } from '../params'
import { OUTPUT_SHADER, VERTEX_SHADER } from '../shaders'
import type { PassContext, RenderPass } from '../RenderGraph'

const UNIFORMS = ['uTex', 'uOutputTf', 'uToneMap'] as const

export class OutputPass implements RenderPass {
  readonly name = 'output'

  #gl: WebGL2RenderingContext
  #program: WebGLProgram
  #u: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

  constructor(gl: WebGL2RenderingContext) {
    this.#gl = gl
    this.#program = buildProgram(gl, VERTEX_SHADER, OUTPUT_SHADER)
    this.#u = uniformLocations(gl, this.#program, UNIFORMS)
  }

  execute(ctx: PassContext): void {
    const gl = ctx.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, ctx.width, ctx.height)

    gl.useProgram(this.#program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, ctx.linear.texture)
    gl.uniform1i(this.#u.uTex, 0)
    gl.uniform1i(this.#u.uOutputTf, TF_CODE[ctx.params.outputTransfer])
    gl.uniform1i(this.#u.uToneMap, ctx.params.toneMap ? 1 : 0)
    ctx.drawFullscreen()
  }

  dispose(): void {
    this.#gl.deleteProgram(this.#program)
  }
}
