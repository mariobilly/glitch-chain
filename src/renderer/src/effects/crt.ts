import type { EffectDef } from './types'

export const crt: EffectDef = {
  id: 'crt',
  name: 'CRT',
  params: [
    { key: 'scanlines', min: 0, max: 1, default: 0.45 },
    { key: 'lines', label: 'line count', min: 60, max: 1200, step: 1, default: 420 },
    { key: 'mask', label: 'rgb mask', min: 0, max: 1, default: 0.55 },
    { key: 'maskSize', label: 'mask pitch (px)', min: 1, max: 12, step: 1, default: 3 },
    { key: 'bloom', min: 0, max: 1.5, default: 0.35 },
    { key: 'curve', label: 'curvature', min: 0, max: 0.3, default: 0.04 },
    { key: 'vignette', min: 0, max: 1.5, default: 0.45 },
    { key: 'flicker', min: 0, max: 0.2, default: 0.03 },
    { key: 'brightness', min: 0.5, max: 2.5, default: 1.35 }
  ],
  frag: /* glsl */ `
uniform float u_scanlines, u_lines, u_mask, u_maskSize, u_bloom, u_curve, u_vignette, u_flicker, u_brightness;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  p += p * dot(p, p) * u_curve;
  vec2 uv = p * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { outColor = vec4(0, 0, 0, 1); return; }

  vec3 col = texture(uTex, uv).rgb;
  vec3 blur = vec3(0.0);
  vec2 px = 3.0 / uRes;
  for (int i = 0; i < 8; i++) {
    vec2 d = vec2(cos(float(i) * 0.785398), sin(float(i) * 0.785398)) * px;
    blur += texture(uTex, uv + d * 2.0).rgb + texture(uTex, uv + d * 5.0).rgb;
  }
  blur /= 16.0;
  col += blur * blur * u_bloom;

  float s = sin(uv.y * u_lines * 3.14159);
  col *= mix(1.0, 0.35 + 0.65 * s * s, u_scanlines);

  float mx = mod(floor(gl_FragCoord.x / u_maskSize), 3.0);
  vec3 m = mx < 1.0 ? vec3(1.0, 0.25, 0.25) : mx < 2.0 ? vec3(0.25, 1.0, 0.25) : vec3(0.25, 0.25, 1.0);
  float gap = step(u_maskSize * 3.0 - 1.0, mod(gl_FragCoord.y + (mx < 1.0 ? 0.0 : u_maskSize), u_maskSize * 3.0));
  m *= 1.0 - gap * 0.6;
  col *= mix(vec3(1.0), m * 1.6, u_mask);

  col *= u_brightness * (1.0 - u_flicker * hash11(floor(uTime * 60.0)));
  col *= 1.0 - u_vignette * dot(p, p) * 0.35;
  outColor = vec4(col, 1.0);
}`
}
