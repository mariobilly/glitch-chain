import '@fontsource/vt323'
import '@fontsource/press-start-2p'
import '@fontsource/silkscreen/700.css'
import './style.css'
import { Pane } from 'tweakpane'
import { Pipeline, type LayerRender, type SourceParams } from './gl/Pipeline'
import { LayersPanel } from './ui/LayersPanel'
import { Source } from './source/Source'
import { ChainPanel } from './ui/ChainPanel'
import { Timeline } from './ui/Timeline'
import { askRenderSettings, showRenderProgress, type RenderChoice } from './ui/RenderDialog'
import { createInstance } from './effects'
import type { Instance } from './effects/types'
import { BUILTIN_PRESETS, DEFAULT_SOURCE, toPresetLayers, type Preset, type PresetLayer } from './presets'
import { renderOffline } from './export/OfflineRender'
import { analyzeAudio, type AudioAnalysis } from './audio/analysis'
import { applyKeys, modulate, setKey } from './anim'
import { Transport, fmtTime } from './Transport'
import { History } from './History'
import { SubjectTracker, anyNeed, maskNeeds } from './vision/SubjectTracker'
import { openPresetBrowser } from './ui/PresetBrowser'
import { Sequencer, defaultSequence } from './sequence'
import { openSequenceDialog } from './ui/SequenceDialog'
import { openQueuePanel, type QueueJob } from './ui/QueuePanel'
import { attachMenu } from './ui/Menu'
import { MaskEditor } from './ui/MaskEditor'
import { TrackStore, trackIds, type MaskTrack } from './masks/TrackStore'
import { Segmenter, interiorPoints, maskToPng, unionMasks, type SegMask } from './vision/Segmenter'
import { DepthEstimator, DEPTH_SIDE } from './vision/Depth'
import { EFFECTS } from './effects'
import { seekVideo } from './export/OfflineRender'
import { ask, choose, toast } from './ui/dialogs'
import { closeWelcome, showWelcome, welcomeAtStartup } from './ui/Welcome'

const OUTPUTS: Record<string, [number, number] | null> = {
  '9:16 · 1080×1920': [1080, 1920],
  '4:5 · 1080×1350': [1080, 1350],
  '1:1 · 1080×1080': [1080, 1080],
  '16:9 · 1920×1080': [1920, 1080],
  'Match source': null
}

document.querySelector('#app')!.innerHTML = `
<header class="toolbar">
  <div class="logo">GLITCH<b>CHAIN</b></div>
  <button id="projectMenu" title="New / open / save projects">Project ▾</button>
  <span id="projName" class="meta proj-name">Untitled</span>
  <span class="sep"></span>
  <button id="open" title="Open image or video (Ctrl+O)">Open</button>
  <button id="camera" title="Use webcam as source">Camera</button>
  <select id="output" title="Output size">${Object.keys(OUTPUTS).map((k) => `<option>${k}</option>`).join('')}</select>
  <button id="undo" title="Undo (Ctrl+Z)" disabled>↶</button>
  <button id="redo" title="Redo (Ctrl+Shift+Z)" disabled>↷</button>
  <button id="compare" title="Split before/after (drag on the preview). Hold B to see the original.">◧ Compare</button>
  <button id="aiStatus" class="ai-status" title="Which AI models are loaded, and whether they run on the GPU or CPU">AI</button>
  <span id="fps" class="meta">— fps</span>
  <span class="spacer"></span>
  <button id="browse" title="Browse presets with previews">▦</button>
  <select id="presets" title="Presets"></select>
  <button id="savePreset" title="Save current chain as preset">Save</button>
  <button id="presetMenu" title="Export / import / delete presets">⋯</button>
  <span class="sep"></span>
  <button id="snap" title="Save PNG snapshot">Snapshot</button>
  <button id="queue" title="Render queue">Queue</button>
  <button id="render" class="rec" title="Render video frame by frame (Ctrl+R)">▶ Render</button>
</header>
<main>
  <section class="stage">
    <div class="viewport" id="viewport">
      <canvas id="out"></canvas>
      <div class="drop" id="drop">Drop image or video</div>
    </div>
    <div class="timeline">
      <div class="tl-head">
        <button id="play" title="Play / pause (Space)">❚❚</button>
        <button id="home" title="Go to start (Home)">⏮</button>
        <span class="meta tc"><span id="tc">0:00.00</span> /</span>
        <input id="dur" type="number" min="0.5" step="0.1" title="Timeline length (seconds)"><span class="meta">s</span>
        <span class="sep"></span>
        <button id="autokey" title="Auto-key (K): slider moves set keyframes at the playhead">◆ Auto-key</button>
        <button id="sequence" title="Cut between presets on beats or time">⇄ Sequence</button>
        <button id="beatSnap" title="Snap the playhead and keyframes to beats (hold Shift to place freely). [ and ] jump between beats.">⌗ Snap</button>
        <span class="sep"></span>
        <button id="music" title="Load a music track to drive audio modulators">♫ Music…</button>
        <span id="musicName" class="meta"></span>
        <button id="clearMusic" title="Remove music" hidden>✕</button>
        <button id="mute" title="Preview audio on/off" hidden>🔇</button>
        <span class="spacer"></span>
        <span class="meta hint">drag keys · right-click: easing · Alt-click / Del: delete · dbl-click track: add key</span>
      </div>
      <div class="tl-body" id="timeline"></div>
    </div>
  </section>
  <aside class="side">
    <div class="section-title">Layers <span class="meta">top → bottom</span></div>
    <div id="layers" class="layers-panel"></div>
    <div class="section-title">Source <span class="meta" id="srcName"></span></div>
    <div id="sourcePane" class="source-pane"></div>
    <div class="section-title">Effect chain <span class="meta">top → bottom</span></div>
    <div id="seqBanner" class="seq-banner" hidden></div>
    <div id="chain" class="chain"></div>
  </aside>
</main>
<input type="file" id="file" accept="image/*,video/*" hidden>
<input type="file" id="musicFile" accept="audio/*,video/*" hidden>
<input type="file" id="layerFile" accept="image/*,video/*" hidden>`

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('out')
const pipeline = new Pipeline(canvas)
const transport = new Transport()
const trackStore = new TrackStore(pipeline.gl)

/**
 * A layer: its own media, framing, settings card (blend / opacity / mask; its toggle is visibility) and effect
 * chain. Index 0 is the bottom layer; its video (or the music) drives the timeline clock.
 */
interface Layer {
  id: string
  name: string
  source: Source
  src: SourceParams
  settings: Instance
  chain: Instance[]
  tracker: SubjectTracker
  /** Bumped when the media changes so detection re-runs on stills. */
  version: number
  /** Path being loaded (so saves/undo see it before the load finishes). */
  pendingPath: string
  /** Estimated depth of the current frame (only computed while something uses depth). */
  depth: { tex: WebGLTexture; has: boolean; key: string; busy: boolean; data?: { w: number; h: number; px: Uint8Array } }
}
let layerSeq = 0
function makeLayer(name: string, id = `L${Date.now().toString(36)}${(layerSeq++).toString(36)}`): Layer {
  return {
    id,
    name,
    source: new Source(),
    src: { ...DEFAULT_SOURCE },
    settings: createInstance('layer'),
    chain: [],
    tracker: new SubjectTracker(pipeline.gl, id),
    version: 0,
    pendingPath: '',
    depth: { tex: depthTexture(), has: false, key: '', busy: false }
  }
}
function depthTexture(): WebGLTexture {
  const gl = pipeline.gl
  const t = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}
const layers: Layer[] = [makeLayer('Layer 1', 'base')]
let active = 0
const activeLayer = (): Layer => layers[active]
/** The active layer's source and tracker: the editing tools (Open, presets, AI selection, masks) act on it. */
let source = layers[0].source
let tracker = layers[0].tracker
layers[0].tracker.onStatus = (s) => s && toast(s, s.includes('failed'))
const baseVideo = (): HTMLVideoElement | null => layers[0].source.fileVideo
// Handle for automated tests (tests/*.e2e.mjs and ad-hoc diagnostics).
;(window as unknown as { __glitch: unknown }).__glitch = {
  get tracker() {
    return tracker
  },
  get source() {
    return source
  },
  pipeline,
  state: () => state,
  seq: () => sequencer,
  tracks: () => trackStore.list(),
  ai: () => ({ segmenter, analysisCanvas }),
  layers: () => layers,
  audio: () => currentAudio()?.analysis ?? null,
  t: () => transport.t,
  get timeline() {
    return timeline
  },
  /** Value of a chain effect's param at time t, with modulators applied (tests). */
  paramAt: (i: number, key: string, t: number) => {
    const inst = state.chain[i]
    const p = EFFECTS[inst.effectId].params.find((x) => x.key === key) as { min: number; max: number }
    return modulate(inst, key, p.min, p.max, inst.params[key] as number, t, currentAudio()?.analysis ?? null)
  },
  /** Append an effect to the active layer's chain (tests). */
  add: (effectId: string, params: Record<string, unknown> = {}) => {
    state.chain.push(createInstance(effectId, { params: params as Instance['params'] }))
    chainPanel.render()
  }
}

/** Subject data for rendering a layer's chain at the playhead (mask tracks decode in the background). */
const subjectsFor = (l: Layer, chain: Instance[]) => ({
  faces: l.tracker.faces,
  caps: l.tracker.caps,
  maskTex: l.tracker.maskTex,
  hasMask: l.tracker.hasMask,
  partsTex: l.tracker.partsTex,
  hasParts: l.tracker.hasParts,
  objects: l.tracker.objects,
  tracks: trackStore.sync(trackIds([[l.settings, ...chain]]), transport.t),
  depthTex: l.depth.has ? l.depth.tex : null
})

// ---------- depth ----------
const depthEstimator = new DepthEstimator((m) => m && toast(m))
/** Does anything in this chain read depth (a depth effect, or a depth mask)? */
const depthNeeded = (chain: Instance[]): boolean =>
  chain.some((i) => i.enabled && (i.mask.source === 'depth' || !!EFFECTS[i.effectId]?.needsDepth))
