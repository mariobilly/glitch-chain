import { EFFECTS } from '../effects'
import { SHAPE_PARAMS } from '../effects/types'
import type { Instance, Keyframe } from '../effects/types'
import type { AudioAnalysis } from '../audio/analysis'
import { EASES, removeKey } from '../anim'
import type { Transport } from '../Transport'

export interface TimelineHost {
  transport: Transport
  chain: () => Instance[]
  audio: () => AudioAnalysis | null
  /** A key was moved/removed/re-eased: re-apply keys and refresh panels. */
  onKeysChanged: () => void
  /** Preset-sequence cuts to draw in the audio lane (empty when the sequencer is off). */
  segments?: () => { t0: number; t1: number; label: string }[]
}

interface Track {
  inst: Instance
  key: string
  label: string
}

const LABEL_W = 180
const RULER_H = 20
const AUDIO_H = 44
const ROW_H = 20

/** Canvas timeline: ruler + audio lane + one row per keyframed param. Click/drag to scrub, drag keys to move. */
export class Timeline {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private sel: { track: Track; k: Keyframe } | null = null
  private drag: 'scrub' | 'key' | null = null
  private cssW = 600
  /** Snap the playhead and keyframes to the beat grid (hold Shift to place freely). */
  snap = true

  constructor(
    private root: HTMLElement,
    private host: TimelineHost
  ) {
    root.appendChild(this.canvas)
    new ResizeObserver(() => this.resize()).observe(root)
    this.canvas.addEventListener('pointerdown', (e) => this.down(e))
    this.canvas.addEventListener('pointermove', (e) => this.move(e))
    this.canvas.addEventListener('pointerup', () => this.up())
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    this.canvas.addEventListener('dblclick', (e) => this.dbl(e))
    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName
      if (this.sel && (e.key === 'Delete' || e.key === 'Backspace') && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        removeKey(this.sel.track.inst, this.sel.track.key, this.sel.k)
        this.sel = null
        this.host.onKeysChanged()
      }
    })
    this.resize()
  }

  private tracks(): Track[] {
    const out: Track[] = []
    this.host.chain().forEach((inst, i) => {
      const def = EFFECTS[inst.effectId]
      for (const [key, ks] of Object.entries(inst.keys)) {
        if (!ks.length) continue
        const p = def.params.find((q) => q.key === key)
        const name = p?.label ?? SHAPE_PARAMS[key as keyof typeof SHAPE_PARAMS]?.label ?? key
        out.push({ inst, key, label: `${String(i + 1).padStart(2, '0')} ${def.name} · ${name}` })
      }
    })
    return out
  }

  private resize(): void {
    this.cssW = Math.max(200, this.root.clientWidth)
    this.draw()
  }

  private get dur(): number {
    return this.host.transport.duration
  }
  private xOf(t: number): number {
    return LABEL_W + (t / this.dur) * (this.cssW - LABEL_W - 12)
  }
  private tOf(x: number): number {
    return Math.min(this.dur, Math.max(0, ((x - LABEL_W) / (this.cssW - LABEL_W - 12)) * this.dur))
  }

  /** Nearest beat within 8 px of t (when snapping is on and there is a grid), else t unchanged. */
  snapT(t: number, free = false): number {
    const beats = this.host.audio()?.beats
    if (!this.snap || free || !beats?.length) return t
    let best = t
    let bd = 8
    for (const b of beats) {
      const d = Math.abs(this.xOf(b) - this.xOf(t))
      if (d <= bd) {
        bd = d
        best = b
      } else if (b > t && d > bd) break
    }
    return Math.min(this.dur, best)
  }

  /** Previous (dir -1) or next (dir 1) beat from t, or null without a beat grid. */
  beatFrom(t: number, dir: 1 | -1): number | null {
    const beats = this.host.audio()?.beats
    if (!beats?.length) return null
    const eps = 1e-3
    if (dir > 0) return beats.find((b) => b > t + eps && b <= this.dur) ?? null
    for (let i = beats.length - 1; i >= 0; i--) if (beats[i] < t - eps) return beats[i]
    return null
  }

  private hitKey(x: number, y: number): { track: Track; k: Keyframe } | null {
    const row = Math.floor((y - RULER_H - AUDIO_H) / ROW_H)
    const track = this.tracks()[row]
    if (!track || y < RULER_H + AUDIO_H) return null
    const k = track.inst.keys[track.key].find((k) => Math.abs(this.xOf(k.t) - x) <= 7)
    return k ? { track, k } : null
  }

  private down(e: PointerEvent): void {
    if (e.offsetX < LABEL_W) return
    this.canvas.setPointerCapture(e.pointerId)
    const hit = this.hitKey(e.offsetX, e.offsetY)
    if (hit) {
      this.sel = hit
      if (e.button === 2) {
        hit.k.ease = EASES[(EASES.indexOf(hit.k.ease) + 1) % EASES.length]
        this.host.onKeysChanged()
      } else if (e.altKey) {
        removeKey(hit.track.inst, hit.track.key, hit.k)
        this.sel = null
        this.host.onKeysChanged()
      } else this.drag = 'key'
    } else {
      this.sel = null
      this.drag = 'scrub'
      this.host.transport.seek(this.snapT(this.tOf(e.offsetX), e.shiftKey))
    }
    this.draw()
  }

  private move(e: PointerEvent): void {
    if (this.drag === 'scrub') this.host.transport.seek(this.snapT(this.tOf(e.offsetX), e.shiftKey))
    else if (this.drag === 'key' && this.sel) {
      this.sel.k.t = this.snapT(this.tOf(e.offsetX), e.shiftKey)
      this.sel.track.inst.keys[this.sel.track.key].sort((a, b) => a.t - b.t)
      this.host.onKeysChanged()
    }
    this.canvas.style.cursor = this.hitKey(e.offsetX, e.offsetY) ? 'ew-resize' : e.offsetX > LABEL_W ? 'text' : 'default'
  }

  private up(): void {
    this.drag = null
  }

  /** Double-click a track: add a key there holding the current value. */
  private dbl(e: MouseEvent): void {
    const row = Math.floor((e.offsetY - RULER_H - AUDIO_H) / ROW_H)
    const track = this.tracks()[row]
    if (!track || e.offsetX < LABEL_W || this.hitKey(e.offsetX, e.offsetY)) return
    const ks = track.inst.keys[track.key]
    const k: Keyframe = { t: this.snapT(this.tOf(e.offsetX), e.shiftKey), v: Number(track.inst.params[track.key]), ease: 'ease' }
    ks.push(k)
    ks.sort((a, b) => a.t - b.t)
    this.sel = { track, k }
    this.host.onKeysChanged()
  }

  draw(): void {
    const tracks = this.tracks()
    const h = RULER_H + AUDIO_H + Math.max(1, tracks.length) * ROW_H + 4
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(this.cssW * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(this.cssW * dpr)
      this.canvas.height = Math.round(h * dpr)
      this.canvas.style.width = this.cssW + 'px'
      this.canvas.style.height = h + 'px'
    }
    const g = this.ctx
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, this.cssW, h)
    g.font = '11px "Segoe UI", sans-serif'
    g.textBaseline = 'middle'
    const right = this.cssW - 12

    // ruler
    g.fillStyle = '#16161c'
    g.fillRect(0, 0, this.cssW, RULER_H)
    const pxPerSec = (right - LABEL_W) / this.dur
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].find((s) => s * pxPerSec >= 60) ?? 300
    g.fillStyle = '#6a6a78'
    g.strokeStyle = '#2a2a34'
    for (let t = 0; t <= this.dur + 1e-6; t += step) {
      const x = this.xOf(t)
      g.fillRect(x, RULER_H - 6, 1, 6)
      g.fillText(t >= 60 ? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}` : `${+t.toFixed(2)}s`, x + 3, 9)
    }

    // audio lane
    const ay = RULER_H
    g.fillStyle = '#101014'
    g.fillRect(0, ay, this.cssW, AUDIO_H)
    g.fillStyle = '#8a8a96'
    const audio = this.host.audio()
    g.fillText(
      audio ? (audio.bpm ? `Audio  ${audio.bpm} BPM · ${audio.downbeats.length} bars` : 'Audio  low · high · hits') : 'Audio  (none — load music or a video)',
      10,
      ay + AUDIO_H / 2
    )
    if (audio) {
      const mid = ay + AUDIO_H / 2
      for (let x = LABEL_W; x < right; x++) {
        const t = this.tOf(x)
        const i = Math.min(audio.low.length - 1, Math.floor(t * audio.rate))
        const lo = audio.low[i] * (AUDIO_H / 2 - 3)
        const hi = audio.high[i] * (AUDIO_H / 2 - 3)
        g.fillStyle = '#ff2a4a99'
        g.fillRect(x, mid - lo, 1, lo)
        g.fillStyle = '#3df2ff88'
        g.fillRect(x, mid, 1, hi)
      }
      // Drum hits along the top: kick (red), snare (cyan), hi-hat (small, grey).
      const mark = (ts: number[], color: string, y: number, hgt: number): void => {
        g.fillStyle = color
        for (const t of ts) if (t <= this.dur) g.fillRect(this.xOf(t) - 1, y, 2, hgt)
      }
      mark(audio.hats, '#8a8a96aa', ay + 2, 3)
      mark(audio.snares, '#3df2ff', ay + 6, 4)
      mark(audio.kicks, '#ff2a4a', ay + 11, 4)
    }
    const segs = this.host.segments?.() ?? []
    if (segs.length) {
      // Sequence strip along the bottom of the audio lane: one colored block per preset cut.
      const sy = ay + AUDIO_H - 12
      segs.forEach((s, i) => {
        const x0 = this.xOf(s.t0)
        const x1 = this.xOf(s.t1)
        g.fillStyle = i % 2 ? '#3df2ff40' : '#ff2a4a50'
        g.fillRect(x0, sy, Math.max(1, x1 - x0 - 1), 11)
        if (x1 - x0 > 40) {
          g.fillStyle = '#e6e6ea'
          g.save()
          g.beginPath()
          g.rect(x0, sy, x1 - x0 - 2, 11)
          g.clip()
          g.font = '9px "Segoe UI", sans-serif'
          g.fillText(s.label, x0 + 3, sy + 6)
          g.restore()
        }
      })
    }

    // Beat grid through the lanes below the ruler: faint beats, stronger bar lines with bar numbers.
    if (audio?.beats.length) {
      const pxPerBeat = audio.bpm ? (60 / audio.bpm) * pxPerSec : 20
      const bars = new Set(audio.downbeats)
      if (pxPerBeat >= 4)
        for (const b of audio.beats) {
          if (b > this.dur || bars.has(b)) continue
          g.fillStyle = '#ffffff12'
          g.fillRect(this.xOf(b), RULER_H, 1, h - RULER_H)
        }
      const labelEvery = Math.max(1, Math.ceil(24 / Math.max(1, pxPerBeat * 4)))
      audio.downbeats.forEach((b, i) => {
        if (b > this.dur) return
        const x = this.xOf(b)
        g.fillStyle = '#ffffff30'
        g.fillRect(x, RULER_H - 8, 1, h - RULER_H + 8)
        if (i % labelEvery === 0) {
          g.fillStyle = '#ffd24a'
          g.font = '9px "Segoe UI", sans-serif'
          g.fillText(String(i + 1), x + 2, RULER_H - 4)
          g.font = '11px "Segoe UI", sans-serif'
        }
      })
    }

    // tracks
    const ty = RULER_H + AUDIO_H
    if (!tracks.length) {
      g.fillStyle = '#5a5a66'
      g.fillText('No keyframes. Turn on Auto-key and move a slider, or right-click a key to change its easing.', 10, ty + ROW_H / 2)
    }
    tracks.forEach((tr, r) => {
      const y = ty + r * ROW_H
      g.fillStyle = r % 2 ? '#15151a' : '#131317'
      g.fillRect(0, y, this.cssW, ROW_H)
      g.fillStyle = tr.inst.enabled ? '#c8c8d0' : '#5a5a66'
      g.fillText(tr.label.length > 30 ? tr.label.slice(0, 29) + '…' : tr.label, 10, y + ROW_H / 2)
      const ks = tr.inst.keys[tr.key]
      g.strokeStyle = '#ff2a4a55'
      g.beginPath()
      g.moveTo(this.xOf(ks[0].t), y + ROW_H / 2)
      g.lineTo(this.xOf(ks[ks.length - 1].t), y + ROW_H / 2)
      g.stroke()
      for (const k of ks) {
        const x = this.xOf(k.t)
        const c = y + ROW_H / 2
        const on = this.sel?.k === k
        g.fillStyle = on ? '#ffffff' : '#ff2a4a'
        g.beginPath()
        if (k.ease === 'hold') g.rect(x - 4, c - 4, 8, 8)
        else if (k.ease === 'ease') g.arc(x, c, 4.5, 0, Math.PI * 2)
        else {
          g.moveTo(x, c - 6)
          g.lineTo(x + 6, c)
          g.lineTo(x, c + 6)
          g.lineTo(x - 6, c)
        }
        g.fill()
      }
    })

    // playhead
    const px = this.xOf(this.host.transport.t)
    g.fillStyle = '#ff2a4a'
    g.fillRect(px, 0, 1.5, h)
    g.beginPath()
    g.moveTo(px - 5, 0)
    g.lineTo(px + 6.5, 0)
    g.lineTo(px + 0.75, 7)
    g.fill()
    g.fillStyle = '#26262e'
    g.fillRect(LABEL_W - 1, 0, 1, h)
  }
}
