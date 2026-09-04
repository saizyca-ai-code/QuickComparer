/** GL 的共用瑣事。pass 各自建自己的 program，所以編譯與連結不能留在 Compositor 裡。 */

export function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
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

export function buildProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('無法建立 shader program')

  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource)
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource)
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

/**
 * 一次把所有 uniform location 查好。
 *
 * 原本每格對每個 uniform 呼叫一次 getUniformLocation —— 那是字串查表，
 * 而且要跨到 GPU 行程。pass 的生命週期比影格長，查一次就夠。
 */
export function uniformLocations<K extends string>(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  names: readonly K[],
): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>
  for (const name of names) out[name] = gl.getUniformLocation(program, name)
  return out
}
