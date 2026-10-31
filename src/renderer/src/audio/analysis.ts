import type { AudioBand } from '../effects/types'
import { analyzeRhythm } from './rhythm'
import { detectDrums } from './drums'

/** Per-band envelopes sampled at `rate` Hz, all normalized to 0..1. */
export interface AudioAnalysis {
  rate: number
  duration: number
  level: Float32Array
  low: Float32Array
  mid: Float32Array
  high: Float32Array
  beat: Float32Array
  /** Beat times in seconds: a steady tempo grid when the music has one, otherwise detected onsets. */
  beats: number[]
  /** Detected tempo, 0 when there is no steady pulse. */
  bpm: number
  /** Bar starts (the "1" of each 4/4 bar) in seconds. */
  downbeats: number[]
  /** How well the hits fit the tempo grid (0..1); the grid is only used above 0.85. */
  tempoFit: number
  /** Drum hit envelopes (0..1, jump on each hit then decay) and hit times in seconds. */
  kick: Float32Array
  snare: Float32Array
  hat: Float32Array
  kicks: number[]
  snares: number[]
  hats: number[]
}

const RATE = 100

/** Decode any audio (or video-with-audio) file and extract envelopes + beats. Null if no audio track. */
export async function analyzeAudio(data: ArrayBuffer): Promise<AudioAnalysis | null> {
  let buf: AudioBuffer
  try {
    buf = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data)
  } catch {
    return null
  }
  const sr = buf.sampleRate
  const n = buf.length
  const mono = new Float32Array(n)
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c)
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels
  }

  const hop = Math.round(sr / RATE)
  const frames = Math.ceil(n / hop)
  const raw = { level: new Float32Array(frames), low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames) }
  // One-pole crossovers at 150 Hz and 4 kHz split the signal into three bands.
  const aL = Math.exp((-2 * Math.PI * 150) / sr)
  const aH = Math.exp((-2 * Math.PI * 4000) / sr)
  let lp1 = 0
  let lp2 = 0
  for (let f = 0; f < frames; f++) {
    let sl = 0, sm = 0, sh = 0, sa = 0
    const end = Math.min(n, (f + 1) * hop)
    for (let i = f * hop; i < end; i++) {
      const x = mono[i]
      lp1 = (1 - aL) * x + aL * lp1
      lp2 = (1 - aH) * x + aH * lp2
      sl += lp1 * lp1
      sm += (lp2 - lp1) * (lp2 - lp1)
      sh += (x - lp2) * (x - lp2)
      sa += x * x
    }
    const cnt = Math.max(1, end - f * hop)
    raw.low[f] = Math.sqrt(sl / cnt)
    raw.mid[f] = Math.sqrt(sm / cnt)
    raw.high[f] = Math.sqrt(sh / cnt)
    raw.level[f] = Math.sqrt(sa / cnt)
  }

  const normalize = (a: Float32Array): Float32Array => {
    const sorted = Float32Array.from(a).sort()
    const ref = sorted[Math.floor(sorted.length * 0.98)] || 1
    return a.map((v) => Math.min(1, v / ref))
  }
  // Instant attack, ~80 ms release so envelopes feel punchy but not jittery.
  const envelope = (a: Float32Array): Float32Array => {
    const out = new Float32Array(a.length)
    let e = 0
    for (let i = 0; i < a.length; i++) out[i] = e = Math.max(a[i], e * 0.9)
    return out
  }
  const low = normalize(raw.low)
  const level = normalize(raw.level)

  // Onset detection: positive flux of the low band (+ some broadband), adaptive threshold, 250 ms refractory.
  const onset = new Float32Array(frames)
  for (let f = 1; f < frames; f++) onset[f] = Math.max(0, low[f] - low[f - 1]) + 0.3 * Math.max(0, level[f] - level[f - 1])
  const onsets: number[] = []
  let last = -1e9
  const W = 25
  for (let f = 1; f < frames - 1; f++) {
    let mean = 0
    const a = Math.max(0, f - W)
    const b = Math.min(frames, f + W)
    for (let i = a; i < b; i++) mean += onset[i]
    mean /= b - a
    const peak = onset[f] >= onset[f - 1] && onset[f] > onset[f + 1]
    if (peak && onset[f] > mean * 1.6 + 0.03 && f - last >= 25) {
      last = f
      onsets.push(f / RATE)
    }
  }

  // Tempo grid from a log-compressed, all-band onset curve (hats and snares help lock the pulse too).
  const flux = new Float32Array(frames)
  // [1 2 1]/4 smoothing cancels the frame-to-frame ripple of low notes (a 50 Hz kick in 10 ms frames),
  // which the log scale would otherwise turn into fake onsets during every decay.
  const smooth = (a: Float32Array): Float32Array => a.map((v, i) => 0.25 * (a[Math.max(0, i - 1)] + 2 * v + a[Math.min(a.length - 1, i + 1)]))
  const sLow = smooth(low)
  const sMid = smooth(normalize(raw.mid))
  const sHigh = smooth(normalize(raw.high))
  const lg = (a: Float32Array, f: number): number => Math.log1p(100 * (a === low ? sLow : a === mid ? sMid : sHigh)[f])
  const mid = normalize(raw.mid)
  const high = normalize(raw.high)
  for (let f = 1; f < frames; f++)
    flux[f] = Math.max(0, lg(low, f) - lg(low, f - 1)) + Math.max(0, lg(mid, f) - lg(mid, f - 1)) + 0.5 * Math.max(0, lg(high, f) - lg(high, f - 1))
  const drums = detectDrums(mono, sr, hop, frames, RATE)
  const rhythm = analyzeRhythm(flux, RATE, { kick: drums.kick.flux, snare: drums.snare.flux, hits: [...drums.kick.times, ...drums.snare.times].map((t) => t * RATE), change: (b) => harmonicChange(mono, sr, hop, b) })
  const beats = rhythm?.beats ?? onsets
  const downbeats = rhythm?.downbeats ?? beats.filter((_, i) => i % 4 === 0)

  // Beat envelope: jumps to 1 on each beat, ~120 ms decay.
  const beat = new Float32Array(frames)
  let bi = 0
  let lastBeat = -1e9
  for (let f = 0; f < frames; f++) {
    while (bi < beats.length && beats[bi] * RATE <= f + 1e-6) lastBeat = beats[bi++] * RATE
    beat[f] = Math.exp(-(f - lastBeat) / 12)
  }

  return {
    rate: RATE,
    duration: n / sr,
    level: envelope(level),
    low: envelope(low),
    mid: envelope(mid),
    high: envelope(high),
    beat,
    beats,
    bpm: rhythm?.bpm ?? 0,
    downbeats,
    tempoFit: rhythm?.fit ?? 0,
    kick: drums.kick.env,
    snare: drums.snare.env,
    hat: drums.hat.env,
    kicks: drums.kick.times,
    snares: drums.snare.times,
    hats: drums.hat.times
  }
}

