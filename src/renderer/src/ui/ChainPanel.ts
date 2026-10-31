import { Pane } from 'tweakpane'
import type { BindingApi } from '@tweakpane/core'
import { EFFECTS, EFFECT_LIST, createInstance, newModulator, randomizeParams } from '../effects'
import type { Instance, ParamDef } from '../effects/types'
import { isNumberParam, SHAPE_PARAMS, type ShapeKey } from '../effects/types'
import { OBJECT_LABELS } from '../vision/types'

type Bindable = Record<string, unknown>

export interface ChainHost {
  /** Chain structure changed (add/remove/reorder). */
  onStructure: () => void
  /** User edited a number param by hand (used for keyframing). */
  onParamEdit: (inst: Instance, key: string, value: number) => void
  /** Mask tools that work on the preview. */
  pickColor: (inst: Instance) => void
  editShape: (inst: Instance) => void
  drawMask: (inst: Instance) => void
  /** Precomputed mask tracks the user can choose from, and a way to make one. */
  tracks: () => { id: string; label: string }[]
  makeTrack: (inst: Instance) => void
  deleteTrack: (id: string) => void
  /** Set a param from the depth under a click on the preview. */
  pickDepth: (inst: Instance, apply: (depth: number) => void) => void
  /** Ask for a file (for 'file' params); resolves the chosen path or null. */
  chooseFile: (filters: { name: string; extensions: string[] }[]) => Promise<string | null>
}

const MOD_SHAPES = {
  'LFO sine': 'sine',
  'LFO saw': 'saw',
  'LFO square': 'square',
  'LFO random': 'random',
  'audio level': 'audio-level',
  'audio low (bass)': 'audio-low',
  'audio mid': 'audio-mid',
  'audio high': 'audio-high',
  'audio beat': 'audio-beat',
  'audio kick': 'audio-kick',
  'audio snare': 'audio-snare',
  'audio hi-hat': 'audio-hat',
  'beat hit ⚡': 'hit',
  off: 'off'
}

const HIT_TRIGGERS = { beat: 'beat', 'off-beat': 'offbeat', 'bar (the "1")': 'bar', kick: 'kick', snare: 'snare', 'hi-hat': 'hat' }
const HIT_EVERY = { 'every one': 1, 'every 2nd': 2, 'every 3rd': 3, 'every 4th': 4, 'every 8th': 8 }

const baseLabel = (p: ParamDef): string => p.label ?? p.key
const keyedLabel = (p: ParamDef, inst: Instance): string => (inst.keys[p.key]?.length ? '◆ ' : '') + baseLabel(p)

/** Fixed precision per param (Tweakpane otherwise infers it from the first value, e.g. 10 decimals after undo). */
function numberFormat(p: { min: number; max: number; step?: number }): (v: number) => string {
  const d = p.step
    ? Math.max(0, (String(p.step).split('.')[1] ?? '').length)
    : Math.min(3, Math.max(0, Math.ceil(-Math.log10((p.max - p.min) / 1000))))
  return (v) => v.toFixed(d)
}

function bindParam(pane: Pane, obj: Bindable, p: ParamDef, label: string, into: Pick<Pane, 'addBinding'> = pane): BindingApi {
  if (isNumberParam(p)) return into.addBinding(obj, p.key, { label, min: p.min, max: p.max, step: p.step, format: numberFormat(p) })
  if (p.type === 'color') return into.addBinding(obj, p.key, { label, view: 'color' })
  if (p.type === 'select') return into.addBinding(obj, p.key, { label, options: p.options })
  return into.addBinding(obj, p.key, { label })
}

/** Stacked, reorderable effect cards. Mutates `chain` in place; panes write straight into instance params. */
export class ChainPanel {
  private panes: Pane[] = []
  private collapsed = new Set<string>()
  private dragUid = ''
  private refreshing = false
  private labels: { inst: Instance; p: ParamDef; b: BindingApi }[] = []

  constructor(
    private root: HTMLElement,
    private chain: Instance[],
    private host: ChainHost
  ) {
    this.render()
  }

  /** Pull animated (keyframed) values back into the sliders without treating it as a user edit. */
  refreshValues(): void {
    this.refreshing = true
    try {
      this.panes.forEach((p) => p.refresh())
    } finally {
      this.refreshing = false
    }
    this.updateKeyLabels()
  }

