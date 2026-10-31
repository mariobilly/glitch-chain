// Depth e2e on the children photo (kids + bike in front of a wooden wall). Output 9:16 cover of 960x1008.
// DEPTH_TEST_IMAGE = test_pose.jpg
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const IMG = process.env.DEPTH_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('DEPTH_TEST_IMAGE must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-depth')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9820
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_LOAD: IMG, ...env }
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
  await page.waitForSelector('.card:not(.layer-card)')
  return { app, browser, page, exited }
}
// Output-pixel regions (1080x1920): wall top-left, boy's face, bottom ground.
const WALL = [60, 150, 360, 500]
const FACE = [500, 640, 600, 740]
/** Sharpness = mean absolute difference between neighbouring pixels (luma). */
const sharp = (page, r) =>
  page.evaluate((b) => {
    const d = window.__glitch.pipeline.toCanvas().getContext('2d').getImageData(b[0], b[1], b[2] - b[0], b[3] - b[1])
    const w = d.width
    const L = (i) => 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2]
    let s = 0, n = 0
    for (let y = 0; y < d.height - 1; y++)
      for (let x = 0; x < w - 1; x++) {
        const i = (y * w + x) * 4
        s += Math.abs(L(i) - L(i + 4)) + Math.abs(L(i) - L(i + w * 4))
        n++
      }
    return s / n
  }, r)
const pixels = (page, r) => page.evaluate((b) => [...window.__glitch.pipeline.toCanvas().getContext('2d').getImageData(b[0], b[1], b[2] - b[0], b[3] - b[1]).data], r)
const meanDiff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length
const toggleCard = (page, n) => page.evaluate((k) => document.querySelectorAll('.card:not(.layer-card) .toggle input')[k].click(), n)
const waitDepth = (page) => page.waitForFunction(() => window.__glitch.layers()[0].depth.has, { timeout: 60000 })

try {
  // ---------- focus picked on the boy's face ----------
  let run = await launch({ GLITCH_PRESET: 'Portrait Focus' })
  let { page } = run
  await page.click('#play')
  await waitDepth(page)
  await sleep(800)
  await page.evaluate(() => [...document.querySelectorAll('.card:not(.layer-card)')[0].querySelectorAll('.tp-btnv_b')].find((b) => b.textContent.trim() === 'Pick focus on preview').click())
  await sleep(200)
  const box = await (await page.$('#out')).boundingBox()
  await page.mouse.click(box.x + (550 / 1080) * box.width, box.y + (690 / 1920) * box.height)
  await sleep(1200)
  const focus = await page.evaluate(() => window.__glitch.state().chain[0].params.focus)
  const on = { wall: await sharp(page, WALL), face: await sharp(page, FACE) }
  await toggleCard(page, 0)
  await sleep(500)
  const off = { wall: await sharp(page, WALL), face: await sharp(page, FACE) }
  const keptFace = on.face / off.face
  const keptWall = on.wall / off.wall
  check('clicking the face sets focus there', typeof focus === 'number' && focus > 0.3 && focus < 1, `focus ${focus}`)
  check('subject stays sharp, background blurs', keptFace > 0.8 && keptWall < 0.5, `face ${Math.round(keptFace * 100)}% sharp · wall ${Math.round(keptWall * 100)}% sharp`)
  await toggleCard(page, 0)
  // Save a project-free render of this look: offline render uses depth frame-exactly.
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  // ---------- depth mask: glitch only the far wall ----------
  run = await launch({ GLITCH_PRESET: 'Foggy Background Tear' })
  page = run.page
  await page.click('#play')
  await waitDepth(page)
  await sleep(800)
  const withG = { wall: await pixels(page, WALL), face: await pixels(page, FACE) }
  await toggleCard(page, 0)
  await sleep(500)
  const noG = { wall: await pixels(page, WALL), face: await pixels(page, FACE) }
  const dw = meanDiff(withG.wall, noG.wall)
  const df = meanDiff(withG.face, noG.face)
  check('depth mask: background glitched, subject untouched', dw > 3 && df < dw / 2.5, `wall changed ${dw.toFixed(1)} · face changed ${df.toFixed(1)}`)
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  // ---------- parallax animates ----------
  run = await launch({ GLITCH_PRESET: '2.5D Parallax' })
  page = run.page
  await page.click('#play')
  await waitDepth(page)
  const seek = async (t) => {
    const c = await (await page.$('#timeline canvas')).boundingBox()
    const dur = Number(await page.$eval('#dur', (e) => e.value))
    await page.mouse.click(c.x + 180 + (t / dur) * (c.width - 192), c.y + 8)
    await sleep(400)
  }
  await seek(0.5)
  const a = await pixels(page, [300, 1400, 700, 1700])
  await seek(1.5)
  const b = await pixels(page, [300, 1400, 700, 1700])
  check('2.5D parallax moves the image over time', meanDiff(a, b) > 3, `frame change ${meanDiff(a, b).toFixed(1)}`)
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  // ---------- offline render uses depth ----------
  const OUT = join(WORK, 'focus.mp4')
  run = await launch({ GLITCH_PRESET: 'Portrait Focus', GLITCH_RENDER: OUT, GLITCH_RENDER_SPEC: JSON.stringify({ duration: 0.5, includeAudio: false }) })
  await Promise.race([run.exited, sleep(90000)])
  await run.browser.disconnect().catch(() => {})
  const ff = require('ffmpeg-static')
  const frame = (file) =>
    spawnSync(ff, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,5),crop=${WALL[2] - WALL[0]}:${WALL[3] - WALL[1]}:${WALL[0]}:${WALL[1]}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1e7 }).stdout
  const g = frame(OUT)
  const w = WALL[2] - WALL[0]
  let s = 0
  for (let i = 0; i < g.length - w - 1; i++) s += Math.abs(g[i] - g[i + 1]) + Math.abs(g[i] - g[i + w])
  const renderedWall = s / (g.length - w - 1)
  check('rendered video has the depth blur', g.length > 0 && renderedWall < off.wall * 0.6, `wall sharpness ${renderedWall.toFixed(1)} vs original ${off.wall.toFixed(1)}`)
} catch (err) {
  check('depth flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
