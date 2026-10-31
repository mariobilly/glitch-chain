import type { EffectDef } from './types'

export const rgbSplit: EffectDef = {
  id: 'rgbSplit',
  name: 'RGB Split',
  params: [
    { key: 'amount', min: 0, max: 0.06, default: 0.006 },
    { key: 'angle', min: 0, max: 360, default: 0 },
    { key: 'jitter', min: 0, max: 1, default: 0.3 },
    { key: 'speed', min: 0, max: 30, default: 12 }
  ],
  frag: /* glsl */ `
uniform float u_amount, u_angle, u_jitter, u_speed;
void main() {
  float a = radians(u_angle);
  float j = 1.0 + (hash11(floor(uTime * u_speed)) - 0.5) * 2.0 * u_jitter;
  vec2 o = vec2(cos(a), sin(a)) * u_amount * j;
  outColor = vec4(texture(uTex, vUv + o).r, texture(uTex, vUv).g, texture(uTex, vUv - o).b, 1.0);
}`
}
