import type { AudioAnalysis } from './audio/analysis'
import { sampleAudio } from './audio/analysis'
import type { AudioBand, Ease, HitTrigger, Instance, Keyframe, ModShape, Modulator } from './effects/types'

export const EASES: Ease[] = ['linear', 'ease', 'hold']

export function evalKeys(keys: Keyframe[], t: number): number {
  if (t <= keys[0].t) return keys[0].v
  const last = keys[keys.length - 1]
  if (t >= last.t) return last.v
  let i = 0
  while (keys[i + 1].t <= t) i++
  const a = keys[i]
  const b = keys[i + 1]
  if (a.ease === 'hold') return a.v
  let u = (t - a.t) / Math.max(1e-6, b.t - a.t)
  if (a.ease === 'ease') u = u * u * (3 - 2 * u)
  return a.v + (b.v - a.v) * u
}

/** Writes keyframed values into instance params for time t. */
export function applyKeys(chain: Instance[], t: number): void {
  for (const inst of chain) for (const [k, ks] of Object.entries(inst.keys)) if (ks.length) inst.params[k] = evalKeys(ks, t)
}

/** Adds or updates the key at t (within half a 60fps frame). */
export function setKey(inst: Instance, key: string, t: number, v: number): void {
  const ks = (inst.keys[key] ??= [])
  const hit = ks.find((k) => Math.abs(k.t - t) < 1 / 120)
  if (hit) hit.v = v
  else {
    ks.push({ t, v, ease: 'ease' })
    ks.sort((a, b) => a.t - b.t)
  }
}

export function removeKey(inst: Instance, key: string, k: Keyframe): void {
  const ks = inst.keys[key]
  if (!ks) return
  ks.splice(ks.indexOf(k), 1)
  if (!ks.length) delete inst.keys[key]
}

const hash = (n: number): number => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453
  return x - Math.floor(x)
}

export const isAudioShape = (s: ModShape): s is `audio-${AudioBand}` => s.startsWith('audio-')

/** Without detected beats, beat/bar/off-beat hits fall back to 120 BPM so they still fire. */
const FALLBACK_BEAT = 0.5

/** Index of the last event at or before t (-1 if none). */
function lastAt(times: number[], t: number): number {
  let lo = 0
  let hi = times.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (times[m] <= t) lo = m + 1
    else hi = m
  }
  return lo - 1
}

/**
 * Time of the most recent trigger event at or before t, or null. Beat and off-beat counts start at the bar,
 * so "every 2 beats" fires on 1 and 3, and "every 2 bars" on odd bars.
 */
export function lastHit(trigger: HitTrigger, every: number, t: number, audio: AudioAnalysis | null): number | null {
  const n = Math.max(1, Math.round(every))
  const pick = (times: number[], offset = 0): number | null => {
    let i = lastAt(times, t)
    while (i >= 0 && (((i - offset) % n) + n) % n !== 0) i--
    return i >= 0 ? times[i] : null
  }
  if (trigger === 'kick' || trigger === 'snare' || trigger === 'hat') return audio ? pick(audio[`${trigger}s`]) : null
  const beats = audio?.beats.length ? audio.beats : null
  if (!beats) {
    // Steady 120 BPM grid from 0.
    const step = trigger === 'bar' ? FALLBACK_BEAT * 4 : FALLBACK_BEAT
    const shift = trigger === 'offbeat' ? FALLBACK_BEAT / 2 : 0
    const k = Math.floor((t - shift) / step)
    const j = Math.floor(k / n) * n
    return j >= 0 ? j * step + shift : null
  }
  if (trigger === 'bar') return pick(audio!.downbeats)
  // Beat index of the first downbeat, so counting starts on a "1".
  const first = audio!.downbeats.length ? Math.max(0, beats.indexOf(audio!.downbeats[0])) : 0
  if (trigger === 'beat') return pick(beats, first)
  // Off-beats: halfway to the next beat.
  const i0 = lastAt(beats, t)
  for (let i = i0; i >= 0; i--) {
    const next = beats[i + 1] ?? beats[i] + (i ? beats[i] - beats[i - 1] : FALLBACK_BEAT)
    const off = (beats[i] + next) / 2
    if (off <= t && (((i - first) % n) + n) % n === 0) return off
  }
  return null
}

/** Beat-hit envelope 0..1: rises over `attack`, then falls to ~0 over `decay` seconds. */
export function hitEnvelope(m: Modulator, t: number, audio: AudioAnalysis | null): number {
  const t0 = lastHit(m.trigger ?? 'beat', m.every ?? 1, t, audio)
  if (t0 === null) return 0
  const u = t - t0
  const attack = Math.max(0, m.attack ?? 0.01)
  const decay = Math.max(0.01, m.decay ?? 0.25)
  if (u < attack) return u / attack
  return Math.exp((-3 * (u - attack)) / decay)
}

/** LFO shapes return -1..1; audio shapes and beat hits return a 0..1 envelope. */
export function modSignal(m: Modulator, t: number, audio: AudioAnalysis | null): number {
  const shape: ModShape = m.shape
  if (shape === 'hit') return hitEnvelope(m, t, audio)
  if (isAudioShape(shape)) return audio ? sampleAudio(audio, shape.slice(6) as AudioBand, t) : 0
  const p = t * m.rate
  switch (shape) {
    case 'sine':
      return Math.sin(p * Math.PI * 2)
    case 'saw':
      return (p - Math.floor(p)) * 2 - 1
    case 'square':
      return Math.sin(p * Math.PI * 2) >= 0 ? 1 : -1
    case 'random':
      return hash(Math.floor(p)) * 2 - 1
    default:
      return 0
  }
}

export function modulate(inst: Instance, key: string, min: number, max: number, base: number, t: number, audio: AudioAnalysis | null): number {
  let n = base
  for (const m of inst.mods) {
    if (m.shape === 'off' || m.target !== key) continue
    n += modSignal(m, t, audio) * m.depth * (max - min)
  }
  return Math.min(max, Math.max(min, n))
}
