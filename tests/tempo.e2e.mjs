// Beat sync step 1: tempo, beat grid and bar detection against synthetic tracks with exact ground truth.
// MUSIC_FILE (optional) = a real song, checked for a sane, steady grid.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { drumTrack, matchTimes } from './lib/drums.mjs'

const require = createRequire(import.meta.url)
const WORK = join(tmpdir(), 'glitch-chain-e2e-tempo')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9900
async function analyze(music) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_MUSIC: music }
  })
  let browser, page
  try {
    for (let i = 0; i < 60 && !browser; i++) {
      try {
        browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${p}`, defaultViewport: null })
      } catch {
        await sleep(300)
      }
    }
    for (let i = 0; i < 60 && !page; i++) {
      page = (await browser.pages()).find((x) => x.url().includes('index.html'))
      if (!page) await sleep(250)
    }
    await page.waitForFunction(() => window.__glitch?.audio?.(), { timeout: 60000 })
    return await page.evaluate(() => {
      const a = window.__glitch.audio()
      return { bpm: a.bpm, fit: a.tempoFit, beats: a.beats, downbeats: a.downbeats, duration: a.duration, toast: document.querySelector('.toast')?.textContent }
    })
  } finally {
    await browser?.disconnect().catch(() => {})
    app.kill()
  }
}
const inside = (list, t0, t1) => list.filter((t) => t >= t0 - 0.06 && t <= t1 + 0.06)

const CASES = [
  { name: 'rock 128 BPM, starts at 0.37 s', o: { bpm: 128, bars: 16, lead: 0.37, pattern: 'rock', seed: 3 } },
  { name: 'four-on-the-floor 100 BPM (bars only from the bass line)', o: { bpm: 100, bars: 12, lead: 1.1, pattern: 'four', seed: 5 } },
  { name: 'drum & bass 174 BPM', o: { bpm: 174, bars: 20, lead: 0.2, pattern: 'rock', seed: 7 } },
  { name: 'fractional 90.5 BPM', o: { bpm: 90.5, bars: 10, lead: 0.6, pattern: 'rock', seed: 11 } },
  { name: 'fast rock 157.6 BPM (used to halve)', o: { bpm: 157.6, bars: 12, lead: 0.12, pattern: 'rock', seed: 1 } },
  { name: 'slow 77.3 BPM (used to read as 116)', o: { bpm: 77.3, bars: 13, lead: 0.27, pattern: 'rock', seed: 1 } },
  { name: 'drums only, no bass line, 95 BPM', o: { bpm: 95, bars: 12, lead: 0.5, pattern: 'rock', seed: 3, bass: false, hats: false } }
]
try {
  for (const c of CASES) {
    const file = join(WORK, `${c.o.bpm}.wav`)
    const truth = drumTrack(file, c.o)
    const a = await analyze(file)
    const last = truth.beats.at(-1)
    const b = matchTimes(inside(a.beats, truth.beats[0], last), truth.beats, 0.035)
    const d = matchTimes(inside(a.downbeats, truth.beats[0], last), truth.downbeats, 0.035)
    check(`${c.name}: tempo`, Math.abs(a.bpm - c.o.bpm) <= 1, `detected ${a.bpm} BPM · toast "${a.toast}"`)
    check(`${c.name}: beat grid`, b.recall >= 0.95 && b.precision >= 0.95 && b.meanErr < 0.012, `recall ${(b.recall * 100).toFixed(0)}% · precision ${(b.precision * 100).toFixed(0)}% · mean error ${(b.meanErr * 1000).toFixed(1)} ms`)
    check(`${c.name}: bars start on the "1"`, d.recall >= 0.9 && d.precision >= 0.9, `recall ${(d.recall * 100).toFixed(0)}% · precision ${(d.precision * 100).toFixed(0)}%`)
  }

  // ---------- no steady pulse: irregular hits must not invent a tempo ----------
  {
    const sr = 44100
    const n = sr * 12
    const buf = Buffer.alloc(44 + n * 2)
    let s = 99
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
    const x = new Float32Array(n)
    for (let t = 0.3; t < 11.5; t += 0.15 + rnd() * 0.9) {
      const i0 = Math.round(t * sr)
      const f = 150 + rnd() * 900
      for (let i = 0; i < 0.2 * sr; i++) x[i0 + i] += Math.sin((2 * Math.PI * f * i) / sr) * Math.exp(-i / sr / 0.05) * (0.3 + rnd() * 0.5)
    }
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
    buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 20000), 44 + i * 2)
    const file = join(WORK, 'irregular.wav')
    writeFileSync(file, buf)
    const a = await analyze(file)
    check('irregular hits: no fake tempo', a.bpm === 0, `bpm ${a.bpm} · ${a.beats.length} onsets kept`)
  }

  // ---------- a real song ----------
  if (process.env.MUSIC_FILE) {
    const a = await analyze(process.env.MUSIC_FILE)
    const ibi = a.beats.slice(1).map((t, i) => t - a.beats[i])
    const med = [...ibi].sort((x, y) => x - y)[ibi.length >> 1]
    const steady = ibi.filter((d) => Math.abs(d - med) < 0.03).length / ibi.length
    check('real song: plausible steady tempo', a.bpm >= 60 && a.bpm <= 200 && steady > 0.9, `${a.bpm} BPM · grid fit ${a.fit.toFixed(2)} · ${a.beats.length} beats · ${a.downbeats.length} bars · ${(steady * 100).toFixed(0)}% of beat gaps steady`)
  }
} catch (err) {
  check('tempo flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