async function computeDepth(l: Layer): Promise<void> {
  const s = l.source
  if (!s.width) return
  const k = Math.min(1, DEPTH_SIDE / Math.max(s.width, s.height))
  const c = new OffscreenCanvas(Math.max(1, Math.round(s.width * k)), Math.max(1, Math.round(s.height * k)))
  c.getContext('2d')!.drawImage(s.el, 0, 0, c.width, c.height)
  const d = await depthEstimator.estimate(c)
  const gl = pipeline.gl
  gl.bindTexture(gl.TEXTURE_2D, l.depth.tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, d.w, d.h, 0, gl.RED, gl.UNSIGNED_BYTE, d.data) // rows stay top-down
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  l.depth.has = true
  l.depth.data = { w: d.w, h: d.h, px: d.data }
}

/** Depth (0 far .. 1 near) under an output-uv point of the active layer, estimating it first if needed. */
async function depthAt(u: number, v: number): Promise<number | null> {
  const l = activeLayer()
  if (!l.depth.data) await computeDepth(l)
  const d = l.depth.data
  if (!d) return null
  const [sx, sy] = outputToSource(u, v)
  const x = Math.min(d.w - 1, Math.max(0, Math.round((sx / l.source.width) * d.w)))
  const y = Math.min(d.h - 1, Math.max(0, Math.round((sy / l.source.height) * d.h)))
  // Median of a small neighbourhood: a click on an edge shouldn't pick up the background behind it.
  const vals: number[] = []
  for (let dy = -3; dy <= 3; dy++)
    for (let dx = -3; dx <= 3; dx++) {
      const xx = Math.min(d.w - 1, Math.max(0, x + dx))
      const yy = Math.min(d.h - 1, Math.max(0, y + dy))
      vals.push(d.px[yy * d.w + xx])
    }
  vals.sort((a, b) => a - b)
  return vals[vals.length >> 1] / 255
}
/** Preview: keep a layer's depth current in the background (one estimate in flight at a time). */
function depthLive(l: Layer, chain: Instance[], key: string): void {
  if (!depthNeeded([l.settings, ...chain]) || l.depth.busy || l.depth.key === key) return
  l.depth.key = key
  l.depth.busy = true
  computeDepth(l)
    .catch(() => (l.depth.key = ''))
    .finally(() => (l.depth.busy = false))
}
const subjects = (chain: Instance[] = []) => subjectsFor(activeLayer(), chain)
function trackLayer(l: Layer, chain: Instance[], tick: number): void {
  const s = l.source
  const v = s.video
  const key = s.kind === 'camera' ? `c${tick}` : v ? `v${l.version}:${v.currentTime}` : `i${l.version}`
  depthLive(l, chain, key)
  const need = maskNeeds([l.settings, ...chain])
  if (!anyNeed(need)) return
  l.tracker.update(s.el, s.width, s.height, key, need, s.kind === 'image' || s.kind === 'placeholder')
}

interface AudioTrack {
  analysis: AudioAnalysis
  name: string
  path: string
}

const state = {
  output: Object.keys(OUTPUTS)[0],
  autoKey: false,
  rendering: false,
  videoAudio: null as AudioTrack | null,
  music: null as (AudioTrack & { el: HTMLAudioElement; url: string }) | null,
  /** The active layer's effects and framing. */
  get chain(): Instance[] {
    return layers[active].chain
  },
  get source(): SourceParams {
    return layers[active].src
  }
}
const currentAudio = (): AudioTrack | null => state.music ?? state.videoAudio
// The preset sequence cuts the bottom layer's chain.
const sequencer = new Sequencer(
  (name) => findPreset(name),
  () => layers[0].chain
)
/** Every chain any layer can render (incl. sequenced presets), each with its layer's settings card. */
const allChains = (): Instance[][] => [
  ...layers.map((l) => [l.settings, ...l.chain]),
  ...(sequencer.active ? sequencer.allChains().map((c) => [layers[0].settings, ...c]) : [])
]
/** Keep GPU state for every chain that can render. */
const pruneLive = (): void => pipeline.prune(allChains().flat())

// ---------- source panel (rebuilt when the active layer changes) ----------
let srcPane: Pane | null = null
function buildSourcePane(): void {
  srcPane?.dispose()
  const p = new Pane({ container: $('sourcePane') })
  const s = state.source
  p.addBinding(s, 'fit', { options: { cover: 0, contain: 1 } })
  p.addBinding(s, 'zoom', { min: 0.2, max: 4 })
  p.addBinding(s, 'panX', { label: 'pan x', min: -0.5, max: 0.5 })
  p.addBinding(s, 'panY', { label: 'pan y', min: -0.5, max: 0.5 })
  p.addBinding(s, 'gray', { label: 'b&w', min: 0, max: 1 })
  p.addBinding(s, 'contrast', { min: 0, max: 3 })
  p.addBinding(s, 'brightness', { min: -0.5, max: 0.5 })
  srcPane = p
}
buildSourcePane()

// ---------- chain + timeline ----------
const chainPanel = new ChainPanel($('chain'), state.chain, {
  onStructure: () => {
    pruneLive()
    timeline.draw()
  },
  onParamEdit: (inst, key, value) => {
    if (!inst.keys[key]?.length && !state.autoKey) return
    setKey(inst, key, transport.t, value)
    chainPanel.updateKeyLabels()
    timeline.draw()
  },
  pickColor: (inst) =>
    maskEditor.pick((u, v) => {
      const hex = (x: number): string => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')
      const [r, g, b] = pipeline.sampleSource(u, v)
      inst.mask.color = `#${hex(r)}${hex(g)}${hex(b)}`
      chainPanel.refreshValues()
    }),
  editShape: (inst) =>
    maskEditor.editShape(inst, (key, value) => {
      inst.params[key] = value
      // Same path as a slider edit, so auto-key / existing keyframes pick it up.
      if (inst.keys[key]?.length || state.autoKey) {
        setKey(inst, key, transport.t, value)
        chainPanel.updateKeyLabels()
      }
      chainPanel.refreshValues()
      timeline.draw()
    }),
  drawMask: (inst) =>
    maskEditor.draw(inst, (poly) => {
      inst.mask.polys = [...inst.mask.polys, poly]
    }),
  tracks: () => trackStore.list().map((t) => ({ id: t.id, label: t.label })),
  makeTrack: (inst) => void openTrackMaker(inst),
  chooseFile: (filters) => window.api.chooseFile(filters),
  pickDepth: (_inst, apply) =>
    maskEditor.pick(async (u, v) => {
      const d = await depthAt(u, v)
      if (d === null) return toast('No depth for this source yet', true)
      apply(Math.round(d * 1000) / 1000)
      timeline.draw()
    }),
  deleteTrack: async (id) => {
    const t = trackStore.get(id)
    if (!t || (await ask(`Delete track “${t.label}”?`, null)) === null) return
    trackStore.remove(id)
    await window.api.deleteTrack(id)
    for (const c of sequencer.allChains()) for (const i of c) if (i.mask.track === id) i.mask.track = ''
    chainPanel.render()
  }
})
const maskEditor = new MaskEditor($('viewport'), canvas)
chainPanel.setChain(layers[0].chain, layers[0].settings)
const timeline: Timeline = new Timeline($('timeline'), {
  transport,
  chain: () => [activeLayer().settings, ...state.chain],
  audio: () => currentAudio()?.analysis ?? null,
  segments: () => sequencer.segments(transport.duration, currentAudio()?.analysis ?? null),
  onKeysChanged: () => {
    applyKeys(state.chain, transport.t)
    chainPanel.refreshValues()
    timeline.draw()
  }
})
// Beat snapping: remembered per user, on by default.
try {
  timeline.snap = localStorage.getItem('glitch.beatSnap') !== 'off'
} catch {
  /* default on */
}
const syncSnap = (): void => {
  $('beatSnap').classList.toggle('active', timeline.snap)
  timeline.draw()
}
$('beatSnap').onclick = () => {
  timeline.snap = !timeline.snap
  try {
    localStorage.setItem('glitch.beatSnap', timeline.snap ? 'on' : 'off')
  } catch {
    /* not remembered */
  }
  syncSnap()
}
syncSnap()

// ---------- transport controls ----------
const durInput = $<HTMLInputElement>('dur')
const syncDuration = (): void => {
  durInput.value = transport.duration.toFixed(2)
  durInput.max = String(transport.maxDuration)
  timeline.draw()
}
durInput.onchange = () => {
  const d = Number(durInput.value)
  transport.duration = Math.min(transport.maxDuration, Math.max(0.5, isFinite(d) ? d : transport.duration))
  transport.seek(Math.min(transport.t, transport.duration))
  syncDuration()
}
function setPlaying(p: boolean): void {
  transport.setPlaying(p)
  $('play').textContent = p ? '❚❚' : '▶'
}
$('play').onclick = () => setPlaying(!transport.playing)
$('home').onclick = () => transport.seek(0)
function setAutoKey(on: boolean): void {
  state.autoKey = on
  $('autokey').classList.toggle('active', on)
}
$('autokey').onclick = () => setAutoKey(!state.autoKey)
function updateAudioUi(): void {
  const m = state.music
  $('musicName').textContent = m ? m.name : state.videoAudio ? `(video audio)` : ''
  $('clearMusic').hidden = !m
  const el = m?.el ?? baseVideo()
  $('mute').hidden = !el
  if (el) $('mute').textContent = el.muted ? '🔇' : '🔊'
}
$('mute').onclick = () => {
  const el = state.music?.el ?? baseVideo()
  if (el) el.muted = !el.muted
  updateAudioUi()
}

// ---------- output size ----------
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
function outputSize(key: string): [number, number] {
  const size = OUTPUTS[key]
  if (size) return size
  const s = Math.min(1, 1920 / Math.max(source.width, source.height))
  return [even(source.width * s), even(source.height * s)]
}
function applyOutput(): void {
  const size = outputSize(state.output)
  if (size[0] !== pipeline.width || size[1] !== pipeline.height) pipeline.resize(size[0], size[1])
}
$<HTMLSelectElement>('output').onchange = (e) => {
  state.output = (e.target as HTMLSelectElement).value
  applyOutput()
}

