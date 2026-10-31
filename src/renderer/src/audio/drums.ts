/**
 * Kick / snare / hi-hat hit detection. Each drum is found in the frequency range where it dominates
 * (steep 4th-order filters so the kick's boom does not leak into the snare band), then hits are the
 * sharp rises of that band's loudness that stand out from the band's own background.
 */

export interface DrumHits {
  /** Hit times in seconds. */
  times: number[]
  /** Loudness change per frame (log domain, rises only) — used as a rhythm cue. */
  flux: Float32Array
  /** 0..1 envelope: jumps on each hit (by its strength), then decays quickly. */
  env: Float32Array
}

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number }

/** RBJ cookbook biquads. */
function biquad(type: 'lp' | 'hp', f: number, sr: number, q = Math.SQRT1_2): Biquad {
  const w = (2 * Math.PI * f) / sr
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  const b1 = type === 'lp' ? 1 - cos : -(1 + cos)
  const b0 = type === 'lp' ? (1 - cos) / 2 : (1 + cos) / 2
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
}

/** Frame RMS of the signal through a chain of biquads. */
function bandEnergy(mono: Float32Array, hop: number, frames: number, chain: Biquad[]): Float32Array {
  const out = new Float32Array(frames)
  const st = chain.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
  for (let f = 0; f < frames; f++) {
    let s = 0
    const end = Math.min(mono.length, (f + 1) * hop)
    for (let i = f * hop; i < end; i++) {
      let x = mono[i]
      for (let k = 0; k < chain.length; k++) {
        const c = chain[k]
        const z = st[k]
        const y = c.b0 * x + c.b1 * z.x1 + c.b2 * z.x2 - c.a1 * z.y1 - c.a2 * z.y2
        z.x2 = z.x1
        z.x1 = x
        z.y2 = z.y1
        z.y1 = y
        x = y
      }
      s += x * x
    }
    out[f] = Math.sqrt(s / Math.max(1, end - f * hop))
  }
  return out
}

/** Loudness smoothed over ~50 ms ([1 2 3 2 1]/9 taps) so low notes' frame-to-frame ripple can't look like hits. */
function smoothed(e: Float32Array, w: number[]): Float32Array {
  const n = e.length
  const r = w.length >> 1
  const sum = w.reduce((a, b) => a + b, 0)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let k = -r; k <= r; k++) s += w[k + r] * e[Math.min(n - 1, Math.max(0, i + k))]
    out[i] = s / sum
  }
  return out
}

/** The band's "loud" level: its 98th-percentile loudness. */
function loudRef(e: Float32Array): number {
  const sorted = Float32Array.from(e).sort()
  return sorted[Math.floor(sorted.length * 0.98)] || 1
}

/** Positive change of log loudness (relative to the band's loud level). */
function logFlux(e: Float32Array, ref: number): Float32Array {
  const n = e.length
  const out = new Float32Array(n)
  let prev = Math.log1p((100 * e[0]) / ref)
  for (let i = 1; i < n; i++) {
    const cur = Math.log1p((100 * e[i]) / ref)
    out[i] = Math.max(0, cur - prev)
    prev = cur
  }
  return out
}

/**
 * Hits: rises that are the largest within ±`gap` frames, clear the local (1 s) average, and are at least
 * `rel` of the band's typical strong hit (so bleed from other drums and small wiggles don't count).
 */
function pickHits(
  flux: Float32Array,
  level: Float32Array,
  ref: number,
  rate: number,
  gap: number,
  rel: number,
  gate: number,
  jump: number
): { frames: number[]; strength: number[] } {
  const n = flux.length
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + flux[i]
  const cands: number[] = []
  const w = Math.round(rate / 2)
  for (let i = 1; i < n; i++) {
    const v = flux[i]
    if (v <= 0) continue
    let top = true
    for (let k = Math.max(0, i - gap); k <= Math.min(n - 1, i + gap) && top; k++) if (flux[k] > v || (flux[k] === v && k < i)) top = false
    if (!top) continue
    const a = Math.max(0, i - w)
    const b = Math.min(n, i + w + 1)
    // A real hit makes the band loud; a faint sound rising from silence (another drum leaking in) doesn't.
    const peak = Math.max(level[i], level[Math.min(n - 1, i + 1)], level[Math.min(n - 1, i + 2)], level[Math.min(n - 1, i + 3)])
    if (peak < gate * ref) continue
    // …and it is a real jump: at least ~+4 dB within 30 ms, not a slow swell or a steady note's wiggle.
    let lo = Infinity
    let hi = -Infinity
    for (let k = Math.max(0, i - 3); k <= i; k++) lo = Math.min(lo, level[k])
    for (let k = i; k <= Math.min(n - 1, i + 3); k++) hi = Math.max(hi, level[k])
    if (hi < jump * lo) continue
    if (v > 1.5 * ((pre[b] - pre[a]) / (b - a)) + 0.02) cands.push(i)
  }
  const hs = cands.map((i) => flux[i]).sort((a, b) => a - b)
  const top = hs[Math.floor(hs.length * 0.9)] ?? 0
  const frames = cands.filter((i) => flux[i] >= rel * top)
  return { frames, strength: frames.map((i) => Math.min(1, flux[i] / (top || 1))) }
}

