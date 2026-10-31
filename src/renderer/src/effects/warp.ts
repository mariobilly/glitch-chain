import type { EffectDef, EffectRuntime } from './types'
import type { RT } from '../gl/Gpu'

const NOISE = /* glsl */ `
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p, float oct) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) { if (float(i) >= oct) break; s += a * vnoise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return s;
}
`

export const displace: EffectDef = {
  id: 'displace',
  name: 'Displace',
  params: [
    { key: 'amount', min: 0, max: 0.3, default: 0.04 },
    { key: 'map', type: 'select', options: { 'noise (liquid)': 0, 'own brightness': 1, 'sine bands': 2, 'blocks': 3 }, default: 0 },
    { key: 'scale', min: 0.2, max: 30, default: 4 },
    { key: 'speed', min: 0, max: 4, default: 0.4 },
    { key: 'octaves', min: 1, max: 6, step: 1, default: 3 },
    { key: 'direction', type: 'select', options: { both: 0, horizontal: 1, vertical: 2 }, default: 0 },
    { key: 'rgb', label: 'rgb split', min: 0, max: 1, default: 0.25 }
  ],
  frag:
    NOISE +
    /* glsl */ `
uniform float u_amount, u_map, u_scale, u_speed, u_octaves, u_direction, u_rgb;
vec2 field(vec2 uv) {
  vec2 p = uv * vec2(uRes.x / uRes.y, 1.0) * u_scale;
  float t = uTime * u_speed;
  vec2 d;
  if (u_map < 0.5) d = vec2(fbm(p + t, u_octaves), fbm(p + vec2(5.2, 1.3) - t, u_octaves)) - 0.5;
  else if (u_map < 1.5) {
    float l = luma(texture(uTex, uv).rgb);
    d = vec2(l - 0.5, 0.5 - l) + (vec2(fbm(p + t, 2.0), fbm(p - t, 2.0)) - 0.5) * 0.3;
  } else if (u_map < 2.5) d = vec2(sin(uv.y * u_scale * 20.0 + t * 6.0), cos(uv.x * u_scale * 13.0 - t * 4.0)) * 0.5;
  else {
    vec2 c = floor(p);
    d = vec2(hash12(c + floor(t * 4.0)), hash12(c + 9.1 + floor(t * 4.0))) - 0.5;
  }
  if (u_direction > 0.5 && u_direction < 1.5) d.y = 0.0;
  if (u_direction > 1.5) d.x = 0.0;
  return d * 2.0;
}
void main() {
  vec2 d = field(vUv) * u_amount;
  vec3 c = vec3(
    texture(uTex, vUv + d * (1.0 + u_rgb * 0.5)).r,
    texture(uTex, vUv + d).g,
    texture(uTex, vUv + d * (1.0 - u_rgb * 0.5)).b);
  outColor = vec4(c, 1.0);
}`
}

const FEEDBACK = NOISE + /* glsl */ `
uniform sampler2D uIn, uSelf;
uniform float uFeedback, uZoom, uRotate, uShiftX, uShiftY, uHue, uWarp, uMode, uFirst, uDecaySat;
void main() {
  vec3 cur = texture(uIn, vUv).rgb;
  // Transform the previous frame around the center: zoom, rotate, drift + a little noise warp.
  vec2 p = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float a = uRotate;
  p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p / uZoom;
  p += (vec2(fbm(p * 3.0 + uTime * 0.3, 3.0), fbm(p * 3.0 - uTime * 0.3 + 4.0, 3.0)) - 0.5) * uWarp;
  vec2 q = p / vec2(uRes.x / uRes.y, 1.0) + 0.5 - vec2(uShiftX, uShiftY);
  vec3 prev = texture(uSelf, q).rgb;
  vec3 yiq = rgb2yiq(prev);
  yiq.yz = mat2(cos(uHue), -sin(uHue), sin(uHue), cos(uHue)) * yiq.yz * uDecaySat;
  prev = yiq2rgb(yiq) * uFeedback;
  if (q.x < 0.0 || q.x > 1.0 || q.y < 0.0 || q.y > 1.0) prev = vec3(0.0);
  vec3 c = uMode < 0.5 ? max(cur, prev) : uMode < 1.5 ? cur + prev * 0.5 : mix(cur, prev, uFeedback);
  outColor = vec4(uFirst > 0.5 ? cur : c, 1.0);
}`

