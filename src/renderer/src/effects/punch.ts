import type { EffectDef } from './types'

/** Zoom / shake / rotate / flash — built to be driven by beat hits (all params rest at 0). */
export const punch: EffectDef = {
  id: 'punch',
  name: 'Punch (zoom / shake / flash)',
  params: [
    { key: 'zoom', min: 0, max: 1, default: 0 },
    { key: 'shake', min: 0, max: 1, default: 0 },
    { key: 'rotate', label: 'rotate (°)', min: -30, max: 30, default: 0 },
    { key: 'flash', min: 0, max: 1, default: 0 },
    { key: 'flashColor', label: 'flash color', type: 'color', default: '#ffffff' }
  ],
  frag: /* glsl */ `
uniform float u_zoom, u_shake, u_rotate, u_flash;
uniform vec3 u_flashColor;
void main() {
  vec2 aspect = vec2(uRes.x / uRes.y, 1.0);
  vec2 p = (vUv - 0.5) * aspect;
  float a = radians(u_rotate);
  p = mat2(cos(a), sin(a), -sin(a), cos(a)) * p;
  p /= 1.0 + u_zoom * 0.6;
  // Shake: a new random offset 30 times a second, scaled by the (usually beat-driven) amount.
  float k = floor(uTime * 30.0);
  p += (vec2(hash11(k), hash11(k + 17.3)) - 0.5) * u_shake * 0.12;
  vec2 uv = p / aspect + 0.5;
  // Mirror at the edges so zoomed-out / shaken frames never show a hard border.
  uv = 1.0 - abs(1.0 - mod(uv, 2.0));
  vec3 c = texture(uTex, uv).rgb;
  outColor = vec4(mix(c, u_flashColor, u_flash), 1.0);
}`
}