function hitEnvelope(frames: number[], strength: number[], n: number, decayFrames: number): Float32Array {
  const env = new Float32Array(n)
  let k = 0
  let level = 0
  for (let f = 0; f < n; f++) {
    level *= Math.exp(-1 / decayFrames)
    while (k < frames.length && frames[k] <= f) level = Math.max(level, strength[k++])
    env[f] = level
  }
  return env
}

/**
 * Where in a detected rise the actual hit is, per drum (frames): frame-start timestamps, smoothing and each band's
 * filter delay shift it differently. Measured against synthetic hits with exact times.
 */
const LAG = { kick: 0.14, snare: 0.76, hat: 0.83 }

/**
 * Precise hit time (fractional frame): where the unsmoothed band loudness first crosses halfway from the level
 * before the hit to the hit's peak. Doesn't depend on what else is playing, unlike the smoothed rise.
 */
function halfRise(raw: Float32Array, f: number): number {
  const n = raw.length
  let base = Infinity
  for (let k = Math.max(0, f - 6); k <= f; k++) base = Math.min(base, raw[k])
  let peak = 0
  for (let k = Math.max(0, f - 2); k <= Math.min(n - 1, f + 6); k++) peak = Math.max(peak, raw[k])
  const half = base + 0.5 * (peak - base)
  for (let k = Math.max(1, f - 4); k <= Math.min(n - 1, f + 6); k++) {
    if (raw[k] >= half) {
      const a = raw[k - 1]
      return k - 1 + (half - a) / Math.max(1e-9, raw[k] - a)
    }
  }
  return f
}

export function detectDrums(mono: Float32Array, sr: number, hop: number, frames: number, rate: number): { kick: DrumHits; snare: DrumHits; hat: DrumHits } {
  const lp = (f: number): Biquad => biquad('lp', f, sr)
  const hp = (f: number): Biquad => biquad('hp', f, sr)
  const bands = {
    // Kick: the boom below ~110 Hz.
    kick: bandEnergy(mono, hop, frames, [lp(110), lp(110)]),
    // Snare: the wire rattle, 1-6 kHz. Its 200 Hz body overlaps the start of a kick's pitch sweep, so it's skipped.
    snare: bandEnergy(mono, hop, frames, [hp(1000), hp(1000), lp(6000), lp(6000)]),
    // Hi-hat: sizzle above 7 kHz.
    hat: bandEnergy(mono, hop, frames, [hp(7000), hp(7000)])
  }
  const make = (
    raw: Float32Array,
    lag: number,
    rel: number,
    decay: number,
    taps: number[],
    gate: number,
    jump: number,
    veto?: (f: number, level: number) => boolean
  ): DrumHits => {
    const e = smoothed(raw, taps)
    const ref = loudRef(e)
    const flux = logFlux(e, ref)
    let { frames: fr, strength } = pickHits(flux, e, ref, rate, 5, rel, gate, jump)
    if (veto) {
      const keep = fr.map((f) => !veto(f, Math.max(e[f], e[Math.min(frames - 1, f + 2)]) / ref))
      fr = fr.filter((_, i) => keep[i])
      strength = strength.filter((_, i) => keep[i])
    }
    return { times: fr.map((f) => (halfRise(raw, f) + lag) / rate), flux, env: hitEnvelope(fr, strength, frames, decay) }
  }
  // Low bands need ~50 ms smoothing against note ripple; hats are 40 ms ticks, so only light smoothing.
  const wide = [1, 2, 3, 2, 1]
  // Kicks attack far faster than a kick tail beating against a bass note, so they need a bigger jump.
  const kick = make(bands.kick, LAG.kick, 0.35, 15, wide, 0.3, 2.5)
  // A kick's beater click also lands in the snare band; on a kick, only a snare-loud hit counts as a snare.
  const onKick = (f: number): boolean => kick.times.some((t) => Math.abs(t * rate - LAG.kick - f) <= 3)
  const snare = make(bands.snare, LAG.snare, 0.35, 12, wide, 0.3, 1.6, (f, level) => onKick(f) && level < 0.6)
  const hat = make(bands.hat, LAG.hat, 0.15, 6, [1, 2, 1], 0.12, 1.6)
  return { kick, snare, hat }
}
