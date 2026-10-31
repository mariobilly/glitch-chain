import type { EffectDef, EffectRuntime } from './types'

type RGB = [number, number, number]
const clamp = (x: number): number => Math.min(1, Math.max(0, x))
const luma = (c: RGB): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
const mix = (a: number, b: number, t: number): number => a + (b - a) * t
const scurve = (x: number, k: number): number => clamp(0.5 + (x - 0.5) * k - (x - 0.5) ** 3 * (k - 1) * 2)

/** Built-in looks, each a color transform baked into a 3D LUT. */
const LOOKS: Record<string, (c: RGB) => RGB> = {
  'Teal & Orange': (c) => {
    const l = luma(c)
    const t = clamp((l - 0.2) / 0.6)
    const tint: RGB = [mix(-0.06, 0.08, t), mix(0.03, 0.02, t), mix(0.08, -0.08, t)]
    const s = 1.2
    return c.map((v, i) => clamp(l + (v - l) * s + tint[i])) as RGB
  },
  'Bleach Bypass': (c) => {
    const l = luma(c)
    return c.map((v) => scurve(mix(v, l, 0.55), 1.35)) as RGB
  },
  'Cross Process': (c) => [scurve(c[0], 1.4), clamp(scurve(c[1], 1.2) + 0.03), clamp(0.12 + c[2] * 0.7)],
  'Faded Film': (c) => {
    const l = luma(c)
    return c.map((v, i) => clamp(0.08 + mix(v, l, 0.2) * 0.84 + [0.03, 0.01, -0.02][i])) as RGB
  },
  Noir: (c) => {
    const l = scurve(luma(c), 1.5)
    return [clamp(l * 0.97), clamp(l * 0.99), clamp(l * 1.04)]
  },
  Cyberpunk: (c) => {
    const l = luma(c)
    const t = clamp((l - 0.15) / 0.7)
    return [clamp(c[0] * 1.1 + mix(0.05, 0.12, t)), clamp(c[1] * 0.85), clamp(c[2] * 1.15 + mix(0.12, 0.02, t))]
  },
  'VHS Warm': (c) => {
    const l = luma(c)
    return c.map((v, i) => clamp(0.05 + mix(v, l, 0.15) * 0.88 + [0.06, 0.01 + (1 - l) * 0.01, -0.02][i])) as RGB
  }
}

const N = 33

function bake(f: (c: RGB) => RGB): { size: number; data: Float32Array } {
  const data = new Float32Array(N * N * N * 4)
  for (let b = 0; b < N; b++)
    for (let g = 0; g < N; g++)
      for (let r = 0; r < N; r++) {
        const o = f([r / (N - 1), g / (N - 1), b / (N - 1)])
        // Texture layout: x = b * N + r, y = g (one N x N slice per blue level, side by side).
        const i = (g * N * N + b * N + r) * 4
        data[i] = o[0]
        data[i + 1] = o[1]
        data[i + 2] = o[2]
        data[i + 3] = 1
      }
  return { size: N, data }
}

/** Parse an Adobe/Resolve .cube 3D LUT (red varies fastest, then green, then blue). */
export function parseCube(text: string): { size: number; data: Float32Array } {
  let size = 0
  let min: RGB = [0, 0, 0]
  let max: RGB = [1, 1, 1]
  const vals: number[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const key = parts[0].toUpperCase()
    if (key === 'LUT_3D_SIZE') size = Number(parts[1])
    else if (key === 'DOMAIN_MIN') min = parts.slice(1, 4).map(Number) as RGB
    else if (key === 'DOMAIN_MAX') max = parts.slice(1, 4).map(Number) as RGB
    else if (key === 'LUT_1D_SIZE') throw new Error('1D LUTs are not supported; export a 3D .cube')
    else if (/^[-+.\d]/.test(parts[0]) && parts.length >= 3) vals.push(Number(parts[0]), Number(parts[1]), Number(parts[2]))
  }
  if (!size || vals.length !== size * size * size * 3) throw new Error(`Not a valid 3D .cube (size ${size}, ${vals.length / 3} entries)`)
  const data = new Float32Array(size * size * size * 4)
  for (let b = 0; b < size; b++)
    for (let g = 0; g < size; g++)
      for (let r = 0; r < size; r++) {
        const s = ((b * size + g) * size + r) * 3
        const i = (g * size * size + b * size + r) * 4
        for (let k = 0; k < 3; k++) data[i + k] = (vals[s + k] - min[k]) / (max[k] - min[k] || 1)
        data[i + 3] = 1
      }
  return { size, data }
}

