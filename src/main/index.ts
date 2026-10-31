import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { join, basename } from 'path'
import { promises as fs } from 'fs'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import ffmpegStatic from 'ffmpeg-static'

// When packaged, the binary lives in app.asar.unpacked (see build.asarUnpack).
const ffmpegPath = String(ffmpegStatic ?? 'ffmpeg').replace('app.asar', 'app.asar.unpacked')
const presetDir = (): string => join(app.getPath('userData'), 'presets')
const safeName = (n: string): string => n.replace(/[^\w\- ]+/g, '').trim() || 'preset'

// Tests point this at a throwaway folder so they never touch the user's presets or saved settings.
if (process.env.GLITCH_USER_DATA) app.setPath('userData', process.env.GLITCH_USER_DATA)

let win: BrowserWindow | null = null
/** Set once the renderer has dealt with unsaved changes (or for test/quit paths that must not block). */
let allowClose = false

/** A .glitch path passed on the command line (double-click in Explorer, or "Open with"). */
const projectArg = (argv: string[]): string => argv.slice(1).find((a) => /\.glitch$/i.test(a)) ?? ''

function createWindow(): void {
  win = new BrowserWindow({
    width: 1560,
    height: 980,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0a0a0c',
    title: 'Glitch Chain',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  // Closing asks the renderer first (unsaved changes); if it doesn't answer quickly, close anyway.
  win.on('close', (e) => {
    if (allowClose || !win) return
    e.preventDefault()
    win.webContents.send('app:close-request')
    closeTimer = setTimeout(() => {
      if (!rendererAnswered) {
        allowClose = true
        win?.close()
      }
    }, 4000)
  })

  // Headless-ish test hook: GLITCH_SHOT=out.png captures the window after a delay and quits.
  const shot = process.env.GLITCH_SHOT
  if (shot) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        const img = await win!.webContents.capturePage()
        await fs.writeFile(shot, img.toPNG())
        allowClose = true
        app.quit()
      }, Number(process.env.GLITCH_SHOT_DELAY || 3500))
    })
  }
}

ipcMain.handle('save-file', async (_e, defaultName: string, filters: Electron.FileFilter[], data: ArrayBuffer) => {
  const r = await dialog.showSaveDialog(win!, { defaultPath: defaultName, filters })
  if (r.canceled || !r.filePath) return null
  await fs.writeFile(r.filePath, Buffer.from(data))
  return r.filePath
})

type Codec = 'h264' | 'h265' | 'prores'

interface RenderOpts {
  out: string
  width: number
  height: number
  fps: number
  duration: number
  codec: Codec
  audioPath?: string
}

