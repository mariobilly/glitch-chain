// LUT + film grain e2e. FINISH_TEST_IMAGE = test_pose.jpg (a normal colour photo).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const IMG = process.env.FINISH_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('FINISH_TEST_IMAGE must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-finish')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

// A 17-point .cube that swaps red and blue, with a comment and a TITLE line like real exports.
const CUBE = join(WORK, 'swap_rb.cube')
{
  const n = 17
  const rows = ['# test LUT', 'TITLE "swap red/blue"', `LUT_3D_SIZE ${n}`, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(`${(b / (n - 1)).toFixed(6)} ${(g / (n - 1)).toFixed(6)} ${(r / (n - 1)).toFixed(6)}`)
  writeFileSync(CUBE, rows.join('\n'))
}

const app = spawn(require('electron'), ['.', '--remote-debugging-port=9871'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
  env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_LOAD: IMG }
})
let browser, page
for (let i = 0; i < 60 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9871', defaultViewport: null })
  } catch {
    await sleep(300)
  }
}
for (let i = 0; i < 60 && !page; i++) {
  page = (await browser.pages()).find((x) => x.url().includes('index.html'))
  if (!page) await sleep(250)
}
/** Whole-frame RGBA from the output canvas, downsampled 4x for speed. */
const frame = () =>
  page.evaluate(() => {
    const c = window.__glitch.pipeline.toCanvas()
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height)
    const out = []
    for (let y = 0; y < d.height; y += 4) for (let x = 0; x < d.width; x += 4) { const i = (y * d.width + x) * 4; out.push(d.data[i], d.data[i + 1], d.data[i + 2]) }
    return out
  })
const set = (params) => page.evaluate((p) => Object.assign(window.__glitch.state().chain.at(-1).params, p), params)
const clear = () => page.evaluate(() => window.__glitch.state().chain.splice(0))
const stats = (px) => {
  let r = 0, g = 0, b = 0, sat = 0
  const n = px.length / 3
  for (let i = 0; i < px.length; i += 3) {
    r += px[i]; g += px[i + 1]; b += px[i + 2]
    sat += Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2])
  }
  return { r: r / n, g: g / n, b: b / n, sat: sat / n }
}
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length

try {
  await page.waitForSelector('.card:not(.layer-card)')
  await clear()
  // The source panel starts in b&w for the default look; grade tests need the photo's real colour.
  await page.evaluate(() => Object.assign(window.__glitch.state().source, { gray: 0, contrast: 1 }))
  await sleep(600)
  const orig = await frame()
  const o = stats(orig)

  // ---------- built-in looks ----------
  await page.evaluate(() => window.__glitch.add('lut', { look: 'Noir' }))
  await sleep(600)
  const noir = stats(await frame())
  check('Noir look removes colour', noir.sat < o.sat * 0.25, `saturation ${o.sat.toFixed(1)} → ${noir.sat.toFixed(1)}`)
  await set({ look: 'Teal & Orange' })
  await sleep(600)
  const to = await frame()
  check('Teal & Orange changes the grade', diff(to, orig) > 4, `mean change ${diff(to, orig).toFixed(1)}`)
  await set({ intensity: 0 })
  await sleep(400)
  check('intensity 0 = untouched', diff(await frame(), orig) < 1.5, `mean change ${diff(await frame(), orig).toFixed(2)}`)

  // ---------- custom .cube file ----------
  await clear()
  await page.evaluate((f) => window.__glitch.add('lut', { look: 'custom', file: f }), CUBE)
  await sleep(1200)
  const sw = await frame()
  let err = 0
  for (let i = 0; i < orig.length; i += 3) err += Math.abs(sw[i] - orig[i + 2]) + Math.abs(sw[i + 2] - orig[i]) + Math.abs(sw[i + 1] - orig[i + 1])
  err /= orig.length
  check('.cube file loads and applies exactly (red/blue swap)', err < 3, `per-channel error ${err.toFixed(2)} (red ${o.r.toFixed(0)}→blue, blue ${o.b.toFixed(0)}→red)`)
  const btn = await page.evaluate(() => [...document.querySelectorAll('.card:not(.layer-card) .tp-btnv_b')].map((b) => b.textContent.trim()))
  check('file button shows the chosen file name', btn.includes('swap_rb.cube'), btn.join(', '))

  // ---------- film grain ----------
  await clear()
  await page.evaluate(() => window.__glitch.add('filmGrain', { amount: 0.6, vignette: 0, fps: 24 }))
  await sleep(500)
  const g1 = await frame()
  await sleep(300)
  const g2 = await frame()
  check('grain adds texture', diff(g1, orig) > 2, `mean change ${diff(g1, orig).toFixed(1)}`)
  check('grain pattern changes over time', diff(g1, g2) > 2, `frame-to-frame ${diff(g1, g2).toFixed(1)}`)
  // Grain strength by brightness: midtones should get more than deep shadows / highlights.
  const bucket = { mid: [0, 0], ext: [0, 0] }
  for (let i = 0; i < orig.length; i += 3) {
    const l = 0.299 * orig[i] + 0.587 * orig[i + 1] + 0.114 * orig[i + 2]
    const d = Math.abs(g1[i + 1] - orig[i + 1])
    const k = l > 100 && l < 155 ? 'mid' : l < 35 || l > 225 ? 'ext' : null
    if (k) { bucket[k][0] += d; bucket[k][1]++ }
  }
  const mid = bucket.mid[0] / bucket.mid[1]
  const ext = bucket.ext[0] / Math.max(1, bucket.ext[1])
  check('grain is strongest in the midtones (film response)', mid > ext * 1.3, `midtones ${mid.toFixed(1)} vs shadows/highlights ${ext.toFixed(1)} (${bucket.ext[1]} px)`)
  await set({ fps: 0 })
  await sleep(300)
  const s1 = await frame()
  await sleep(300)
  check('grain rate 0 freezes the pattern', diff(s1, await frame()) < 0.5)
  await set({ amount: 0, vignette: 0.8 })
  await sleep(300)
  const v = await frame()
  // Brightness ratio edge/centre along the middle row: the vignette should pull the edges down vs the centre.
  const W = await page.evaluate(() => Math.ceil(window.__glitch.pipeline.toCanvas().width / 4))
  const H = v.length / 3 / W
  const lum = (px, x, y) => { const i = (Math.floor(y) * W + Math.floor(x)) * 3; return px[i] + px[i + 1] + px[i + 2] }
  const ratio = (px) => {
    let e = 0, c = 0
    for (let y = H * 0.1; y < H * 0.9; y += 4) { e += lum(px, 1, y) + lum(px, W - 2, y); c += 2 * lum(px, W / 2, y) }
    return e / c
  }
  check('vignette darkens the edges', ratio(v) < ratio(orig) * 0.75, `edge/centre ${ratio(orig).toFixed(2)} → ${ratio(v).toFixed(2)}`)
} catch (e) {
  check('finish flow', false, e.stack)
}
app.kill()
await browser?.disconnect().catch(() => {})
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
