// Synthetic drum + bass track with exact ground truth, for testing beat / bar / drum detection.
import { writeFileSync } from 'node:fs'

/**
 * @param {object} o
 * @param {number} o.bpm tempo
 * @param {number} o.bars number of 4/4 bars
 * @param {number} o.lead seconds of silence before the first beat
 * @param {'rock'|'four'} o.pattern rock: kick on 1 & 3, snare 2 & 4. four: kick every beat, clap 2 & 4.
 * @param {number} o.seed
 * Returns ground truth times in seconds.
 */
export function drumTrack(file, { bpm = 128, bars = 16, lead = 0.37, pattern = 'rock', seed = 1, hats = true, bass = true } = {}) {
  const sr = 44100
  const spb = 60 / bpm
  const dur = lead + bars * 4 * spb + 1
  const n = Math.ceil(dur * sr)
  const x = new Float32Array(n)
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  const noise = () => rnd() * 2 - 1
  const truth = { beats: [], downbeats: [], kicks: [], snares: [], hats: [], bpm }
  const add = (t, len, fn) => {
    const i0 = Math.round(t * sr)
    for (let i = 0; i < len * sr && i0 + i < n; i++) x[i0 + i] += fn(i / sr)
  }
  const kick = (t, v) => {
    truth.kicks.push(t)
    let ph = 0
    add(t, 0.25, (u) => {
      ph += (2 * Math.PI * (50 + 90 * Math.exp(-u * 30))) / sr
      return v * 0.9 * Math.sin(ph) * Math.exp(-u * 12)
    })
  }
  const snare = (t, v) => {
    truth.snares.push(t)
    let lp = 0
    add(t, 0.18, (u) => {
      const w = noise()
      lp += 0.35 * (w - lp)
      return v * (0.45 * (w - lp) * Math.exp(-u * 22) + 0.25 * Math.sin(2 * Math.PI * 190 * u) * Math.exp(-u * 30))
    })
  }
  const hat = (t, v) => {
    truth.hats.push(t)
    let prev = 0
    add(t, 0.05, (u) => {
      const w = noise()
      const hp = w - prev
      prev = w
      return v * 0.18 * hp * Math.exp(-u * 90)
    })
  }
  // Bass line: a new note on every bar's "1" (A, F, C, G), soft saw, held for the bar.
  const notes = [55, 43.65, 65.41, 49]
  for (let b = 0; b < bars; b++) {
    for (let q = 0; q < 4; q++) {
      const t = lead + (b * 4 + q) * spb
      truth.beats.push(t)
      if (q === 0) truth.downbeats.push(t)
      const vel = 0.85 + 0.15 * rnd()
      if (pattern === 'four' || q % 2 === 0) kick(t, vel)
      if (q % 2 === 1) snare(t, vel)
      if (hats) {
        hat(t, 0.8 * vel)
        hat(t + spb / 2, 0.5 * vel)
      }
    }
    if (bass) {
      const f = notes[b % 4]
      const t0 = lead + b * 4 * spb
      // Band-limited saw (12 harmonics): a naive saw clicks every cycle, which no real bass does.
      add(t0, 4 * spb, (u) => {
        let saw = 0
        for (let h = 1; h <= 12; h++) saw += Math.sin(2 * Math.PI * f * h * u) / h
        return 0.12 * saw * Math.min(1, u * 40) * Math.min(1, (4 * spb - u) * 40)
      })
    }
  }
  // 16-bit mono WAV
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sr, 24)
  buf.writeUInt32LE(sr * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 0.6 * 32767))), 44 + i * 2)
  writeFileSync(file, buf)
  truth.kicks.sort((a, b) => a - b)
  truth.duration = dur
  return truth
}

/** Match detected times to truth within tol seconds: precision, recall and mean absolute error. */
export function matchTimes(detected, truth, tol = 0.05) {
  const used = new Set()
  let hit = 0
  let err = 0
  for (const t of truth) {
    let best = -1
    let bd = tol
    detected.forEach((d, i) => {
      if (!used.has(i) && Math.abs(d - t) <= bd) {
        bd = Math.abs(d - t)
        best = i
      }
    })
    if (best >= 0) {
      used.add(best)
      hit++
      err += bd
    }
  }
  return { precision: detected.length ? hit / detected.length : 0, recall: truth.length ? hit / truth.length : 0, meanErr: hit ? err / hit : 0 }
}