/** In-place radix-2 FFT (re/im arrays of power-of-two length). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

/**
 * How much the harmony (12-note chroma, bass notes included) changes at each beat: chroma averaged over the beat
 * vs over the previous beat. Chord and bass-note changes mark bar starts even when the drums repeat every beat.
 */
function harmonicChange(mono: Float32Array, sr: number, hop: number, beats: number[]): number[] {
  const N = 4096
  const win = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  const bins: number[] = []
  for (let k = 0; k < N / 2; k++) {
    const hz = (k * sr) / N
    bins.push(hz < 40 || hz > 2000 ? -1 : ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12) % 12)
  }
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const chromaAt = (center: number, out: Float32Array): void => {
    const c = Math.round(center) - N / 2
    for (let i = 0; i < N; i++) {
      const j = c + i
      re[i] = j >= 0 && j < mono.length ? mono[j] * win[i] : 0
      im[i] = 0
    }
    fft(re, im)
    for (let k = 1; k < N / 2; k++) if (bins[k] >= 0) out[bins[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k])
  }
  // Two snapshots inside each beat (at 1/3 and 2/3), skipping the drum attack at the beat itself.
  const chroma = beats.map((f, i) => {
    const next = beats[i + 1] ?? f + (i ? f - beats[i - 1] : 50)
    const ch = new Float32Array(12)
    for (const u of [1 / 3, 2 / 3]) chromaAt((f + (next - f) * u) * hop, ch)
    return ch
  })
  const cos = (a: Float32Array, b: Float32Array): number => {
    let d = 0
    for (let q = 0; q < 12; q++) d += a[q] * b[q]
    return d / ((Math.hypot(...a) * Math.hypot(...b)) || 1)
  }
  return chroma.map((c, i) => (i ? 1 - cos(c, chroma[i - 1]) : 0))
}

export function sampleAudio(a: AudioAnalysis, band: AudioBand, t: number): number {
  const arr = a[band]
  const x = t * a.rate
  const i = Math.floor(x)
  if (i < 0 || i >= arr.length) return 0
  const j = Math.min(arr.length - 1, i + 1)
  return arr[i] + (arr[j] - arr[i]) * (x - i)
}
