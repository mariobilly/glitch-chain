import type { EffectDef, EffectRuntime } from './types'
import type { RT } from '../gl/Gpu'

// Sort space: one row per image row (horizontal) or column (vertical), padded to a multiple of the chunk size.
// rgb = color, a = working value (boundary index during the scan, sort key afterwards).

const METRIC = /* glsl */ `
float metric(vec3 c, float by) {
  if (by < 0.5) return luma(c);
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b));
  if (by > 1.5) return mx < 1e-4 ? 0.0 : (mx - mn) / mx; // saturation
  float d = mx - mn;
  if (d < 1e-4) return 0.0;
  float h = mx == c.r ? mod((c.g - c.b) / d, 6.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
  return h / 6.0; // hue
}`

const BUILD = METRIC + /* glsl */ `
uniform sampler2D uIn;
uniform float uLen, uRows, uAxis, uLo, uHi, uBy, uN, uStagger;
void main() {
  vec2 f = floor(gl_FragCoord.xy);
  // Each row starts its chunks at a different offset so chunk seams don't line up into visible bands.
  float i = f.x - floor(hash11(f.y * 1.37 + 0.5) * uN * uStagger);
  if (i < 0.0 || i >= uLen) { outColor = vec4(0.0, 0.0, 0.0, f.x); return; } // padding = fixed boundary
  vec2 uv = uAxis < 0.5 ? vec2((i + 0.5) / uLen, (f.y + 0.5) / uRows) : vec2((f.y + 0.5) / uRows, (i + 0.5) / uLen);
  vec3 c = texture(uIn, uv).rgb;
  float v = metric(c, uBy);
  bool inRange = v >= uLo && v <= uHi;
  // Pixels outside the range are boundaries (they store their own index); in-range pixels get sorted.
  outColor = vec4(c, inRange ? -1.0 : f.x);
}`

/** Inclusive prefix-max inside each chunk: every pixel learns the nearest boundary to its left. */
const SCAN = /* glsl */ `
uniform sampler2D uS;
uniform float uO, uN;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS, p, 0);
  float cs = floor(float(p.x) / uN) * uN;
  if (float(p.x) - uO >= cs) s.a = max(s.a, texelFetch(uS, ivec2(p.x - int(uO), p.y), 0).a);
  outColor = s;
}`

const KEYS = METRIC + /* glsl */ `
uniform sampler2D uS;
uniform float uN, uBy, uReverse;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uS, p, 0);
  float x = float(p.x);
  float key = x; // boundary: stays exactly where it is
  if (s.a != x) {
    float cs = floor(x / uN) * uN;
    float b = s.a >= cs ? s.a : cs - 1.0;
    float v = metric(s.rgb, uBy);
    // Keys of a run sit strictly between its left boundary and the next index, so runs sort in place.
    key = b + 0.5 + 0.49 * (uReverse > 0.5 ? 1.0 - v : v);
  }
  outColor = vec4(s.rgb, key);
}`

/** One compare-exchange step of a bitonic sorting network (stage k, distance j) within each chunk. */
const BITONIC = /* glsl */ `
uniform sampler2D uS;
uniform float uK, uJ, uN;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = int(uN), k = int(uK), j = int(uJ);
  int i = p.x % n;
  int partner = p.x - i + (i ^ j);
  vec4 a = texelFetch(uS, p, 0);
  vec4 b = texelFetch(uS, ivec2(partner, p.y), 0);
  bool asc = (i & k) == 0;
  bool lower = i < (i ^ j);
  // Swap only on strict inequality so equal keys never duplicate.
  bool swap = (asc == lower) ? b.a < a.a : b.a > a.a;
  outColor = swap ? b : a;
}`

/** Back from sort space to the output frame (nearest texel: low resolution gives chunky streaks on purpose). */
const UNMAP = /* glsl */ `
uniform sampler2D uS;
uniform float uLen, uRows, uAxis, uN, uStagger;
void main() {
  vec2 q = uAxis < 0.5 ? vUv : vUv.yx;
  float row = min(floor(q.y * uRows), uRows - 1.0);
  float off = floor(hash11(row * 1.37 + 0.5) * uN * uStagger);
  ivec2 t = ivec2(min(floor(q.x * uLen), uLen - 1.0) + off, row);
  outColor = vec4(texelFetch(uS, t, 0).rgb, 1.0);
}`

export const pixelSort: EffectDef = {
  id: 'pixelSort',
  name: 'Pixel Sort',
  params: [
    { key: 'amount', min: 0, max: 1, default: 1 },
    { key: 'lo', label: 'range low', min: 0, max: 1, default: 0.35 },
    { key: 'hi', label: 'range high', min: 0, max: 1, default: 0.95 },
    { key: 'by', label: 'sort by', type: 'select', options: { brightness: 0, hue: 1, saturation: 2 }, default: 0 },
    { key: 'axis', label: 'direction', type: 'select', options: { horizontal: 0, vertical: 1 }, default: 1 },
    { key: 'reverse', type: 'bool', default: false },
    { key: 'chunk', label: 'max streak (px)', type: 'select', options: { '64': 64, '128': 128, '256': 256, '512': 512, '1024': 1024 }, default: 256 },
    { key: 'stagger', label: 'stagger seams', type: 'bool', default: true },
    { key: 'res', label: 'resolution', type: 'select', options: { full: 1, half: 0.5, quarter: 0.25 }, default: 1 }
  ],
  frag: /* glsl */ `
uniform sampler2D uSorted;
uniform float u_amount;
void main() { outColor = vec4(mix(texture(uTex, vUv).rgb, texture(uSorted, vUv).rgb, u_amount), 1.0); }`,
  runtime: (_gl, gpu): EffectRuntime => {
    let a: RT | null = null
    let b: RT | null = null
    let out: RT | null = null
    return {
      prepare({ input, width, height, params }) {
        const res = Number(params.res)
        const axis = Number(params.axis)
        const n = Number(params.chunk)
        const len = Math.max(1, Math.round((axis < 0.5 ? width : height) * res))
        const rows = Math.max(1, Math.round((axis < 0.5 ? height : width) * res))
        const stagger = params.stagger ? 1 : 0
        const padded = Math.ceil((len + (stagger ? n : 0)) / n) * n
        a = gpu.fit(a, padded, rows, 'rgba32f', false)
        b = gpu.fit(b, padded, rows, 'rgba32f', false)
        out = gpu.fit(out, width, height, 'rgba16f')
        let src = a
        let dst = b
        const step = (frag: string, u: Record<string, number | RT>): void => {
          gpu.pass(frag, dst, { uS: src, ...u })
          ;[src, dst] = [dst, src]
        }
        const by = Number(params.by)
        gpu.pass(BUILD, src, { uIn: input, uLen: len, uRows: rows, uAxis: axis, uLo: Number(params.lo), uHi: Number(params.hi), uBy: by, uN: n, uStagger: stagger })
        for (let o = 1; o < n; o *= 2) step(SCAN, { uO: o, uN: n })
        step(KEYS, { uN: n, uBy: by, uReverse: params.reverse ? 1 : 0 })
        for (let k = 2; k <= n; k *= 2) for (let j = k / 2; j >= 1; j /= 2) step(BITONIC, { uK: k, uJ: j, uN: n })
        gpu.pass(UNMAP, out, { uS: src, uLen: len, uRows: rows, uAxis: axis, uN: n, uStagger: stagger })
        return { uSorted: out.tex }
      },
      dispose() {
        ;[a, b, out].forEach((t) => gpu.free(t))
      }
    }
  }
}
