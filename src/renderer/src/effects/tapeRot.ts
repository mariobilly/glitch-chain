import type { EffectDef } from './types'

/** VHS decay: line jitter, rolling tracking band, chroma bleed, grain, color crush. */
export const tapeRot: EffectDef = {
  id: 'tapeRot',
  name: 'Tape Rot',
  params: [
    { key: 'jitter', min: 0, max: 0.03, default: 0.004 },
    { key: 'wobble', min: 0, max: 0.02, default: 0.003 },
    { key: 'tracking', min: 0, max: 1, default: 0.45 },
    { key: 'trackSpeed', label: 'track speed', min: -1, max: 1, default: 0.12 },
    { key: 'bleed', label: 'chroma bleed', min: 0, max: 0.03, default: 0.008 },
    { key: 'chromaShift', label: 'chroma shift', min: -0.02, max: 0.02, default: 0.004 },
    { key: 'saturation', min: 0, max: 3, default: 1.5 },
    { key: 'noise', min: 0, max: 1, default: 0.18 },
    { key: 'dropouts', min: 0, max: 1, default: 0.25 },
    { key: 'levels', label: 'color levels', min: 2, max: 64, step: 1, default: 40 }
  ],
  frag: /* glsl */ `
uniform float u_jitter, u_wobble, u_tracking, u_trackSpeed, u_bleed, u_chromaShift, u_saturation, u_noise, u_dropouts, u_levels;
void main() {
  float line = floor(vUv.y * uRes.y / 2.0);
  float fr = floor(uTime * 30.0);
  float x = vUv.x + (hash12(vec2(line, fr)) - 0.5) * u_jitter;
  x += sin(vUv.y * 12.0 + uTime * 2.0) * u_wobble * noise1(uTime * 0.7);

  float ty = fract(1.0 - uTime * u_trackSpeed);
  float band = smoothstep(0.07, 0.0, abs(vUv.y - ty)) * u_tracking;
  x += band * (hash12(vec2(line, fr + 5.0)) - 0.3) * 0.06;
  vec2 uv = vec2(x, vUv.y);

  float Y = rgb2yiq(texture(uTex, uv).rgb).x;
  vec2 c = vec2(0.0);
  for (int i = -4; i <= 4; i++) {
    c += rgb2yiq(texture(uTex, uv + vec2(float(i) * u_bleed * 0.25 + u_chromaShift, 0.0)).rgb).yz;
  }
  c /= 9.0;
  vec3 col = yiq2rgb(vec3(Y, c * u_saturation));

  col += (hash12(vUv * uRes + fr * 13.1) - 0.5) * u_noise * 0.5;
  col += band * hash12(vec2(vUv.x * uRes.x * 0.2, line + fr)) * u_noise * 1.5;
  float drop = step(1.0 - u_dropouts * 0.02, hash12(vec2(line, fr * 0.37)));
  col = mix(col, vec3(0.9), drop * step(0.5, hash12(vec2(floor(vUv.x * 30.0), line))));

  col = floor(clamp(col, 0.0, 1.0) * u_levels + 0.5) / u_levels;
  outColor = vec4(col, 1.0);
}`
}
