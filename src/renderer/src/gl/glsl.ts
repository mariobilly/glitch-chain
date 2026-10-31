export const VERT = /* glsl */ `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

export const HEADER = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform sampler2D uPrev;
uniform vec2 uRes;
uniform float uTime;
uniform float uFrame;

float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise1(float x) { float i = floor(x); float f = fract(x); return mix(hash11(i), hash11(i + 1.0), f * f * (3.0 - 2.0 * f)); }
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 rgb2yiq(vec3 c) { return vec3(dot(c, vec3(0.299, 0.587, 0.114)), dot(c, vec3(0.596, -0.274, -0.322)), dot(c, vec3(0.211, -0.523, 0.312))); }
vec3 yiq2rgb(vec3 c) { return vec3(dot(c, vec3(1.0, 0.956, 0.621)), dot(c, vec3(1.0, -0.272, -0.647)), dot(c, vec3(1.0, -1.106, 1.703))); }
vec3 rainbow(float t) { return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67))); }
`

/** Final float -> 8-bit copy with ±0.5 LSB dither so 16-bit gradients don't band. */
export const BLIT = HEADER + /* glsl */ `
void main() {
  vec3 c = texture(uTex, vUv).rgb;
  c += (hash12(gl_FragCoord.xy + fract(uTime) * 91.7) - 0.5) / 255.0;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`

