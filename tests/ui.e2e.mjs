// End-to-end UI test: launches the built app with remote debugging and drives it with real mouse/keyboard
// input via puppeteer-core. Run `npm run build` first, then `npm run test:e2e`.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const electronPath = require('electron')
const PORT = 9333
const SHOT_DIR = process.env.SHOT_DIR || '.'

// Throwaway profile: tests must never touch the user's real presets or saved settings.
const USER_DATA = join(tmpdir(), 'glitch-chain-e2e')
rmSync(USER_DATA, { recursive: true, force: true })
const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
  env: { ...process.env, GLITCH_USER_DATA: USER_DATA }
})
let browser
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

try {
  for (let i = 0; i < 50 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
    } catch {
      await sleep(300)
    }
  }
  const page = (await browser.pages()).find((p) => p.url().includes('index.html')) ?? (await browser.pages())[0]
  await page.waitForSelector('.card:not(.layer-card) .tp-sldv_t')
  await sleep(800)

  // --- helpers (all reads go through the real DOM) ---
  const row = (card, label) =>
    page.evaluateHandle(
      (c, l) =>
        [...document.querySelectorAll('.card:not(.layer-card)')[c].querySelectorAll('.tp-lblv')].find(
          (r) => r.querySelector('.tp-lblv_l')?.textContent.replace('◆', '').trim() === l
        ),
      card,
      label
    )
  const value = async (card, label) => Number(await (await row(card, label)).evaluate((r) => r.querySelector('input').value))
  const labelText = async (card, label) => (await row(card, label)).evaluate((r) => r.querySelector('.tp-lblv_l').textContent.trim())
  const dragSlider = async (card, label, frac) => {
    const track = await (await row(card, label)).evaluateHandle((r) => r.querySelector('.tp-sldv_t'))
    const b = await track.boundingBox()
    await page.mouse.move(b.x + 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * frac, b.y + b.height / 2, { steps: 8 })
    await page.mouse.up()
  }
  const cardNames = () => page.$$eval('.card:not(.layer-card) .name', (els) => els.map((e) => e.textContent))
  const settle = () => sleep(700) // history commits after 350 ms of stability, polled every ~250 ms
  const tl = async () => {
    const c = await page.$('#timeline canvas')
    const b = await c.boundingBox()
    const dur = Number(await page.$eval('#dur', (e) => e.value))
    return { b, dur, x: (t) => b.x + 180 + (t / dur) * (b.width - 180 - 12), rowY: (r) => b.y + 20 + 44 + r * 20 + 10 }
  }
  const seek = async (t) => {
    const { x, b } = await tl()
    await page.mouse.click(x(t), b.y + 8)
    await sleep(120)
  }

  // pause playback so values are stable
  await page.click('#play')
  await sleep(200)

  // ---------- undo / redo of a slider drag ----------
  const before = await value(0, 'amount')
  await dragSlider(0, 'amount', 0.2)
  await settle()
  const after = await value(0, 'amount')
  check('slider drag changes value', Math.abs(after - before) > 0.05, `${before} → ${after}`)
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  await sleep(300)
  check('Ctrl+Z restores slider', Math.abs((await value(0, 'amount')) - before) < 0.006, String(await value(0, 'amount')))
  await page.keyboard.down('Control')
  await page.keyboard.down('Shift')
  await page.keyboard.press('z')
  await page.keyboard.up('Shift')
  await page.keyboard.up('Control')
  await sleep(300)
  check('Ctrl+Shift+Z redoes', Math.abs((await value(0, 'amount')) - after) < 0.006, String(await value(0, 'amount')))

  // ---------- auto-key ----------
  await page.click('#autokey')
  await seek(1)
  await dragSlider(0, 'amount', 0.1)
  const v1 = await value(0, 'amount')
  await seek(3)
  await dragSlider(0, 'amount', 0.9)
  const v3 = await value(0, 'amount')
  await page.click('#autokey')
  await settle()
  check('auto-key marks param ◆', (await labelText(0, 'amount')).startsWith('◆'), await labelText(0, 'amount'))
  await seek(1)
  const r1 = await value(0, 'amount')
  await seek(2)
  const r2 = await value(0, 'amount')
  check('keys interpolate on seek', Math.abs(r1 - v1) < 0.02 && r2 > r1 && r2 < v3, `t1=${r1.toFixed(3)} t2=${r2.toFixed(3)} (keys ${v1.toFixed(3)} → ${v3.toFixed(3)})`)

  // ---------- drag a key in the timeline ----------
  let T = await tl()
  await page.mouse.move(T.x(3), T.rowY(0))
  await page.mouse.down()
  await page.mouse.move(T.x(2), T.rowY(0), { steps: 6 })
  await page.mouse.up()
  await seek(2)
  check('dragging key moves it in time', Math.abs((await value(0, 'amount')) - v3) < 0.02, `value at 2s = ${(await value(0, 'amount')).toFixed(3)}`)

  // ---------- right-click cycles easing (ease → hold) ----------
  T = await tl()
  await page.mouse.click(T.x(1), T.rowY(0), { button: 'right' })
  await seek(1.5)
  check('right-click sets hold easing', Math.abs((await value(0, 'amount')) - v1) < 0.02, `value at 1.5s = ${(await value(0, 'amount')).toFixed(3)}`)

  // ---------- delete keys ----------
  for (const t of [2, 1]) {
    T = await tl()
    await page.mouse.click(T.x(t), T.rowY(0))
    await page.keyboard.press('Delete')
    await sleep(100)
  }
  check('Delete removes keys (◆ cleared)', !(await labelText(0, 'amount')).startsWith('◆'), await labelText(0, 'amount'))

  // ---------- reorder by drag, then undo ----------
  await settle()
  const order0 = await cardNames()
  // Native DnD can't be started by CDP mouse input without interception, so dispatch the drag events
  // the card handlers listen for (dragstart on the grip row, dragover/drop on the target card).
  await page.evaluate(() => {
    const dt = new DataTransfer()
    const head = document.querySelectorAll('.card:not(.layer-card) .card-head')[0]
    const target = document.querySelectorAll('.card:not(.layer-card)')[2]
    const r = target.getBoundingClientRect()
    const opts = { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.x + 40, clientY: r.bottom - 6 }
    head.dispatchEvent(new DragEvent('dragstart', opts))
    target.dispatchEvent(new DragEvent('dragover', opts))
    target.dispatchEvent(new DragEvent('drop', opts))
    head.dispatchEvent(new DragEvent('dragend', opts))
  })
  await sleep(300)
  const order1 = await cardNames()
  check('drag card reorders chain', order1[0] !== order0[0], `${order0.slice(0, 3).join(' | ')}  →  ${order1.slice(0, 3).join(' | ')}`)
  await settle()
  await page.keyboard.down('Control')
  await page.keyboard.press('z')
  await page.keyboard.up('Control')
  await sleep(300)
  check('undo reorder', (await cardNames()).join() === order0.join())

  // ---------- compare ----------
  await page.click('#compare')
  const cv = await (await page.$('#out')).boundingBox()
  await page.mouse.click(cv.x + cv.width * 0.3, cv.y + cv.height / 2)
  await sleep(200)
  check('compare toggles on', await page.$eval('#compare', (e) => e.classList.contains('active')))
  await page.screenshot({ path: `${SHOT_DIR}/e2e_compare.png` })
  await page.click('#compare')

  // ---------- preset browser ----------
  await page.click('#browse')
  await page.waitForSelector('.preset-card')
  await page.waitForFunction(() => [...document.querySelectorAll('.preset-card .thumb')].every((t) => t.querySelector('canvas')), { timeout: 10000 })
  const n = await page.$$eval('.preset-card canvas', (c) => c.length)
  check('browser renders all thumbnails', n >= 5, `${n} thumbnails`)
  await page.screenshot({ path: `${SHOT_DIR}/e2e_browser.png` })
  const cards = await page.$$('.preset-card')
  for (const c of cards) if ((await c.evaluate((e) => e.title)) === 'Tape Rot') await c.click()
  await sleep(300)
  check('picking a thumbnail applies preset', (await page.$eval('#presets', (e) => e.value)) === 'Tape Rot' && (await cardNames())[0] === 'Tape Rot')

  // ---------- face mask preset loads the face model and reports status ----------
  await page.select('#presets', 'Face Tear')
  await page.waitForFunction(() => /face/.test(document.querySelector('#fps').textContent), { timeout: 15000 }).catch(() => {})
  check('Face Tear preset: mask UI + face status', /Mask: face/.test(await page.$eval('.card:not(.layer-card)', (c) => c.textContent)) && /face/.test(await page.$eval('#fps', (e) => e.textContent)), await page.$eval('#fps', (e) => e.textContent))

  // ---------- mask menu offers the limb sources ----------
  const opts = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-lblv')].find((r) => r.querySelector('.tp-lblv_l')?.textContent.trim() === 'limit to')
    return [...row.querySelector('select').options].map((o) => o.textContent)
  })
  check('mask sources include hands/fingers/legs', ['hands', 'fingers only', 'legs'].every((o) => opts.includes(o)), opts.join(', '))

  // ---------- camera: either becomes the source or reports why not (never throws) ----------
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.click('#camera')
  await sleep(2500)
  const camName = await page.$eval('#srcName', (e) => e.textContent)
  const camToast = await page.evaluate(() => document.querySelector('.toast')?.textContent ?? '')
  check('camera button handled', !errs.length && (camName !== '' || /Camera unavailable/.test(camToast)), camName || camToast)
} catch (err) {
  check('test run', false, err.stack)
} finally {
  await browser?.disconnect()
  app.kill()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
