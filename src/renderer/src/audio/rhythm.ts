/**
 * Tempo and beat-grid tracking from an onset-strength curve (frames at `rate` Hz).
 * Tempo: autocorrelation with a mild preference for ~120 BPM (avoids half/double-time picks).
 * Beats: dynamic programming (Ellis 2007) so beats sit on real onsets but keep a steady spacing,
 * continuing through breaks. Downbeats: the beat-in-bar phase where kicks and bass/harmony changes land.
 */
export interface Rhythm {
  /** 0 when the audio has no steady pulse (speech, ambient). */
  bpm: number
  /** Beat times in seconds. */
  beats: number[]
  /** Bar starts (every 4th beat) in seconds. */
  downbeats: number[]
  /** Index into `beats` of the first downbeat (0..3). */
  barPhase: number
  /** Share of strong hits that land on the beat grid (0..1). */
  fit: number
}

const BEATS_PER_BAR = 4

/** Normalize to unit standard deviation after removing a local (1 s) mean, keeping only rises. */
export function conditionOnsets(o: Float32Array, rate: number): Float32Array {
  const n = o.length
  const w = Math.round(rate / 2)
  const out = new Float32Array(n)
  let acc = 0
  const pre = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + o[i]
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w)
    const b = Math.min(n, i + w + 1)
    out[i] = Math.max(0, o[i] - (pre[b] - pre[a]) / (b - a))
    acc += out[i] * out[i]
  }
  const sd = Math.sqrt(acc / Math.max(1, n)) || 1
  for (let i = 0; i < n; i++) out[i] /= sd
  return out
}

/** Max-filter (radius 2 frames) so grid sampling tolerates onsets between frames and slight drift. */
function dilate(o: Float32Array): Float32Array {
  const n = o.length
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let k = Math.max(0, i - 2); k <= Math.min(n - 1, i + 2); k++) m = Math.max(m, o[k])
    out[i] = m
  }
  return out
}

/** Grid windows: tempo is scored in 6 s windows (each with its own phase) so slight drift can't hide it. */
const WIN = 600
const WIN_HOP = 300

/** Best phase of a period-p grid in [a, b): the one whose points carry the most onset. */
function bestPhase(d: Float32Array, p: number, a: number, b: number): { phase: number; mean: number } {
  let phase = 0
  let mean = -1
  for (let ph = 0; ph < p; ph++) {
    let s = 0
    let c = 0
    for (let t = a + ph; t < b; t += p) {
      s += d[Math.round(t)]
      c++
    }
    if (c && s / c > mean) {
      mean = s / c
      phase = a + ph
    }
  }
  return { phase, mean }
}

function windows(n: number): [number, number][] {
  const out: [number, number][] = []
  for (let a = 0; a < n; a += WIN_HOP) {
    const b = Math.min(n, a + WIN)
    if (b - a >= WIN / 2 || !out.length) out.push([a, b])
    if (b === n) break
  }
  return out
}

/** Comb score: mean onset on a period-p grid (best phase per window), averaged over windows. */
function comb(d: Float32Array, p: number): number {
  const ws = windows(d.length)
  let s = 0
  for (const [a, b] of ws) s += bestPhase(d, p, a, b).mean
  return s / ws.length
}

/**
 * Share of in-between points (halfway between grid beats) that carry a kick or snare, relative to the beats.
 * High means the grid is running at half the real tempo. Off-beat hi-hats alone don't count.
 */
function accentRatio(d: Float32Array, accents: Float32Array, p: number): number {
  let on = 0
  let mid = 0
  for (const [a, b] of windows(d.length)) {
    const { phase } = bestPhase(d, p, a, b)
    for (let t = phase; t + p / 2 < b; t += p) {
      on += accents[Math.round(t)]
      mid += accents[Math.round(t + p / 2)]
    }
  }
  return on > 0 ? mid / on : 0
}

/** Beat period in frames (fractional), or 0. */
export function estimatePeriod(o: Float32Array, rate: number, accents: Float32Array): number {
  const minP = (rate * 60) / 200
  const maxP = (rate * 60) / 60
  if (o.length < maxP * 6) return 0
  const d = dilate(o)
  let best = 0
  let bestScore = -Infinity
  for (let p = minP; p <= maxP; p += 0.25) {
    const bpm = (60 * rate) / p
    // Mild preference for common tempos; the metrical checks below settle half/double time.
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)
    const sc = comb(d, p) * prior
    if (sc > bestScore) {
      bestScore = sc
      best = p
    }
  }
  // If the in-between points reliably carry kicks or snares (not just off-beat hats), the real beat is twice as fast.
  while (best / 2 >= minP && accentRatio(d, accents, best) >= 0.6) best /= 2
  // Fine-tune around the pick.
  let fine = best
  let fs = comb(d, best)
  for (let p = best - 0.3; p <= best + 0.3; p += 0.02) {
    const sc = comb(d, p)
    if (sc > fs) {
      fs = sc
      fine = p
    }
  }
  return fine
}

