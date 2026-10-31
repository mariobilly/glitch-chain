// Project files e2e: save, reopen, autosave recovery after a crash, close prompt, missing media.
// PROJ_IMAGE = any photo, PROJ_MUSIC = any audio file. Everything runs in a throwaway folder + profile.
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
for (const k of ['PROJ_IMAGE', 'PROJ_MUSIC']) if (!process.env[k] || !existsSync(process.env[k])) throw new Error(`${k} must be an existing file`)
const WORK = join(tmpdir(), 'glitch-chain-e2e-project')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const PHOTO = join(WORK, 'photo.jpg')
const MUSIC = join(WORK, 'music.mp3')
copyFileSync(process.env.PROJ_IMAGE, PHOTO)
copyFileSync(process.env.PROJ_MUSIC, MUSIC)
const PROFILE = join(WORK, 'profile')
const SAVE = join(WORK, 'my look.glitch')

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

let port = 9700
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: PROFILE, GLITCH_SAVE_PATH: SAVE, GLITCH_AUTOSAVE_MS: '1500', ...env }
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
const projName = (page) => page.$eval('#projName', (e) => e.textContent)
const dialogTitle = (page) => page.evaluate(() => document.querySelector('.modal .modal-title')?.textContent ?? '')
const clickDialog = (page, label) =>
  page.evaluate((l) => [...document.querySelectorAll('.modal .modal-actions button')].find((b) => b.textContent === l).click(), label)
const firstLabel = (page) => page.evaluate(() => document.querySelector('.card:not(.layer-card) .tp-lblv_l')?.textContent.trim())
async function dragFirstSlider(page, frac) {
  const t = await page.$('.card:not(.layer-card) .tp-sldv_t')
  const b = await t.boundingBox()
  await page.mouse.move(b.x + 2, b.y + b.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width * frac, b.y + b.height / 2, { steps: 6 })
  await page.mouse.up()
}
const exitedWithin = (run, ms) => Promise.race([run.exited, sleep(ms).then(() => false)])

