// Layers e2e with exact numbers: base = shapes image (gray 128 background, red circle, green square),
// top = solid blue (0,0,255). Output 9:16 1080x1920 maps both images 1:1.
// LAYER_BASE = shapes_test.png, LAYER_TOP = blue_test.png
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const BASE = process.env.LAYER_BASE
const TOP = process.env.LAYER_TOP
for (const f of [BASE, TOP]) if (!f || !existsSync(f)) throw new Error('LAYER_BASE and LAYER_TOP must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-layers')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(join(WORK, 'profile', 'presets'), { recursive: true })
// A do-nothing preset so pixels are exact (no effects on either layer).
writeFileSync(join(WORK, 'profile', 'presets', 'T_clean.json'), JSON.stringify({ name: 'T_clean', chain: [] }))
const SAVE = join(WORK, 'two layers.glitch')
const OUT = join(WORK, 'render.mp4')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9750
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_PRESET: 'T_clean', GLITCH_SAVE_PATH: SAVE, ...env }
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
  await page.waitForSelector('#layers .layer-row')
  return { app, browser, page, exited }
}
/** Mean RGB of an output rectangle. */
const rgb = (page, x0, y0, x1, y1) =>
  page.evaluate(
    (r) => {
      const d = window.__glitch.pipeline.toCanvas().getContext('2d').getImageData(r[0], r[1], r[2] - r[0], r[3] - r[1]).data
      const s = [0, 0, 0]
      for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) s[c] += d[i + c]
      return s.map((v) => Math.round(v / (d.length / 4)))
    },
    [x0, y0, x1, y1]
  )
const GRAY = [900, 200, 1000, 300]
const CIRCLE = [260, 460, 340, 540]
const near = (a, b, tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol)
const layerNames = (page) => page.$$eval('#layers .layer-row .n', (els) => els.map((e) => e.textContent))
/** Set a control on the pinned Layer card by its label. */
async function setLayer(page, label, value) {
  await page.evaluate(
    (l, v) => {
      const row = [...document.querySelector('.card.layer-card').querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.replace('◆', '').trim() === l)
      const sel = row.querySelector('select')
      if (sel) {
        sel.value = [...sel.options].find((o) => o.textContent === v).value
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      } else {
        const input = row.querySelector('input')
        input.value = String(v)
        input.dispatchEvent(new Event('change', { bubbles: true }))
      }
    },
    label,
    value
  )
  await sleep(250)
}

