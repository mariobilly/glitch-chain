// Beat sync step 5: preset sequence cutting on bars (and beats counted from the bar), incl. offline render.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { drumTrack } from './lib/drums.mjs'

const require = createRequire(import.meta.url)
const IMG = process.env.SEQ_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('SEQ_TEST_IMAGE must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-seqbars')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
// 110 BPM starting after a silent intro: the beat grid extends back into the silence, so bar 1 is not beat 0.
const MUSIC = join(WORK, 'bars110.wav')
const truth = drumTrack(MUSIC, { bpm: 110, bars: 8, lead: 0.3 + 60 / 110, pattern: 'four', seed: 6 })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9970
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_LOAD: IMG, GLITCH_MUSIC: MUSIC, ...env }
  })
  const exited = new Promise((r) => app.on('exit', () => r(true)))
  let browser, page
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
  return { app, browser, page, exited }
}
/** Cut times of the current sequence over the clip. */
const cuts = (page) =>
  page.evaluate(() => {
    const segs = window.__glitch.seq().segments(12, window.__glitch.audio())
    return segs.slice(1).map((s) => s.t0)
  })
const near = (list, t, tol = 1 / 60 + 1e-6) => list.some((x) => Math.abs(x - t) <= tol)

let run
try {
  run = await launch({})
  const { page } = run
  await page.waitForFunction(() => window.__glitch?.audio?.()?.bpm > 0, { timeout: 60000 })
  const a = await page.evaluate(() => {
    const x = window.__glitch.audio()
    return { beats: x.beats, downbeats: x.downbeats }
  })
  const bars = a.downbeats.filter((t) => t < 11.9)
  check('music analysed: bar 1 where the music starts, grid extended into the silent intro', Math.abs(a.downbeats[0] - truth.downbeats[0]) < 0.02, `first bar at ${a.downbeats[0].toFixed(3)} s (true ${truth.downbeats[0].toFixed(3)})`)

  // ---------- dialog: bars mode ----------
  await page.click('#sequence')
  await page.waitForSelector('.seq-box')
  const modes = await page.$$eval('.seq-box [name=mode] option', (o) => o.map((x) => x.value))
  await page.$eval('.seq-box [name=every]', (e) => {
    e.value = '1'
    e.dispatchEvent(new Event('change'))
  })
  await page.select('.seq-box [name=mode]', 'bars')
  const hint = await page.$eval('.seq-box .seq-hint', (e) => e.textContent)
  for (const n of ['Clean Tear', 'Neon Noir']) {
    await page.select('.seq-box [name=add]', n)
    await page.click('.seq-box [data-a=add]')
  }
  await page.click('.seq-box .primary')
  check('sequence dialog offers "bars" and explains it', modes.includes('bars') && /bar/.test(hint), `modes: ${modes.join(', ')} · "${hint}"`)

  // ---------- cut positions ----------
  let c = await cuts(page)
  check('every bar: cuts exactly on each bar line', c.length === bars.length - 1 && bars.slice(1).every((t) => near(c, t)), `cuts ${c.map((t) => t.toFixed(2)).join(' ')} · bars ${bars.map((t) => t.toFixed(2)).join(' ')}`)
  await page.evaluate(() => {
    window.__glitch.seq().seq.every = 2
    window.__glitch.seq().invalidate()
  })
  c = await cuts(page)
  const odd = bars.filter((_, i) => i % 2 === 0).slice(1)
  check('every 2 bars: cuts on bars 3, 5, 7…', c.length === odd.length && odd.every((t) => near(c, t)), `cuts ${c.map((t) => t.toFixed(2)).join(' ')}`)
  await page.evaluate(() => {
    const s = window.__glitch.seq().seq
    s.mode = 'beats'
    s.every = 4
    window.__glitch.seq().invalidate()
  })
  c = await cuts(page)
  check('every 4 beats: counted from bar 1, so cuts also land on bar lines (intro stays in the first segment)', bars.slice(1).every((t) => near(c, t)) && c.length === bars.length - 1, `cuts ${c.map((t) => t.toFixed(2)).join(' ')}`)
  await page.evaluate(() => {
    const s = window.__glitch.seq().seq
    s.mode = 'seconds'
    s.every = 1.5
    window.__glitch.seq().invalidate()
  })
  c = await cuts(page)
  check('seconds mode unchanged', c.slice(0, 4).every((t, i) => Math.abs(t - 1.5 * (i + 1)) < 1 / 60 + 1e-6), c.slice(0, 4).map((t) => t.toFixed(2)).join(' '))
  await run.browser.disconnect().catch(() => {})
  run.app.kill()

  // ---------- offline render: the look switches on the bar frames ----------
  const OUT = join(WORK, 'bars.mp4')
  run = await launch({
    GLITCH_PRESET: 'Clean Tear',
    GLITCH_RENDER: OUT,
    GLITCH_RENDER_SPEC: JSON.stringify({ duration: 8, fps: 30, includeAudio: false, sequence: { items: ['Clean Tear', 'Neon Noir'], mode: 'bars', every: 1, order: 'loop' } })
  })
  await Promise.race([run.exited, sleep(150000)])
  await run.browser.disconnect().catch(() => {})
  const ff = require('ffmpeg-static')
  const raw = spawnSync(ff, ['-v', 'error', '-i', OUT, '-vf', 'scale=36:64', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e8 }).stdout
  const fsz = 36 * 64 * 3
  // Blue minus green per frame: Neon Noir's cyberpunk grade is strongly purple, Clean Tear isn't.
  const tint = []
  for (let o = 0; o + fsz <= raw.length; o += fsz) {
    let s = 0
    for (let i = o; i < o + fsz; i += 3) s += raw[i + 2] - raw[i + 1]
    tint.push(s / (fsz / 3))
  }
  const jumps = tint.slice(1).map((v, i) => ({ f: i + 1, d: Math.abs(v - tint[i]) }))
  const big = jumps.filter((j) => j.d > 12).map((j) => j.f)
  const expected = a.downbeats.filter((t) => t > 0.1 && t < 7.9).slice(1).map((t) => Math.ceil(t * 30 - 1e-6))
  check('rendered video switches look exactly on the bar frames', big.length === expected.length && expected.every((f) => big.includes(f)), `switch frames ${big.join(', ')} · bar frames ${expected.join(', ')}`)
} catch (err) {
  check('seqbars flow', false, err.stack)
} finally {
  await run?.browser.disconnect().catch(() => {})
  run?.app.kill()
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
