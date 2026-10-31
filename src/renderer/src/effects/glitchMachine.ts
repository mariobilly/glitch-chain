import type { EffectDef } from './types'

/** Horizontal stretch-tear: bands shift, then pixels past a random edge smear out into rainbow streaks. */
export const glitchMachine: EffectDef = {
  id: 'glitchMachine',
  name: 'Glitch Machine',
  params: [
    { key: 'amount', min: 0, max: 1, default: 0.9 },
    { key: 'bands', min: 2, max: 160, step: 1, default: 28 },
    { key: 'density', min: 0, max: 1, default: 0.5 },
    { key: 'speed', label: 'speed (steps/s)', min: 0, max: 30, default: 6 },
    { key: 'shift', min: 0, max: 0.5, default: 0.08 },
    { key: 'stretch', min: 0, max: 1, default: 0.93 },
    { key: 'direction', type: 'select', options: { right: 1, left: -1, both: 0 }, default: 0 },
    { key: 'lineJitter', label: 'line jitter', min: 0, max: 0.1, default: 0.02 },
    { key: 'wave', min: 0, max: 0.2, default: 0.015 },
    { key: 'spread', label: 'rgb spread', min: 0, max: 0.08, default: 0.012 },
    { key: 'rainbow', min: 0, max: 1, default: 0.75 },
    { key: 'rainbowFreq', label: 'rainbow freq', min: 0, max: 8, default: 2.5 },
    { key: 'yMin', label: 'region top', min: 0, max: 1, default: 0.25 },
    { key: 'yMax', label: 'region bottom', min: 0, max: 1, default: 0.72 },
    { key: 'soft', label: 'region soft', min: 0, max: 0.3, default: 0.05 }
  ],
  frag: /* glsl */ `
uniform float u_amount, u_bands, u_density, u_speed, u_shift, u_stretch, u_direction, u_lineJitter,
  u_wave, u_spread, u_rainbow, u_rainbowFreq, u_yMin, u_yMax, u_soft;

void main() {
  float y = vUv.y;
  float yTop = 1.0 - y; // region sliders are measured from the top
  float st = floor(uTime * u_speed);
  float band = floor(y * u_bands);
  float coarse = floor(y * u_bands * 0.3);

  float on = step(1.0 - u_density, hash12(vec2(coarse, st + 1.7)));
  on = max(on, step(1.0 - u_density * 0.5, hash12(vec2(band, st + 9.1))));
  float region = smoothstep(u_yMin - u_soft, u_yMin, yTop) * (1.0 - smoothstep(u_yMax, u_yMax + u_soft, yTop));
  float k = on * region * u_amount;

  float line = floor(y * uRes.y / 2.0);
  float lj = (hash12(vec2(line, st)) - 0.5) * u_lineJitter;

  float dir = u_direction;
  if (dir == 0.0) dir = hash12(vec2(coarse, st + 2.3)) > 0.35 ? 1.0 : -1.0;
  float edge = 0.2 + 0.6 * hash12(vec2(coarse, st + 4.2)) + lj * 6.0;

  float x = vUv.x - (hash12(vec2(band, st)) - 0.5) * 2.0 * u_shift * k;
  x += sin(y * 90.0 + uTime * 7.0) * u_wave * k;
  float past = dir > 0.0 ? x - edge : edge - x;
  float smear = 0.0;
  if (past > 0.0 && k > 0.0) {
    x = edge + dir * past * (1.0 - u_stretch * k);
    smear = clamp(past * 3.0, 0.0, 1.0) * k;
  }
  x += lj * k;

  float sp = u_spread * k;
  vec3 col = vec3(texture(uTex, vec2(x + sp, y)).r, texture(uTex, vec2(x, y)).g, texture(uTex, vec2(x - sp, y)).b);

  float l = luma(col);
  vec3 rb = rainbow(l * u_rainbowFreq + hash12(vec2(line, st)) * 0.25 + vUv.x * 1.5 - uTime * 0.2) * (0.25 + l * 1.25);
  col = mix(col, rb, u_rainbow * max(smear, k * 0.12));
  outColor = vec4(col, 1.0);
}`
}