// ---------- presets ----------
let userPresets: Preset[] = []
async function refreshPresets(select?: string): Promise<void> {
  userPresets = ((await window.api.listPresets()) as Preset[]).filter((p) => p && Array.isArray(p.chain))
  const opt = (p: Preset): string => `<option value="${p.name}">${p.name}</option>`
  $('presets').innerHTML =
    `<optgroup label="Built-in">${BUILTIN_PRESETS.map(opt).join('')}</optgroup>` +
    (userPresets.length ? `<optgroup label="My presets">${userPresets.map(opt).join('')}</optgroup>` : '')
  if (select) $<HTMLSelectElement>('presets').value = select
  sequencer.invalidate()
}
const findPreset = (name: string): Preset | undefined =>
  userPresets.find((p) => p.name === name) ?? BUILTIN_PRESETS.find((p) => p.name === name)

function applyPreset(p: Preset): void {
  state.chain.splice(0, state.chain.length, ...p.chain.map((l) => createInstance(l.effectId, l)))
  Object.assign(state.source, DEFAULT_SOURCE, p.source ?? {})
  srcPane?.refresh()
  if (p.output && p.output in OUTPUTS) {
    state.output = p.output
    $<HTMLSelectElement>('output').value = p.output
    applyOutput()
  }
  if (p.duration && !transport.master) transport.duration = p.duration
  syncDuration()
  chainPanel.setChain(state.chain)
  pruneLive()
  timeline.draw()
}

$<HTMLSelectElement>('presets').onchange = (e) => {
  const p = findPreset((e.target as HTMLSelectElement).value)
  if (p) applyPreset(p)
}
$('savePreset').onclick = async () => {
  const cur = $<HTMLSelectElement>('presets').value
  const name = await ask('Save preset as', BUILTIN_PRESETS.some((p) => p.name === cur) ? `${cur} copy` : cur)
  if (!name) return
  await window.api.savePreset(name, currentAsPreset(name))
  await refreshPresets(name)
  toast(`Saved preset “${name}”`)
}
const currentAsPreset = (name: string): Preset => ({
  name,
  output: state.output,
  duration: transport.duration,
  source: { ...state.source },
  chain: toPresetLayers(state.chain)
})
const allPresetNames = (): string[] => [...BUILTIN_PRESETS, ...userPresets].map((p) => p.name)

/** Save imported presets under names that don't clash with existing ones. */
async function importPresetObjects(list: unknown[]): Promise<void> {
  const valid = list.filter((p): p is Preset => !!p && typeof p === 'object' && Array.isArray((p as Preset).chain))
  const taken = new Set(allPresetNames())
  let last = ''
  for (const p of valid) {
    let name = String(p.name || 'Imported').slice(0, 60)
    for (let i = 2; taken.has(name); i++) name = `${String(p.name || 'Imported').slice(0, 55)} (${i})`
    taken.add(name)
    await window.api.savePreset(name, { ...p, name, builtin: false })
    last = name
  }
  await refreshPresets(last || undefined)
  toast(valid.length ? `Imported ${valid.length} preset${valid.length === 1 ? '' : 's'}` : 'No presets found in that file', !valid.length)
}

attachMenu($('presetMenu'), [
  {
    label: 'Export current look as preset file…',
    run: async () => {
      const name = $<HTMLSelectElement>('presets').value || 'My look'
      const p = await window.api.exportPreset(name, currentAsPreset(name))
      if (p) toast(`Exported ${p}`, false, () => window.api.reveal(p))
    }
  },
  { label: 'Import preset files…', run: async () => importPresetObjects(await window.api.importPresets()) },
  {
    label: 'Delete selected preset',
    danger: true,
    run: async () => {
      const name = $<HTMLSelectElement>('presets').value
      if (!userPresets.some((p) => p.name === name)) return toast('Built-in presets can’t be deleted')
      if ((await ask(`Delete “${name}”?`, null)) === null) return
      await window.api.deletePreset(name)
      await refreshPresets()
      toast(`Deleted “${name}”`)
    }
  }
])

// ---------- loading media ----------
const MAX_ANALYZE_BYTES = 600 * 1024 * 1024

async function loadLayerMedia(l: Layer, blob: Blob, name: string, path = ''): Promise<boolean> {
  closeWelcome()
  l.pendingPath = path
  try {
    await l.source.load(blob, name, path)
  } catch (err) {
    l.pendingPath = ''
    toast(String((err as Error).message || err), true)
    return false
  }
  l.pendingPath = ''
  l.version++
  const isBase = l === layers[0]
  if (l === activeLayer()) {
    $('srcName').textContent = name
    $('drop').classList.add('hidden')
  }
  // Only the bottom layer's video is heard (and drives the clock); upper layers are silent.
  const v = l.source.fileVideo
  if (v && (!isBase || state.music)) v.muted = true
  if (isBase) {
    state.videoAudio = null
    transport.attach(baseVideo(), state.music?.el ?? null, !!state.music)
    syncDuration()
  }
  applyOutput()
  updateAudioUi()
  refreshLayers()
  if (isBase && l.source.kind === 'video' && blob.size < MAX_ANALYZE_BYTES) {
    const a = await analyzeAudio(await blob.arrayBuffer())
    if (a && layers[0] === l && l.source.name === name) {
      state.videoAudio = { analysis: a, name, path }
      updateAudioUi()
      timeline.draw()
    }
  }
  return true
}
/** Load into the active layer (Open, drag & drop). */
const loadMedia = (blob: Blob, name: string, path = ''): Promise<boolean> => loadLayerMedia(activeLayer(), blob, name, path)

async function loadMusic(blob: Blob, name: string, path: string): Promise<void> {
  const analysis = blob.size < MAX_ANALYZE_BYTES ? await analyzeAudio(await blob.arrayBuffer()) : null
  if (!analysis) return toast(`No decodable audio in ${name}`, true)
  clearMusic(false)
  const url = URL.createObjectURL(blob)
  const el = new Audio(url)
  el.loop = true
  await new Promise<void>((res) => {
    el.onloadedmetadata = () => res()
    el.onerror = () => res()
  })
  state.music = { analysis, name, path, el, url }
  const bv = baseVideo()
  if (bv) bv.muted = true
  transport.attach(bv, el)
  syncDuration()
  updateAudioUi()
  toast(analysis.bpm ? `Music loaded · ${analysis.bpm} BPM · ${analysis.downbeats.length} bars` : `Music loaded · ${analysis.beats.length} beats detected`)
}

function clearMusic(reattach = true): void {
  const m = state.music
  if (!m) return
  m.el.pause()
  URL.revokeObjectURL(m.url)
  state.music = null
  if (reattach) {
    transport.attach(baseVideo(), null)
    syncDuration()
    updateAudioUi()
  }
}

$('open').onclick = () => $('file').click()
$('music').onclick = () => $('musicFile').click()
$('clearMusic').onclick = () => clearMusic()
$<HTMLInputElement>('file').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadMedia(f, f.name, window.api.pathForFile(f))
  ;(e.target as HTMLInputElement).value = ''
}
$<HTMLInputElement>('musicFile').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  if (f) loadMusic(f, f.name, window.api.pathForFile(f))
  ;(e.target as HTMLInputElement).value = ''
}
window.addEventListener('dragover', (e) => {
  if (e.dataTransfer?.types.includes('Files')) {
    e.preventDefault()
    $('viewport').classList.add('over')
  }
})
window.addEventListener('dragleave', () => $('viewport').classList.remove('over'))
window.addEventListener('drop', (e) => {
  $('viewport').classList.remove('over')
  const f = e.dataTransfer?.files?.[0]
  if (!f) return
  e.preventDefault()
  // Preset files import; audio-only files become the music track; images/videos become the source.
  if (/\.json$/i.test(f.name)) {
    f.text()
      .then((t) => importPresetObjects([JSON.parse(t)]))
      .catch(() => toast('That file is not a Glitch Chain preset', true))
  } else if (f.type.startsWith('audio/')) loadMusic(f, f.name, window.api.pathForFile(f))
  else loadMedia(f, f.name, window.api.pathForFile(f))
})

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || state.rendering) return
  if (e.code === 'Space') {
    e.preventDefault()
    setPlaying(!transport.playing)
  } else if (e.key === 'Home') transport.seek(0)
  else if (e.key.toLowerCase() === 'k' && !e.ctrlKey) setAutoKey(!state.autoKey)
  else if ((e.key === '[' || e.key === ']') && !e.ctrlKey) {
    const t = timeline.beatFrom(transport.t, e.key === ']' ? 1 : -1)
    if (t !== null) transport.seek(t)
  }
  else if (e.key.toLowerCase() === 'b' && !e.ctrlKey && !e.repeat) holdOriginal(true)
  else if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault()
    history.undo()
  } else if (e.ctrlKey && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
    e.preventDefault()
    history.redo()
  }
  else if (e.ctrlKey && e.key.toLowerCase() === 's') {
    e.preventDefault()
    void saveProject(e.shiftKey)
  } else if (e.ctrlKey && e.key.toLowerCase() === 'n') {
    e.preventDefault()
    void newProject()
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'o') {
    e.preventDefault()
    void openProject()
  } else if (e.ctrlKey && e.key.toLowerCase() === 'o') $('file').click()
  else if (e.ctrlKey && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    doRender()
  }
})

// ---------- export ----------
const baseName = (): string => (source.kind === 'placeholder' ? 'glitch' : source.name.replace(/\.[^.]+$/, '')) + '_glitch'

$('snap').onclick = () => {
  pipeline.toCanvas().toBlob(async (b) => {
    if (!b) return
    const p = await window.api.saveFile(`${baseName()}.png`, [{ name: 'PNG', extensions: ['png'] }], await b.arrayBuffer())
    if (p) toast(`Saved ${p}`, false, () => window.api.reveal(p))
  }, 'image/png')
}