/** Blends an effect's output over its input through a face-ellipse or person mask (mapped from source space). */
export const MASK = HEADER + /* glsl */ `
uniform sampler2D uAfter;
uniform sampler2D uMask;
uniform sampler2D uParts;
uniform float uHasParts;
uniform vec2 uSrcRes;
uniform float uFit, uZoom, uPanX, uPanY;
uniform float uMode, uInvert, uFeather, uExpand, uShow, uHasMask, uFaceCount;
uniform vec4 uFaces[4];
uniform float uAngles[4];
uniform vec4 uCaps[64];
uniform float uCapR[64];
uniform float uCapCount;
uniform sampler2D uSrcImg, uDraw, uTrack;
uniform vec3 uKey;
uniform float uTol, uHasTrack;
uniform vec4 uShape;          // cx, cy, w, h in output uv (y down)
uniform float uShapeAngle, uShapeRound;
uniform vec4 uBoxes[16];      // x, y, w, h in source pixels (y down)
uniform float uBoxCount;
uniform sampler2D uDepthOut;  // layer depth in output space (1 = near)
uniform float uDepthLo, uDepthHi, uHasDepth;

/** 1 inside a superellipse of half-size 1, 0 outside; n = 2 is an ellipse, large n approaches a rectangle. */
float superellipse(vec2 q, float n, float feather) {
  float d = pow(pow(abs(q.x), n) + pow(abs(q.y), n), 1.0 / n);
  return 1.0 - smoothstep(1.0 - feather * 0.5, 1.0 + feather * 0.5 + 1e-3, d);
}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0));
}

void main() {
  vec3 before = texture(uTex, vUv).rgb;
  vec3 after = texture(uAfter, vUv).rgb;

  // Same output->source mapping as the source pass (source uv is y-up).
  float ra = uRes.x / uRes.y, sa = uSrcRes.x / uSrcRes.y;
  vec2 s = vec2(1.0);
  if (uFit < 0.5) { if (sa > ra) s.x = ra / sa; else s.y = sa / ra; }
  else            { if (sa > ra) s.y = sa / ra; else s.x = ra / sa; }
  vec2 suv = (vUv - 0.5) * s / uZoom + 0.5 + vec2(uPanX, uPanY);

  float m = 0.0;
  if (uMode > 6.5) {
    if (uMode < 7.5) {
      // Precomputed track (AI object / Segment Anything): source space, top-down rows.
      if (uHasTrack > 0.5) {
        float c = texture(uTrack, vec2(suv.x, 1.0 - suv.y)).r;
        float th = clamp(0.5 / uExpand, 0.02, 0.98);
        m = smoothstep(th - uFeather * 0.5, th + uFeather * 0.5 + 1e-3, c);
      }
    } else if (uMode < 8.5) {
      // Color key on the untouched source image, compared in YIQ so hue matters more than brightness.
      vec3 a = rgb2yiq(texture(uSrcImg, vUv).rgb), b = rgb2yiq(uKey);
      float d = length((a - b) * vec3(0.6, 1.4, 1.4));
      float tol = uTol * uExpand;
      m = 1.0 - smoothstep(tol, tol + uFeather * 0.3 + 1e-3, d);
    } else if (uMode < 9.5) {
      // Shape in output space (pixels so it stays round on any aspect), rotated, rect <-> ellipse by roundness.
      vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uRes;
      vec2 q = p - uShape.xy * uRes;
      float a = -uShapeAngle;
      q = mat2(cos(a), sin(a), -sin(a), cos(a)) * q;
      q /= max(uShape.zw * uRes * 0.5 * uExpand, vec2(1.0));
      m = superellipse(q, mix(12.0, 2.0, uShapeRound), uFeather);
    } else if (uMode < 10.5) {
      // Freehand drawing, rasterized (and blurred for feather) in output space.
      float c = texture(uDraw, vUv).r;
      float th = clamp(0.5 / uExpand, 0.02, 0.98);
      m = smoothstep(th - 0.25, th + 0.25, c);
    } else if (uMode > 11.5) {
      // Depth band: keep what lies between the two depths (feather softens both ends).
      if (uHasDepth > 0.5) {
        float d = texture(uDepthOut, vUv).r;
        float f = uFeather * 0.25 + 1e-3;
        m = smoothstep(uDepthLo - f, uDepthLo + f, d) * (1.0 - smoothstep(uDepthHi - f, uDepthHi + f, d));
      }
    } else {
      // Detected objects: rounded boxes in source pixels.
      vec2 p = vec2(suv.x, 1.0 - suv.y) * uSrcRes;
      for (int i = 0; i < 16; i++) {
        if (float(i) >= uBoxCount) break;
        vec4 bx = uBoxes[i];
        vec2 q = (p - (bx.xy + bx.zw * 0.5)) / max(bx.zw * 0.5 * uExpand, vec2(1.0));
        m = max(m, superellipse(q, 4.0, uFeather));
      }
    }
  } else if (uMode > 3.5) {
    // Body parts: 4 hair (r), 5 skin (g), 6 clothes (b). Rows are top-down like the person mask.
    if (uHasParts > 0.5) {
      vec4 pc = texture(uParts, vec2(suv.x, 1.0 - suv.y));
      float c = uMode < 4.5 ? pc.r : uMode < 5.5 ? pc.g : pc.b;
      float th = clamp(0.5 / uExpand, 0.02, 0.98);
      m = smoothstep(th - uFeather * 0.5, th + uFeather * 0.5 + 1e-3, c);
    }
  } else if (uMode < 1.5) {
    vec2 p = vec2(suv.x, 1.0 - suv.y) * uSrcRes; // pixels, y down (detector space)
    for (int i = 0; i < 4; i++) {
      if (float(i) >= uFaceCount) break;
      vec2 d = p - uFaces[i].xy * uSrcRes;
      float a = -uAngles[i];
      d = mat2(cos(a), sin(a), -sin(a), cos(a)) * d;
      float e = length(d / (uFaces[i].zw * uSrcRes * uExpand));
      m = max(m, 1.0 - smoothstep(1.0 - uFeather, 1.0 + uFeather * 0.5, e));
    }
  } else if (uMode > 2.5) {
    // Limbs: union of capsules (source pixels, y down).
    vec2 p = vec2(suv.x, 1.0 - suv.y) * uSrcRes;
    for (int i = 0; i < 64; i++) {
      if (float(i) >= uCapCount) break;
      float r = uCapR[i] * uExpand;
      float d = segDist(p, uCaps[i].xy, uCaps[i].zw);
      m = max(m, 1.0 - smoothstep(r * (1.0 - uFeather), r * (1.0 + uFeather * 0.5), d));
    }
  } else if (uHasMask > 0.5) {
    float c = texture(uMask, vec2(suv.x, 1.0 - suv.y)).r; // mask rows are top-down
    float th = clamp(0.5 / uExpand, 0.02, 0.98);
    m = smoothstep(th - uFeather * 0.5, th + uFeather * 0.5 + 1e-3, c);
  }
  if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) m = 0.0;
  if (uInvert > 0.5) m = 1.0 - m;

  vec3 c = mix(before, after, m);
  if (uShow > 0.5) c = mix(c, vec3(1.0, 0.1, 0.3), 0.35 * m);
  outColor = vec4(c, 1.0);
}`

