import type { EffectDef } from './types'

// Depth effects read `uDepth`: the layer's depth in output space, 1 = nearest, 0 = farthest.

export const depthFog: EffectDef = {
  id: 'depthFog',
  name: 'Depth Fog',
  needsDepth: true,
  pickers: [{ param: 'start', label: 'Pick where fog starts', from: 'depth' }],
  params: [
    { key: 'density', min: 0, max: 1, default: 0.75 },
    { key: 'start', label: 'starts at (far 0 → near 1)', min: 0, max: 1, default: 0.55 },
    { key: 'end', label: 'full at', min: 0, max: 1, default: 0.1 },
    { key: 'color', type: 'color', default: '#9fb4c8' },
    { key: 'drift', label: 'drift (animated)', min: 0, max: 1, default: 0.25 }
  ],
  frag: /* glsl */ `
uniform sampler2D uDepth;
uniform float u_density, u_start, u_end, u_drift;
uniform vec3 u_color;
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  float d = texture(uDepth, vUv).r;
  // Fog grows as things get farther: 0 at "start" nearness, full at "end".
  float f = smoothstep(u_start, u_end, d) * u_density;
  f *= 1.0 - u_drift * 0.5 + u_drift * vnoise(vUv * vec2(3.0, 6.0) + vec2(uTime * 0.08, 0.0));
  outColor = vec4(mix(c, u_color, clamp(f, 0.0, 1.0)), 1.0);
}`
}

export const depthBlur: EffectDef = {
  id: 'depthBlur',
  name: 'Depth Blur (focus)',
  needsDepth: true,
  pickers: [{ param: 'focus', label: 'Pick focus on preview', from: 'depth' }],
  params: [
    { key: 'focus', label: 'focus (far 0 → near 1)', min: 0, max: 1, default: 0.8 },
    { key: 'range', label: 'sharp range', min: 0, max: 0.6, default: 0.08 },
    { key: 'falloff', label: 'blur falloff', min: 0.02, max: 1, default: 0.2 },
    { key: 'blur', label: 'max blur (px)', min: 0, max: 40, default: 16 },
    { key: 'bokeh', label: 'bokeh glow', min: 0, max: 1, default: 0.3 }
  ],
  frag: /* glsl */ `
uniform sampler2D uDepth;
uniform float u_focus, u_range, u_falloff, u_blur, u_bokeh;
float coc(vec2 uv) {
  // 0 inside the sharp range around the focus depth, ramping to full blur over "falloff".
  float d = texture(uDepth, uv).r;
  return clamp((abs(d - u_focus) - u_range) / u_falloff, 0.0, 1.0);
}
void main() {
  float r = coc(vUv) * u_blur;
  vec3 base = texture(uTex, vUv).rgb;
  if (r < 0.5) { outColor = vec4(base, 1.0); return; }
  // Golden-angle disk; each tap weighted by its own blur so sharp foreground doesn't smear into the background.
  vec3 acc = base;
  float wsum = 1.0;
  for (int i = 1; i < 40; i++) {
    float fi = float(i);
    float rad = sqrt(fi / 40.0) * r;
    float a = fi * 2.39996;
    vec2 uv = vUv + vec2(cos(a), sin(a)) * rad / uRes;
    vec3 s = texture(uTex, uv).rgb;
    float w = max(coc(uv), 0.05) * (1.0 + u_bokeh * 3.0 * smoothstep(0.7, 1.0, luma(s)));
    acc += s * w;
    wsum += w;
  }
  outColor = vec4(acc / wsum, 1.0);
}`
}

export const depthParallax: EffectDef = {
  id: 'depthParallax',
  name: '2.5D Parallax',
  needsDepth: true,
  pickers: [{ param: 'pivot', label: 'Pick pivot on preview', from: 'depth' }],
  params: [
    { key: 'amount', min: 0, max: 0.08, default: 0.02 },
    { key: 'speed', min: 0, max: 3, default: 0.6 },
    { key: 'orbit', label: 'orbit (0 sway → 1 circle)', min: 0, max: 1, default: 0.5 },
    { key: 'pivot', label: 'pivot depth', min: 0, max: 1, default: 0.5 },
    { key: 'zoom', label: 'dolly zoom', min: -0.1, max: 0.1, default: 0.02 }
  ],
  frag: /* glsl */ `
uniform sampler2D uDepth;
uniform float u_amount, u_speed, u_orbit, u_pivot, u_zoom;
void main() {
  // Fake camera move: nearer pixels shift more than far ones, around a pivot depth.
  float a = uTime * u_speed * 6.28318;
  vec2 dir = vec2(cos(a), sin(a) * u_orbit);
  vec2 uv = vUv;
  // Two refinement steps so the shift follows the depth at the displaced position (fewer tears).
  for (int i = 0; i < 2; i++) {
    float d = texture(uDepth, uv).r - u_pivot;
    uv = vUv - dir * d * u_amount - (vUv - 0.5) * d * u_zoom * (0.5 + 0.5 * sin(a));
  }
  outColor = vec4(texture(uTex, clamp(uv, 0.0, 1.0)).rgb, 1.0);
}`
}