/** Render the editor's current state to `out` (frame by frame). Shared by Render and the queue. */
function renderJob(
  out: string,
  c: { width: number; height: number; fps: number; codec: RenderChoice['codec']; includeAudio: boolean },
  onProgress: (frame: number, total: number) => void,
  signal: AbortSignal
): Promise<string> {
  const audio = currentAudio()
  const a = audio?.analysis ?? null
  const stack = [...layers]
  return renderOffline(
    {
      out,
      width: c.width,
      height: c.height,
      fps: c.fps,
      duration: transport.duration,
      codec: c.codec,
      audioPath: c.includeAudio && audio?.path ? audio.path : undefined
    },
    {
      pipeline,
      prepare: async () => {
        for (const [i, l] of stack.entries()) {
          l.source.fileVideo?.pause()
          const chains = i === 0 ? [...sequencer.allChains(), l.chain] : [l.chain]
          const need = maskNeeds([l.settings, ...chains.flat()])
          if (anyNeed(need)) await l.tracker.ensure(need)
          await l.tracker.reset()
        }
      },
      frame: async (t) => {
        const renders: LayerRender[] = []
        for (const [i, l] of stack.entries()) {
          const chain = i === 0 ? sequencer.chainAt(t, a) : l.chain
          const s = l.source
          const v = s.fileVideo
          if (v) {
            // Aim just inside the frame so rounding never lands on the previous one.
            await seekVideo(v, (t % v.duration) + 0.001)
            pipeline.uploadSource(v, s.width, s.height, l.id)
          } else if (t === 0) pipeline.uploadSource(s.el, s.width, s.height, l.id)
          const full = [l.settings, ...chain]
          const need = maskNeeds(full)
          // Stills are analyzed once; video frames every frame, awaited so each frame uses its own detections.
          if (anyNeed(need) && (v || t === 0)) await l.tracker.analyzeNow(v ?? s.el, s.width, s.height, need, !v)
          if (depthNeeded(full) && (v || t === 0)) await computeDepth(l)
          const sub = { ...subjectsFor(l, chain), tracks: await trackStore.prepare(trackIds([full]), t) }
          applyKeys(full, t)
          renders.push({ id: l.id, src: l.src, effects: chain, settings: l.settings, subjects: sub })
        }
        pipeline.renderLayers(renders, t, a)
      },
      restore: () => {
        for (const l of layers) l.source.dirty = true
      }
    },
    onProgress,
    signal
  )
}

async function doRender(auto?: { out: string; choice: RenderChoice }): Promise<void> {
  if (state.rendering) return
  if (layers.some((l) => l.source.kind === 'camera')) return toast('The webcam is live-only. Record a clip with your camera app and open it to render.', true)
  const audio = currentAudio()
  const choice =
    auto?.choice ??
    (await askRenderSettings({
      width: pipeline.width,
      height: pipeline.height,
      duration: transport.duration,
      audioLabel: audio?.path ? audio.name : null
    }))
  if (!choice) return
  if (choice.action !== 'render') return enqueue(choice)
  const out = auto?.out ?? (await window.api.renderChoose(baseName(), choice.codec))
  if (!out) return

  const wasPlaying = transport.playing
  setPlaying(false)
  state.rendering = true
  const ac = new AbortController()
  const progress = showRenderProgress(() => ac.abort())
  try {
    const path = await renderJob(out, choice, progress.update, ac.signal)
    toast(`Rendered ${path}`, false, () => window.api.reveal(path))
  } catch (err) {
    if ((err as Error).name === 'AbortError') toast('Render cancelled')
    else toast('Render failed: ' + String((err as Error).message || err), true)
  } finally {
    progress.close()
    state.rendering = false
    transport.seek(transport.t)
    setPlaying(wasPlaying)
  }
}
$('render').onclick = () => doRender()

// ---------- render queue ----------
const queue: QueueJob[] = []
let queueRunning = false
let queueAbort: AbortController | null = null
let refreshQueue = (): void => {}
let jobSeq = 0
const SOCIAL = ['9:16 · 1080×1920', '1:1 · 1080×1080', '16:9 · 1920×1080']

function updateQueueBadge(): void {
  const n = queue.filter((j) => j.status === 'queued').length
  $('queue').textContent = queueRunning ? 'Queue ▶' : n ? `Queue (${n})` : 'Queue'
}
function openQueue(): void {
  refreshQueue = openQueuePanel(queue, () => queueRunning, {
    run: runQueue,
    cancel: () => queueAbort?.abort(),
    reveal: (p) => window.api.reveal(p),
    changed: updateQueueBadge
  })
}
$('queue').onclick = openQueue

function enqueue(choice: RenderChoice): void {
  const base = layers[0].source
  if (!base.path || base.kind === 'camera' || base.kind === 'placeholder')
    return toast('The queue needs a source file: open an image or video first.', true)
  const outputs = choice.action === 'social' ? SOCIAL : [state.output]
  const look = sequencer.active ? 'sequence' : $<HTMLSelectElement>('presets').value || 'custom'
  for (const output of outputs) {
    queue.push({
      id: ++jobSeq,
      label: `${base.name} — ${look}`,
      sourcePath: base.path,
      sourceName: base.name,
      musicPath: state.music?.path ?? '',
      snapshot: serializeState(),
      sequence: structuredClone(sequencer.seq),
      output,
      scale: choice.scale,
      fps: choice.fps,
      codec: choice.codec,
      includeAudio: choice.includeAudio,
      duration: transport.duration,
      status: 'queued',
      progress: 0
    })
  }
  updateQueueBadge()
  refreshQueue()
  toast(`Added ${outputs.length} job${outputs.length === 1 ? '' : 's'} to the queue: click to open`, false, openQueue)
}

async function loadMediaPath(p: string): Promise<void> {
  const f = await window.api.readFile(p)
  if (!(await loadMedia(new Blob([f.data]), f.name, p))) throw new Error(`Could not open ${p}`)
}
async function setMusicPath(p: string): Promise<void> {
  if ((state.music?.path ?? '') === p) return
  if (!p) return clearMusic()
  const f = await window.api.readFile(p)
  await loadMusic(new Blob([f.data]), f.name, p)
}

/** Put a job's source, music, chain, sequence and output size into the editor. */
async function loadForJob(job: QueueJob): Promise<void> {
  if (job.sourcePath !== layers[0].source.path) await loadLayerPath(layers[0], job.sourcePath)
  await setMusicPath(job.musicPath)
  await restoreState(job.snapshot)
  sequencer.seq = structuredClone(job.sequence)
  sequencer.invalidate()
  state.output = job.output
  $<HTMLSelectElement>('output').value = job.output
  applyOutput()
  transport.duration = Math.min(job.duration, transport.maxDuration)
  syncDuration()
}

async function runQueue(): Promise<void> {
  if (queueRunning || !queue.some((j) => j.status === 'queued')) return
  const dir = await window.api.chooseFolder('Render queue: choose an output folder')
  if (!dir) return
  const original = { snap: serializeState(), seq: structuredClone(sequencer.seq), path: layers[0].source.path, kind: layers[0].source.kind, music: state.music?.path ?? '' }
  const wasPlaying = transport.playing
  setPlaying(false)
  queueRunning = true
  state.rendering = true
  queueAbort = new AbortController()
  updateQueueBadge()
  refreshQueue()
  try {
    for (const job of queue) {
      if (job.status !== 'queued') continue
      if (queueAbort.signal.aborted) break
      job.status = 'rendering'
      job.progress = 0
      refreshQueue()
      try {
        await loadForJob(job)
        const [w, h] = outputSize(job.output)
        const tag = job.output.split(' · ')[0].replace(':', 'x')
        const look = job.label.split(' — ')[1] ?? 'glitch'
        const out = await window.api.uniquePath(dir, `${job.sourceName.replace(/\.[^.]+$/, '')}_${look}_${tag}`, job.codec === 'prores' ? 'mov' : 'mp4')
        job.outFile = await renderJob(
          out,
          { width: even(w * job.scale), height: even(h * job.scale), fps: job.fps, codec: job.codec, includeAudio: job.includeAudio },
          (f, n) => {
            job.progress = f / n
            if (f % 8 === 0 || f === n) refreshQueue()
          },
          queueAbort.signal
        )
        job.status = 'done'
      } catch (err) {
        job.status = (err as Error).name === 'AbortError' ? 'cancelled' : 'failed'
        job.error = String((err as Error).message || err)
      }
      refreshQueue()
    }
  } finally {
    // Put the editor back the way it was before the queue ran.
    try {
      if (original.path && original.path !== layers[0].source.path && original.kind !== 'camera') await loadLayerPath(layers[0], original.path)
      await setMusicPath(original.music)
      await restoreState(original.snap)
      sequencer.seq = original.seq
      sequencer.invalidate()
      pruneLive()
    } catch {
      /* editor restore is best-effort; the renders themselves are done */
    }
    queueRunning = false
    state.rendering = false
    queueAbort = null
    setPlaying(wasPlaying)
    updateQueueBadge()
    refreshQueue()
    const done = queue.filter((j) => j.status === 'done').length
    const failed = queue.filter((j) => j.status === 'failed').length
    toast(`Queue finished: ${done} rendered${failed ? `, ${failed} failed` : ''}`, failed > 0, () => window.api.reveal(dir))
  }
}

// ---------- AI object masks (Segment Anything + Grounding DINO, in-app) ----------
const TRACK_FPS = 30
const ANALYSIS_SIDE = 1024
// Model-loading messages only add information; the step that asked for the model clears the bar when done.
const segmenter = new Segmenter((msg) => msg && maskEditor.setBusy(msg))

/** Output uv (y down) -> source pixel, the inverse of the source pass (fit / zoom / pan). */
function outputToSource(u: number, v: number): [number, number] {
  const ra = pipeline.width / pipeline.height
  const sa = source.width / source.height
  let sx = 1
  let sy = 1
  if (state.source.fit < 0.5) {
    if (sa > ra) sx = ra / sa
    else sy = sa / ra
  } else if (sa > ra) sy = sa / ra
  else sx = ra / sa
  const x = (u - 0.5) * (sx / state.source.zoom) + 0.5 + state.source.panX
  const yUp = (0.5 - v) * (sy / state.source.zoom) + 0.5 + state.source.panY
  return [x * source.width, (1 - yUp) * source.height]
}

