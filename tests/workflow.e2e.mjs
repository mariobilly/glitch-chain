// Workflow e2e: preset sequence, preset import by drop, render queue + social pack, editor restore.
// Needs `npm run build`. Uses GLITCH_LOAD (a source file) and GLITCH_QUEUE_DIR (skips the folder dialog).
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const PORT = 9335
const QUEUE_DIR = process.env.GLITCH_QUEUE_DIR
// Refuse to run on bad paths rather than writing somewhere unexpected; never delete the output folder.
if (!process.env.GLITCH_LOAD || !existsSync(process.env.GLITCH_LOAD)) throw new Error('GLITCH_LOAD must be an existing image/video file')
if (!QUEUE_DIR || !isAbsolute(QUEUE_DIR)) throw new Error('GLITCH_QUEUE_DIR must be an absolute path')
if (existsSync(QUEUE_DIR) && readdirSync(QUEUE_DIR).length) throw new Error(`GLITCH_QUEUE_DIR must be empty: ${QUEUE_DIR}`)
mkdirSync(QUEUE_DIR, { recursive: true })

// Throwaway profile: tests must never touch the user's real presets or saved settings.
const USER_DATA = join(tmpdir(), 'glitch-chain-e2e')
rmSync(USER_DATA, { recursive: true, force: true })
const app = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
  env: { ...process.env, GLITCH_USER_DATA: USER_DATA }
})
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let browser
try {
  for (let i = 0; i < 60 && !browser; i++) {
    try {
      browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null })
    } catch {
      await sleep(300)
    }
  }
  let page
  for (let i = 0; i < 60 && !page; i++) {
    page = (await browser.pages()).find((p) => p.url().includes('index.html'))
    if (!page) await sleep(250)
  }
  await page.waitForSelector('#sequence')
  await sleep(2500)
  await page.click('#play') // pause
  const seek = async (t) => {
    const c = await page.$('#timeline canvas')
    const b = await c.boundingBox()
    const dur = Number(await page.$eval('#dur', (e) => e.value))
    await page.mouse.click(b.x + 180 + (t / dur) * (b.width - 192), b.y + 8)
    await sleep(900) // banner refreshes every 15 frames
  }
  const banner = () => page.$eval('#seqBanner', (e) => (e.hidden ? '' : e.textContent))

  // ---------- sequence: Clean Tear -> Tape Rot every 1 s ----------
  await page.click('#sequence')
  await page.waitForSelector('.seq-box')
  await page.$eval('.seq-box [name=every]', (e) => { e.value = '1'; e.dispatchEvent(new Event('change')) })
  await page.select('.seq-box [name=mode]', 'seconds')
  await page.select('.seq-box [name=add]', 'Clean Tear')
  await page.click('.seq-box [data-a=add]')
  await page.select('.seq-box [name=add]', 'Tape Rot')
  await page.click('.seq-box [data-a=add]')
  await page.click('.seq-box .primary')
  check('sequence turns on', await page.$eval('#sequence', (e) => e.classList.contains('active')))
  await seek(0.5)
  const b1 = await banner()
  await seek(1.5)
  const b2 = await banner()
  check('cuts between presets on time', b1.includes('“Clean Tear”') && b2.includes('“Tape Rot”'), `0.5s: ${b1.match(/“(.+?)”/)?.[1]} · 1.5s: ${b2.match(/“(.+?)”/)?.[1]}`)

  // ---------- import a preset by dropping a .json file ----------
  await page.evaluate(() => {
    const preset = { name: 'Dropped Look', chain: [{ effectId: 'rgbSplit', params: { amount: 0.02 } }] }
    const dt = new DataTransfer()
    dt.items.add(new File([JSON.stringify(preset)], 'dropped.glitch.json', { type: 'application/json' }))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  })
  await sleep(800)
  const names = await page.$$eval('#presets option', (o) => o.map((x) => x.value))
  check('dropped preset file is imported', names.includes('Dropped Look'))

  // ---------- queue: social pack = 3 renders ----------
  const presetBefore = await page.$eval('#presets', (e) => e.value)
  await page.$eval('#dur', (e) => { e.value = '2'; e.dispatchEvent(new Event('change')) })
  await page.click('#render')
  await page.waitForSelector('.render-box [data-act=social]')
  await page.click('.render-box [data-act=social]')
  await sleep(300)
  check('social pack queues 3 jobs', (await page.$eval('#queue', (e) => e.textContent)).includes('(3)'), await page.$eval('#queue', (e) => e.textContent))
  await page.click('#queue')
  await page.waitForSelector('.queue-box [data-a=run]')
  await page.click('.queue-box [data-a=run]')
  const t0 = Date.now()
  await page.waitForFunction(() => document.querySelectorAll('.queue-item.done, .queue-item.failed').length === 3, { timeout: 240000, polling: 500 })
  const states = await page.$$eval('.queue-item', (els) => els.map((e) => e.className.replace('queue-item ', '')))
  check('queue renders all jobs', states.every((s) => s.startsWith('done')), `${states.join(', ')} in ${Math.round((Date.now() - t0) / 1000)}s`)
  const files = readdirSync(QUEUE_DIR)
  check('3 files written to the folder', files.length === 3, files.join(' | '))
  await sleep(1500)
  check('editor restored after queue', (await page.$eval('#presets', (e) => e.value)) === presetBefore && (await page.$eval('#sequence', (e) => e.classList.contains('active'))))
} catch (err) {
  check('test run', false, err.stack)
} finally {
  await browser?.disconnect()
  app.kill()
  const failed = results.filter((r) => !r).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}
