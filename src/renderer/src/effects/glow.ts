import type { EffectDef, EffectRuntime } from './types'
import type { RT } from '../gl/Gpu'

const BRIGHT = /* glsl */ `
uniform sampler2D uIn;
uniform float uThreshold, uKnee;
void main() {
  vec3 c = texture(uIn, vUv).rgb;
  float l = max(c.r, max(c.g, c.b));
  // Soft knee so the glow fades in instead of clipping on at the threshold.
  float k = clamp((l - uThreshold + uKnee) / max(2.0 * uKnee, 1e-4), 0.0, 1.0);
  float w = max(l - uThreshold, 0.0) + k * k * uKnee * 0.5;
  outColor = vec4(c * w / max(l, 1e-4), 1.0);
}`

/** 13-tap-ish downsample (4 bilinear taps), stretched horizontally for anamorphic streaks. */
const DOWN = /* glsl */ `
uniform sampler2D uIn;
uniform float uStreak;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uIn, 0)) * vec2(1.0 + uStreak * 6.0, 1.0 / (1.0 + uStreak * 2.0));
  vec3 c = texture(uIn, vUv + vec2(-t.x, -t.y)).rgb + texture(uIn, vUv + vec2(t.x, -t.y)).rgb
         + texture(uIn, vUv + vec2(-t.x, t.y)).rgb + texture(uIn, vUv + vec2(t.x, t.y)).rgb;
  outColor = vec4(c * 0.25, 1.0);
}`

const UP = /* glsl */ `
uniform sampler2D uLow, uHigh;
uniform float uRadius;
void main() {
  vec2 t = 1.0 / vec2(textureSize(uLow, 0));
  vec3 c = texture(uLow, vUv).rgb * 4.0;
  c += (texture(uLow, vUv + vec2(t.x, 0)).rgb + texture(uLow, vUv - vec2(t.x, 0)).rgb + texture(uLow, vUv + vec2(0, t.y)).rgb + texture(uLow, vUv - vec2(0, t.y)).rgb) * 2.0;
  c += texture(uLow, vUv + t).rgb + texture(uLow, vUv - t).rgb + texture(uLow, vUv + vec2(t.x, -t.y)).rgb + texture(uLow, vUv + vec2(-t.x, t.y)).rgb;
  outColor = vec4(texture(uHigh, vUv).rgb + c / 16.0 * uRadius, 1.0);
}`

/** Multi-level bloom (bright pass → mip chain → tent upsample) in half float. */
export const glow: EffectDef = {
  id: 'glow',
  name: 'Glow',
  params: [
    { key: 'intensity', min: 0, max: 4, default: 1.2 },
    { key: 'threshold', min: 0, max: 1.5, default: 0.6 },
    { key: 'knee', min: 0, max: 1, default: 0.3 },
    { key: 'radius', min: 0.2, max: 1.5, default: 1 },
    { key: 'levels', min: 1, max: 7, step: 1, default: 6 },
    { key: 'streak', label: 'anamorphic streak', min: 0, max: 1, default: 0 },
    { key: 'tint', type: 'color', default: '#ffffff' }
  ],
  frag: /* glsl */ `
uniform sampler2D uBloom;
uniform float u_intensity;
uniform vec3 u_tint;
void main() { outColor = vec4(texture(uTex, vUv).rgb + texture(uBloom, vUv).rgb * u_intensity * u_tint, 1.0); }`,
  runtime: (_gl, gpu): EffectRuntime => {
    let down: (RT | null)[] = []
    let up: (RT | null)[] = []
    return {
      prepare({ input, width, height, params }) {
        const levels = Math.round(Number(params.levels))
        const streak = Number(params.streak)
        for (let i = 0; i < 8; i++) {
          const s = 2 ** (i + 1)
          down[i] = gpu.fit(down[i] ?? null, width / s, height / s, 'rgba16f')
          up[i] = gpu.fit(up[i] ?? null, width / s, height / s, 'rgba16f')
        }
        gpu.pass(BRIGHT, down[0]!, { uIn: input, uThreshold: Number(params.threshold), uKnee: Number(params.knee) })
        for (let i = 1; i < levels; i++) gpu.pass(DOWN, down[i]!, { uIn: down[i - 1]!, uStreak: streak })
        let low = down[levels - 1]!
        for (let i = levels - 2; i >= 0; i--) {
          gpu.pass(UP, up[i]!, { uLow: low, uHigh: down[i]!, uRadius: Number(params.radius) })
          low = up[i]!
        }
        return { uBloom: low.tex }
      },
      dispose() {
        ;[...down, ...up].forEach((t) => gpu.free(t))
        down = []
        up = []
      }
    }
  }
}