/** Current source frame, downscaled for the models. */
function analysisCanvas(): { canvas: HTMLCanvasElement; scale: number } {
  const scale = Math.min(1, ANALYSIS_SIDE / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(source.width * scale))
  canvas.height = Math.max(1, Math.round(source.height * scale))
  canvas.getContext('2d')!.drawImage(source.el, 0, 0, canvas.width, canvas.height)
  return { canvas, scale }
}

const grow = (b: [number, number, number, number], k: number, w: number, h: number): [number, number, number, number] => {
  const dx = (b[2] - b[0]) * k
  const dy = (b[3] - b[1]) * k
  return [Math.max(0, b[0] - dx), Math.max(0, b[1] - dy), Math.min(w - 1, b[2] + dx), Math.min(h - 1, b[3] + dy)]
}
const area = (m: SegMask): number => (m.box ? (m.box[2] - m.box[0]) * (m.box[3] - m.box[1]) : 0)

async function segmentText(text: string, w: number, h: number): Promise<SegMask | null> {
  const boxes = (await segmenter.detect(text)).slice(0, 4)
  if (!boxes.length) return null
  const ms: SegMask[] = []
  for (const b of boxes) {
    const m = await segmenter.segmentInBox(b.box)
    if (m) ms.push(m)
  }
  return ms.length ? unionMasks(ms, w, h) : null
}

/**
 * Interactive selection on the preview: clicks and/or a text prompt drive SAM on the current frame and the
 * result shows live (tinted) through the real mask pipeline. "Track through clip" then follows the object
 * frame by frame, re-prompting SAM with where it was last seen.
 */
async function openTrackMaker(inst: Instance): Promise<void> {
  if (state.rendering) return
  if (source.kind === 'camera' || source.kind === 'placeholder') return toast('Open an image or video first.', true)
  setPlaying(false)
  const video = source.fileVideo
  const before = { source: inst.mask.source, track: inst.mask.track, show: inst.mask.show }
  const previewId = `preview_${inst.uid}`
  const t0 = transport.t
  let points: [number, number, number][] = []
  let text = ''
  let current: SegMask | null = null
  let busy = false
  const frame = analysisCanvas()

  const showPreview = async (m: SegMask | null): Promise<void> => {
    current = m
    if (!m) {
      trackStore.remove(previewId)
      inst.mask.track = ''
      return
    }
    trackStore.add({ id: previewId, label: '(selecting…)', engine: 'preview', sourcePath: '', fps: TRACK_FPS, frames: [await maskToPng(m)] })
    Object.assign(inst.mask, { source: 'track', track: previewId, show: true })
    chainPanel.refreshValues()
  }
  let message = ''
  const work = async (label: string, fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    busy = true
    message = ''
    maskEditor.setBusy(label)
    try {
      await fn()
      if (!message) maskEditor.setBusy('')
    } catch (err) {
      maskEditor.setBusy('Failed: ' + String((err as Error).message || err).slice(0, 120))
    } finally {
      busy = false
    }
  }
  await work('Loading Segment Anything…', async () => {
    await segmenter.setImage(frame.canvas)
  })

  const recompute = async (): Promise<void> => {
    const { width: w, height: h } = frame.canvas
    let m: SegMask | null = null
    if (text) m = await segmentText(text, w, h)
    if (points.length) {
      const pm = await segmenter.segment({ points })
      m = m && !points.some(([, , l]) => l === 0) ? unionMasks([m, pm], w, h) : pm
    }
    await showPreview(m)
    if (text && !m) {
      message = `No “${text}” found: try other words or click it`
      maskEditor.setBusy(message)
    }
  }

  const finish = async (commit: boolean): Promise<void> => {
    maskEditor.stop()
    trackStore.remove(previewId)
    if (!commit || !current) {
      Object.assign(inst.mask, before)
      chainPanel.render()
      return
    }
    const id = `trk_${Date.now().toString(36)}`
    const name = text || 'object'
    let frames: (Blob | null)[]
    if (!video) frames = [await maskToPng(current)]
    else {
      const out = await trackClip(current, text, t0, maskEditor.trackStep)
      if (!out) {
        Object.assign(inst.mask, before)
        chainPanel.render()
        return
      }
      frames = out
    }
    const track = { id, label: `${name} · ${source.name}`, engine: `SAM${text ? ' + Grounding DINO: ' + text : ' (clicked)'}`, sourcePath: source.path, fps: TRACK_FPS, frames }
    trackStore.add(track)
    await window.api.saveTrack(
      { id, label: track.label, engine: track.engine, sourcePath: track.sourcePath, fps: TRACK_FPS, frameCount: frames.length },
      await Promise.all(frames.map((f) => (f ? f.arrayBuffer() : null)))
    )
    Object.assign(inst.mask, { source: 'track', track: id, show: false })
    chainPanel.render()
    toast(`Object mask ready${video ? `: ${frames.filter(Boolean).length} frames tracked` : ''}`)
  }

  maskEditor.aiSelect(
    {
      point: (u, v, label) =>
        void work('Segmenting…', async () => {
          const [sx, sy] = outputToSource(u, v)
          points.push([sx * frame.scale, sy * frame.scale, label])
          await recompute()
        }),
      find: (t) =>
        void work(`Looking for “${t}”…`, async () => {
          text = t
          await recompute()
        }),
      clear: () => {
        points = []
        text = ''
        void showPreview(null)
      },
      commit: () => {
        if (busy) return
        if (!current) return maskEditor.setBusy('Select something first: click it or type what it is')
        void finish(true)
      },
      cancel: () => void finish(false)
    },
    !!video
  )
}

/** Fill unanalyzed frames by cross-fading the masks of the nearest analyzed frames on each side. */
async function fillBetween(frames: (Blob | null)[], step: number): Promise<void> {
  const decode = async (b: Blob): Promise<ImageData> => {
    const bmp = await createImageBitmap(b)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    bmp.close()
    return g.getImageData(0, 0, c.width, c.height)
  }
  const known = frames.map((f, i) => (f ? i : -1)).filter((i) => i >= 0)
  for (let k = 0; k < known.length - 1; k++) {
    const a = known[k]
    const b = known[k + 1]
    if (b - a < 2 || b - a > step) continue
    const [A, B] = await Promise.all([decode(frames[a]!), decode(frames[b]!)])
    if (A.width !== B.width || A.height !== B.height) continue
    for (let i = a + 1; i < b; i++) {
      const w = (i - a) / (b - a)
      const out = new ImageData(A.width, A.height)
      for (let p = 0; p < out.data.length; p += 4) {
        const v = A.data[p] * (1 - w) + B.data[p] * w
        out.data[p] = out.data[p + 1] = out.data[p + 2] = v
        out.data[p + 3] = 255
      }
      const c = new OffscreenCanvas(A.width, A.height)
      c.getContext('2d')!.putImageData(out, 0, 0)
      frames[i] = await c.convertToBlob({ type: 'image/png' })
    }
  }
}

/** Follow the object through the clip from the selection frame, forward then backward. Null if cancelled. */
async function trackClip(first: SegMask, text: string, t0: number, step = 1): Promise<(Blob | null)[] | null> {
  const v = source.fileVideo!
  const total = Math.max(1, Math.round(transport.duration * TRACK_FPS))
  const i0 = Math.min(total - 1, Math.round(t0 * TRACK_FPS))
  const frames: (Blob | null)[] = new Array(total).fill(null)
  frames[i0] = await maskToPng(first)
  // Everything is judged against the original selection, so errors can't compound frame after frame.
  const refArea = Math.max(1, area(first))
  const refW = first.box ? first.box[2] - first.box[0] : 1
  const refH = first.box ? first.box[3] - first.box[1] : 1
  const frameArea = first.w * first.h
  const plausible = (m: SegMask | null): m is SegMask => {
    if (!m || !m.box) return false
    const a = area(m)
    if (a > refArea * 3 || a < refArea * 0.25) return false
    // A mask that suddenly covers most of the frame has leaked into the background.
    return a / frameArea < 0.6 || refArea / frameArea > 0.4
  }
  const searchBox = (b: [number, number, number, number], w: number, h: number): [number, number, number, number] => {
    const cx = (b[0] + b[2]) / 2
    const cy = (b[1] + b[3]) / 2
    const bw = Math.min(Math.max((b[2] - b[0]) * 1.15, refW * 0.6), refW * 1.6)
    const bh = Math.min(Math.max((b[3] - b[1]) * 1.15, refH * 0.6), refH * 1.6)
    return [Math.max(0, cx - bw / 2), Math.max(0, cy - bh / 2), Math.min(w - 1, cx + bw / 2), Math.min(h - 1, cy + bh / 2)]
  }
  let empty: Blob | null = null
  const emptyMask = async (): Promise<Blob> => (empty ??= await maskToPng({ w: first.w, h: first.h, data: new Uint8Array(first.w * first.h), score: 0, box: null }))

  state.rendering = true
  const ac = new AbortController()
  const progress = showRenderProgress(() => ac.abort(), 'Tracking object…')
  let done = 1
  try {
    for (const dir of [1, -1]) {
      let prev = first
      let misses = 0
      // Stride through the clip, but always finish on the first/last frame so nothing is left without a mask.
      const end = dir > 0 ? total - 1 : 0
      for (let i = i0 + dir * step; dir > 0 ? i < total + step - 1 : i > -step; i += dir * step) {
        if (dir > 0 ? i > end : i < end) i = end
        if (i === i0) break
        if (ac.signal.aborted) return null
        await seekVideo(v, ((i / TRACK_FPS) % v.duration) + 0.001)
        const f = analysisCanvas()
        await segmenter.setImage(f.canvas)
        const { width: w, height: h } = f.canvas
        let m: SegMask | null = null
        // Text prompt: re-detect every frame (re-acquires after cuts). Otherwise search where it was last seen.
        if (text) m = await segmentText(text, w, h)
        if (!plausible(m) && prev.box) m = await segmenter.segmentInBox(searchBox(prev.box, w, h), interiorPoints(prev))
        if (plausible(m)) {
          frames[i] = await maskToPng(m)
          prev = m
          misses = 0
        } else if (++misses > 5) {
          // Lost (cut away, occluded): no mask rather than a stale one; keep searching near the last sighting.
          frames[i] = await emptyMask()
        }
        progress.update(++done, Math.ceil(total / step))
      }
    }
    // Frames that were skipped get the average of their analyzed neighbours, so motion stays smooth.
    if (step > 1) await fillBetween(frames, step)
    return frames
  } finally {
    progress.close()
    state.rendering = false
    transport.seek(t0)
  }
}

