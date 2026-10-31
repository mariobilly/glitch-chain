import type { EffectDef } from './types'

export const blockGlitch: EffectDef = {
  id: 'blockGlitch',
  name: 'Block Glitch',
  params: [
    { key: 'amount', min: 0, max: 1, default: 0.15 },
    { key: 'blockSize', label: 'block size (px)', min: 4, max: 300, step: 1, default: 60 },
    { key: 'aspect', min: 0.2, max: 8, default: 3 },
    { key: 'speed', min: 0, max: 30, default: 8 },
    { key: 'shift', min: 0, max: 0.5, default: 0.1 },
    { key: 'swap', label: 'channel swap', min: 0, max: 1, default: 0.4 }
  ],
  frag: /* glsl */ `
uniform float u_amount, u_blockSize, u_aspect, u_speed, u_shift, u_swap;
void main() {
  vec2 bs = vec2(u_blockSize * u_aspect, u_blockSize) / uRes;
  vec2 b = floor(vUv / bs);
  float st = floor(uTime * u_speed);
  vec3 col;
  if (hash12(b + st * 1.37) < u_amount) {
    vec2 o = (vec2(hash12(b + st + 3.1), hash12(b + st + 7.7)) - 0.5) * 2.0 * u_shift;
    o.y *= 0.15;
    col = texture(uTex, vUv + o).rgb;
    float s = hash12(b + st + 11.0);
    if (s < u_swap * 0.5) col = col.brg; else if (s < u_swap) col = col.gbr;
  } else col = texture(uTex, vUv).rgb;
  outColor = vec4(col, 1.0);
}`
}
