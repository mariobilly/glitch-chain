// Mask tools e2e on a synthetic image (1080x1920: red circle @ (300,500) r150, green square 600-900 x 1200-1500).
// The chain is one strong "darken" effect; each check measures which regions went dark in the real output.
// Usage: MASK_TEST_IMAGE=<shapes_test.png> [OBJECT_TEST_IMAGE=<photo with a bicycle>] node tests/masks.e2e.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const IMG = process.env.MASK_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('MASK_TEST_IMAGE must be the synthetic shapes image')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

async function launch(load, port) {
  const USER_DATA = join(tmpdir(), `glitch-chain-e2e-masks-${port}`)
  rmSync(USER_DATA, { recursive: true, force: true })
  mkdirSync(join(USER_DATA, 'presets'), { recursive: true })
  writeFileSync(join(USER_DATA, 'presets', 'T_dark.json'), JSON.stringify({ name: 'T_dark', chain: [{ effectId: 'grade', params: { exposure: -3 } }] }))
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
  await page.waitForSelector('.card:not(.layer-card)')
  await sleep(2500)
  await page.click('#play') // pause
  return { app, browser, page }
}

// ---- helpers over the real DOM ----
const rowByLabel = (page, label) =>
  page.evaluateHandle(
    (l) => [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.replace('◆', '').trim() === l),
    label
  )