try {
  // ---------- 1. edit + save ----------
  let run = await launch({ GLITCH_LOAD: PHOTO, GLITCH_MUSIC: MUSIC, GLITCH_PRESET: 'Clean Tear' })
  let { page } = run
  await sleep(2500)
  await page.click('#play')
  await page.select('#output', '1:1 · 1080×1080')
  await page.click('#autokey')
  const tl = await (await page.$('#timeline canvas')).boundingBox()
  const dur = Number(await page.$eval('#dur', (e) => e.value))
  await page.mouse.click(tl.x + 180 + (1 / dur) * (tl.width - 192), tl.y + 8)
  await dragFirstSlider(page, 0.3)
  await page.click('#autokey')
  await sleep(1200)
  check('edits mark the project unsaved', (await projName(page)).startsWith('•'), await projName(page))
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 15000 })
  const saved = JSON.parse(readFileSync(SAVE, 'utf8'))
  const chain = saved.editor.layers[0].chain
  check(
    'project file holds source, music, output, keyframes',
    saved.version === 2 && saved.editor.layers[0].path === PHOTO && saved.music.path === MUSIC && saved.editor.output.startsWith('1:1') && Object.values(chain[0].keys).some((k) => k.length),
    `source ${saved.source.name} · music ${saved.music.name} · output ${saved.editor.output} · ${chain.length} effects`
  )
  check('saving clears the unsaved mark', (await projName(page)) === 'my look', await projName(page))
  await page.evaluate(() => window.close())
  check('clean project closes without asking', await exitedWithin(run, 6000))
  await run.browser.disconnect().catch(() => {})

  // ---------- 2. reopen from file ----------
  run = await launch({ GLITCH_PROJECT: SAVE })
  page = run.page
  await page.waitForFunction(() => document.querySelector('#projName').textContent === 'my look', { timeout: 20000 })
  await sleep(1500)
  const restored = {
    src: await page.$eval('#srcName', (e) => e.textContent),
    music: await page.$eval('#musicName', (e) => e.textContent),
    output: await page.$eval('#output', (e) => e.value),
    keyed: await firstLabel(page)
  }
  check(
    'reopening restores everything',
    restored.src === 'photo.jpg' && restored.music === 'music.mp3' && restored.output.startsWith('1:1') && restored.keyed.startsWith('◆'),
    JSON.stringify(restored)
  )
  // Change something, let autosave run, then "crash".
  await page.click('#play')
  await dragFirstSlider(page, 0.8)
  await sleep(4000)
  run.app.kill()
  await run.exited
  await run.browser.disconnect().catch(() => {})

  // ---------- 3. recovery + close prompt ----------
  run = await launch({})
  page = run.page
  await page.waitForFunction(() => document.querySelector('.modal .modal-title')?.textContent === 'Restore unsaved work?', { timeout: 20000 })
  check('after a crash, restore is offered', true, await dialogTitle(page))
  await clickDialog(page, 'Restore')
  await page.waitForFunction(() => /Recovered/.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 20000 })
  check('recovered work is still marked unsaved, same project', (await projName(page)) === '• my look', await projName(page))
  await page.evaluate(() => window.close())
  await page.waitForFunction(() => /Save changes/.test(document.querySelector('.modal .modal-title')?.textContent ?? ''), { timeout: 8000 })
  await clickDialog(page, 'Cancel')
  check('Cancel keeps the window open', !(await exitedWithin(run, 2500)))
  await page.evaluate(() => window.close())
  await page.waitForFunction(() => /Save changes/.test(document.querySelector('.modal .modal-title')?.textContent ?? ''), { timeout: 8000 })
  await clickDialog(page, "Don't save")
  check("Don't save closes the app", await exitedWithin(run, 6000))
  await run.browser.disconnect().catch(() => {})

  // ---------- 4. moved media ----------
  renameSync(PHOTO, join(WORK, 'photo_moved.jpg'))
  run = await launch({ GLITCH_PROJECT: SAVE })
  page = run.page
  await page.waitForFunction(() => /Can't find/.test(document.querySelector('.modal .modal-title')?.textContent ?? ''), { timeout: 20000 })
  check('moved source asks where it went', true, await dialogTitle(page))
  await clickDialog(page, 'Skip')
  await page.waitForFunction(() => document.querySelector('#projName').textContent === 'my look', { timeout: 20000 })
  check('project still opens without it', true)
  run.app.kill()
  await run.browser.disconnect().catch(() => {})

  // ---------- 5. AI masks travel inside the project ----------
  renameSync(join(WORK, 'photo_moved.jpg'), PHOTO)
  const SAVE2 = join(WORK, 'with mask.glitch')
  run = await launch({ GLITCH_LOAD: PHOTO, GLITCH_PRESET: 'Clean Tear', GLITCH_SAVE_PATH: SAVE2 })
  page = run.page
  await sleep(2000)
  await page.click('#play')
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
  await page.waitForFunction(() => !document.querySelector('.mask-bar').classList.contains('busy'), { timeout: 120000, polling: 250 })
  const box = await (await page.$('#out')).boundingBox()
  // Default 9:16 cover of the 960x1008 photo: the girl's dress sits around (0.78, 0.69) of the preview.
  await page.mouse.click(box.x + 0.78 * box.width, box.y + 0.69 * box.height)
  await sleep(300)
  await page.waitForFunction(() => !document.querySelector('.mask-bar').classList.contains('busy'), { timeout: 60000, polling: 250 })
  await page.click('.mask-bar [data-a=commit]')
  await page.waitForFunction(() => /Object mask ready/.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 60000 })
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await page.waitForFunction(() => /^Saved /.test(document.querySelector('.toast')?.textContent ?? ''), { timeout: 15000 })
  const withMask = JSON.parse(readFileSync(SAVE2, 'utf8'))
  const trackId = withMask.editor.layers[0].chain[0].mask.track
  check('project embeds the AI mask', withMask.tracks.length === 1 && withMask.tracks[0].id === trackId && !!withMask.tracks[0].frames[0], `${withMask.tracks.length} track · ${Math.round(readFileSync(SAVE2).length / 1024)} KB file`)
  run.app.kill()
  await run.browser.disconnect().catch(() => {})
  // "Another PC": a brand-new profile that has never seen this track.
  run = await launch({ GLITCH_PROJECT: SAVE2, GLITCH_USER_DATA: join(WORK, 'other-pc') })
  page = run.page
  await page.waitForFunction(() => document.querySelector('#projName').textContent === 'with mask', { timeout: 20000 })
  await sleep(1500)
  const there = await page.evaluate((id) => ({ has: window.__glitch.tracks().some((t) => t.id === id), mask: window.__glitch.state().chain[0].mask }), trackId)
  check('mask works on a machine that never had it', there.has && there.mask.source === 'track' && there.mask.track === trackId, JSON.stringify({ has: there.has, source: there.mask.source }))
  run.app.kill()
  await run.browser.disconnect().catch(() => {})
} catch (err) {
  check('project flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
