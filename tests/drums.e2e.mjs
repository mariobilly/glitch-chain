// Beat sync step 2: kick / snare / hi-hat detection and their modulator sources.
// MUSIC_FILE (optional) = a real song, sanity-checked.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { drumTrack, matchTimes } from './lib/drums.mjs'

const require = createRequire(import.meta.url)
const WORK = join(tmpdir(), 'glitch-chain-e2e-drums')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9920
async function open(music) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_MUSIC: music }
  })
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
  await page.waitForFunction(() => window.__glitch?.audio?.(), { timeout: 60000 })
  await page.waitForSelector('.card:not(.layer-card)')
  return {
    page,
    close: async () => {
      await browser.disconnect().catch(() => {})
      app.kill()
    }
  }
}
/** Mean signed timing error in ms of detected hits vs the true ones they match. */
const signedMs = (det, tr) => {
  const d = tr.map((x) => det.reduce((b, y) => (Math.abs(y - x) < Math.abs(b - x) ? y : b), 1e9) - x).filter((v) => Math.abs(v) < 0.03)
  return d.length ? (d.reduce((s, v) => s + v, 0) / d.length) * 1000 : NaN
}

try {
  // ---------- detection accuracy on tracks with exact hit times ----------
  const CASES = [
    { bpm: 96, pattern: 'rock', seed: 21 },
    { bpm: 128, pattern: 'four', seed: 22 },
    { bpm: 140, pattern: 'rock', seed: 23, bass: false },
    { bpm: 174, pattern: 'rock', seed: 24 }
  ]
  let modRun = null
  let modTruth = null
  for (const c of CASES) {
    const file = join(WORK, `d${c.bpm}.wav`)
    const truth = drumTrack(file, { bars: 10, lead: 0.45, ...c })
    const run = await open(file)
    const a = await run.page.evaluate(() => {
      const x = window.__glitch.audio()
      return { kicks: x.kicks, snares: x.snares, hats: x.hats }
    })
    const parts = []
    let ok = true
    for (const k of ['kicks', 'snares', 'hats']) {
      const m = matchTimes(a[k], truth[k], 0.025)
      const e = signedMs(a[k], truth[k])
      ok &&= m.recall >= 0.95 && m.precision >= 0.9 && Math.abs(e) < 6
      parts.push(`${k} R${Math.round(m.recall * 100)} P${Math.round(m.precision * 100)} ${e.toFixed(1)}ms`)
    }
    check(`${c.pattern} ${c.bpm} BPM${c.bass === false ? ' (no bass)' : ''}: kick / snare / hat hits`, ok, parts.join(' · '))
    if (!modRun) {
      modRun = run
      modTruth = truth
    } else await run.close()
  }

  // ---------- modulator sources follow the right drum ----------
  const page = modRun.page
  const menu = await page.evaluate(async () => {
    window.__glitch.add('rgbSplit', {})
    await new Promise((r) => setTimeout(r, 200))
    const card = [...document.querySelectorAll('.card:not(.layer-card)')].at(-1)
    const f = [...card.querySelectorAll('.tp-fldv')].find((x) => x.querySelector('.tp-fldv_t')?.textContent.startsWith('Modulators'))
    if (!f.classList.contains('tp-fldv-expanded')) f.querySelector('.tp-fldv_b').click()
    ;[...f.querySelectorAll('.tp-btnv_b')].find((b) => b.textContent.includes('Add modulator')).click()
    await new Promise((r) => setTimeout(r, 300))
    const card2 = [...document.querySelectorAll('.card:not(.layer-card)')].at(-1)
    const row = [...card2.querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'source')
    return [...row.querySelector('select').options].map((o) => o.textContent)
  })
  check('modulator menu offers kick / snare / hi-hat', ['audio kick', 'audio snare', 'audio hi-hat'].every((x) => menu.includes(x)), menu.filter((x) => x.startsWith('audio')).join(', '))
  const idx = await page.evaluate(() => window.__glitch.state().chain.length - 1)
  const key = await page.evaluate((i) => window.__glitch.state().chain[i].mods[0].target, idx)
  const base = await page.evaluate((i, k) => window.__glitch.state().chain[i].params[k], idx, key)
  const probe = async (shape) => {
    await page.evaluate(
      (i, sh) => {
        const m = window.__glitch.state().chain[i].mods[0]
        m.shape = sh
        m.depth = 0.5
      },
      idx,
      shape
    )
    const at = async (ts) => {
      const v = await page.evaluate((i, k, list) => list.map((t) => window.__glitch.paramAt(i, k, t)), idx, key, ts)
      return v.reduce((s, x) => s + x, 0) / v.length - base
    }
    return {
      kick: await at(modTruth.kicks.slice(2, 12).map((t) => t + 0.02)),
      snare: await at(modTruth.snares.slice(2, 12).map((t) => t + 0.02)),
      before: await at(modTruth.kicks.slice(2, 12).map((t) => t - 0.03))
    }
  }
  const k = await probe('audio-kick')
  check('"audio kick" jumps on kicks, not on snares', k.kick > 3 * Math.max(k.snare, 1e-6) && k.kick > 3 * Math.max(k.before, 1e-6), `+${k.kick.toFixed(3)} on kicks · +${k.snare.toFixed(3)} on snares · +${k.before.toFixed(3)} just before kicks`)
  const s = await probe('audio-snare')
  check('"audio snare" jumps on snares, not on kicks', s.snare > 3 * Math.max(s.kick, 1e-6), `+${s.snare.toFixed(3)} on snares · +${s.kick.toFixed(3)} on kicks`)
  await modRun.close()

  // ---------- a real song ----------
  if (process.env.MUSIC_FILE) {
    const run = await open(process.env.MUSIC_FILE)
    const a = await run.page.evaluate(() => {
      const x = window.__glitch.audio()
      return { kicks: x.kicks, snares: x.snares, hats: x.hats, beats: x.beats, bpm: x.bpm }
    })
    await run.close()
    const spb = 60 / a.bpm
    const onGrid = (ts) => ts.filter((t) => a.beats.some((b) => Math.abs(t - b) < 0.035 || Math.abs(t - b - spb / 2) < 0.035)).length / Math.max(1, ts.length)
    check(
      'real song: kicks and snares mostly on the beat grid',
      a.kicks.length > 5 && onGrid(a.kicks) > 0.7 && onGrid(a.snares) > 0.6,
      `${a.kicks.length} kicks (${Math.round(onGrid(a.kicks) * 100)}% on grid) · ${a.snares.length} snares (${Math.round(onGrid(a.snares) * 100)}%) · ${a.hats.length} hats`
    )
  }
} catch (err) {
  check('drums flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