/** Load tracks saved in earlier sessions. */
async function loadSavedTracks(): Promise<void> {
  const metas = (await window.api.listTracks()) as { id: string; label: string; engine: string; sourcePath: string; fps: number; frameCount: number }[]
  for (const m of metas) {
    const bufs = await window.api.loadTrack(m.id, m.frameCount)
    trackStore.add({ ...m, frames: bufs.map((b) => (b ? new Blob([b], { type: 'image/png' }) : null)) })
  }
}

// ---------- projects (.glitch) ----------
const PROJECT_VERSION = 2
let projectPath: string | null = null
let savedSnapshot = ''
let lastDirty: boolean | null = null

interface ProjectFile {
  app: 'glitch-chain'
  version: number
  savedAt: string
  source: { path: string; name: string } | null
  music: { path: string; name: string } | null
  editor: unknown
  sequence: ReturnType<typeof defaultSequence>
  playhead: number
  /** Mask tracks used by the project, embedded so it opens with its masks on any machine. */
  tracks: { id: string; label: string; engine: string; sourcePath: string; fps: number; frames: (string | null)[] }[]
  /** Set in autosaves: the project file they belong to. */
  autosaveOf?: string | null
}

const projectName = (): string => (projectPath ? projectPath.split(/[\\/]/).pop()!.replace(/\.glitch$/i, '') : 'Untitled')
/** Everything a project saves; compared with the last save to know if there are unsaved changes. */
const projectSnapshot = (): string =>
  [serializeState(), JSON.stringify(sequencer.seq), state.music?.path ?? '', trackIds(allChains()).join(',')].join('|')
const isDirty = (): boolean => projectSnapshot() !== savedSnapshot

function updateTitle(force = false): void {
  const dirty = isDirty()
  if (!force && dirty === lastDirty) return
  lastDirty = dirty
  $('projName').textContent = `${dirty ? '• ' : ''}${projectName()}`
  void window.api.setTitle(`${dirty ? '• ' : ''}${projectName()} — Glitch Chain`)
}
function markSaved(): void {
  savedSnapshot = projectSnapshot()
  updateTitle(true)
}

const blobToB64 = (b: Blob): Promise<string> =>
  new Promise((res, rej) => {
    const r = new FileReader()
    r.onload = () => res(String(r.result).split(',')[1])
    r.onerror = () => rej(r.error)
    r.readAsDataURL(b)
  })
const b64ToBlob = (s: string, type = 'image/png'): Blob => {
  const bin = atob(s)
  const u8 = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
  return new Blob([u8], { type })
}

async function buildProject(): Promise<string> {
  const tracks: ProjectFile['tracks'] = []
  for (const id of trackIds(allChains())) {
    const t = trackStore.get(id)
    if (!t) continue
    tracks.push({ id, label: t.label, engine: t.engine, sourcePath: t.sourcePath, fps: t.fps, frames: await Promise.all(t.frames.map((b) => (b ? blobToB64(b) : null))) })
  }
  const file: ProjectFile = {
    app: 'glitch-chain',
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    source: layers[0].source.kind === 'image' || layers[0].source.kind === 'video' ? { path: layers[0].source.path, name: layers[0].source.name } : null,
    music: state.music ? { path: state.music.path, name: state.music.name } : null,
    editor: JSON.parse(serializeState()),
    sequence: sequencer.seq,
    playhead: transport.t,
    tracks
  }
  return JSON.stringify(file)
}

/** Find a media file that may have moved since the project was saved (asks the user if needed). */
async function findMedia(p: { path: string; name: string }, kind: 'media' | 'audio'): Promise<string | null> {
  if (p.path && (await window.api.fileExists(p.path))) return p.path
  const pick = await choose(`Can't find “${p.name}”`, `It was at ${p.path || '(unknown)'}. It may have been moved or renamed.`, ['Skip', 'Locate…'])
  if (pick !== 1) return null
  return window.api.locateFile(`Where is “${p.name}”?`, p.name, kind)
}

async function applyProject(text: string, path: string | null): Promise<boolean> {
  let p: ProjectFile
  try {
    p = JSON.parse(text)
    if (p.app !== 'glitch-chain' || !p.editor) throw new Error('not a Glitch Chain project')
  } catch (err) {
    toast('Could not open project: ' + String((err as Error).message || err), true)
    return false
  }
  if (p.version > PROJECT_VERSION) toast('This project was saved by a newer version; some settings may be ignored.', true)
  // Tracks first: the chain refers to them. Keep them in the app's library too, so they survive restarts.
  for (const t of p.tracks ?? []) {
    if (trackStore.get(t.id)) continue
    const frames = t.frames.map((f) => (f ? b64ToBlob(f) : null))
    trackStore.add({ id: t.id, label: t.label, engine: t.engine, sourcePath: t.sourcePath, fps: t.fps, frames })
    await window.api.saveTrack({ id: t.id, label: t.label, engine: t.engine, sourcePath: t.sourcePath, fps: t.fps, frameCount: frames.length }, await Promise.all(frames.map((b) => (b ? b.arrayBuffer() : null))))
  }
  // v1 projects hold one source + one chain; v2 hold layers (each with its media path).
  const ed = p.editor as { layers?: SerLayer[]; source?: SourceParams; chain?: unknown[]; output: string; duration: number; active?: number }
  if (!ed.layers)
    ed.layers = [{ id: layers[0].id, name: 'Layer 1', path: p.source?.path ?? '', src: ed.source ?? { ...DEFAULT_SOURCE }, settings: null, chain: (ed.chain ?? []) as SerLayer['chain'] }]
  for (const sl of ed.layers) {
    if (!sl.path) continue
    const name = sl.path.split(/[\\/]/).pop()!
    const found = await findMedia({ path: sl.path, name }, 'media')
    if (!found) toast(`“${name}” not loaded`, true)
    sl.path = found ?? ''
  }
  if (p.music) {
    const mp = await findMedia(p.music, 'audio')
    await setMusicPath(mp ?? '')
  } else clearMusic()
  await restoreState(JSON.stringify(ed))
  sequencer.seq = { ...defaultSequence(), ...(p.sequence ?? {}) }
  sequencer.save()
  sequencer.invalidate()
  pruneLive()
  updateSequenceUi()
  transport.seek(Math.min(p.playhead ?? 0, transport.duration))
  projectPath = path
  history.reset()
  markSaved()
  return true
}

/** Save (or Save As). Returns false if cancelled or failed. */
async function saveProject(saveAs = false): Promise<boolean> {
  try {
    const out = await window.api.saveProject(saveAs ? null : projectPath, projectName(), await buildProject())
    if (!out) return false
    projectPath = out
    markSaved()
    await window.api.clearAutosave()
    toast(`Saved ${out}`)
    return true
  } catch (err) {
    toast('Save failed: ' + String((err as Error).message || err), true)
    return false
  }
}

/** If there are unsaved changes, ask Save / Don't save / Cancel. True means go ahead. */
async function confirmDiscard(action: string): Promise<boolean> {
  if (!isDirty()) return true
  const i = await choose(`Save changes to “${projectName()}”?`, `Your changes will be lost if you ${action} without saving.`, ['Cancel', "Don't save", 'Save'])
  if (i === 2) return saveProject()
  return i === 1
}

async function openProject(path?: string, skipConfirm = false): Promise<void> {
  if (state.rendering || (!skipConfirm && !(await confirmDiscard('open another project')))) return
  const r = await window.api.openProject(path)
  if (!r) return
  if (await applyProject(r.text, r.path)) {
    await window.api.clearAutosave()
    toast(`Opened ${projectName()}`)
  }
}

async function newProject(): Promise<void> {
  if (state.rendering || !(await confirmDiscard('start a new project'))) return
  for (const l of layers.slice(1)) disposeLayer(l)
  layers.length = 1
  const base = layers[0]
  base.source.reset()
  base.version++
  base.name = 'Layer 1'
  base.settings = createInstance('layer')
  Object.assign(base.src, DEFAULT_SOURCE)
  selectLayer(0)
  clearMusic()
  transport.attach(null, null)
  transport.duration = 10
  sequencer.seq = defaultSequence()
  sequencer.save()
  sequencer.invalidate()
  applyPreset(BUILTIN_PRESETS[0])
  $<HTMLSelectElement>('presets').value = BUILTIN_PRESETS[0].name
  updateSequenceUi()
  transport.seek(0)
  projectPath = null
  history.reset()
  markSaved()
  await window.api.clearAutosave()
}

attachMenu($('projectMenu'), async () => {
  const recent = await window.api.recentProjects()
  return [
    { label: 'New project', hint: 'Ctrl+N', run: () => void newProject() },
    { label: 'Open project…', hint: 'Ctrl+Shift+O', run: () => void openProject() },
    { label: 'Save', hint: 'Ctrl+S', run: () => void saveProject() },
    { label: 'Save as…', hint: 'Ctrl+Shift+S', run: () => void saveProject(true) },
    ...(recent.length ? [{ label: 'Recent', heading: true }] : []),
    ...recent.map((r) => ({
      label: r.path.split(/[\\/]/).pop()!.replace(/\.glitch$/i, ''),
      hint: r.exists ? '' : 'missing',
      disabled: !r.exists,
      run: () => void openProject(r.path)
    })),
    { label: 'Welcome screen', run: () => void openWelcome() }
  ]
})

// Autosave: a separate file, so a crash never loses more than ~30 s and never touches the real project file.
function startAutosave(ms: number): void {
  setInterval(async () => {
    if (state.rendering || !isDirty()) return
    try {
      const text = await buildProject()
      await window.api.autosave(JSON.stringify({ ...JSON.parse(text), autosaveOf: projectPath }))
    } catch {
      /* autosave is best-effort */
    }
  }, ms)
}