/** Own-state feedback (independent of the final output), for tunnels, spirals and fractal smears. */
export const feedbackWarp: EffectDef = {
  id: 'feedbackWarp',
  name: 'Feedback Warp',
  params: [
    { key: 'feedback', min: 0, max: 0.99, default: 0.85 },
    { key: 'mode', type: 'select', options: { lighten: 0, add: 1, mix: 2 }, default: 0 },
    { key: 'zoom', min: 0.9, max: 1.1, default: 1.02 },
    { key: 'rotate', label: 'rotate (rad/frame)', min: -0.1, max: 0.1, default: 0.01 },
    { key: 'shiftX', label: 'drift x', min: -0.02, max: 0.02, default: 0 },
    { key: 'shiftY', label: 'drift y', min: -0.02, max: 0.02, default: 0 },
    { key: 'warp', label: 'noise warp', min: 0, max: 0.05, default: 0.004 },
    { key: 'hue', label: 'hue cycle', min: 0, max: 0.5, default: 0.08 },
    { key: 'saturate', min: 0.5, max: 1.3, default: 1.02 }
  ],
  frag: /* glsl */ `
uniform sampler2D uFb;
void main() { outColor = vec4(texture(uFb, vUv).rgb, 1.0); }`,
  runtime: (_gl, gpu): EffectRuntime => {
    let st: [RT | null, RT | null] = [null, null]
    let cur = 0
    let first = true
    return {
      prepare({ input, width, height, time, params }) {
        st = [gpu.fit(st[0], width, height, 'rgba16f'), gpu.fit(st[1], width, height, 'rgba16f')]
        gpu.pass(FEEDBACK, st[cur]!, {
          uIn: input,
          uSelf: st[cur ^ 1]!,
          uFeedback: Number(params.feedback),
          uMode: Number(params.mode),
          uZoom: Number(params.zoom),
          uRotate: Number(params.rotate),
          uShiftX: Number(params.shiftX),
          uShiftY: Number(params.shiftY),
          uWarp: Number(params.warp),
          uHue: Number(params.hue),
          uDecaySat: Number(params.saturate),
          uFirst: first ? 1 : 0,
          uTime: time
        })
        const out = st[cur]!.tex
        cur ^= 1
        first = false
        return { uFb: out }
      },
      reset() {
        first = true
      },
      dispose() {
        st.forEach((t) => gpu.free(t))
      }
    }
  }
}

export const kaleido: EffectDef = {
  id: 'kaleido',
  name: 'Kaleido / Mirror',
  params: [
    { key: 'mode', type: 'select', options: { 'mirror left→right': 0, 'mirror top→bottom': 1, quad: 2, kaleidoscope: 3 }, default: 3 },
    { key: 'segments', min: 2, max: 16, step: 1, default: 6 },
    { key: 'rotate', min: 0, max: 6.2832, default: 0 },
    { key: 'spin', label: 'spin speed', min: -2, max: 2, default: 0.1 },
    { key: 'zoom', min: 0.3, max: 3, default: 1 },
    { key: 'centerX', label: 'center x', min: 0, max: 1, default: 0.5 },
    { key: 'centerY', label: 'center y', min: 0, max: 1, default: 0.5 },
    { key: 'amount', min: 0, max: 1, default: 1 }
  ],
  frag: /* glsl */ `
uniform float u_mode, u_segments, u_rotate, u_spin, u_zoom, u_centerX, u_centerY, u_amount;
void main() {
  vec2 uv = vUv;
  vec2 c = vec2(u_centerX, u_centerY);
  if (u_mode < 0.5) uv.x = c.x - abs(uv.x - c.x);
  else if (u_mode < 1.5) uv.y = c.y + abs(uv.y - c.y);
  else if (u_mode < 2.5) uv = c - abs(uv - c);
  else {
    float asp = uRes.x / uRes.y;
    vec2 p = (uv - c) * vec2(asp, 1.0);
    float r = length(p) / u_zoom;
    float a = atan(p.y, p.x) + u_rotate + uTime * u_spin;
    float seg = 6.28318 / u_segments;
    a = mod(a, seg);
    a = abs(a - seg * 0.5);
    uv = c + vec2(cos(a), sin(a)) * r / vec2(asp, 1.0);
  }
  uv = clamp(uv, 0.0, 1.0);
  outColor = vec4(mix(texture(uTex, vUv).rgb, texture(uTex, uv).rgb, u_amount), 1.0);
}`
}