const cubeCache = new Map<string, Promise<{ size: number; data: Float32Array }>>()
function loadCube(path: string): Promise<{ size: number; data: Float32Array }> {
  let p = cubeCache.get(path)
  if (!p) {
    p = window.api.readFile(path).then((f) => parseCube(new TextDecoder().decode(f.data)))
    p.catch(() => cubeCache.delete(path))
    cubeCache.set(path, p)
  }
  return p
}

export const lut: EffectDef = {
  id: 'lut',
  name: 'LUT / Color Look',
  params: [
    { key: 'look', type: 'select', options: { ...Object.fromEntries(Object.keys(LOOKS).map((k) => [k, k])), 'custom .cube file': 'custom' }, default: 'Teal & Orange' },
    { key: 'file', label: '.cube file', type: 'file', filters: [{ name: '3D LUT (.cube)', extensions: ['cube'] }], sets: { look: 'custom' }, default: '' },
    { key: 'intensity', min: 0, max: 1, default: 1 }
  ],
  frag: /* glsl */ `
uniform sampler2D uLut;
uniform float u_intensity;
vec3 applyLut(vec3 c, float n) {
  c = clamp(c, 0.0, 1.0);
  float b = c.b * (n - 1.0);
  float b0 = floor(b);
  float b1 = min(b0 + 1.0, n - 1.0);
  vec2 rg = vec2(c.r * (n - 1.0) + 0.5, c.g * (n - 1.0) + 0.5);
  vec3 s0 = texture(uLut, vec2((b0 * n + rg.x) / (n * n), rg.y / n)).rgb;
  vec3 s1 = texture(uLut, vec2((b1 * n + rg.x) / (n * n), rg.y / n)).rgb;
  return mix(s0, s1, b - b0);
}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  // The LUT texture is (n*n) x n, so its height is the grid size; 0 until a LUT is loaded (then pass through).
  float n = float(textureSize(uLut, 0).y);
  outColor = vec4(mix(c, n > 1.5 ? applyLut(c, n) : c, u_intensity), 1.0);
}`,
  runtime: (gl): EffectRuntime => {
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    let key = ''
    const upload = (l: { size: number; data: Float32Array }): void => {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, l.size * l.size, l.size, 0, gl.RGBA, gl.FLOAT, l.data)
    }
    const clear = (): void => {
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    }
    return {
      textures(p) {
        const k = `${p.look}|${p.file}`
        if (k !== key) {
          key = k
          clear()
          if (p.look === 'custom') {
            if (p.file) loadCube(String(p.file)).then((l) => key === k && upload(l)).catch((e) => console.warn('LUT', e))
          } else upload(bake(LOOKS[String(p.look)] ?? LOOKS['Teal & Orange']))
        }
        return { uLut: tex }
      },
      dispose() {
        gl.deleteTexture(tex)
      }
    }
  }
}

export const filmGrain: EffectDef = {
  id: 'filmGrain',
  name: 'Film Grain',
  params: [
    { key: 'amount', min: 0, max: 1, default: 0.35 },
    { key: 'size', label: 'grain size', min: 0.5, max: 4, default: 1.3 },
    { key: 'color', label: 'color grain', min: 0, max: 1, default: 0.2 },
    { key: 'response', label: 'shadows ↔ highlights', min: -1, max: 1, default: 0 },
    { key: 'fps', label: 'grain rate (fps)', min: 0, max: 30, step: 1, default: 24 },
    { key: 'vignette', min: 0, max: 1, default: 0.25 }
  ],
  frag: /* glsl */ `
uniform float u_amount, u_size, u_color, u_response, u_fps, u_vignette;
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float grain(vec2 p, float seed) {
  // Two octaves of fine noise at the chosen grain size, re-seeded each grain frame.
  p = p / u_size + seed * 17.13;
  return (vnoise(p) * 0.65 + vnoise(p * 2.13 + 5.1) * 0.35) - 0.5;
}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float seed = u_fps > 0.0 ? floor(uTime * u_fps) : 0.0;
  vec2 p = vUv * uRes;
  float l = luma(c);
  // Film grain is strongest in the midtones; the response slider slides that peak toward shadows or highlights.
  float center = 0.5 + u_response * 0.35;
  float w = exp(-pow((l - center) / 0.32, 2.0)) * 0.85 + 0.15;
  float g = grain(p, seed);
  vec3 gc = vec3(grain(p, seed + 1.7), grain(p, seed + 3.1), grain(p, seed + 5.3));
  c += mix(vec3(g), gc, u_color) * u_amount * 0.45 * w;
  // Elliptical vignette that follows the frame: 0 at the centre, 1 in the corners.
  float d = length(vUv - 0.5) * 1.4142;
  c *= 1.0 - u_vignette * smoothstep(0.3, 1.0, d);
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`
}