/** Offer recovered work after a crash; true if there was some to offer. */
async function offerAutosaveRestore(): Promise<boolean> {
  const a = await window.api.readAutosave()
  if (!a) return false
  const when = new Date(a.time).toLocaleString()
  const i = await choose('Restore unsaved work?', `Glitch Chain closed without saving. Recovered work from ${when}.`, ['Discard', 'Restore'])
  if (i === 1) {
    const of = (JSON.parse(a.text) as ProjectFile).autosaveOf ?? null
    if (await applyProject(a.text, of)) {
      // Restored work isn't saved anywhere yet: keep it marked as changed.
      savedSnapshot = ''
      updateTitle(true)
      toast('Recovered unsaved work')
    }
  } else await window.api.clearAutosave()
  return true
}

const openWelcome = (): Promise<void> =>
  showWelcome({
    openMedia: () => $('open').click(),
    camera: () => $('camera').click(),
    openProject: (p) => void openProject(p),
    browseLooks: () => $('browse').click(),
    recent: () => window.api.recentProjects()
  })

// Closing the window: offer to save first.
window.api.onCloseRequest(async () => {
  await window.api.ackClose()
  if (!isDirty() || (await confirmDiscard('close'))) {
    await window.api.clearAutosave()
    await window.api.closeNow(true)
  } else await window.api.closeNow(false)
})
window.api.onOpenProject((p) => void openProject(p))

// ---------- AI device indicator ----------
const MODEL_NAMES: Record<string, string> = {
  face: 'Face detector',
  person: 'Person segmentation',
  'body parts': 'Hair / skin / clothes',
  hand: 'Hands & fingers',
  pose: 'Body pose (arms, legs)',
  object: 'Object detector (80 types)'
}
/** Every loaded model with the processor it really runs on. */
function aiDevices(): { name: string; device: 'GPU' | 'CPU' }[] {
  const out: { name: string; device: 'GPU' | 'CPU' }[] = []
  for (const [k, d] of Object.entries(SubjectTracker.devices)) out.push({ name: MODEL_NAMES[k] ?? k, device: d })
  if (segmenter.device) out.push({ name: 'Segment Anything + Grounding DINO', device: segmenter.device === 'webgpu' ? 'GPU' : 'CPU' })
  if (depthEstimator.device) out.push({ name: 'Depth Anything', device: depthEstimator.device === 'webgpu' ? 'GPU' : 'CPU' })
  return out
}
function updateAiStatus(): void {
  const list = aiDevices()
  const gpu = list.filter((m) => m.device === 'GPU').length
  const cpu = list.length - gpu
  const el = $('aiStatus')
  el.textContent = list.length ? `AI · ${gpu ? `${gpu} GPU` : ''}${gpu && cpu ? ' · ' : ''}${cpu ? `${cpu} CPU` : ''}` : 'AI'
  el.classList.toggle('has-cpu', cpu > 0)
}
attachMenu($('aiStatus'), () => {
  const list = aiDevices()
  if (!list.length) return [{ label: 'No AI models loaded yet: they load the first time a mask or effect needs them.', disabled: true }]
  return [
    { label: 'Loaded AI models', heading: true },
    ...list.map((m) => ({ label: m.name, hint: m.device, disabled: true })),
    { label: 'Hands run on the CPU on purpose (the GPU version returns no hands on some cards).', heading: true }
  ]
})

// ---------- preset sequence ----------
function updateSequenceUi(): void {
  $('sequence').classList.toggle('active', sequencer.active)
  const banner = $('seqBanner')
  banner.hidden = !sequencer.active
  if (sequencer.active) {
    const now = sequencer.itemAt(transport.t, currentAudio()?.analysis ?? null)
    banner.textContent = `⇄ Sequence on · now playing “${now}”. The chain below is used only where the sequence says “(current chain)”.`
  }
}
$('sequence').onclick = () =>
  openSequenceDialog(sequencer.seq, allPresetNames(), !!currentAudio()?.analysis.beats.length, () => {
    sequencer.save()
    sequencer.invalidate()
    pruneLive()
    updateSequenceUi()
    timeline.draw()
  })

// ---------- undo / redo ----------
/** Keyframed values are derived from keys every frame; leaving them out keeps playback from looking like edits. */
function serInst(i: Instance): Record<string, unknown> {
  const params = { ...i.params }
  for (const k of Object.keys(i.keys)) if (i.keys[k].length) delete params[k]
  return { uid: i.uid, effectId: i.effectId, enabled: i.enabled, params, mods: i.mods, keys: i.keys, mask: i.mask }
}
function serializeState(): string {
  return JSON.stringify({
    output: state.output,
    duration: +transport.duration.toFixed(4),
    active,
    layers: layers.map((l) => ({
      id: l.id,
      name: l.name,
      path: l.source.path || l.pendingPath,
      src: l.src,
      settings: serInst(l.settings),
      chain: l.chain.map(serInst)
    }))
  })
}

interface SerLayer {
  id: string
  name: string
  path: string
  src: SourceParams
  settings: (Instance & PresetLayer) | null
  chain: (Instance & PresetLayer)[]
}

function disposeLayer(l: Layer): void {
  pipeline.gl.deleteTexture(l.depth.tex)
  l.source.reset()
  l.tracker.dispose()
  pipeline.dropSource(l.id)
}

/** Put a saved state back: reconcile layers by id (keeping loaded media), load any media that changed. */
async function restoreState(snap: string): Promise<void> {
  const d = JSON.parse(snap) as { output: string; duration: number; active?: number; layers?: SerLayer[]; source?: SourceParams; chain?: (Instance & PresetLayer)[] }
  // Older single-chain snapshots / projects become one layer.
  const list: SerLayer[] = d.layers ?? [
    { id: layers[0].id, name: layers[0].name, path: layers[0].source.path, src: d.source ?? { ...DEFAULT_SOURCE }, settings: null, chain: d.chain ?? [] }
  ]
  const oldBase = layers[0]
  const loads: Promise<void>[] = []
  const next = list.map((sl) => {
    const l = layers.find((x) => x.id === sl.id) ?? makeLayer(sl.name, sl.id)
    l.name = sl.name
    Object.assign(l.src, DEFAULT_SOURCE, sl.src ?? {})
    if (sl.settings) l.settings = { ...createInstance('layer', sl.settings), uid: sl.settings.uid }
    l.chain.splice(0, l.chain.length, ...sl.chain.map((x) => ({ ...createInstance(x.effectId, x), uid: x.uid })))
    const cur = l.source.path || l.pendingPath
    if (sl.path && sl.path !== cur) loads.push(loadLayerPath(l, sl.path).catch(() => toast(`Could not open ${sl.path}`, true)))
    else if (!sl.path && cur) {
      l.source.reset()
      l.version++
    }
    return l
  })
  for (const old of layers) if (!next.includes(old)) disposeLayer(old)
  layers.splice(0, layers.length, ...next)
  if (layers[0] !== oldBase) transport.attach(baseVideo(), state.music?.el ?? null, true)
  if (d.output !== state.output && d.output in OUTPUTS) {
    state.output = d.output
    $<HTMLSelectElement>('output').value = d.output
    applyOutput()
  }
  const setDuration = (): void => {
    transport.duration = Math.min(d.duration, transport.maxDuration)
    syncDuration()
  }
  setDuration()
  selectLayer(Math.min(Math.max(0, d.active ?? 0), layers.length - 1))
  pruneLive()
  timeline.draw()
  if (loads.length) {
    await Promise.all(loads)
    // Loading a base video resets the timeline length to the clip; the saved length wins.
    setDuration()
  }
}
const history = new History(serializeState, restoreState, () => {
  $<HTMLButtonElement>('undo').disabled = !history.canUndo
  $<HTMLButtonElement>('redo').disabled = !history.canRedo
})
$('undo').onclick = () => history.undo()
$('redo').onclick = () => history.redo()

// ---------- layers ----------
async function loadLayerPath(l: Layer, p: string): Promise<void> {
  const f = await window.api.readFile(p)
  if (!(await loadLayerMedia(l, new Blob([f.data]), f.name, p))) throw new Error(`Could not open ${p}`)
}

function selectLayer(i: number): void {
  maskEditor?.stop()
  active = i
  source = layers[i].source
  tracker = layers[i].tracker
  buildSourcePane()
  chainPanel.setChain(layers[i].chain, layers[i].settings)
  $('srcName').textContent = source.kind === 'placeholder' ? '' : source.name
  $('drop').classList.toggle('hidden', source.kind !== 'placeholder' || i > 0)
  refreshLayers(true)
  timeline.draw()
}

let layersSig = ''
function refreshLayers(force = false): void {
  const rows = layers.map((l) => ({
    id: l.id,
    name: l.name,
    visible: l.settings.enabled,
    blend: Number(l.settings.params.blend ?? 0),
    opacity: Number(l.settings.params.opacity ?? 1),
    media: l.pendingPath ? 'loading…' : l.source.kind === 'placeholder' ? '' : l.source.name
  }))
  const sig = JSON.stringify(rows) + activeLayer().id
  if (!force && sig === layersSig) return
  layersSig = sig
  layersPanel.render(rows, activeLayer().id)
}