const visible = (page, label) => page.evaluate((l) => {
  const r = [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-lblv')].find((x) => x.querySelector('.tp-lblv_l')?.textContent.replace('◆', '').trim() === l)
  return !!r && r.offsetParent !== null && getComputedStyle(r).display !== 'none'
}, label)
async function chooseMask(page, text) {
  // Open the Mask folder like a user would (controls inside a collapsed folder aren't visible).
  await page.evaluate(() => {
    const f = [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-fldv')].find((x) => x.querySelector('.tp-fldv_t')?.textContent.startsWith('Mask'))
    if (f && !f.classList.contains('tp-fldv-expanded')) f.querySelector('.tp-fldv_b').click()
  })
  await sleep(250)
  await page.evaluate((t) => {
    const row = [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'limit to')
    const sel = row.querySelector('select')
    sel.value = [...sel.options].find((o) => o.textContent === t).value
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  }, text)
  await sleep(300)
}
const clickButton = (page, title) =>
  page.evaluate((t) => [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-btnv_b')].find((b) => b.textContent.trim() === t).click(), title)
async function canvasPoint(page, u, v) {
  const b = await (await page.$('#out')).boundingBox()
  return [b.x + u * b.width, b.y + v * b.height]
}
/** Mean luma of an output-pixel rectangle (1080x1920 output). */
const luma = (page, x0, y0, x1, y1) =>
  page.evaluate(
    (r) => {
      const c = window.__glitch.pipeline.toCanvas()
      const d = c.getContext('2d').getImageData(r[0], r[1], r[2] - r[0], r[3] - r[1]).data
      let s = 0
      for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      return s / (d.length / 4)
    },
    [x0, y0, x1, y1]
  )
const CIRCLE = [260, 460, 340, 540]
const SQUARE = [700, 1300, 800, 1400]
const GRAY = [900, 200, 1000, 300]

let run = await launch(IMG, 9611)
try {
  const { page } = run
  const base = { circle: await luma(page, ...CIRCLE), square: await luma(page, ...SQUARE) }
  // Unmasked, the whole frame is darkened: confirm the effect works at all.
  check('darken effect active (unmasked)', base.circle < 35 && base.square < 35, `circle ${base.circle.toFixed(0)}, square ${base.square.toFixed(0)}`)

  // ---------- color key ----------
  await chooseMask(page, 'color key')
  check('color controls shown, shape controls hidden', (await visible(page, 'tolerance')) && !(await visible(page, 'shape x')))
  await clickButton(page, 'Pick color from preview')
  await sleep(200)
  const [px, py] = await canvasPoint(page, 300 / 1080, 500 / 1920)
  await page.mouse.click(px, py)
  await sleep(500)
  const ck = { circle: await luma(page, ...CIRCLE), square: await luma(page, ...SQUARE), gray: await luma(page, ...GRAY) }
  const keyHex = await (await rowByLabel(page, 'key color')).evaluate((r) => r.querySelector('input').value)
  check('eyedropper picks the red', /^#?(d|e|c)[0-9a-f]/i.test(keyHex.replace('0x', '#')), keyHex)
  check('color key darkens only the red circle', ck.circle < 35 && ck.square > 80 && ck.gray > 80, `circle ${ck.circle.toFixed(0)} · square ${ck.square.toFixed(0)} · gray ${ck.gray.toFixed(0)}`)

  // ---------- shape: drag onto the circle, resize ----------
  await chooseMask(page, 'shape (drag on preview)')
  await clickButton(page, 'Edit shape on preview')
  await sleep(300)
  const [sx, sy] = await canvasPoint(page, 0.5, 0.45)
  const [tx, ty] = await canvasPoint(page, 300 / 1080, 500 / 1920)
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  await page.mouse.move(tx, ty, { steps: 10 })
  await page.mouse.up()
  await sleep(200)
  // Corner handle sits at center + (w/2, h/2) = (0.278 + 0.25, 0.26 + 0.15): pull it in to ~0.2 x 0.1.
  const [cx0, cy0] = await canvasPoint(page, 300 / 1080 + 0.25, 500 / 1920 + 0.15)
  const [cx1, cy1] = await canvasPoint(page, 300 / 1080 + 0.1, 500 / 1920 + 0.05)
  await page.mouse.move(cx0, cy0)
  await page.mouse.down()
  await page.mouse.move(cx1, cy1, { steps: 10 })
  await page.mouse.up()
  await sleep(400)
  const shapeX = Number(await (await rowByLabel(page, 'shape x')).evaluate((r) => r.querySelector('input').value))
  const shapeW = Number(await (await rowByLabel(page, 'shape width')).evaluate((r) => r.querySelector('input').value))
  check('dragging moves and resizes the shape', Math.abs(shapeX - 300 / 1080) < 0.02 && Math.abs(shapeW - 0.2) < 0.03, `x ${shapeX} · width ${shapeW}`)
  const sh = { circle: await luma(page, ...CIRCLE), square: await luma(page, ...SQUARE) }
  check('shape mask darkens only inside the shape', sh.circle < 30 && sh.square > 80, `circle ${sh.circle.toFixed(0)} · square ${sh.square.toFixed(0)}`)
  // Auto-key: a drag at 1 s makes the shape position keyframed.
  await page.click('#autokey')
  const tl = await (await page.$('#timeline canvas')).boundingBox()
  const dur = Number(await page.$eval('#dur', (e) => e.value))
  await page.mouse.click(tl.x + 180 + (1 / dur) * (tl.width - 192), tl.y + 8)
  await sleep(200)
  await page.mouse.move(tx, ty)
  await page.mouse.down()
  await page.mouse.move(tx + 20, ty + 10, { steps: 5 })
  await page.mouse.up()
  await page.click('#autokey')
  await sleep(300)
  const keyed = await (await rowByLabel(page, 'shape x')).evaluate((r) => r.querySelector('.tp-lblv_l').textContent.trim())
  check('auto-key records shape moves', keyed.startsWith('◆'), keyed)
  await page.click('.mask-bar button') // Done

  // ---------- lasso around the square ----------
  await chooseMask(page, 'drawn (lasso)')
  await clickButton(page, 'Draw on preview')
  await sleep(300)
  const corners = [[590, 1190], [910, 1190], [910, 1510], [590, 1510], [590, 1195]]
  const [ax, ay] = await canvasPoint(page, corners[0][0] / 1080, corners[0][1] / 1920)
  await page.mouse.move(ax, ay)
  await page.mouse.down()
  for (const [x, y] of corners.slice(1)) {
    const [qx, qy] = await canvasPoint(page, x / 1080, y / 1920)
    await page.mouse.move(qx, qy, { steps: 12 })
  }
  await page.mouse.up()
  await page.click('.mask-bar button')
  await sleep(500)
  const dr = { circle: await luma(page, ...CIRCLE), square: await luma(page, ...SQUARE) }
  check('lasso mask darkens only the drawn area', dr.square < 30 && dr.circle > 60, `square ${dr.square.toFixed(0)} · circle ${dr.circle.toFixed(0)}`)
} catch (err) {
  check('mask tools run', false, err.stack)
} finally {
  await run.browser?.disconnect()
  run.app.kill()
}

// ---------- in-app object detection on a real photo ----------
if (process.env.OBJECT_TEST_IMAGE) {
  run = await launch(process.env.OBJECT_TEST_IMAGE, 9612)
  try {
    const { page } = run
    await chooseMask(page, 'object (auto-detect)')
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'object')
      const sel = row.querySelector('select')
      sel.value = [...sel.options].find((o) => o.textContent === 'bicycle').value
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await page.waitForFunction(() => /\d+ objects?/.test(document.querySelector('#fps').textContent) && window.__glitch.tracker.objects.length > 0, { timeout: 30000 }).catch(() => {})
    const labels = await page.evaluate(() => window.__glitch.tracker.objects.map((o) => `${o.label} ${o.score.toFixed(2)}`))
    check('detector finds the bicycle', labels.some((l) => l.startsWith('bicycle')), labels.join(', '))
    // Measure in source pixels (output = source size), effect on vs off: only the bike box should change.
    await page.select('#output', 'Match source')
    await sleep(800)
    const measure = () =>
      page.evaluate(() => {
        const g = window.__glitch
        const b = g.tracker.objects.find((o) => o.label === 'bicycle')
        const c = g.pipeline.toCanvas()
        const ctx = c.getContext('2d')
        const L = (x, y, w, h) => {
          const d = ctx.getImageData(Math.round(x), Math.round(y), w, h).data
          let s = 0
          for (let i = 0; i < d.length; i += 4) s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
          return s / (d.length / 4)
        }
        return { inside: L(b.x + b.w * 0.3, b.y + b.h * 0.3, 40, 40), outside: L(c.width - 120, 60, 60, 60) }
      })
    const on = await measure()
    await page.evaluate(() => document.querySelector('.card:not(.layer-card) .toggle input').click())
    await sleep(500)
    const off = await measure()
    check(
      'object mask darkens only the bicycle',
      on.inside < off.inside * 0.4 && Math.abs(on.outside - off.outside) < 6,
      `inside ${off.inside.toFixed(0)}→${on.inside.toFixed(0)} · outside ${off.outside.toFixed(0)}→${on.outside.toFixed(0)}`
    )
    await page.screenshot({ path: join(process.env.SHOT_DIR ?? tmpdir(), 'e2e_object_mask.png') })
  } catch (err) {
    check('object detection runs', false, err.stack)
  } finally {
    await run.browser?.disconnect()
    run.app.kill()
  }
}

const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
