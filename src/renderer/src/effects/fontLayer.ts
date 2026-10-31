import type { EffectDef, EffectRuntime, Params } from './types'

// Bump when web fonts finish loading so cached text textures get redrawn.
let fontsVersion = 0
document.fonts.addEventListener('loadingdone', () => fontsVersion++)

const FONTS: Record<string, string> = {
  'VT323': '400 "VT323"',
  'Press Start 2P': '400 "Press Start 2P"',
  'Silkscreen': '700 "Silkscreen"',
  'Impact': '400 Impact',
  'Arial Black': '900 "Arial Black"',
  'Courier New': '700 "Courier New"',
  'Times': '700 "Times New Roman"'
}

/** Resolves once every bundled pixel font is loaded (so renders never use a fallback face). */
export async function preloadFonts(): Promise<void> {
  await Promise.all(Object.values(FONTS).map((f) => document.fonts.load(`${f.split(' ')[0]} 32px ${f.slice(f.indexOf(' ') + 1)}`).catch(() => [])))
}

/** Text drawn at low resolution (pixel size) onto a 2D canvas, composited so later passes glitch it. */
export const fontLayer: EffectDef = {
  id: 'fontLayer',
  name: 'Font Layer',
  params: [
    { key: 'text', label: 'text ( | = newline )', type: 'text', default: 'VIOLENT|BY DESIGN' },
    { key: 'font', type: 'select', options: Object.fromEntries(Object.keys(FONTS).map((k) => [k, k])), default: 'Silkscreen' },
    { key: 'color', type: 'color', default: '#ff1a1a' },
    { key: 'size', min: 0.01, max: 0.4, default: 0.06 },
    { key: 'x', min: -0.2, max: 1.2, default: 0.05 },
    { key: 'y', min: -0.2, max: 1.2, default: 0.56 },
    { key: 'align', type: 'select', options: { left: 'left', center: 'center', right: 'right' }, default: 'left' },
    { key: 'lineHeight', label: 'line height', min: 0.6, max: 2, default: 1.0 },
    { key: 'tracking', min: -0.2, max: 1, default: 0.05 },
    { key: 'pixel', label: 'pixel size', min: 1, max: 24, step: 1, default: 3 },
    { key: 'crisp', type: 'bool', default: true },
    { key: 'shadow', type: 'bool', default: false },
    { key: 'blend', type: 'select', options: { normal: 0, add: 1, screen: 2, difference: 3 }, default: 0 },
    { key: 'opacity', min: 0, max: 1, default: 1 }
  ],
  frag: /* glsl */ `
uniform sampler2D uText;
uniform float u_crisp, u_blend, u_opacity;
void main() {
  vec3 base = texture(uTex, vUv).rgb;
  vec4 t = texture(uText, vUv);
  float a = (u_crisp > 0.5 ? step(0.45, t.a) : t.a) * u_opacity;
  vec3 top = t.rgb;
  if (u_blend > 2.5) top = abs(base - t.rgb);
  else if (u_blend > 1.5) top = 1.0 - (1.0 - base) * (1.0 - t.rgb);
  else if (u_blend > 0.5) top = base + t.rgb;
  outColor = vec4(mix(base, clamp(top, 0.0, 1.0), a), 1.0);
}`,
  runtime: (gl): EffectRuntime => {
    const cvs = document.createElement('canvas')
    const ctx = cvs.getContext('2d')!
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    let key = ''

    const draw = (p: Params, w: number, h: number): void => {
      const px = Math.max(1, Math.round(Number(p.pixel)))
      cvs.width = Math.ceil(w / px)
      cvs.height = Math.ceil(h / px)
      ctx.clearRect(0, 0, cvs.width, cvs.height)
      const fs = Math.max(4, (Number(p.size) * h) / px)
      const font = FONTS[String(p.font)] ?? FONTS['Silkscreen']
      ctx.font = `${font.split(' ')[0]} ${fs}px ${font.slice(font.indexOf(' ') + 1)}, monospace`
      ctx.letterSpacing = `${Number(p.tracking) * fs}px`
      ctx.textBaseline = 'top'
      ctx.textAlign = String(p.align) as CanvasTextAlign
      if (p.shadow) {
        ctx.shadowColor = 'rgba(0,0,0,0.85)'
        ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(1, fs * 0.06)
      }
      ctx.fillStyle = String(p.color)
      const lines = String(p.text).split(/\||\n/)
      lines.forEach((l, i) => ctx.fillText(l, Number(p.x) * cvs.width, Number(p.y) * cvs.height + i * fs * Number(p.lineHeight)))
      ctx.shadowColor = 'transparent'
      document.fonts.load(ctx.font).catch(() => {})
    }

    return {
      textures(p, w, h) {
        const k = JSON.stringify(p) + w + 'x' + h + ':' + fontsVersion
        if (k !== key) {
          key = k
          draw(p, w, h)
          gl.bindTexture(gl.TEXTURE_2D, tex)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true)
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cvs)
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        }
        return { uText: tex }
      },
      dispose() {
        gl.deleteTexture(tex)
      }
    }
  }
}
