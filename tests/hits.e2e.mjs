// Beat sync step 3: beat-hit modulators (triggers, every N, attack/decay), UI, save/reopen, render.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { drumTrack } from './lib/drums.mjs'

const require = createRequire(import.meta.url)
const IMG = process.env.HITS_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('HITS_TEST_IMAGE must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-hits')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const MUSIC = join(WORK, 'beat120.wav')
const truth = drumTrack(MUSIC, { bpm: 120, bars: 8, lead: 0.5, pattern: 'rock', seed: 4 })
const SAVE = join(WORK, 'hits.glitch')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9940
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_LOAD: IMG, GLITCH_SAVE_PATH: SAVE, ...env }
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
  return { app, browser, page, exited, close: async () => (await browser.disconnect().catch(() => {}), app.kill()) }
}

try {
  let run = await launch({ GLITCH_MUSIC: MUSIC })
  let { page } = run
  await page.waitForFunction(() => window.__glitch?.audio?.()?.bpm > 0, { timeout: 60000 })
  const a = await page.evaluate(() => {
    const x = window.__glitch.audio()
    return { beats: x.beats, downbeats: x.downbeats }
  })
  // An RGB split whose amount rests at 0 and is driven only by one beat-hit modulator (depth 1 = full range).
  await page.evaluate(() => {
    window.__glitch.state().chain.splice(0)
    window.__glitch.add('rgbSplit', { amount: 0 })
  })
  const RANGE = 0.06
  const setMod = (m) =>
    page.evaluate((mm) => {
      const inst = window.__glitch.state().chain[0]
      inst.mods = [{ target: 'amount', shape: 'hit', rate: 0.5, depth: 1, trigger: 'beat', every: 1, attack: 0, decay: 0.25, ...mm }]
    }, m)
  /** Envelope (0..1) at each time. */
  const env = (ts) => page.evaluate((list, r) => list.map((t) => window.__glitch.paramAt(0, 'amount', t) / r), ts, RANGE)
  const beats = a.beats.filter((t) => t > 1 && t < 14)
  const down = a.downbeats.filter((t) => t > 1 && t < 14)
  const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length
  const bars = (t) => a.downbeats.filter((d) => d <= t + 1e-6).length

  // ---------- triggers ----------
  await setMod({ trigger: 'beat' })
  const onB = await env(beats.map((t) => t + 0.01))
  const preB = await env(beats.map((t) => t - 0.02))
  check('beat: fires on every beat', Math.min(...onB) > 0.8 && Math.max(...preB) < 0.05, `on beat ≥ ${Math.min(...onB).toFixed(2)} · just before ≤ ${Math.max(...preB).toFixed(2)}`)

  await setMod({ trigger: 'beat', every: 2 })
  // Position in bar: 0 = the "1".
  const pos = (t) => Math.round((t - a.downbeats.filter((d) => d <= t + 1e-6).at(-1)) / 0.5)
  const odd = beats.filter((t) => pos(t) % 2 === 0)
  const even = beats.filter((t) => pos(t) % 2 === 1)
  const e1 = await env(odd.map((t) => t + 0.01))
  const e2 = await env(even.map((t) => t + 0.01))
  check('every 2nd beat: fires on 1 and 3, not 2 and 4', Math.min(...e1) > 0.8 && Math.max(...e2) < 0.1, `beats 1/3: ${avg(e1).toFixed(2)} · beats 2/4: ${avg(e2).toFixed(2)}`)

  await setMod({ trigger: 'bar' })
  const onBar = await env(down.map((t) => t + 0.01))
  const notBar = await env(beats.filter((t) => pos(t) !== 0).map((t) => t + 0.01))
  check('bar: fires only on the "1"', Math.min(...onBar) > 0.8 && Math.max(...notBar) < 0.1, `downbeats ${avg(onBar).toFixed(2)} · other beats ${avg(notBar).toFixed(2)}`)

  await setMod({ trigger: 'bar', every: 2 })
  const b2 = await env(down.map((t) => t + 0.01))
  const alt = b2.map((v, i) => (bars(down[i]) % 2 === 1 ? v > 0.8 : v < 0.1)).every(Boolean)
  check('every 2nd bar: alternating bars', alt, b2.map((v) => v.toFixed(1)).join(' '))

  await setMod({ trigger: 'offbeat' })
  const off = await env(beats.map((t) => t + 0.25 + 0.01))
  const offPre = await env(beats.map((t) => t + 0.01))
  check('off-beat: fires halfway between beats', Math.min(...off) > 0.8 && Math.max(...offPre) < 0.1, `off-beats ${avg(off).toFixed(2)} · beats ${avg(offPre).toFixed(2)}`)

  for (const [trig, list, other] of [
    ['kick', truth.kicks, truth.snares],
    ['snare', truth.snares, truth.kicks]
  ]) {
    await setMod({ trigger: trig })
    const hit = await env(list.filter((t) => t > 1 && t < 14).map((t) => t + 0.015))
    const miss = await env(other.filter((t) => t > 1 && t < 14).map((t) => t + 0.015))
    check(`${trig}: fires on ${trig}s only`, Math.min(...hit) > 0.75 && Math.max(...miss) < 0.1, `${trig}s ${avg(hit).toFixed(2)} · others ${avg(miss).toFixed(2)}`)
  }
  await setMod({ trigger: 'hat' })
  const hh = await env(truth.hats.filter((t) => t > 1 && t < 14).map((t) => t + 0.012))
  check('hi-hat: fires on every hat (8ths)', Math.min(...hh) > 0.75, `min ${Math.min(...hh).toFixed(2)} over ${hh.length} hats`)

  // ---------- envelope shape ----------
  await setMod({ trigger: 'bar', attack: 0.1, decay: 0.6 })
  const d0 = down[1]
  const [atHalf, atPeak, atThird, atEnd] = await env([d0 + 0.05, d0 + 0.1, d0 + 0.1 + 0.2, d0 + 0.1 + 0.6])
  check('attack ramps up, decay falls off', Math.abs(atHalf - 0.5) < 0.08 && atPeak > 0.95 && Math.abs(atThird - Math.exp(-1)) < 0.08 && atEnd < 0.07, `½ attack ${atHalf.toFixed(2)} · peak ${atPeak.toFixed(2)} · ⅓ decay ${atThird.toFixed(2)} · end ${atEnd.toFixed(2)}`)
  await setMod({ trigger: 'beat', depth: -1 })
  await page.evaluate(() => (window.__glitch.state().chain[0].params.amount = 0.06))
  const duck = await env([beats[3] + 0.01, beats[3] - 0.02])
  check('negative depth ducks the value on the hit', duck[0] < 0.2 && duck[1] > 0.95, `on hit ${duck[0].toFixed(2)} · before ${duck[1].toFixed(2)}`)

  // ---------- UI ----------
  await page.evaluate(() => {
    window.__glitch.state().chain.splice(0)
    window.__glitch.add('punch', {})
  })
  await sleep(300)
  const ui = await page.evaluate(async () => {
    const card = () => [...document.querySelectorAll('.card:not(.layer-card)')].at(-1)
    const f = [...card().querySelectorAll('.tp-fldv')].find((x) => x.querySelector('.tp-fldv_t')?.textContent.startsWith('Modulators'))
    if (!f.classList.contains('tp-fldv-expanded')) f.querySelector('.tp-fldv_b').click()
    ;[...f.querySelectorAll('.tp-btnv_b')].find((b) => b.textContent.includes('Add modulator')).click()
    await new Promise((r) => setTimeout(r, 300))
    const labels = () => [...card().querySelectorAll('.tp-lblv_l')].map((l) => l.textContent.trim())
    const before = labels()
    const sel = [...card().querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'source').querySelector('select')
    sel.value = [...sel.options].find((o) => o.textContent.startsWith('beat hit')).value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 400))
    return { before, after: labels(), mod: window.__glitch.state().chain[0].mods[0] }
  })
  const hasHit = ['on', 'every', 'attack (s)', 'decay (s)'].every((l) => ui.after.includes(l))
  check('choosing "beat hit" shows trigger / every / attack / decay (and hides LFO rate)', hasHit && !ui.after.includes('LFO rate (Hz)') && ui.mod.shape === 'hit', ui.after.filter((l) => ['source', 'on', 'every', 'attack (s)', 'decay (s)', 'LFO rate (Hz)'].includes(l)).join(', '))

  // ---------- save + reopen keeps hit settings ----------
  await page.evaluate(() => Object.assign(window.__glitch.state().chain[0].mods[0], { target: 'flash', trigger: 'snare', every: 2, attack: 0.05, decay: 0.7, depth: 0.6 }))
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 15000 })
  await run.close()
  run = await launch({ GLITCH_PROJECT: SAVE })
  page = run.page
  await page.waitForFunction(() => window.__glitch?.state().chain[0]?.effectId === 'punch', { timeout: 20000 })
  const m = await page.evaluate(() => window.__glitch.state().chain[0].mods[0])
  check('project reopens with the beat-hit settings', m.shape === 'hit' && m.trigger === 'snare' && m.every === 2 && m.attack === 0.05 && m.decay === 0.7 && m.target === 'flash', JSON.stringify(m))
  await run.close()

  // ---------- no music: falls back to 120 BPM ----------
  run = await launch({})
  page = run.page
  await page.waitForSelector('.card:not(.layer-card)')
  await page.evaluate(() => {
    window.__glitch.state().chain.splice(0)
    window.__glitch.add('rgbSplit', { amount: 0 })
    window.__glitch.state().chain[0].mods = [{ target: 'amount', shape: 'hit', rate: 0.5, depth: 1, trigger: 'beat', every: 1, attack: 0, decay: 0.2 }]
  })
  const fb = await page.evaluate(() => [1.0, 1.5, 2.0, 1.25, 1.74].map((t) => window.__glitch.paramAt(0, 'amount', t + 0.005) / 0.06))
  check('without music, beat hits still fire at 120 BPM', fb.slice(0, 3).every((v) => v > 0.9) && fb.slice(3).every((v) => v < 0.1), fb.map((v) => v.toFixed(2)).join(' '))
  await run.close()

  // ---------- offline render: bar flashes land on the bar frames ----------
  const OUT = join(WORK, 'flash.mp4')
  run = await launch({
    GLITCH_MUSIC: MUSIC,
    GLITCH_PRESET: 'Beat Hits',
    GLITCH_RENDER: OUT,
    GLITCH_RENDER_SPEC: JSON.stringify({ duration: 5, fps: 30, includeAudio: false })
  })
  await Promise.race([run.exited, sleep(120000)])
  await run.browser.disconnect().catch(() => {})
  const ff = require('ffmpeg-static')
  const luma = spawnSync(ff, ['-v', 'error', '-i', OUT, '-vf', 'scale=32:56,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1e8 }).stdout
  const fsz = 32 * 56
  const L = []
  for (let o = 0; o + fsz <= luma.length; o += fsz) L.push(luma.subarray(o, o + fsz).reduce((s, v) => s + v, 0) / fsz)
  const barFrames = a.downbeats.filter((t) => t < 4.8).map((t) => Math.ceil(t * 30))
  const lifts = barFrames.map((f) => L[f] - L[f - 3])
  check('rendered video flashes on every bar', L.length >= 140 && lifts.length >= 2 && lifts.every((d) => d > 8), `${L.length} frames · brightness jump at bars: ${lifts.map((d) => d.toFixed(0)).join(', ')}`)
} catch (err) {
  check('hits flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
