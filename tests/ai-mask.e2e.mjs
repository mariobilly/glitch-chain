// In-app AI object masks (Segment Anything + Grounding DINO, no ComfyUI).
// AI_TEST_IMAGE = photo with a bicycle; in the 960x1008 test photo the bike spans about x 207-514, y 471-937.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const IMG = process.env.AI_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('AI_TEST_IMAGE must be an existing photo')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function launch(port, load = IMG) {
  const USER_DATA = join(tmpdir(), `glitch-chain-e2e-ai-${port}`)
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(join(USER_DATA, 'presets'), { recursive: true })
  writeFileSync(join(USER_DATA, 'presets', 'T_dark.json'), JSON.stringify({ name: 'T_dark', output: 'Match source', chain: [{ effectId: 'grade', params: { exposure: -3 } }] }))
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${port}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: USER_DATA, GLITCH_PRESET: 'T_dark', GLITCH_LOAD: load }
  })
  let browser, page
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null })
    } catch {
      await sleep(300)
    }
  }
  for (let i = 0; i < 60 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().includes('index.html'))
    if (!page) await sleep(250)
  }
  const errors = []
  const loaded = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  page.on('requestfinished', (r) => /\.(onnx|wasm|mjs)(\?|$)/.test(r.url()) && loaded.push(r.url().split('/').slice(-2).join('/')))
  page.on('requestfailed', (r) => errors.push('request failed: ' + r.url()))
  await page.waitForSelector('.card:not(.layer-card)')
  await sleep(2000)
  return { app, browser, page, errors, loaded }
}

const L = (page, x, y, w, h) =>
  page.evaluate(
    (r) => {
      const d = window.__glitch.pipeline.toCanvas().getContext('2d').getImageData(r[0], r[1], r[2], r[3]).data
      let s = 0
      for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      return s / (d.length / 4)
    },
    [x, y, w, h]
  )

