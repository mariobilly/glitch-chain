import type { EffectDef } from './types'

export const pixelate: EffectDef = {
  id: 'pixelate',
  name: 'Pixelate',
  params: [
    { key: 'size', label: 'size (px)', min: 1, max: 80, step: 1, default: 6 },
    { key: 'aspect', min: 0.25, max: 4, default: 1 }
  ],
  frag: /* glsl */ `
uniform float u_size, u_aspect;
void main() {
  vec2 s = vec2(u_size * u_aspect, u_size) / uRes;
  outColor = vec4(texture(uTex, (floor(vUv / s) + 0.5) * s).rgb, 1.0);
}`
}

/** Feedback trails from the previous output frame. */
export const echo: EffectDef = {
  id: 'echo',
  name: 'Echo / Feedback',
  params: [
    { key: 'feedback', min: 0, max: 0.98, default: 0.6 },
    { key: 'mode', type: 'select', options: { mix: 0, lighten: 1 }, default: 1 },
    { key: 'offsetX', label: 'drift x', min: -0.02, max: 0.02, default: 0.003 },
    { key: 'offsetY', label: 'drift y', min: -0.02, max: 0.02, default: 0 },
    { key: 'zoom', min: 0.95, max: 1.05, default: 1.0 },
    { key: 'hueDrift', label: 'hue drift', min: 0, max: 0.5, default: 0.05 }
  ],
  frag: /* glsl */ `
uniform float u_feedback, u_mode, u_offsetX, u_offsetY, u_zoom, u_hueDrift;
void main() {
  vec3 cur = texture(uTex, vUv).rgb;
  vec2 puv = (vUv - 0.5) / u_zoom + 0.5 - vec2(u_offsetX, u_offsetY);
  vec3 yiq = rgb2yiq(texture(uPrev, puv).rgb);
  float a = u_hueDrift;
  yiq.yz = mat2(cos(a), -sin(a), sin(a), cos(a)) * yiq.yz;
  vec3 prev = yiq2rgb(yiq) * u_feedback;
  outColor = vec4(u_mode > 0.5 ? max(cur, prev) : mix(cur, prev, u_feedback), 1.0);
}`
}

export const grade: EffectDef = {
  id: 'grade',
  name: 'Color Grade',
  params: [
    { key: 'exposure', min: -2, max: 2, default: 0 },
    { key: 'contrast', min: 0, max: 3, default: 1.1 },
    { key: 'saturation', min: 0, max: 3, default: 1.2 },
    { key: 'gamma', min: 0.3, max: 3, default: 1 },
    { key: 'tint', type: 'color', default: '#ffffff' },
    { key: 'posterize', min: 0, max: 32, step: 1, default: 0 }
  ],
  frag: /* glsl */ `
uniform float u_exposure, u_contrast, u_saturation, u_gamma, u_posterize;
uniform vec3 u_tint;
void main() {
  vec3 c = texture(uTex, vUv).rgb * exp2(u_exposure);
  c = (c - 0.5) * u_contrast + 0.5;
  c = mix(vec3(luma(c)), c, u_saturation);
  c = pow(max(c, 0.0), vec3(1.0 / u_gamma)) * u_tint;
  if (u_posterize >= 2.0) c = floor(c * u_posterize + 0.5) / u_posterize;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`
}
