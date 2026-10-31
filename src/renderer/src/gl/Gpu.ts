import { VERT, HEADER } from './glsl'

export class Program {
  prog: WebGLProgram
  private locs = new Map<string, WebGLUniformLocation | null>()

  constructor(private gl: WebGL2RenderingContext, frag: string) {
    const compile = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader error')
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT))
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, frag))
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link error')
    this.prog = p
  }

  loc(name: string): WebGLUniformLocation | null {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.prog, name))
    return this.locs.get(name)!
  }
  f1(n: string, v: number): void {
    this.gl.uniform1f(this.loc(n), v)
  }
  f2(n: string, a: number, b: number): void {
    this.gl.uniform2f(this.loc(n), a, b)
  }
  f3(n: string, a: number, b: number, c: number): void {
    this.gl.uniform3f(this.loc(n), a, b, c)
  }
  tex(n: string, unit: number, t: WebGLTexture): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.uniform1i(this.loc(n), unit)
  }
}

export type Fmt = 'rgba8' | 'rgba16f' | 'rgba32f'

/** A render target: texture + framebuffer of a given size/format. */
export interface RT {
  tex: WebGLTexture
  fbo: WebGLFramebuffer
  w: number
  h: number
  fmt: Fmt
}

export type Uniform = number | number[] | WebGLTexture | RT

const isRT = (u: unknown): u is RT => typeof u === 'object' && u !== null && 'fbo' in u

/**
 * Small GPU toolkit shared by the pipeline and multi-pass effects: allocate float/8-bit targets and draw
 * fullscreen passes from a fragment body (the common HEADER is prepended; programs are cached by source).
 */
export class Gpu {
  /** Float color buffers are renderable (EXT_color_buffer_float). */
  readonly floatOk: boolean
  private programs = new Map<string, Program>()

  constructor(
    readonly gl: WebGL2RenderingContext,
    private vao: WebGLVertexArrayObject
  ) {
    this.floatOk = !!gl.getExtension('EXT_color_buffer_float')
    gl.getExtension('OES_texture_float_linear')
  }

  program(frag: string): Program {
    let p = this.programs.get(frag)
    if (!p) {
      p = new Program(this.gl, HEADER + frag)
      this.programs.set(frag, p)
    }
    return p
  }

  texture(filter: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  target(w: number, h: number, fmt: Fmt = 'rgba8', linear = true): RT {
    const gl = this.gl
    if (fmt !== 'rgba8' && !this.floatOk) fmt = 'rgba8'
    // 32-bit float is only filterable with OES_texture_float_linear; sorting/state buffers use NEAREST anyway.
    const tex = this.texture(linear && fmt !== 'rgba32f' ? gl.LINEAR : gl.NEAREST)
    w = Math.max(1, Math.round(w))
    h = Math.max(1, Math.round(h))
    if (fmt === 'rgba8') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    else if (fmt === 'rgba16f') gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { tex, fbo, w, h, fmt }
  }

  free(rt: RT | null | undefined): void {
    if (!rt) return
    this.gl.deleteTexture(rt.tex)
    this.gl.deleteFramebuffer(rt.fbo)
  }

  /** Returns `rt` if it already matches, otherwise frees it and allocates a new one. */
  fit(rt: RT | null, w: number, h: number, fmt: Fmt = 'rgba8', linear = true): RT {
    w = Math.max(1, Math.round(w))
    h = Math.max(1, Math.round(h))
    if (rt && rt.w === w && rt.h === h && (rt.fmt === fmt || !this.floatOk)) return rt
    this.free(rt)
    return this.target(w, h, fmt, linear)
  }

  /** Draw a fullscreen pass into `out` (null = canvas at the given size). `uRes` is set to the target size. */
  pass(frag: string, out: RT | null, uniforms: Record<string, Uniform>, canvasSize?: [number, number]): void {
    const gl = this.gl
    const p = this.program(frag)
    gl.useProgram(p.prog)
    const [w, h] = out ? [out.w, out.h] : canvasSize!
    p.f2('uRes', w, h)
    let unit = 0
    for (const [name, v] of Object.entries(uniforms)) {
      if (typeof v === 'number') p.f1(name, v)
      else if (Array.isArray(v)) {
        const loc = p.loc(name)
        if (v.length === 2) gl.uniform2fv(loc, v)
        else if (v.length === 3) gl.uniform3fv(loc, v)
        else if (v.length === 4) gl.uniform4fv(loc, v)
        else gl.uniform1fv(loc, v)
      } else p.tex(name, unit++, isRT(v) ? v.tex : v)
    }
    this.draw(out, w, h)
  }

  draw(out: RT | { fbo: WebGLFramebuffer } | null, w: number, h: number): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, out ? out.fbo : null)
    gl.viewport(0, 0, w, h)
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }
}