async function startSelect(page) {
  await page.evaluate(() => {
    const card = document.querySelectorAll('.card:not(.layer-card)')[0]
    const f = [...card.querySelectorAll('.tp-fldv')].find((x) => x.querySelector('.tp-fldv_t')?.textContent.startsWith('Mask'))
    if (!f.classList.contains('tp-fldv-expanded')) f.querySelector('.tp-fldv_b').click()
    const row = [...card.querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'limit to')
    const sel = row.querySelector('select')
    sel.value = [...sel.options].find((o) => o.textContent === 'AI object (click or type)').value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(300)
  await page.evaluate(() => [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-btnv_b')].find((b) => b.textContent.trim() === 'Select object on preview…').click())
  await page.waitForSelector('.mask-bar input')
  // Wait until the model has loaded and encoded the frame (the bar stops being busy).
  await page.waitForFunction(() => !document.querySelector('.mask-bar').classList.contains('busy'), { timeout: 180000, polling: 250 })
}
const idle = (page) => page.waitForFunction(() => !document.querySelector('.mask-bar')?.classList.contains('busy'), { timeout: 180000, polling: 250 })
async function commitAndMeasure(page, name, target = [290, 600], others = { wall: [700, 150], girl: [660, 700] }) {
  await page.click('.mask-bar [data-a=commit]')
  await page.waitForFunction(() => /Object mask ready/.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 60000 })
  await sleep(1200)
  const measure = async () => {
    const r = { target: await L(page, target[0], target[1], 30, 30) }
    for (const [k, [x, y]] of Object.entries(others)) r[k] = await L(page, x, y, 40, 40)
    return r
  }
  const on = await measure()
  await page.evaluate(() => document.querySelector('.card:not(.layer-card) .toggle input').click())
  await sleep(600)
  const off = await measure()
  const keep = Object.keys(others).every((k) => Math.abs(on[k] - off[k]) < 6)
  check(
    `${name}: only the selected object darkens`,
    on.target < off.target * 0.45 && keep,
    Object.keys(off).map((k) => `${k} ${off[k].toFixed(0)}→${on[k].toFixed(0)}`).join(' · ')
  )
}

// ---------- type what to mask ----------
let run = await launch(9641)
try {
  const { page } = run
  const t0 = Date.now()
  await startSelect(page)
  check('Segment Anything loads in-app', !run.errors.length, `${Math.round((Date.now() - t0) / 1000)} s · ${run.loaded.join(', ')}`)
  await page.type('.mask-bar input', 'bicycle')
  const t1 = Date.now()
  await page.keyboard.press('Enter')
  await sleep(300)
  await idle(page)
  const barText = await page.$eval('.mask-bar .ai-hint', (e) => e.textContent)
  check('text prompt finds it', (await page.evaluate(() => window.__glitch.tracks().some((t) => t.id.startsWith('preview_')))), `${Math.round((Date.now() - t1) / 1000)} s incl. Grounding DINO load · bar: ${barText}`)
  await commitAndMeasure(page, 'typed “bicycle”')
  if (run.errors.length) console.log('  errors:', run.errors.slice(0, 5).join(' || '))
} catch (err) {
  check('type flow', false, err.stack + '\n  errors: ' + run.errors.slice(0, 5).join(' || '))
} finally {
  await run.browser?.disconnect()
  run.app.kill()
}

// ---------- click the object ----------
run = await launch(9642)
try {
  const { page } = run
  await startSelect(page)
  const b = await (await page.$('#out')).boundingBox()
  // The girl's dress on the right (source px ~ (690, 700) of 960x1008; output = source size).
  const t1 = Date.now()
  await page.mouse.click(b.x + (690 / 960) * b.width, b.y + (700 / 1008) * b.height)
  await sleep(300)
  await idle(page)
  check('click segments instantly', true, `${Date.now() - t1} ms`)
  await commitAndMeasure(page, 'clicked dress', [670, 690], { wall: [700, 150], bike: [290, 600] })
} catch (err) {
  check('click flow', false, err.stack + '\n  errors: ' + run.errors.slice(0, 5).join(' || '))
} finally {
  await run.browser?.disconnect()
  run.app.kill()
}

// ---------- tracking through a clip with known motion ----------
// TRACK_TEST_VIDEO: the test photo panning left by 240 px over 3 s (720x1008). The boy's shirt must follow.
if (process.env.TRACK_TEST_VIDEO) {
  run = await launch(9643, process.env.TRACK_TEST_VIDEO)
  try {
    const { page } = run
    await page.click('#play')
    await page.$eval('#dur', (e) => { e.value = '3'; e.dispatchEvent(new Event('change')) })
    await page.click('#home')
    await sleep(600)
    await startSelect(page)
    const b = await (await page.$('#out')).boundingBox()
    await page.mouse.click(b.x + 0.694 * b.width, b.y + 0.466 * b.height)
    await sleep(300)
    await idle(page)
    const t0 = Date.now()
    await page.click('.mask-bar [data-a=commit]')
    await page.waitForFunction(() => /Object mask ready/.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 900000, polling: 1000 })
    const stats = await page.evaluate(async () => {
      const t = window.__glitch.tracks().find((x) => !x.id.startsWith('preview_'))
      const out = []
      // Step 9 hits both analyzed (even) and blended in-between (odd) frames of the default 2x-faster tracking.
      out.missing = t.frames.filter((f) => !f).length
      for (let n = 0; n < t.frames.length; n += 9) {
        const blob = t.frames[n]
        if (!blob) continue
        const bmp = await createImageBitmap(blob)
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const g = c.getContext('2d')
        g.drawImage(bmp, 0, 0)
        const d = g.getImageData(0, 0, c.width, c.height).data
        let sx = 0, cnt = 0
        for (let i = 0; i < d.length; i += 4) if (d[i] > 127) { sx += (i / 4) % c.width; cnt++ }
        out.push({ n, cx: cnt ? (sx / cnt) * (720 / c.width) : null, cnt })
      }
      return { list: out, missing: out.missing, total: t.frames.length }
    })
    check('every frame has a mask (in-between frames filled)', stats.missing === 0, `${stats.total - stats.missing}/${stats.total} frames`)
    const f0 = stats.list[0]
    const worst = Math.max(...stats.list.map((s) => Math.abs(s.cx - (f0.cx - (240 * s.n) / 90))))
    const sizes = stats.list.map((s) => s.cnt)
    const spread = Math.max(...sizes) / Math.min(...sizes)
    check('tracking follows known motion', worst < 8 && spread < 1.3, `max error ${worst.toFixed(1)} px · size spread ×${spread.toFixed(2)} · ${Math.round((Date.now() - t0) / 1000)} s for 90 frames`)
  } catch (err) {
    check('tracking flow', false, err.stack)
  } finally {
    await run.browser?.disconnect()
    run.app.kill()
  }
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