const CODEC_ARGS: Record<Codec, string[]> = {
  h264: ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
  h265: ['-c:v', 'libx265', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', '-x265-params', 'log-level=error', '-movflags', '+faststart'],
  prores: ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-vendor', 'apl0']
}
const CODEC_EXT: Record<Codec, { name: string; ext: string }> = {
  h264: { name: 'MP4 (H.264)', ext: 'mp4' },
  h265: { name: 'MP4 (H.265 / HEVC)', ext: 'mp4' },
  prores: { name: 'QuickTime (ProRes 422 HQ)', ext: 'mov' }
}

/** One offline render at a time: renderer pushes raw RGBA frames, ffmpeg encodes from stdin. */
let session: { proc: ChildProcessWithoutNullStreams; out: string; done: Promise<void>; log: () => string } | null = null

ipcMain.handle('render:choose', async (_e, defaultName: string, codec: Codec) => {
  const { name, ext } = CODEC_EXT[codec]
  const r = await dialog.showSaveDialog(win!, { defaultPath: `${defaultName}.${ext}`, filters: [{ name, extensions: [ext] }] })
  return r.canceled || !r.filePath ? null : r.filePath
})

ipcMain.handle('render:start', (_e, o: RenderOpts) => {
  if (session) session.proc.kill('SIGKILL')
  const args = ['-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${o.width}x${o.height}`, '-r', String(o.fps), '-i', '-']
  if (o.audioPath) args.push('-i', o.audioPath, '-map', '0:v:0', '-map', '1:a:0?')
  // readPixels rows are bottom-up; convert to BT.709 limited range and tag it so players show correct color.
  args.push('-vf', 'vflip,scale=out_color_matrix=bt709:out_range=tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709')
  args.push(...CODEC_ARGS[o.codec])
  if (o.audioPath) args.push(...(o.codec === 'prores' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'aac', '-b:a', '320k']))
  args.push('-t', String(o.duration), o.out)

  const proc = spawn(ffmpegPath, args, { windowsHide: true })
  let log = ''
  proc.stderr.on('data', (d) => (log = (log + d.toString()).slice(-4000)))
  proc.stdin.on('error', () => {}) // surfaced via frame write callbacks / exit code
  const done = new Promise<void>((resolve, reject) => {
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${log}`))))
  })
  done.catch(() => {})
  session = { proc, out: o.out, done, log: () => log }
  return true
})

ipcMain.handle('render:frame', (_e, data: Uint8Array) => {
  const s = session
  if (!s) throw new Error('No render in progress')
  return new Promise<void>((resolve, reject) => {
    s.proc.stdin.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (err) =>
      err ? reject(new Error(`Encoder stopped: ${err.message}\n${s.log()}`)) : resolve()
    )
  })
})

ipcMain.handle('render:finish', async () => {
  const s = session
  if (!s) throw new Error('No render in progress')
  s.proc.stdin.end()
  try {
    await s.done
  } finally {
    session = null
  }
  return s.out
})

ipcMain.handle('render:cancel', async () => {
  const s = session
  session = null
  if (!s) return
  s.proc.kill('SIGKILL')
  await s.done.catch(() => {})
  await fs.unlink(s.out).catch(() => {})
})

ipcMain.handle('presets:list', async () => {
  await fs.mkdir(presetDir(), { recursive: true })
  const files = (await fs.readdir(presetDir())).filter((f) => f.endsWith('.json'))
  const out: unknown[] = []
  for (const f of files) {
    try {
      out.push(JSON.parse(await fs.readFile(join(presetDir(), f), 'utf8')))
    } catch {
      /* skip corrupt preset */
    }
  }
  return out
})

ipcMain.handle('presets:save', async (_e, name: string, data: unknown) => {
  await fs.mkdir(presetDir(), { recursive: true })
  await fs.writeFile(join(presetDir(), safeName(name) + '.json'), JSON.stringify(data, null, 2))
  return true
})

ipcMain.handle('presets:delete', async (_e, name: string) => {
  await fs.unlink(join(presetDir(), safeName(name) + '.json')).catch(() => {})
  return true
})

ipcMain.handle('preset:export', async (_e, name: string, data: unknown) => {
  const r = await dialog.showSaveDialog(win!, {
    defaultPath: `${safeName(name)}.glitch.json`,
    filters: [{ name: 'Glitch Chain preset', extensions: ['json'] }]
  })
  if (r.canceled || !r.filePath) return null
  await fs.writeFile(r.filePath, JSON.stringify(data, null, 2))
  return r.filePath
})

ipcMain.handle('preset:import', async () => {
  const r = await dialog.showOpenDialog(win!, {
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Glitch Chain preset', extensions: ['json'] }]
  })
  if (r.canceled) return []
  const out: unknown[] = []
  for (const f of r.filePaths) {
    try {
      out.push(JSON.parse(await fs.readFile(f, 'utf8')))
    } catch {
      /* not JSON: skipped, the renderer reports how many were imported */
    }
  }
  return out
})

ipcMain.handle('choose-folder', async (_e, title: string) => {
  if (process.env.GLITCH_QUEUE_DIR) return process.env.GLITCH_QUEUE_DIR // test hook: skip the native dialog
  const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory', 'createDirectory'] })
  return r.canceled ? null : r.filePaths[0]
})

/** `dir/name.ext`, or `dir/name (2).ext` etc. if taken. */
ipcMain.handle('unique-path', async (_e, dir: string, name: string, ext: string) => {
  const base = name.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'render'
  for (let i = 1; ; i++) {
    const p = join(dir, `${base}${i > 1 ? ` (${i})` : ''}.${ext}`)
    try {
      await fs.access(p)
    } catch {
      return p
    }
  }
})

// ---------- mask tracks on disk: userData/masktracks/<id>/{meta.json, 00000.png ...} ----------
const tracksDir = (): string => join(app.getPath('userData'), 'masktracks')
const safeId = (id: string): string => id.replace(/[^\w-]/g, '')

ipcMain.handle('tracks:save', async (_e, meta: { id: string; frameCount: number }, frames: (ArrayBuffer | null)[]) => {
  const dir = join(tracksDir(), safeId(meta.id))
  await fs.mkdir(dir, { recursive: true })
  await Promise.all(frames.map((f, i) => (f ? fs.writeFile(join(dir, `${String(i).padStart(5, '0')}.png`), Buffer.from(f)) : null)))
  await fs.writeFile(join(dir, 'meta.json'), JSON.stringify(meta))
  return true
})

ipcMain.handle('tracks:list', async () => {
  await fs.mkdir(tracksDir(), { recursive: true })
  const out: unknown[] = []
  for (const d of await fs.readdir(tracksDir())) {
    try {
      out.push(JSON.parse(await fs.readFile(join(tracksDir(), d, 'meta.json'), 'utf8')))
    } catch {
      /* incomplete track folder: skipped */
    }
  }
  return out
})

ipcMain.handle('tracks:load', async (_e, id: string, frameCount: number) => {
  const dir = join(tracksDir(), safeId(id))
  return Promise.all(
    Array.from({ length: frameCount }, async (_, i) => {
      try {
        const b = await fs.readFile(join(dir, `${String(i).padStart(5, '0')}.png`))
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
      } catch {
        return null
      }
    })
  )
})

ipcMain.handle('tracks:delete', async (_e, id: string) => {
  await fs.rm(join(tracksDir(), safeId(id)), { recursive: true, force: true })
  return true
})

ipcMain.handle('read-file', async (_e, p: string) => {
  const buf = await fs.readFile(p)
  return { name: basename(p), data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }
})

// Test hooks: preload media / music / preset, and optionally run an offline render to a path.
ipcMain.handle('autoload', () => ({
  load: process.env.GLITCH_LOAD || '',
  music: process.env.GLITCH_MUSIC || '',
  preset: process.env.GLITCH_PRESET || '',
  render: process.env.GLITCH_RENDER || '',
  renderSpec: process.env.GLITCH_RENDER_SPEC || '',
  project: process.env.GLITCH_PROJECT || projectArg(process.argv),
  autosaveMs: Number(process.env.GLITCH_AUTOSAVE_MS || 30000),
  // Test profiles skip the welcome screen unless a test asks for it.
  welcome: process.env.GLITCH_WELCOME ? process.env.GLITCH_WELCOME === '1' : !process.env.GLITCH_USER_DATA
}))

ipcMain.handle('quit', () => {
  allowClose = true
  app.quit()
})

// ---------- projects ----------
let rendererAnswered = false
let closeTimer: ReturnType<typeof setTimeout> | null = null

/** Renderer: "I'm handling the close request" (it shows its own Save / Don't save dialog). */
ipcMain.handle('app:close-ack', () => {
  rendererAnswered = true
  if (closeTimer) clearTimeout(closeTimer)
})
/** Renderer: close now (after saving or discarding), or cancel the close. */
ipcMain.handle('app:close-now', (_e, close: boolean) => {
  rendererAnswered = false
  if (!close) return
  allowClose = true
  win?.close()
})

ipcMain.handle('app:title', (_e, title: string) => win?.setTitle(title))

const recentFile = (): string => join(app.getPath('userData'), 'recent.json')
async function readRecent(): Promise<string[]> {
  try {
    return JSON.parse(await fs.readFile(recentFile(), 'utf8'))
  } catch {
    return []
  }
}
async function addRecent(p: string): Promise<void> {
  const list = [p, ...(await readRecent()).filter((x) => x.toLowerCase() !== p.toLowerCase())].slice(0, 10)
  await fs.writeFile(recentFile(), JSON.stringify(list))
  app.addRecentDocument(p)
}

ipcMain.handle('project:recent', async () => {
  const out: { path: string; exists: boolean }[] = []
  for (const p of await readRecent()) {
    let exists = true
    try {
      await fs.access(p)
    } catch {
      exists = false
    }
    out.push({ path: p, exists })
  }
  return out
})

/** Save to `path`, or ask where (Save As / first save). Returns the path written, or null if cancelled. */
ipcMain.handle('project:save', async (_e, path: string | null, suggested: string, json: string) => {
  let out = path ?? process.env.GLITCH_SAVE_PATH ?? null // test hook: skip the native Save dialog
  if (!out) {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: `${suggested.replace(/[<>:"/\\|?*]+/g, '_') || 'Untitled'}.glitch`,
      filters: [{ name: 'Glitch Chain project', extensions: ['glitch'] }]
    })
    if (r.canceled || !r.filePath) return null
    out = r.filePath
  }
  // Write-then-rename so a crash mid-save never leaves a half-written project.
  await fs.writeFile(out + '.tmp', json)
  await fs.rename(out + '.tmp', out)
  await addRecent(out)
  return out
})

/** Open a project: from `path`, or ask. Returns its path and text, or null if cancelled. */
ipcMain.handle('project:open', async (_e, path?: string) => {
  let p = path
  if (!p) {
    const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters: [{ name: 'Glitch Chain project', extensions: ['glitch'] }] })
    if (r.canceled || !r.filePaths[0]) return null
    p = r.filePaths[0]
  }
  const text = await fs.readFile(p, 'utf8')
  await addRecent(p)
  return { path: p, text }
})

const autosaveFile = (): string => join(app.getPath('userData'), 'autosave.glitch')
ipcMain.handle('project:autosave', (_e, json: string) => fs.writeFile(autosaveFile(), json))
ipcMain.handle('project:autosave-read', async () => {
  try {
    const st = await fs.stat(autosaveFile())
    return { text: await fs.readFile(autosaveFile(), 'utf8'), time: st.mtimeMs }
  } catch {
    return null
  }
})
ipcMain.handle('project:autosave-clear', () => fs.rm(autosaveFile(), { force: true }))

ipcMain.handle('file:choose', async (_e, filters: Electron.FileFilter[]) => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], filters })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('file:exists', async (_e, p: string) => {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
})

/** Ask the user to find a moved/missing file. */
ipcMain.handle('file:locate', async (_e, title: string, name: string, kind: 'media' | 'audio') => {
  const r = await dialog.showOpenDialog(win!, {
    title,
    defaultPath: name,
    properties: ['openFile'],
    filters:
      kind === 'audio'
        ? [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'mp4', 'mov', 'webm'] }]
        : [{ name: 'Images & video', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'mp4', 'mov', 'webm', 'mkv', 'm4v'] }]
  })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p))

// One window: opening a .glitch while running hands it to the existing window.
if (!process.env.GLITCH_USER_DATA && !app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
    const p = projectArg(argv)
    if (p) win.webContents.send('app:open-project', p)
  })
  app.whenReady().then(createWindow)
}
app.on('window-all-closed', () => app.quit())