/** Fraction of strong onsets that land on the grid (a beat or halfway between): high for music, low for noise. */
export function gridFit(o: Float32Array, beats: number[]): number {
  const strong: number[] = []
  // Peaks that are the maximum within ±60 ms (one per hit, not every wiggle of its decay).
  for (let i = 0; i < o.length; i++) {
    if (o[i] < 1.5) continue
    let top = true
    for (let k = Math.max(0, i - 6); k <= Math.min(o.length - 1, i + 6) && top; k++) if (o[k] > o[i] || (o[k] === o[i] && k < i)) top = false
    if (top) strong.push(i)
  }
  // Only hits that are loud relative to this track's main hits count (quiet wiggles between hits don't).
  const heights = strong.map((i) => o[i]).sort((a, b) => a - b)
  const ref = heights[Math.floor(heights.length * 0.9)] ?? 0
  for (let k = strong.length - 1; k >= 0; k--) if (o[strong[k]] < 0.35 * ref) strong.splice(k, 1)
  if (strong.length < 8) return 0
  let hit = 0
  let b = 0
  for (const t of strong) {
    while (b + 1 < beats.length && beats[b + 1] <= t) b++
    const a = beats[b]
    const c = beats[Math.min(beats.length - 1, b + 1)]
    const half = (a + c) / 2
    if (Math.min(Math.abs(t - a), Math.abs(t - c), Math.abs(t - half)) <= 3) hit++
  }
  return hit / strong.length
}

/** Dynamic-programming beat tracker: beat frames that balance onset strength against steady spacing. */
export function trackBeats(o: Float32Array, period: number, tightness = 400): number[] {
  const n = o.length
  const score = new Float64Array(n)
  const back = new Int32Array(n).fill(-1)
  const pMin = Math.round(period / 2)
  const pMax = Math.round(period * 2)
  for (let t = 0; t < n; t++) {
    let best = 0
    let arg = -1
    for (let tau = t - pMax; tau <= t - pMin; tau++) {
      if (tau < 0) continue
      const pen = Math.log((t - tau) / period)
      const s = score[tau] - tightness * pen * pen
      if (arg < 0 || s > best) {
        best = s
        arg = tau
      }
    }
    score[t] = o[t] + (arg >= 0 ? Math.max(0, best) : 0)
    back[t] = arg >= 0 && best > 0 ? arg : -1
  }
  // End on the best-scoring frame within the last beat period.
  let end = n - 1
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[end]) end = t
  const beats: number[] = []
  for (let t = end; t >= 0; t = back[t]) {
    beats.push(t)
    if (back[t] < 0) break
  }
  beats.reverse()
  // Extend the grid through leading/trailing silence at the tracked tempo.
  const step = beats.length > 1 ? (beats[beats.length - 1] - beats[0]) / (beats.length - 1) : period
  while (beats.length && beats[0] - step >= 0) beats.unshift(Math.round(beats[0] - step))
  while (beats.length && beats[beats.length - 1] + step < n) beats.push(Math.round(beats[beats.length - 1] + step))
  return beats
}

/** Which of the 4 beat-in-bar phases is "the 1": kicks and bass/harmony changes land there, snares don't. */
export function barPhase(beats: number[], kick: Float32Array, snare: Float32Array, change: number[]): number {
  const near = (a: Float32Array, f: number): number => {
    let m = 0
    for (let i = Math.max(0, f - 3); i <= Math.min(a.length - 1, f + 3); i++) m = Math.max(m, a[i])
    return m
  }
  const norm = (vals: number[]): number[] => {
    const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1) || 1
    return vals.map((v) => v / mean)
  }
  const k = norm(beats.map((f) => near(kick, f)))
  const s = norm(beats.map((f) => near(snare, f)))
  const c = norm(change)
  const scores: number[] = []
  for (let ph = 0; ph < BEATS_PER_BAR; ph++) {
    let sc = 0
    let cnt = 0
    for (let i = ph; i < beats.length; i += BEATS_PER_BAR) {
      sc += k[i] - 0.7 * s[i] + 1.2 * c[i]
      cnt++
    }
    scores.push(sc / (cnt || 1))
  }
  const top = Math.max(...scores)
  const spread = top - Math.min(...scores)
  // Near-ties (e.g. kick-snare-kick-snare with nothing else: beats 1 and 3 sound the same) go to the phase where
  // the music starts, since songs almost always begin on a "1".
  const tied = scores.map((v, ph) => (top - v <= 0.1 * spread ? ph : -1)).filter((ph) => ph >= 0)
  if (tied.length === 1) return tied[0]
  const first = beats.findIndex((_, i) => k[i] > 0.5 || s[i] > 0.5)
  if (first < 0) return tied[0]
  return tied.find((ph) => ph === first % BEATS_PER_BAR) ?? tied[0]
}

export function analyzeRhythm(
  onset: Float32Array,
  rate: number,
  cues: { kick: Float32Array; snare: Float32Array; hits: number[]; change: (beats: number[]) => number[] }
): Rhythm | null {
  const o = conditionOnsets(onset, rate)
  // Kick/snare hit frames, widened ±3 frames, as a 0/1 track.
  const accents = new Float32Array(o.length)
  for (const f of cues.hits) for (let k = Math.max(0, Math.round(f) - 3); k <= Math.min(o.length - 1, Math.round(f) + 3); k++) accents[k] = 1
  const period = estimatePeriod(o, rate, accents)
  if (!period) return null
  const frames = trackBeats(o, period)
  if (frames.length < 4) return null
  const fit = gridFit(o, frames)
  if (fit < 0.85) return null
  const phase = barPhase(frames, cues.kick, cues.snare, cues.change(frames))
  // Report tempo from the tracked beats (least-squares slope), which is finer than the autocorrelation lag.
  const m = frames.length
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  frames.forEach((f, i) => {
    sx += i
    sy += f
    sxx += i * i
    sxy += i * f
  })
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx)
  // Onset rises register ~0.85 frame early (frame-start timestamps + the [1 2 1] smoothing), measured on
  // synthetic tracks with exact hit times.
  const beats = frames.map((f) => (f + 0.85) / rate)
  return {
    bpm: Math.round(((60 * rate) / slope) * 10) / 10,
    beats,
    downbeats: beats.filter((_, i) => i >= phase && (i - phase) % BEATS_PER_BAR === 0),
    barPhase: phase,
    fit
  }
}