/** Layer compositing: top over base with a blend mode and opacity. */
export const BLEND = HEADER + /* glsl */ `
uniform sampler2D uBase, uTop;
uniform float uMode, uOpacity;
void main() {
  vec3 b = texture(uBase, vUv).rgb;
  vec3 t = texture(uTop, vUv).rgb;
  vec3 c;
  if (uMode < 0.5) c = t;
  else if (uMode < 1.5) c = b + t;
  else if (uMode < 2.5) c = 1.0 - (1.0 - b) * (1.0 - t);
  else if (uMode < 3.5) c = b * t;
  else if (uMode < 4.5) c = mix(2.0 * b * t, 1.0 - 2.0 * (1.0 - b) * (1.0 - t), step(0.5, b));
  else if (uMode < 5.5) c = abs(b - t);
  else if (uMode < 6.5) c = max(b, t);
  else if (uMode < 7.5) c = min(b, t);
  else c = max(b - t, 0.0);
  outColor = vec4(mix(b, c, uOpacity), 1.0);
}`

/** Screen output with optional before/after compare. */
export const COMPARE = HEADER + /* glsl */ `
uniform sampler2D uSrc;
uniform float uMode, uSplit;
void main() {
  vec3 after = texture(uTex, vUv).rgb;
  vec3 before = texture(uSrc, vUv).rgb;
  vec3 c = uMode > 0.5 && uMode < 1.5 ? before : after;
  if (uMode > 1.5) {
    c = vUv.x < uSplit ? before : after;
    float d = abs(vUv.x - uSplit) * uRes.x;
    c = mix(vec3(1.0), c, smoothstep(1.0, 2.5, d));
  }
  outColor = vec4(c, 1.0);
}`

/** A layer's depth (source space, top-down rows) mapped into output space with the source's framing. */
export const DEPTHMAP = HEADER + /* glsl */ `
uniform vec2 uSrcRes;
uniform float uFit, uZoom, uPanX, uPanY;
void main() {
  float ra = uRes.x / uRes.y, sa = uSrcRes.x / uSrcRes.y;
  vec2 s = vec2(1.0);
  if (uFit < 0.5) { if (sa > ra) s.x = ra / sa; else s.y = sa / ra; }
  else            { if (sa > ra) s.y = sa / ra; else s.x = ra / sa; }
  vec2 suv = (vUv - 0.5) * s / uZoom + 0.5 + vec2(uPanX, uPanY);
  float d = (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) ? 0.0 : texture(uTex, vec2(suv.x, 1.0 - suv.y)).r;
  outColor = vec4(d, d, d, 1.0);
}`

/** Maps the raw source into the output frame (cover/contain, zoom, pan) + basic tone. */
export const SOURCE = HEADER + /* glsl */ `
uniform vec2 uSrcRes;
uniform float uFit, uZoom, uPanX, uPanY, uGray, uContrast, uBrightness;
void main() {
  float ra = uRes.x / uRes.y, sa = uSrcRes.x / uSrcRes.y;
  vec2 s = vec2(1.0);
  if (uFit < 0.5) { if (sa > ra) s.x = ra / sa; else s.y = sa / ra; }
  else            { if (sa > ra) s.y = sa / ra; else s.x = ra / sa; }
  vec2 uv = (vUv - 0.5) * s / uZoom + 0.5 + vec2(uPanX, uPanY);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { outColor = vec4(0, 0, 0, 1); return; }
  vec3 c = texture(uTex, uv).rgb;
  c = mix(c, vec3(luma(c)), uGray);
  c = (c - 0.5) * uContrast + 0.5 + uBrightness;
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`
