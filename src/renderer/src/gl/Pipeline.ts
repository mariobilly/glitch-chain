import { HEADER, BLIT, SOURCE, COMPARE, MASK, BLEND, DEPTHMAP } from './glsl'
import { Gpu, Program, type RT } from './Gpu'
import { EFFECTS } from '../effects'
import type { EffectDef, EffectRuntime, Instance, Params } from '../effects/types'
import type { AudioAnalysis } from '../audio/analysis'
import { modulate } from '../anim'
import type { Capsule, Face, LimbKind, ObjBox } from '../vision/SubjectTracker'
import { SHAPE_PARAMS } from '../effects/types'

/** Per-frame subject data for masked effects. */
export interface Subjects {
  faces: Face[]
  caps: Record<LimbKind, Capsule[]>
  maskTex: WebGLTexture
  hasMask: boolean
  partsTex: WebGLTexture
  hasParts: boolean
  objects: ObjBox[]
  /** Current frame of each precomputed mask track, by track id. */
  tracks: Record<string, WebGLTexture>
  /** Estimated depth of the layer's source (source space, 1 = near), if any effect or mask needs it. */
  depthTex?: WebGLTexture | null
}
import { isNumberParam } from '../effects/types'

/** One layer to render: its source framing, its effects, and its settings card (blend/opacity/mask). */
export interface LayerRender {
  id: string
  src: SourceParams
  effects: Instance[]
  /** The layer's settings instance; null = plain normal blend at full opacity, no mask. */
  settings: Instance | null
  subjects: Subjects | null
}

export interface SourceParams {
  fit: number
  zoom: number
  panX: number
  panY: number
  gray: number
  contrast: number
  brightness: number
}

type Target = RT

const hexToRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export class Pipeline {
  readonly gl: WebGL2RenderingContext
  width = 1080
  height = 1920
  private targets: Target[] = []
  /** Source pass output (the "before" image for compare). */
  private srcTarget!: Target
  private prev!: Target
  private programs = new Map<string, Program>()
  private runtimes = new Map<string, EffectRuntime>()
  private srcProgram: Program
  private blitProgram: Program
  private compareProgram: Program
  private maskProgram: Program
  /** Scratch output for masked effects before they're blended back. */
  private tmp!: Target
  /** Rasterized freehand masks per instance (rebuilt when the drawing or feather changes). */
  private drawTex = new Map<string, { tex: WebGLTexture; key: string }>()
  private blank: WebGLTexture | null = null
  /** Display-only compare: 0 off, 1 show original, 2 split (left = original). Never affects renders. */
  compare = { mode: 0, split: 0.5 }
  /** Source textures per layer id, with their pixel size. */
  private sources = new Map<string, { tex: WebGLTexture; size: [number, number] }>()
  /** Size of the source of the layer currently being rendered (masks map through it). */
  private srcSize: [number, number] = [1, 1]
  private blendProgram: Program
  private depthProgram: Program
  /** The current layer's depth in output space, and whether it is valid for this layer. */
  private depthTarget!: Target
  private depthReady = false
  /** Layer accumulation (ping-pong) and the base layer's untouched source (compare "before"). */
  private acc: Target[] = []
  private before!: Target
  private vao: WebGLVertexArrayObject
  readonly gpu: Gpu
  frame = 0

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false, alpha: false })
    if (!gl) throw new Error('WebGL2 not available')
    this.gl = gl
    this.vao = gl.createVertexArray()!
    this.gpu = new Gpu(gl, this.vao)
    this.srcProgram = new Program(gl, SOURCE)
    this.blitProgram = new Program(gl, BLIT)
    this.compareProgram = new Program(gl, COMPARE)
    this.maskProgram = new Program(gl, MASK)
    this.blendProgram = new Program(gl, BLEND)
    this.depthProgram = new Program(gl, DEPTHMAP)
    this.resize(this.width, this.height)
  }

  makeTexture(filter: number): WebGLTexture {
    return this.gpu.texture(filter)
  }

  /** Working buffers are 16-bit float (no banding across long chains); `prev` stays 8-bit for readback. */
  private makeTarget(fmt: 'rgba8' | 'rgba16f' = 'rgba16f'): Target {
    return this.gpu.target(this.width, this.height, fmt)
  }

  resize(w: number, h: number): void {
    for (const t of [...this.targets, ...this.acc, this.prev, this.srcTarget, this.tmp, this.before, this.depthTarget]) this.gpu.free(t)
    this.width = this.canvas.width = Math.round(w)
    this.height = this.canvas.height = Math.round(h)
    this.targets = [this.makeTarget(), this.makeTarget()]
    this.prev = this.makeTarget('rgba8')
    this.srcTarget = this.makeTarget()
    this.tmp = this.makeTarget()
    this.acc = [this.makeTarget(), this.makeTarget()]
    this.before = this.makeTarget()
    this.depthTarget = this.makeTarget('rgba8')
    // Stateful effects (datamosh, feedback) start clean at a new size or a new render.
    for (const r of this.runtimes.values()) r.reset?.()
  }

  /** Upload an image / video frame / canvas as the source texture. */
  uploadSource(el: TexImageSource, w: number, h: number, layer = 'base'): void {
    const gl = this.gl
    let s = this.sources.get(layer)
    if (!s) {
      s = { tex: this.makeTexture(gl.LINEAR), size: [1, 1] }
      this.sources.set(layer, s)
    }
    s.size = [w, h]
    gl.bindTexture(gl.TEXTURE_2D, s.tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  }

  /** Forget a removed layer's source texture. */
  dropSource(layer: string): void {
    const s = this.sources.get(layer)
    if (s) this.gl.deleteTexture(s.tex)
    this.sources.delete(layer)
  }

  private programFor(def: EffectDef): Program {
    let p = this.programs.get(def.id)
    if (!p) {
      p = new Program(this.gl, HEADER + def.frag)
      this.programs.set(def.id, p)
    }
    return p
  }

  private runtimeFor(inst: Instance, def: EffectDef): EffectRuntime | undefined {
    if (!def.runtime) return undefined
    let r = this.runtimes.get(inst.uid)
    if (!r) {
      r = def.runtime(this.gl, this.gpu)
      this.runtimes.set(inst.uid, r)
    }
    return r
  }

  /** Drop runtimes for instances no longer in the chain. */
  prune(chain: Instance[]): void {
    const live = new Set(chain.map((c) => c.uid))
    for (const [uid, r] of this.runtimes) {
      if (!live.has(uid)) {
        r.dispose()
        this.runtimes.delete(uid)
      }
    }
  }

  /** Param values for this frame, with modulators applied (numbers only). */
  private resolveParams(def: EffectDef, inst: Instance, time: number, audio: AudioAnalysis | null): Params {
    const out: Params = {}
    for (const p of def.params) {
      const v = inst.params[p.key] ?? p.default
      out[p.key] = isNumberParam(p) ? modulate(inst, p.key, p.min, p.max, v as number, time, audio) : v
    }
    return out
  }

  private setUniforms(prog: Program, def: EffectDef, values: Params): void {
    for (const p of def.params) {
      const v = values[p.key]
      if (isNumberParam(p)) prog.f1('u_' + p.key, v as number)
      else if (p.type === 'bool') prog.f1('u_' + p.key, v ? 1 : 0)
      else if (p.type === 'color') prog.f3('u_' + p.key, ...hexToRgb(String(v)))
      else if (p.type === 'select' && typeof v === 'number') prog.f1('u_' + p.key, v)
    }
  }

  /** RGBA pixels of the last rendered frame (bottom-up rows). */
  readPixels(out?: Uint8Array): Uint8Array {
    const gl = this.gl
    const px = out && out.length === this.width * this.height * 4 ? out : new Uint8Array(this.width * this.height * 4)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.prev.fbo)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return px
  }

  private composite(before: Target, inst: Instance, src: SourceParams, sub: Subjects, time: number): void {
    const mask = inst.mask
    const p = this.maskProgram
    this.gl.useProgram(p.prog)
    this.common(p, time)
    p.tex('uTex', 0, before.tex)
    p.tex('uAfter', 1, this.tmp.tex)
    p.tex('uMask', 2, sub.maskTex)
    p.tex('uParts', 3, sub.partsTex)
    p.f1('uHasParts', sub.hasParts ? 1 : 0)
    p.f2('uSrcRes', this.srcSize[0], this.srcSize[1])
    p.f1('uFit', src.fit)
    p.f1('uZoom', src.zoom)
    p.f1('uPanX', src.panX)
    p.f1('uPanY', src.panY)
    const MODES: Record<string, number> = {
      face: 1,
      person: 2,
      hands: 3,
      fingers: 3,
      arms: 3,
      legs: 3,
      hair: 4,
      skin: 5,
      clothes: 6,
      track: 7,
      color: 8,
      shape: 9,
      draw: 10,
      object: 11,
      depth: 12
    }
    p.f1('uMode', MODES[mask.source] ?? 2)
    p.f1('uInvert', mask.invert ? 1 : 0)
    p.f1('uFeather', Math.max(0.001, mask.feather))
    p.f1('uExpand', Math.max(0.05, mask.expand))
    p.f1('uShow', mask.show ? 1 : 0)
    p.f1('uHasMask', sub.hasMask ? 1 : 0)
    const faces = sub.faces.slice(0, 4)
    p.f1('uFaceCount', faces.length)
    const fv = new Float32Array(16)
    const av = new Float32Array(4)
    faces.forEach((f, i) => {
      fv.set([f.cx, f.cy, f.rx, f.ry], i * 4)
      av[i] = f.angle
    })
    this.gl.uniform4fv(p.loc('uFaces'), fv)
    this.gl.uniform1fv(p.loc('uAngles'), av)
    // Every sampler the shader declares gets a real texture, even when unused this frame.
    const blank = this.blankTex()
    p.tex('uSrcImg', 4, this.srcTarget.tex)
    p.tex('uDepthOut', 7, this.depthReady ? this.depthTarget.tex : blank)
    p.f1('uHasDepth', this.depthReady ? 1 : 0)
    p.f1('uDepthLo', mask.depthLo ?? 0.5)
    p.f1('uDepthHi', mask.depthHi ?? 1)
    p.tex('uDraw', 5, mask.source === 'draw' ? this.drawTexture(inst) : blank)
    const track = mask.source === 'track' ? sub.tracks[mask.track] : undefined
    p.tex('uTrack', 6, track ?? blank)
    p.f1('uHasTrack', track ? 1 : 0)
    if (mask.source === 'color') {
      const n = parseInt(mask.color.replace('#', '').slice(0, 6), 16)
      p.f3('uKey', ((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
      p.f1('uTol', mask.tolerance)
    }
    if (mask.source === 'shape') {
      const v = (k: keyof typeof SHAPE_PARAMS): number => Number(inst.params[k] ?? SHAPE_PARAMS[k].default)
      this.gl.uniform4f(p.loc('uShape'), v('mask.cx'), v('mask.cy'), v('mask.w'), v('mask.h'))
      p.f1('uShapeAngle', v('mask.angle'))
      p.f1('uShapeRound', v('mask.round'))
    }
    if (mask.source === 'object') {
      const boxes = sub.objects.filter((b) => b.label === mask.label).slice(0, 16)
      const bv = new Float32Array(64)
      boxes.forEach((b, i) => bv.set([b.x, b.y, b.w, b.h], i * 4))
      p.f1('uBoxCount', boxes.length)
      this.gl.uniform4fv(p.loc('uBoxes'), bv)
    }
    if (mask.source === 'hands' || mask.source === 'fingers' || mask.source === 'legs' || mask.source === 'arms') {
      const caps = sub.caps[mask.source].slice(0, 64)
      const cv = new Float32Array(64 * 4)
      const rv = new Float32Array(64)
      caps.forEach((c, i) => {
        cv.set([c[0], c[1], c[2], c[3]], i * 4)
        rv[i] = c[4]
      })
      p.f1('uCapCount', caps.length)
      this.gl.uniform4fv(p.loc('uCaps'), cv)
      this.gl.uniform1fv(p.loc('uCapR'), rv)
    }
  }

  private blankTex(): WebGLTexture {
    if (!this.blank) {
      const gl = this.gl
      this.blank = this.gpu.texture(gl.NEAREST)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    }
    return this.blank
  }

  /** Freehand polygons -> blurred coverage texture in output space (cached until the drawing changes). */
  private drawTexture(inst: Instance): WebGLTexture {
    const { polys, feather } = inst.mask
    const key = JSON.stringify(polys) + feather + this.width + 'x' + this.height
    let e = this.drawTex.get(inst.uid)
    if (e && e.key === key) return e.tex
    const scale = Math.min(1, 720 / Math.max(this.width, this.height))
    const c = document.createElement('canvas')
    c.width = Math.round(this.width * scale)
    c.height = Math.round(this.height * scale)
    const g = c.getContext('2d')!
    g.fillStyle = '#000'
    g.fillRect(0, 0, c.width, c.height)
    g.filter = `blur(${(feather * Math.min(c.width, c.height)) / 30}px)`
    g.fillStyle = '#fff'
    for (const poly of polys) {
      if (poly.length < 6) continue
      g.beginPath()
      g.moveTo(poly[0] * c.width, poly[1] * c.height)
      for (let i = 2; i < poly.length; i += 2) g.lineTo(poly[i] * c.width, poly[i + 1] * c.height)
      g.closePath()
      g.fill()
    }
    const gl = this.gl
    const tex = e?.tex ?? this.gpu.texture(gl.LINEAR)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    this.drawTex.set(inst.uid, { tex, key })
    return tex
  }

  /** Color of the source image (before effects) at output uv (y down), for the color-key eyedropper. */
  sampleSource(u: number, v: number): [number, number, number] {
    const gl = this.gl
    const x = Math.min(this.width - 1, Math.max(0, Math.floor(u * this.width)))
    const y = Math.min(this.height - 1, Math.max(0, Math.floor((1 - v) * this.height)))
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.srcTarget.fbo)
    const out = new Float32Array(4)
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, out)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return [out[0], out[1], out[2]]
  }

  /** Last rendered frame as a top-down 2D canvas (no compare overlay). */
  toCanvas(): HTMLCanvasElement {
    const { width: w, height: h } = this
    const px = this.readPixels()
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    const img = g.createImageData(w, h)
    const row = w * 4
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row)
    g.putImageData(img, 0, 0)
    return c
  }

  /** Run fn at a temporary output size, then restore. */
  withSize<T>(w: number, h: number, fn: () => T): T {
    const prev: [number, number] = [this.width, this.height]
    this.resize(w, h)
    try {
      return fn()
    } finally {
      this.resize(prev[0], prev[1])
    }
  }

  private draw(target: Target | null): void {
    this.gpu.draw(target, this.width, this.height)
  }

  private common(p: Program, time: number): void {
    p.f2('uRes', this.width, this.height)
    p.f1('uTime', time)
    p.f1('uFrame', this.frame)
  }

  /** Single chain on the base layer (thumbnails, older callers). */
  render(chain: Instance[], time: number, src: SourceParams, audio: AudioAnalysis | null = null, subjects: Subjects | null = null): void {
    this.renderLayers([{ id: 'base', src, effects: chain, settings: null, subjects }], time, audio)
  }

  /** Source pass + effect chain for one layer; returns the target holding its result. */
  private renderLayer(layer: LayerRender, time: number, audio: AudioAnalysis | null): Target {
    const s = this.sources.get(layer.id)
    this.srcSize = s ? s.size : [1, 1]
    const src = layer.src
    const sp = this.srcProgram
    this.gl.useProgram(sp.prog)
    this.common(sp, time)
    sp.tex('uTex', 0, s ? s.tex : this.blankTex())
    sp.f2('uSrcRes', this.srcSize[0], this.srcSize[1])
    sp.f1('uFit', src.fit)
    sp.f1('uZoom', src.zoom)
    sp.f1('uPanX', src.panX)
    sp.f1('uPanY', src.panY)
    sp.f1('uGray', src.gray)
    sp.f1('uContrast', src.contrast)
    sp.f1('uBrightness', src.brightness)
    this.draw(this.srcTarget)

    // Depth follows the same framing as the image, so effects and masks can sample it at vUv.
    const depthTex = layer.subjects?.depthTex ?? null
    this.depthReady = !!depthTex
    if (depthTex) {
      const dp = this.depthProgram
      this.gl.useProgram(dp.prog)
      this.common(dp, time)
      dp.tex('uTex', 0, depthTex)
      dp.f2('uSrcRes', this.srcSize[0], this.srcSize[1])
      dp.f1('uFit', src.fit)
      dp.f1('uZoom', src.zoom)
      dp.f1('uPanX', src.panX)
      dp.f1('uPanY', src.panY)
      this.draw(this.depthTarget)
    }

    // Ping-pong between targets[0]/[1]; srcTarget is only read (masks key colors from it).
    let cur = this.srcTarget
    let a = 0
    for (const inst of layer.effects) {
      if (!inst.enabled) continue
      const def = EFFECTS[inst.effectId]
      if (!def || inst.effectId === 'layer') continue
      const values = this.resolveParams(def, inst, time, audio)
      const rt = this.runtimeFor(inst, def)
      // Multi-pass effects draw their own passes first (they change GL state), then the main shader runs.
      const extra = {
        ...(rt?.prepare?.({ input: cur.tex, width: this.width, height: this.height, time, params: values, frame: this.frame }) ?? {}),
        ...(rt?.textures?.(values, this.width, this.height) ?? {})
      }
      const prog = this.programFor(def)
      this.gl.useProgram(prog.prog)
      this.common(prog, time)
      prog.tex('uTex', 0, cur.tex)
      prog.tex('uPrev', 1, this.prev.tex)
      this.setUniforms(prog, def, values)
      let unit = 2
      for (const [name, t] of Object.entries(extra)) prog.tex(name, unit++, t)
      if (def.needsDepth) prog.tex('uDepth', unit++, this.depthReady ? this.depthTarget.tex : this.blankTex())
      const out = this.targets[a]
      if (inst.mask.source !== 'none' && layer.subjects) {
        this.draw(this.tmp)
        this.composite(cur, inst, src, layer.subjects, time)
        this.draw(out)
      } else this.draw(out)
      cur = out
      a ^= 1
    }
    return cur
  }

  /**
   * Render layers bottom to top: each through its own chain, then blended onto what's below with its
   * settings (blend mode, opacity with modulators/keys, optional mask). The base sits on black.
   */
  renderLayers(layers: LayerRender[], time: number, audio: AudioAnalysis | null = null): void {
    this.frame++
    const black = this.blankTex()
    let base: WebGLTexture = black
    let k = 0
    let first = true
    for (const layer of layers) {
      if (layer.settings && !layer.settings.enabled) continue
      const top = this.renderLayer(layer, time, audio)
      if (first) {
        // The first visible layer's untouched source is the "before" image for compare.
        this.copy(this.srcTarget.tex, this.before, time)
        first = false
      }
      const values = layer.settings ? this.resolveParams(EFFECTS.layer, layer.settings, time, audio) : { blend: 0, opacity: 1 }
      const out = this.acc[k]
      const bp = this.blendProgram
      this.gl.useProgram(bp.prog)
      this.common(bp, time)
      bp.tex('uBase', 0, base)
      bp.tex('uTop', 1, top.tex)
      bp.f1('uMode', Number(values.blend))
      bp.f1('uOpacity', Number(values.opacity))
      const masked = layer.settings && layer.settings.mask.source !== 'none' && layer.subjects
      if (masked) {
        // Blend into tmp, then let the layer's mask decide where the blended result replaces what's below.
        this.draw(this.tmp)
        const below = this.acc[k ^ 1]
        if (base === black) this.clear(below)
        this.composite(below, layer.settings!, layer.src, layer.subjects!, time)
        this.draw(out)
      } else this.draw(out)
      base = out.tex
      k ^= 1
    }
    const result = base === black ? null : this.acc[k ^ 1]
    const bl = this.blitProgram
    this.gl.useProgram(bl.prog)
    this.common(bl, time)
    bl.tex('uTex', 0, result ? result.tex : black)
    this.draw(this.prev)

    const cp = this.compareProgram
    this.gl.useProgram(cp.prog)
    this.common(cp, time)
    cp.tex('uTex', 0, result ? result.tex : black)
    cp.tex('uSrc', 1, this.before.tex)
    cp.f1('uMode', this.compare.mode)
    cp.f1('uSplit', this.compare.split)
    this.draw(null)
  }

  private copy(tex: WebGLTexture, to: Target, time: number): void {
    const bl = this.blitProgram
    this.gl.useProgram(bl.prog)
    this.common(bl, time)
    bl.tex('uTex', 0, tex)
    this.draw(to)
  }

  private clear(t: Target): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }
}