try {
  let run = await launch({ GLITCH_LOAD: BASE })
  let { page } = run
  await sleep(1500)
  await page.click('#play')
  check('one layer shows the base image', near(await rgb(page, ...GRAY), [128, 128, 128]), JSON.stringify(await rgb(page, ...GRAY)))

  // ---------- add a layer through the real + Layer file input ----------
  await (await page.$('#layerFile')).uploadFile(TOP)
  await page.waitForFunction(() => document.querySelectorAll('#layers .layer-row').length === 2 && !/loading/.test(document.querySelector('#layers').textContent), { timeout: 15000 })
  await sleep(600)
  check('+ Layer adds it on top, selected', (await layerNames(page))[0] === 'Layer 2' && (await page.$eval('#layers .layer-row.active .n', (e) => e.textContent)) === 'Layer 2', (await layerNames(page)).join(' / '))
  check('normal blend: top covers base', near(await rgb(page, ...GRAY), [0, 0, 255]) && near(await rgb(page, ...CIRCLE), [0, 0, 255]), JSON.stringify(await rgb(page, ...GRAY)))

  await setLayer(page, 'opacity', 0.5)
  check('50% opacity mixes exactly', near(await rgb(page, ...GRAY), [64, 64, 192]), JSON.stringify(await rgb(page, ...GRAY)))
  await setLayer(page, 'opacity', 1)
  await setLayer(page, 'blend', 'multiply')
  check('multiply blend = base × top', near(await rgb(page, ...GRAY), [0, 0, 128]), JSON.stringify(await rgb(page, ...GRAY)))
  await setLayer(page, 'blend', 'normal')

  // ---------- hide ----------
  await page.click('#layers .layer-row.active .eye')
  await sleep(300)
  check('hiding the layer shows the base', near(await rgb(page, ...GRAY), [128, 128, 128]), JSON.stringify(await rgb(page, ...GRAY)))
  await page.click('#layers .layer-row.active .eye')
  await sleep(300)

  // ---------- layer mask: shape ----------
  await page.evaluate(() => {
    const card = document.querySelector('.card.layer-card')
    const f = [...card.querySelectorAll('.tp-fldv')].find((x) => x.querySelector('.tp-fldv_t')?.textContent.startsWith('Mask'))
    if (!f.classList.contains('tp-fldv-expanded')) f.querySelector('.tp-fldv_b').click()
    const row = [...card.querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'limit to')
    const sel = row.querySelector('select')
    sel.value = [...sel.options].find((o) => o.textContent === 'shape (drag on preview)').value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(400)
  // Default shape: centered at (0.5, 0.45), 0.5 x 0.3 of the frame, soft edge.
  const inside = await rgb(page, 500, 820, 580, 900)
  const outside = await rgb(page, ...GRAY)
  check('layer mask: top only inside the shape', near(inside, [0, 0, 255], 6) && near(outside, [128, 128, 128]), `inside ${JSON.stringify(inside)} · outside ${JSON.stringify(outside)}`)
  await setLayer(page, 'limit to', 'whole frame')

  // ---------- reorder: drag the top layer below the base ----------
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#layers .layer-row')
    const dt = new DataTransfer()
    const r = rows[1].getBoundingClientRect()
    const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.bottom - 3 }
    rows[0].dispatchEvent(new DragEvent('dragstart', o))
    rows[1].dispatchEvent(new DragEvent('dragover', o))
    rows[1].dispatchEvent(new DragEvent('drop', o))
  })
  await sleep(500)
  check('reordering puts the base image back on top', (await layerNames(page))[0] === 'Layer 1' && near(await rgb(page, ...GRAY), [128, 128, 128]), (await layerNames(page)).join(' / '))
  // back again
  await page.evaluate(() => {
    const rows = document.querySelectorAll('#layers .layer-row')
    const dt = new DataTransfer()
    const r = rows[1].getBoundingClientRect()
    const o = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 20, clientY: r.bottom - 3 }
    rows[0].dispatchEvent(new DragEvent('dragstart', o))
    rows[1].dispatchEvent(new DragEvent('dragover', o))
    rows[1].dispatchEvent(new DragEvent('drop', o))
  })
  await sleep(700)

  // ---------- delete + undo ----------
  await page.click('#layers .layer-row .x') // top row = Layer 2
  await sleep(800)
  check('delete removes the layer', (await layerNames(page)).length === 1 && near(await rgb(page, ...GRAY), [128, 128, 128]))
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => document.querySelectorAll('#layers .layer-row').length === 2, { timeout: 8000 })
  await sleep(1200)
  check('undo brings it back with its media', near(await rgb(page, ...GRAY), [0, 0, 255]), JSON.stringify(await rgb(page, ...GRAY)) + ' ' + (await layerNames(page)).join(' / ') + ' ' + JSON.stringify(await page.evaluate(() => window.__glitch.layers().map((l) => [l.id, l.source.name ?? l.source.fileName ?? '?', l.settings?.enabled]))))

  // ---------- save, reopen, render ----------
  await setLayer(page, 'opacity', 0.5)
  await sleep(600)
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 15000 })
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  run = await launch({ GLITCH_PROJECT: SAVE })
  page = run.page
  await page.waitForFunction(() => document.querySelector('#projName').textContent === 'two layers' && document.querySelectorAll('#layers .layer-row').length === 2, { timeout: 20000 })
  await sleep(1500)
  check('project reopens with both layers + opacity', near(await rgb(page, ...GRAY), [64, 64, 192]), `${(await layerNames(page)).join(' / ')} · ${JSON.stringify(await rgb(page, ...GRAY))}`)
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  // Offline render of the two-layer project, read back with ffmpeg.
  run = await launch({ GLITCH_PROJECT: SAVE, GLITCH_RENDER: OUT, GLITCH_RENDER_SPEC: JSON.stringify({ duration: 1, includeAudio: false }) })
  await Promise.race([run.exited, sleep(90000)])
  await run.browser.disconnect().catch(() => {})
  const ff = require('ffmpeg-static')
  const px = spawnSync(ff, ['-v', 'error', '-i', OUT, '-vf', 'select=eq(n\\,10),crop=100:100:900:200,scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1e6 }).stdout
  const got = px ? [...px.subarray(0, 3)] : []
  check('render matches the preview blend', got.length === 3 && near(got, [64, 64, 192], 6), JSON.stringify(got))
} catch (err) {
  check('layers flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
