// Welcome screen e2e. WELCOME_TEST_IMAGE = any image.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createRequire } from 'node:module'
import puppeteer from 'puppeteer-core'

const require = createRequire(import.meta.url)
const IMG = process.env.WELCOME_TEST_IMAGE
if (!IMG || !existsSync(IMG)) throw new Error('WELCOME_TEST_IMAGE must exist')
const WORK = join(tmpdir(), 'glitch-chain-e2e-welcome')
rmSync(WORK, { recursive: true, force: true })
mkdirSync(WORK, { recursive: true })
const PROJ = join(WORK, 'My Glitch.glitch')
const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
let port = 9880
async function launch(env) {
  const p = ++port
  const app = spawn(require('electron'), ['.', `--remote-debugging-port=${p}`], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
    env: { ...process.env, GLITCH_USER_DATA: join(WORK, 'profile'), GLITCH_SAVE_PATH: PROJ, ...env }
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
  await sleep(1200)
  return { app, browser, page, exited }
}
/** Quit through the app so localStorage is flushed to disk. */
async function quit(run) {
  await run.page.evaluate(() => setTimeout(() => window.api.quit(), 300))
  await run.browser.disconnect().catch(() => {})
  const clean = await Promise.race([run.exited, sleep(10000).then(() => false)])
  if (!clean) console.log('  (app did not exit by itself)')
  run.app.kill()
  await run.browser.disconnect().catch(() => {})
}
const shown = (page) => page.evaluate(() => !!document.querySelector('.welcome'))
const click = (page, sel) => page.evaluate((s) => document.querySelector(s).click(), sel)
const menu = async (page, label) => {
  await page.click('#projectMenu')
  await sleep(300)
  await page.evaluate((l) => [...document.querySelectorAll('.menu button')].find((b) => b.textContent.includes(l)).click(), label)
  await sleep(500)
}

try {
  // ---------- first run ----------
  let run = await launch({ GLITCH_WELCOME: '1' })
  let { page } = run
  check('welcome shows on first start', await shown(page))
  await page.screenshot({ path: join(WORK, 'welcome.png') })
  const buttons = await page.evaluate(() => [...document.querySelectorAll('.welcome button.big')].map((b) => b.firstChild.textContent.trim()))
  check('offers open / camera / project / looks', buttons.length === 4, buttons.join(' · '))
  check('no recent section without projects', await page.evaluate(() => document.querySelector('.welcome .recent-label').hidden))
  await page.keyboard.press('Escape')
  await sleep(200)
  check('Escape closes it', !(await shown(page)))
  // Save a project so it shows up under Recent next time.
  await page.keyboard.down('Control')
  await page.keyboard.press('s')
  await page.keyboard.up('Control')
  await sleep(1500)
  check('project saved for the recent list', existsSync(PROJ))
  await menu(page, 'Welcome screen')
  check('Project menu reopens it', await shown(page))
  const recent = await page.evaluate(() => [...document.querySelectorAll('.welcome .recent')].map((b) => b.textContent))
  check('recent projects listed', recent.includes('My Glitch'), recent.join(', '))
  // Turn it off for next time.
  await click(page, '.welcome [data-a=startup]')
  await click(page, '.welcome [data-a=close]')
  await sleep(200)
  check('Close button closes it', !(await shown(page)))
  await quit(run)

  // ---------- "show at startup" off is remembered ----------
  run = await launch({ GLITCH_WELCOME: '1' })
  page = run.page
  check('stays hidden after turning off "Show at startup"', !(await shown(page)), `stored: ${await page.evaluate(() => localStorage.getItem('glitch.welcome'))}`)
  await menu(page, 'Welcome screen')
  check('still available from the menu', await shown(page))
  check('checkbox reflects the setting', !(await page.evaluate(() => document.querySelector('.welcome [data-a=startup]').checked)))
  await page.evaluate(() => document.querySelector('.welcome .recent').click())
  await page.waitForFunction(() => document.querySelector('#projName').textContent.includes('My Glitch'), { timeout: 10000 }).catch(() => {})
  const name = await page.$eval('#projName', (e) => e.textContent)
  check('clicking a recent project opens it and closes the welcome', name.includes('My Glitch') && !(await shown(page)), name)
  // Loading media while it is open closes it.
  await menu(page, 'Welcome screen')
  await page.evaluate(async (p) => {
    const f = await window.api.readFile(p)
    const dt = new DataTransfer()
    dt.items.add(new File([f.data], f.name, { type: 'image/jpeg' }))
    document.querySelector('#viewport').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, IMG)
  await sleep(1500)
  check('dropping a file closes it', !(await shown(page)))
  // Regression: modal key handlers used to cancel every key, so names could not be typed.
  await page.click('#savePreset')
  await page.waitForSelector('.modal input[type=text]')
  await page.evaluate(() => (document.querySelector('.modal input[type=text]').value = ''))
  await page.keyboard.type('Typed Name')
  await page.keyboard.press('Enter')
  await sleep(800)
  const opts = await page.$$eval('#presets option', (o) => o.map((x) => x.textContent))
  check('typing in the preset-name prompt works', opts.some((o) => o.includes('Typed Name')), opts.filter((o) => /Typed/.test(o)).join(','))
  await quit(run)

  // ---------- never over a file / project being opened, or in test profiles ----------
  run = await launch({ GLITCH_WELCOME: '1', GLITCH_LOAD: IMG })
  check('not shown when starting with a file', !(await shown(run.page)))
  await quit(run)
  rmSync(join(WORK, 'profile'), { recursive: true, force: true })
  run = await launch({})
  check('not shown in automated test profiles', !(await shown(run.page)))
  await quit(run)
} catch (err) {
  check('welcome flow', false, err.stack)
}
const failed = results.filter((r) => !r).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
