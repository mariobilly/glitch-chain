// Beat sync step 4: beat/bar grid on the timeline, snapping (playhead, key drag, new keys), [ ] beat jumps.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'
import { drumTrack } from './lib/drums.mjs'

const require = createRequire(import.meta.url)
const WORK = join(tmpdir(), 'glitch-chain-e2e-grid')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const MUSIC = join(WORK, 'beat100.wav')
drumTrack(MUSIC, { bpm: 100, bars: 4, lead: 0.3, pattern: 'rock', seed: 8 })
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const LABEL_W = 180

const app = spawn(require('electron'), ['.', '--remote-debugging-port=9960'], {
  cwd: new URL('..', import.meta.url),
  stdio: 'ignore',
  env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_MUSIC: MUSIC }
})
let browser, page
for (let i = 0; i < 60 && !browser; i++) {
  try {
    browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9960', defaultViewport: null })
  } catch {
    await sleep(300)
  }
}
for (let i = 0; i < 60 && !page; i++) {
  page = (await browser.pages()).find((x) => x.url().includes('index.html'))
  if (!page) await sleep(250)
}

try {
  await page.waitForFunction(() => window.__glitch?.audio?.()?.bpm > 0, { timeout: 60000 })
  await page.click('#play') // pause so the playhead stays where we put it
  await sleep(300)
  if (await page.evaluate(() => document.querySelector('#play').textContent.includes('❚'))) await page.click('#play')
  const a = await page.evaluate(() => {
    const x = window.__glitch.audio()
    return { beats: x.beats, downbeats: x.downbeats, bpm: x.bpm }
  })
  const box = await (await page.$('#timeline canvas')).boundingBox()
  const dur = Number(await page.$eval('#dur', (e) => e.value))
  const xOf = (t) => box.x + LABEL_W + (t / dur) * (box.width - LABEL_W - 12)
  const tNow = () => page.evaluate(() => window.__glitch.t())

  // ---------- grid drawn ----------
  check('snap is on by default', await page.$eval('#beatSnap', (b) => b.classList.contains('active')))
  const col = (t, yCss) =>
    page.evaluate(
      (x, y) => {
        const c = document.querySelector('#timeline canvas')
        const r = c.getBoundingClientRect()
        const dpr = c.width / r.width
        const d = c.getContext('2d').getImageData(Math.round((x - r.x) * dpr), Math.round(y * dpr), 1, 1).data
        // Colour weighted by opacity (lines are translucent over a transparent area when there are no key rows).
        return Math.round(((d[0] + d[1] + d[2]) * d[3]) / 255)
      },
      xOf(t),
      yCss
    )
  // Row area below the audio lane (y = ruler 20 + audio 44 + half a row), right of the empty-timeline hint text.
  const barX = a.downbeats[3]
  const beatX = a.beats.find((b) => b > barX + 0.1)
  const between = (barX + beatX) / 2
  const [onBar, onBeat, off] = [await col(barX, 74), await col(beatX, 74), await col(between, 74)]
  check('bar lines stronger than beat lines, both visible over the background', onBar > onBeat && onBeat > off, `bar ${onBar} · beat ${onBeat} · between ${off}`)
  await page.screenshot({ path: join(WORK, 'timeline.png'), clip: { x: box.x, y: box.y - 40, width: box.width, height: box.height + 40 } })

  // ---------- playhead snapping ----------
  const target = a.beats[5]
  await page.mouse.click(xOf(target) + 5, box.y + 8)
  await sleep(150)
  const t1 = await tNow()
  check('clicking near a beat snaps the playhead onto it', Math.abs(t1 - target) < 1e-6, `clicked ${((5 / (box.width - LABEL_W - 12)) * dur * 1000).toFixed(0)} ms off · playhead at ${t1.toFixed(4)} · beat ${target.toFixed(4)}`)
  await page.keyboard.down('Shift')
  await page.mouse.click(xOf(target) + 5, box.y + 8)
  await page.keyboard.up('Shift')
  await sleep(150)
  const t2 = await tNow()
  check('Shift-click places freely', Math.abs(t2 - target) > 0.01, `playhead ${t2.toFixed(4)}`)

  // ---------- [ and ] jump between beats ----------
  await page.mouse.click(xOf(a.beats[3]) + 1, box.y + 8)
  await page.keyboard.press(']')
  await sleep(100)
  const n1 = await tNow()
  await page.keyboard.press(']')
  await sleep(100)
  const n2 = await tNow()
  await page.keyboard.press('[')
  await sleep(100)
  const p1 = await tNow()
  check('] / [ jump to next / previous beat', Math.abs(n1 - a.beats[4]) < 1e-6 && Math.abs(n2 - a.beats[5]) < 1e-6 && Math.abs(p1 - a.beats[4]) < 1e-6, [n1, n2, p1].map((v) => v.toFixed(3)).join(' → '))

  // ---------- keyframes snap ----------
  await page.evaluate(() => {
    const inst = window.__glitch.state().chain[0]
    const key = Object.keys(inst.params).find((k) => typeof inst.params[k] === 'number')
    inst.keys[key] = [{ t: 1.0, v: inst.params[key], ease: 'ease' }, { t: 6.0, v: inst.params[key], ease: 'ease' }]
    window.__glitch.timeline.draw()
  })
  await sleep(200)
  const box2 = await (await page.$('#timeline canvas')).boundingBox()
  const rowY = box2.y + 20 + 44 + 10
  const keyT = () => page.evaluate(() => { const inst = window.__glitch.state().chain[0]; return Object.values(inst.keys)[0].map((k) => k.t) })
  const dragTo = async (fromT, toX, shift) => {
    await page.mouse.move(xOf(fromT), rowY)
    await page.mouse.down()
    if (shift) await page.keyboard.down('Shift')
    await page.mouse.move(toX, rowY, { steps: 6 })
    await page.mouse.up()
    if (shift) await page.keyboard.up('Shift')
    await sleep(150)
  }
  const bar2 = a.downbeats[2]
  await dragTo(1.0, xOf(bar2) - 6, false)
  let ks = await keyT()
  check('dragging a keyframe near a bar snaps it exactly onto the bar', ks.some((t) => Math.abs(t - bar2) < 1e-6), `keys at ${ks.map((t) => t.toFixed(4)).join(', ')} · bar ${bar2.toFixed(4)}`)
  await dragTo(bar2, xOf(bar2) + 20, true)
  ks = await keyT()
  check('Shift-drag moves a keyframe freely', !ks.some((t) => a.beats.some((b) => Math.abs(t - b) < 1e-6) && Math.abs(t - 6) > 1e-6), ks.map((t) => t.toFixed(4)).join(', '))
  const b9 = a.beats[9]
  await page.mouse.click(xOf(b9) + 4, rowY, { count: 2 })
  await sleep(200)
  ks = await keyT()
  check('double-click adds a keyframe snapped onto the beat', ks.some((t) => Math.abs(t - b9) < 1e-6), `keys ${ks.map((t) => t.toFixed(3)).join(', ')} · beat ${b9.toFixed(3)}`)

  // ---------- snap off ----------
  await page.click('#beatSnap')
  await page.mouse.click(xOf(target) + 5, box.y + 8)
  await sleep(150)
  const t3 = await tNow()
  check('with Snap off, clicks are not snapped', Math.abs(t3 - target) > 0.01 && !(await page.$eval('#beatSnap', (b) => b.classList.contains('active'))), `playhead ${t3.toFixed(4)}`)
} catch (err) {
  check('grid flow', false, err.stack)
}
await browser?.disconnect().catch(() => {})
app.kill()
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
