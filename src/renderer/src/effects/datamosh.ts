import type { EffectDef, EffectRuntime } from './types'
import type { RT } from '../gl/Gpu'

const SCALE = 8 // motion is estimated at 1/8 resolution

const DOWN = /* glsl */ `
uniform sampler2D uIn;
void main() {
  // 4-tap box average, luma only: smooth enough to match blocks, cheap enough to run every frame.
  vec2 t = 0.25 / uRes;
  float l = 0.0;
  l += luma(texture(uIn, vUv + vec2(-t.x, -t.y)).rgb);
  l += luma(texture(uIn, vUv + vec2( t.x, -t.y)).rgb);
  l += luma(texture(uIn, vUv + vec2(-t.x,  t.y)).rgb);
  l += luma(texture(uIn, vUv + vec2( t.x,  t.y)).rgb);
  outColor = vec4(l * 0.25, 0.0, 0.0, 1.0);
}`

/** Block matching: for each small pixel find d so that cur(p) ≈ prev(p + d). Output d in uv units. */
const FLOW = /* glsl */ `
uniform sampler2D uCur, uPrevL;
uniform float uR;
float L(sampler2D t, ivec2 p) { return texelFetch(t, clamp(p, ivec2(0), ivec2(uRes) - 1), 0).r; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 1e9;
  vec2 bd = vec2(0.0);
  for (int dy = -7; dy <= 7; dy++) {
    for (int dx = -7; dx <= 7; dx++) {
      if (abs(float(dx)) > uR || abs(float(dy)) > uR) continue;
      float c = 0.0;
      for (int qy = -1; qy <= 1; qy++)
        for (int qx = -1; qx <= 1; qx++) {
          ivec2 q = p + ivec2(qx, qy);
          c += abs(L(uCur, q) - L(uPrevL, q + ivec2(dx, dy)));
        }
      c += length(vec2(dx, dy)) * 0.01; // prefer no motion when it's a tie (kills noise shimmer)
      if (c < best) { best = c; bd = vec2(dx, dy); }
    }
  }
  outColor = vec4(bd / uRes, best, 1.0);
}`

const MOSH = /* glsl */ `
uniform sampler2D uIn, uMoshPrev, uFlow;
uniform float uStrength, uBlock, uRefresh, uBleed, uDrift, uSeed, uFirst;
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  // Macroblocks: every pixel in a block moves together, like a real codec's motion vectors.
  vec2 bs = max(uBlock, 1.0) / uRes;
  vec2 cell = floor(vUv / bs);
  vec2 cuv = uBlock > 1.5 ? (cell + 0.5) * bs : vUv;
  vec2 d = texture(uFlow, cuv).xy * uStrength;
  float a = vnoise(cuv * 6.0 + uTime * 0.15) * 12.566;
  d += vec2(cos(a), sin(a)) * uDrift;
  vec3 moshed = texture(uMoshPrev, vUv + d).rgb;
  vec3 inp = texture(uIn, vUv).rgb;
  float refresh = step(hash12(cell * 1.31 + uSeed), uRefresh);
  outColor = vec4(mix(moshed, inp, max(max(refresh, uBleed), uFirst)), 1.0);
}`

/** P-frame bleed: the previous moshed image is dragged along the current frame's motion instead of refreshed. */
export const datamosh: EffectDef = {
  id: 'datamosh',
  name: 'Datamosh',
  params: [
    { key: 'amount', min: 0, max: 1, default: 1 },
    { key: 'strength', label: 'motion strength', min: 0, max: 4, default: 1.6 },
    { key: 'block', label: 'macroblock (px)', min: 1, max: 64, step: 1, default: 16 },
    { key: 'range', label: 'search range', type: 'select', options: { small: 3, medium: 5, large: 7 }, default: 5 },
    { key: 'refresh', label: 'refresh (I-frame)', min: 0, max: 1, default: 0 },
    { key: 'bleed', label: 'clean bleed', min: 0, max: 0.3, default: 0.01 },
    { key: 'drift', min: 0, max: 0.02, default: 0.0015 }
  ],
  frag: /* glsl */ `
uniform sampler2D uMosh;
uniform float u_amount;
void main() { outColor = vec4(mix(texture(uTex, vUv).rgb, texture(uMosh, vUv).rgb, u_amount), 1.0); }`,
  runtime: (_gl, gpu): EffectRuntime => {
    let small: [RT | null, RT | null] = [null, null]
    let mosh: [RT | null, RT | null] = [null, null]
    let flow: RT | null = null
    let first = true
    let cur = 0
    return {
      prepare({ input, width, height, time, params }) {
        const sw = Math.ceil(width / SCALE)
        const sh = Math.ceil(height / SCALE)
        small = [gpu.fit(small[0], sw, sh, 'rgba16f'), gpu.fit(small[1], sw, sh, 'rgba16f')]
        mosh = [gpu.fit(mosh[0], width, height, 'rgba16f'), gpu.fit(mosh[1], width, height, 'rgba16f')]
        flow = gpu.fit(flow, sw, sh, 'rgba16f', false)
        const now = small[cur]!
        const before = small[cur ^ 1]!
        gpu.pass(DOWN, now, { uIn: input })
        gpu.pass(FLOW, flow, { uCur: now, uPrevL: first ? now : before, uR: Number(params.range) })
        gpu.pass(MOSH, mosh[cur]!, {
          uIn: input,
          uMoshPrev: mosh[cur ^ 1]!,
          uFlow: flow,
          uStrength: Number(params.strength),
          uBlock: Number(params.block),
          uRefresh: Number(params.refresh),
          uBleed: Number(params.bleed),
          uDrift: Number(params.drift),
          uSeed: Math.floor(time * 30) * 0.618,
          uFirst: first ? 1 : 0,
          uTime: time
        })
        const out = mosh[cur]!.tex
        first = false
        cur ^= 1
        return { uMosh: out }
      },
      reset() {
        first = true
      },
      dispose() {
        ;[...small, ...mosh, flow].forEach((t) => gpu.free(t))
      }
    }
  }
}
