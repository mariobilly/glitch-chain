import { createInstance } from './effects'
import type { Instance } from './effects/types'
import type { Preset } from './presets'
import type { AudioAnalysis } from './audio/analysis'

/** Sequence entry that stands for whatever is in the effect chain panel right now. */
export const CURRENT = '(current chain)'

export interface Sequence {
  on: boolean
  items: string[]
  mode: 'beats' | 'bars' | 'seconds'
  /** Switch every N beats, N bars, or every N seconds. */
  every: number
  order: 'loop' | 'random'
}

export const defaultSequence = (): Sequence => ({ on: false, items: [], mode: 'beats', every: 4, order: 'loop' })

const hash = (n: number): number => {
  const x = Math.sin(n * 91.345 + 47.853) * 43758.5453
  return x - Math.floor(x)
}

/** Without audio, "every N beats" falls back to 120 BPM so the sequence still cuts. */
const FALLBACK_BEAT = 0.5

/**
 * Cuts between presets on the timeline. Which preset is active is a pure function of time (and the detected
 * beats), so a frame-by-frame render reproduces the preview exactly.
 */
export class Sequencer {
  seq: Sequence = defaultSequence()
  private cache = new Map<string, Instance[]>()
  private order: number[] = []

  constructor(
    private find: (name: string) => Preset | undefined,
    private current: () => Instance[]
  ) {}

  get active(): boolean {
    return this.seq.on && this.seq.items.length > 0
  }

  /** Call when presets change so cached chains are rebuilt. */
  invalidate(): void {
    this.cache.clear()
    this.order = []
  }

  chainFor(name: string): Instance[] {
    if (name === CURRENT) return this.current()
    let c = this.cache.get(name)
    if (!c) {
      const p = this.find(name)
      if (!p) return this.current()
      c = p.chain.map((l) => createInstance(l.effectId, l))
      this.cache.set(name, c)
    }
    return c
  }

  /**
   * Segment number at time t (0-based). Beat and bar counts start on the first "1" of a bar, so cuts land on
   * bar lines; anything before that first downbeat belongs to the first segment.
   */
  segmentAt(t: number, audio: AudioAnalysis | null): number {
    const every = Math.max(0.01, this.seq.every)
    if (this.seq.mode === 'seconds') return Math.floor(t / every)
    const n = Math.max(1, Math.round(every))
    const bars = this.seq.mode === 'bars'
    const grid = bars ? audio?.downbeats : audio?.beats
    if (!grid?.length) return Math.floor(t / (n * FALLBACK_BEAT * (bars ? 4 : 1)))
    // Index of the grid point at or before t.
    let lo = 0
    let hi = grid.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (grid[m] <= t + 1e-9) lo = m + 1
      else hi = m
    }
    const first = bars ? 0 : Math.max(0, audio!.downbeats.length ? grid.indexOf(audio!.downbeats[0]) : 0)
    return Math.max(0, Math.floor((lo - 1 - first) / n))
  }

  /** Random order never repeats the same preset twice in a row. */
  private indexOf(seg: number): number {
    const n = this.seq.items.length
    if (this.seq.order === 'loop' || n < 2) return seg % n
    while (this.order.length <= seg) {
      const i = this.order.length
      const prev = i ? this.order[i - 1] : -1
      const pick = Math.floor(hash(i) * (prev < 0 ? n : n - 1))
      this.order.push(prev < 0 ? pick : (prev + 1 + pick) % n)
    }
    return this.order[seg]
  }

  itemAt(t: number, audio: AudioAnalysis | null): string | null {
    if (!this.active) return null
    return this.seq.items[this.indexOf(this.segmentAt(t, audio))]
  }

  chainAt(t: number, audio: AudioAnalysis | null): Instance[] {
    const name = this.itemAt(t, audio)
    return name ? this.chainFor(name) : this.current()
  }

  /** Every chain that can be active (for pruning runtimes and loading mask models up front). */
  allChains(): Instance[][] {
    return this.active ? [...new Set(this.seq.items)].map((n) => this.chainFor(n)) : [this.current()]
  }

  /** Segments over [0, duration] for drawing on the timeline. */
  segments(duration: number, audio: AudioAnalysis | null): { t0: number; t1: number; label: string }[] {
    if (!this.active) return []
    const out: { t0: number; t1: number; label: string }[] = []
    const step = 1 / 60
    let t0 = 0
    let seg = this.segmentAt(0, audio)
    for (let t = step; t <= duration + step; t += step) {
      const s = t > duration ? -1 : this.segmentAt(t, audio)
      if (s !== seg) {
        out.push({ t0, t1: Math.min(t, duration), label: this.seq.items[this.indexOf(seg)] })
        t0 = t
        seg = s
      }
    }
    return out
  }

  load(): void {
    try {
      const s = JSON.parse(localStorage.getItem('glitch.sequence') || 'null')
      if (s && Array.isArray(s.items)) this.seq = { ...defaultSequence(), ...s }
    } catch {
      /* private mode or corrupt: keep defaults */
    }
  }

  save(): void {
    try {
      localStorage.setItem('glitch.sequence', JSON.stringify(this.seq))
    } catch {
      /* not persisted; still works for this session */
    }
    this.order = []
  }
}