  updateKeyLabels(): void {
    for (const { inst, p, b } of this.labels) {
      const l = keyedLabel(p, inst)
      if (b.label !== l) b.label = l
    }
  }

  /** Shown pinned above the chain: the layer's settings card (not draggable / removable). */
  private pinned: Instance | null = null

  setChain(chain: Instance[], pinned: Instance | null = this.pinned): void {
    this.chain = chain
    this.pinned = pinned
    this.render()
  }

  add(effectId: string): void {
    this.chain.push(createInstance(effectId))
    this.changed()
  }

  private changed(): void {
    this.render()
    this.host.onStructure()
  }

  render(): void {
    this.panes.forEach((p) => p.dispose())
    this.panes = []
    this.labels = []
    this.root.innerHTML = ''
    if (this.pinned) this.root.appendChild(this.card(this.pinned, -1))
    this.chain.forEach((inst, idx) => this.root.appendChild(this.card(inst, idx)))

    const add = document.createElement('select')
    add.className = 'add-fx'
    add.innerHTML =
      '<option value="">＋ Add effect…</option>' + EFFECT_LIST.map((e) => `<option value="${e.id}">${e.name}</option>`).join('')
    add.onchange = () => add.value && this.add(add.value)
    this.root.appendChild(add)
  }

  private card(inst: Instance, idx: number): HTMLElement {
    const def = EFFECTS[inst.effectId]
    const el = document.createElement('div')
    const isPinned = inst === this.pinned
    el.className = 'card' + (isPinned ? ' layer-card' : '') + (inst.enabled ? '' : ' off')
    el.dataset.uid = inst.uid

    const head = document.createElement('div')
    head.className = 'card-head'
    head.draggable = !isPinned
    head.innerHTML = isPinned
      ? `<span class="grip">▣</span>
      <label class="toggle" title="Show layer"><input type="checkbox" ${inst.enabled ? 'checked' : ''}><span></span></label>
      <span class="name">Layer · blend, opacity, mask</span>
      <button data-a="fold" title="Collapse">${this.collapsed.has(inst.uid) ? '▸' : '▾'}</button>`
      : `
      <span class="grip" title="Drag to reorder">⠿</span>
      <label class="toggle" title="Enable"><input type="checkbox" ${inst.enabled ? 'checked' : ''}><span></span></label>
      <span class="idx">${String(idx + 1).padStart(2, '0')}</span>
      <span class="name">${def.name}</span>
      <button data-a="rand" title="Randomize">⚄</button>
      <button data-a="dup" title="Duplicate">⧉</button>
      <button data-a="del" title="Remove">✕</button>
      <button data-a="fold" title="Collapse">${this.collapsed.has(inst.uid) ? '▸' : '▾'}</button>`
    el.appendChild(head)

    const body = document.createElement('div')
    body.className = 'card-body'
    body.hidden = this.collapsed.has(inst.uid)
    el.appendChild(body)

    const pane = new Pane({ container: body })
    for (const p of def.params) {
      if (p.type === 'file') {
        const name = String(inst.params[p.key] || '').split(/[\\/]/).pop()
        pane.addButton({ label: p.label ?? p.key, title: name || 'Choose file…' }).on('click', async () => {
          const f = await this.host.chooseFile(p.filters)
          if (!f) return
          inst.params[p.key] = f
          Object.assign(inst.params, p.sets)
          this.render()
        })
        continue
      }
      const b = bindParam(pane, inst.params as Bindable, p, keyedLabel(p, inst))
      if (!isNumberParam(p)) continue
      this.labels.push({ inst, p, b })
      b.on('change', (ev) => {
        if (!this.refreshing) this.host.onParamEdit(inst, p.key, ev.value as number)
      })
    }
    for (const pk of def.pickers ?? []) {
      pane.addButton({ title: pk.label }).on('click', () =>
        this.host.pickDepth(inst, (d) => {
          inst.params[pk.param] = d
          this.host.onParamEdit(inst, pk.param, d)
          this.refreshValues()
        })
      )
    }
    const nums = def.params.filter(isNumberParam)
    if (nums.length) {
      const f = pane.addFolder({ title: `Modulators${inst.mods.length ? ` (${inst.mods.length})` : ''}`, expanded: inst.mods.length > 0 })
      inst.mods.forEach((m, mi) => {
        const mf = f.addFolder({ title: `Mod ${mi + 1}` })
        const mod = m as unknown as Bindable
        // Changing the source swaps which controls apply (LFO rate vs beat-hit settings).
        mf.addBinding(mod, 'shape', { label: 'source', options: MOD_SHAPES }).on('change', () => this.render())
        mf.addBinding(mod, 'target', { options: Object.fromEntries(nums.map((p) => [baseLabel(p), p.key])) })
        mf.addBinding(mod, 'depth', { min: -1, max: 1, format: (v: number) => v.toFixed(2) })
        if (m.shape === 'hit') {
          m.trigger ??= 'beat'
          m.every ??= 1
          m.attack ??= 0.01
          m.decay ??= 0.25
          mf.addBinding(mod, 'trigger', { label: 'on', options: HIT_TRIGGERS })
          mf.addBinding(mod, 'every', { label: 'every', options: HIT_EVERY })
          mf.addBinding(mod, 'attack', { label: 'attack (s)', min: 0, max: 1, format: (v: number) => v.toFixed(2) })
          mf.addBinding(mod, 'decay', { label: 'decay (s)', min: 0.02, max: 2, format: (v: number) => v.toFixed(2) })
        } else if (!m.shape.startsWith('audio-')) mf.addBinding(mod, 'rate', { label: 'LFO rate (Hz)', min: 0.01, max: 20, format: (v: number) => v.toFixed(2) })
        mf.addButton({ title: 'Remove modulator' }).on('click', () => {
          inst.mods.splice(mi, 1)
          this.render()
        })
      })
      f.addButton({ title: '+ Add modulator' }).on('click', () => {
        inst.mods.push(newModulator(inst.effectId, { shape: 'audio-beat', depth: 0.5 }))
        this.render()
      })
    }
    const mask = inst.mask as unknown as Bindable
    const maskTitle = (): string => (inst.mask.source === 'none' ? 'Mask' : `Mask: ${inst.mask.source}${inst.mask.invert ? ' (inverted)' : ''}`)
    const mf = pane.addFolder({ title: maskTitle(), expanded: inst.mask.source !== 'none' })
    mf.addBinding(mask, 'source', {
      label: 'limit to',
      options: {
        'whole frame': 'none',
        face: 'face',
        'person (body)': 'person',
        hair: 'hair',
        skin: 'skin',
        clothes: 'clothes',
        hands: 'hands',
        'fingers only': 'fingers',
        arms: 'arms',
        legs: 'legs',
        'color key': 'color',
        'shape (drag on preview)': 'shape',
        'drawn (lasso)': 'draw',
        'object (auto-detect)': 'object',
        'AI object (click or type)': 'track',
        'depth (near ↔ far)': 'depth'
      }
    })
    // Controls that only make sense for some sources are hidden for the rest.
    const only: [{ hidden: boolean }, string[]][] = []
    const when = <T extends { hidden: boolean }>(ctl: T, ...sources: string[]): T => {
      only.push([ctl, sources])
      return ctl
    }
    when(mf.addBinding(mask, 'color', { label: 'key color', view: 'color' }), 'color')
    when(mf.addBinding(mask, 'tolerance', { min: 0.01, max: 0.6, format: (v: number) => v.toFixed(2) }), 'color')
    when(mf.addButton({ title: 'Pick color from preview' }), 'color').on('click', () => this.host.pickColor(inst))
    when(mf.addBinding(mask, 'label', { label: 'object', options: Object.fromEntries(OBJECT_LABELS.map((l) => [l, l])) }), 'object')
    const tracks = this.host.tracks()
    when(
      mf.addBinding(mask, 'track', {
        label: 'saved object',
        options: tracks.length ? Object.fromEntries(tracks.map((t) => [t.label, t.id])) : { '(none yet)': '' }
      }),
      'track'
    )
    when(mf.addButton({ title: 'Select object on preview…' }), 'track').on('click', () => this.host.makeTrack(inst))
    when(mf.addButton({ title: 'Delete selected track' }), 'track').on('click', () => inst.mask.track && this.host.deleteTrack(inst.mask.track))
    when(mf.addBinding(mask, 'depthLo', { label: 'from (far 0)', min: 0, max: 1, format: (v: number) => v.toFixed(2) }), 'depth')
    when(mf.addBinding(mask, 'depthHi', { label: 'to (near 1)', min: 0, max: 1, format: (v: number) => v.toFixed(2) }), 'depth')
    when(mf.addButton({ title: 'Pick depth on preview' }), 'depth').on('click', () =>
      this.host.pickDepth(inst, (d) => {
        // Center a band on what was clicked; its width is kept if one was already set.
        const half = Math.max(0.08, (inst.mask.depthHi - inst.mask.depthLo) / 2)
        inst.mask.depthLo = Math.max(0, d - half)
        inst.mask.depthHi = Math.min(1, d + half)
        this.refreshValues()
      })
    )
    when(mf.addButton({ title: 'Edit shape on preview' }), 'shape').on('click', () => this.host.editShape(inst))
    for (const [key, d] of Object.entries(SHAPE_PARAMS) as [ShapeKey, (typeof SHAPE_PARAMS)[ShapeKey]][]) {
      if (inst.params[key] === undefined) inst.params[key] = d.default
      const p = { key, label: d.label, min: d.min, max: d.max, default: d.default }
      const b = when(bindParam(pane, inst.params as Bindable, p, keyedLabel(p, inst), mf), 'shape') as unknown as BindingApi
      this.labels.push({ inst, p, b })
      b.on('change', (ev) => {
        if (!this.refreshing) this.host.onParamEdit(inst, key, ev.value as number)
      })
    }
    when(mf.addButton({ title: 'Draw on preview' }), 'draw').on('click', () => this.host.drawMask(inst))
    when(mf.addButton({ title: 'Clear drawing' }), 'draw').on('click', () => {
      inst.mask.polys = []
      this.host.onStructure()
    })
    const common = [mf.addBinding(mask, 'invert', { label: 'invert (outside)' }), mf.addBinding(mask, 'feather', { min: 0, max: 1, format: (v: number) => v.toFixed(2) }), mf.addBinding(mask, 'expand', { min: 0.3, max: 3, format: (v: number) => v.toFixed(2) }), mf.addBinding(mask, 'show', { label: 'show mask' })]
    const syncVisibility = (): void => {
      for (const [ctl, sources] of only) ctl.hidden = !sources.includes(inst.mask.source)
      for (const c of common) c.hidden = inst.mask.source === 'none'
      mf.title = maskTitle()
    }
    syncVisibility()
    mf.on('change', syncVisibility)
    this.panes.push(pane)

    head.querySelector('input')!.onchange = (e) => {
      inst.enabled = (e.target as HTMLInputElement).checked
      el.classList.toggle('off', !inst.enabled)
    }
    head.querySelectorAll('button').forEach((b) => {
      b.onclick = () => {
        const i = this.chain.indexOf(inst)
        switch (b.dataset.a) {
          case 'rand':
            randomizeParams(inst)
            pane.refresh()
            return
          case 'dup':
            this.chain.splice(i + 1, 0, createInstance(inst.effectId, structuredClone({ ...inst })))
            break
          case 'del':
            this.chain.splice(i, 1)
            break
          case 'fold':
            if (this.collapsed.has(inst.uid)) this.collapsed.delete(inst.uid)
            else this.collapsed.add(inst.uid)
            body.hidden = this.collapsed.has(inst.uid)
            b.textContent = body.hidden ? '▸' : '▾'
            return
        }
        this.changed()
      }
    })

    head.ondragstart = (e) => {
      this.dragUid = inst.uid
      e.dataTransfer!.effectAllowed = 'move'
      el.classList.add('dragging')
    }
    head.ondragend = () => el.classList.remove('dragging')
    el.ondragover = (e) => {
      if (!this.dragUid || isPinned) return
      e.preventDefault()
      const r = el.getBoundingClientRect()
      el.classList.toggle('drop-before', e.clientY < r.top + r.height / 2)
      el.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2)
    }
    el.ondragleave = () => el.classList.remove('drop-before', 'drop-after')
    el.ondrop = (e) => {
      if (!this.dragUid || isPinned) return
      e.preventDefault()
      e.stopPropagation()
      const after = el.classList.contains('drop-after')
      el.classList.remove('drop-before', 'drop-after')
      const from = this.chain.findIndex((c) => c.uid === this.dragUid)
      this.dragUid = ''
      if (from < 0 || this.chain[from] === inst) return
      const [moved] = this.chain.splice(from, 1)
      this.chain.splice(this.chain.indexOf(inst) + (after ? 1 : 0), 0, moved)
      this.changed()
    }
    return el
  }
}