const layerIndex = (id: string): number => layers.findIndex((l) => l.id === id)
const layersPanel = new LayersPanel($('layers'), {
  select: (id) => selectLayer(layerIndex(id)),
  toggle: (id, visible) => {
    layers[layerIndex(id)].settings.enabled = visible
    chainPanel.render()
    refreshLayers()
  },
  rename: async (id) => {
    const l = layers[layerIndex(id)]
    const name = await ask('Layer name', l.name)
    if (name) l.name = name
    refreshLayers()
  },
  remove: (id) => {
    if (layers.length < 2) return
    const i = layerIndex(id)
    const wasBase = i === 0
    disposeLayer(layers[i])
    layers.splice(i, 1)
    if (wasBase) transport.attach(baseVideo(), state.music?.el ?? null, true)
    selectLayer(Math.min(active >= i ? Math.max(0, active - 1) : active, layers.length - 1))
    pruneLive()
  },
  reorder: (ids) => {
    const cur = activeLayer()
    const base = layers[0]
    layers.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id))
    if (layers[0] !== base) transport.attach(baseVideo(), state.music?.el ?? null, true)
    selectLayer(layers.indexOf(cur))
  },
  add: () => $('layerFile').click(),
  duplicate: (id) => {
    const src = layers[layerIndex(id)]
    const l = makeLayer(`${src.name} copy`)
    Object.assign(l.src, src.src)
    l.settings = createInstance('layer', structuredClone({ ...src.settings }))
    l.chain.push(...src.chain.map((x) => createInstance(x.effectId, structuredClone({ ...x }))))
    layers.splice(layerIndex(id) + 1, 0, l)
    selectLayer(layers.indexOf(l))
    if (src.source.path) void loadLayerPath(l, src.source.path)
  }
})
$<HTMLInputElement>('layerFile').onchange = (e) => {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  const l = makeLayer(`Layer ${layers.length + 1}`)
  layers.push(l)
  selectLayer(layers.length - 1)
  void loadLayerMedia(l, f, f.name, window.api.pathForFile(f))
}

/** Upper layers' videos follow the timeline (the bottom layer's video is the clock itself). */
function syncLayerVideos(): void {
  for (const l of layers.slice(1)) {
    const v = l.source.fileVideo
    if (!v || !v.duration) continue
    const want = transport.t % v.duration
    if (transport.playing) {
      if (v.paused) void v.play().catch(() => {})
      if (Math.abs(v.currentTime - want) > 0.25 && !v.seeking) v.currentTime = want
    } else {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - want) > 0.03 && !v.seeking) v.currentTime = want
    }
  }
}

// ---------- compare ----------
let compareBeforeHold = 0
function setCompare(mode: number): void {
  pipeline.compare.mode = mode
  $('compare').classList.toggle('active', mode === 2)
}
function holdOriginal(on: boolean): void {
  if (on && pipeline.compare.mode !== 1) {
    compareBeforeHold = pipeline.compare.mode
    pipeline.compare.mode = 1
  } else if (!on && pipeline.compare.mode === 1) pipeline.compare.mode = compareBeforeHold
}
window.addEventListener('keyup', (e) => e.key.toLowerCase() === 'b' && holdOriginal(false))
window.addEventListener('blur', () => holdOriginal(false))
$('compare').onclick = () => setCompare(pipeline.compare.mode === 2 ? 0 : 2)
const moveSplit = (e: PointerEvent): void => {
  if (pipeline.compare.mode === 2 && (e.buttons & 1 || e.type === 'pointerdown'))
    pipeline.compare.split = Math.min(1, Math.max(0, e.offsetX / canvas.clientWidth))
}
canvas.addEventListener('pointerdown', (e) => {
  if (pipeline.compare.mode !== 2) return
  canvas.setPointerCapture(e.pointerId)
  moveSplit(e)
})
canvas.addEventListener('pointermove', moveSplit)

// ---------- camera ----------
$('camera').onclick = async () => {
  try {
    await source.loadCamera()
  } catch (err) {
    return toast('Camera unavailable: ' + String((err as Error).message || err), true)
  }
  $('srcName').textContent = source.name
  $('drop').classList.add('hidden')
  activeLayer().version++
  if (active === 0) state.videoAudio = null
  transport.attach(baseVideo(), state.music?.el ?? null, true)
  refreshLayers()
  syncDuration()
  applyOutput()
  updateAudioUi()
}

// ---------- preset browser ----------
function presetThumb(p: Preset): HTMLCanvasElement {
  const chain = p.chain.map((l) => createInstance(l.effectId, l))
  const src = { ...DEFAULT_SOURCE, ...(p.source ?? {}) }
  const s = 320 / Math.max(pipeline.width, pipeline.height)
  const w = Math.round(pipeline.width * s)
  const h = Math.round(pipeline.height * s)
  try {
    return pipeline.withSize(w, h, () => {
      applyKeys(chain, transport.t)
      pipeline.renderLayers([{ id: activeLayer().id, src, effects: chain, settings: null, subjects: subjects(chain) }], transport.t, currentAudio()?.analysis ?? null)
      return pipeline.toCanvas()
    })
  } finally {
    pruneLive()
  }
}
$('browse').onclick = async () => {
  // Make sure face/person data exists for the current frame so masked presets preview properly.
  const all = [...BUILTIN_PRESETS, ...userPresets].flatMap((p) => p.chain.map((l) => createInstance(l.effectId, l)))
  const need = maskNeeds(all)
  if (anyNeed(need)) await tracker.analyzeNow(source.el, source.width, source.height, need, source.kind === 'image' || source.kind === 'placeholder')
  openPresetBrowser(
    [
      { title: 'Built-in', presets: BUILTIN_PRESETS },
      { title: 'My presets', presets: userPresets }
    ],
    presetThumb,
    (p) => {
      applyPreset(p)
      $<HTMLSelectElement>('presets').value = p.name
    }
  )
}

// ---------- render loop ----------
let last = performance.now()
let fpsAvg = 60
let tick = 0
let lastRefreshT = -1
const hasKeys = (): boolean => state.chain.some((i) => Object.keys(i.keys).length > 0)

function frame(now: number): void {
  requestAnimationFrame(frame)
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  if (state.rendering) return
  tick++
  transport.tick(dt)
  fpsAvg += (1 / Math.max(dt, 1e-3) - fpsAvg) * 0.05

  for (const l of layers) {
    if (l.source.ready && l.source.width > 0) {
      pipeline.uploadSource(l.source.el, l.source.width, l.source.height, l.id)
      l.source.dirty = false
    }
  }
  syncLayerVideos()
  const analysis = currentAudio()?.analysis ?? null
  const renders: LayerRender[] = layers.map((l, i) => {
    const chain = i === 0 ? sequencer.chainAt(transport.t, analysis) : l.chain
    trackLayer(l, chain, tick)
    applyKeys([l.settings, ...chain], transport.t)
    return { id: l.id, src: l.src, effects: chain, settings: l.settings, subjects: subjectsFor(l, chain) }
  })
  pipeline.renderLayers(renders, transport.t, analysis)
  maskEditor.update()

  if (tick % 2 === 0) {
    timeline.draw()
    $('tc').textContent = fmtTime(transport.t)
  }
  // Keep sliders in sync with keyframed values whenever the playhead moves (playing or scrubbing).
  if (tick % 6 === 0 && transport.t !== lastRefreshT && hasKeys()) {
    lastRefreshT = transport.t
    chainPanel.refreshValues()
  }
  if (tick % 15 === 0) history.poll()
  if (tick % 60 === 0) updateAiStatus()
  if (tick % 30 === 0) updateTitle()
  if (tick % 15 === 0) {
    updateSequenceUi()
    const need = maskNeeds([activeLayer().settings, ...(active === 0 ? sequencer.chainAt(transport.t, currentAudio()?.analysis ?? null) : state.chain)])
    refreshLayers()
    const plural = (n: number, w: string, many = w + 's'): string => `${n} ${n === 1 ? w : many}`
    const who = [
      need.face && plural(tracker.faces.length, 'face'),
      need.person && 'person mask',
      need.hands && plural(tracker.handCount, 'hand'),
      need.parts && 'body parts',
      need.objects && plural(tracker.objects.length, 'object'),
      depthNeeded([activeLayer().settings, ...state.chain]) && (activeLayer().depth.has ? 'depth' : 'depth…'),
      need.pose && (tracker.poseCount ? plural(tracker.poseCount, 'body', 'bodies') : 'no body')
    ]
      .filter(Boolean)
      .map((s) => ` · ${s}`)
      .join('')
    $('fps').textContent = `${Math.round(fpsAvg)} fps · ${pipeline.width}×${pipeline.height}${who}`
  }
}

// ---------- boot ----------
;(async () => {
  await refreshPresets(BUILTIN_PRESETS[0].name)
  sequencer.load()
  await loadSavedTracks().catch(() => toast('Some saved mask tracks could not be loaded', true))
  const auto = await window.api.autoload()
  const preset = findPreset(auto.preset) ?? BUILTIN_PRESETS[0]
  applyPreset(preset)
  $<HTMLSelectElement>('presets').value = preset.name
  if (auto.load) {
    const f = await window.api.readFile(auto.load)
    await loadMedia(new Blob([f.data]), f.name, auto.load)
  }
  if (auto.music) {
    const f = await window.api.readFile(auto.music)
    await loadMusic(new Blob([f.data]), f.name, auto.music)
  }
  applyOutput()
  syncDuration()
  history.reset()
  markSaved()
  refreshLayers(true)
  requestAnimationFrame(frame)
  if (auto.project) await openProject(auto.project, true)
  else if (!auto.load && !auto.render && !(await offerAutosaveRestore()) && auto.welcome && welcomeAtStartup()) void openWelcome()
  startAutosave(auto.autosaveMs || 30_000)

  if (auto.render) {
    const spec = { fps: 30, codec: 'h264', scale: 1, includeAudio: true, ...(auto.renderSpec ? JSON.parse(auto.renderSpec) : {}) }
    if (spec.sequence) {
      sequencer.seq = { on: true, mode: 'seconds', every: 1, order: 'loop', ...spec.sequence }
      sequencer.invalidate()
    }
    if (spec.duration) transport.duration = spec.duration
    if (spec.keys) setKey(state.chain[0], spec.keys.param, 0, spec.keys.from), setKey(state.chain[0], spec.keys.param, transport.duration, spec.keys.to)
    await new Promise((r) => setTimeout(r, 500))
    await doRender({
      out: auto.render,
      choice: {
        width: Math.round((pipeline.width * spec.scale) / 2) * 2,
        height: Math.round((pipeline.height * spec.scale) / 2) * 2,
        fps: spec.fps,
        codec: spec.codec,
        includeAudio: spec.includeAudio,
        scale: spec.scale,
        action: 'render'
      }
    })
    window.api.quit()
  }
})()
