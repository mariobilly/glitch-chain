import { SHAPE_PARAMS, type Instance, type ShapeKey } from '../effects/types'

const NS = 'http://www.w3.org/2000/svg'
type Mode = 'shape' | 'draw' | 'pick' | 'ai' | null

export interface AiHandlers {
  /** Click on the preview: label 1 = include this spot, 0 = exclude it. */
  point: (u: number, v: number, label: number) => void
  find: (text: string) => void
  clear: () => void
  commit: () => void
  cancel: () => void
}

/**
 * On-preview editing for masks, drawn as an SVG layer exactly over the output canvas. Coordinates handed back
 * are output uv (0..1, y down) so they're independent of the preview's on-screen size.
 */
export class MaskEditor {
  private svg = document.createElementNS(NS, 'svg')
  private bar = document.createElement('div')
  private mode: Mode = null
  private inst: Instance | null = null
  private onEdit: (key: ShapeKey, value: number) => void = () => {}
  private onPoly: (poly: number[]) => void = () => {}
  private onPick: (u: number, v: number) => void = () => {}
  private drag: { kind: 'move' | 'size' | 'rotate'; ox: number; oy: number; cx: number; cy: number } | null = null
  private stroke: number[] = []
  private ai: AiHandlers | null = null
  /** Tracking speed chosen in the bar: analyze every frame (1) or every 2nd frame and blend between (2). */
  trackStep = 2
  private aiPoints: [number, number, number][] = []

  constructor(
    private host: HTMLElement,
    private canvas: HTMLCanvasElement
  ) {
    this.svg.classList.add('mask-editor')
    this.bar.className = 'mask-bar'
    this.bar.hidden = true
    host.append(this.svg, this.bar)
    this.svg.style.display = 'none'
    this.svg.addEventListener('pointerdown', (e) => this.down(e))
    this.svg.addEventListener('pointermove', (e) => this.move(e))
    this.svg.addEventListener('pointerup', () => this.up())
    this.svg.addEventListener('contextmenu', (e) => e.preventDefault())
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.mode) return
      this.ai?.cancel()
      this.stop()
    })
  }

  get active(): boolean {
    return this.mode !== null
  }

  editShape(inst: Instance, onEdit: (key: ShapeKey, value: number) => void): void {
    this.start('shape', inst, 'Drag the middle to move · corner to resize · top dot to rotate')
    this.onEdit = onEdit
  }

  draw(inst: Instance, onPoly: (poly: number[]) => void): void {
    this.start('draw', inst, 'Drag to draw a shape around what you want masked · draw more to add')
    this.onPoly = onPoly
  }

  pick(onPick: (u: number, v: number) => void): void {
    this.start('pick', null, 'Click the color to key')
    this.onPick = onPick
  }

  /** AI object selection: click to include / right-click to exclude, or type what to find. */
  aiSelect(h: AiHandlers, isVideo: boolean): void {
    this.start('ai', null, '')
    this.ai = h
    this.aiPoints = []
    this.bar.innerHTML = `<input type="text" placeholder="type what to mask, e.g. bicycle" spellcheck="false">
      <button data-a="find">Find</button><span class="ai-hint">or click it · right-click excludes</span>
      <button data-a="clear">Clear</button>${
        isVideo
          ? `<select data-a="step" title="Tracking speed"><option value="2">2× faster</option><option value="1">every frame</option></select>`
          : ''
      }<button data-a="commit" class="primary">${isVideo ? 'Track through clip' : 'Use'}</button><button data-a="cancel">Cancel</button>`
    const input = this.bar.querySelector('input')!
    const run = (): void => {
      if (input.value.trim()) h.find(input.value.trim())
    }
    input.onkeydown = (e) => {
      e.stopPropagation()
      if (e.key === 'Enter') run()
    }
    this.bar.querySelector<HTMLButtonElement>('[data-a=find]')!.onclick = run
    this.bar.querySelector<HTMLButtonElement>('[data-a=clear]')!.onclick = () => {
      this.aiPoints = []
      this.update()
      h.clear()
    }
    const stepSel = this.bar.querySelector<HTMLSelectElement>('[data-a=step]')
    if (stepSel) {
      stepSel.value = String(this.trackStep)
      stepSel.onchange = () => (this.trackStep = Number(stepSel.value))
    }
    this.bar.querySelector<HTMLButtonElement>('[data-a=commit]')!.onclick = () => h.commit()
    this.bar.querySelector<HTMLButtonElement>('[data-a=cancel]')!.onclick = () => {
      h.cancel()
      this.stop()
    }
    this.svg.style.cursor = 'crosshair'
  }

  /** Show progress / errors in the bar while the models work. */
  setBusy(text: string): void {
    let el = this.bar.querySelector<HTMLSpanElement>('.ai-hint')
    if (!el) return
    el.textContent = text || 'or click it · right-click excludes'
    this.bar.classList.toggle('busy', !!text && !/^No |^Failed/.test(text))
  }

  stop(): void {
    this.ai = null
    this.aiPoints = []
    this.mode = null
    this.inst = null
    this.drag = null
    this.svg.style.display = 'none'
    this.bar.hidden = true
  }

  private start(mode: Mode, inst: Instance | null, hint: string): void {
    this.mode = mode
    this.inst = inst
    this.svg.style.display = ''
    this.svg.style.cursor = mode === 'pick' ? 'crosshair' : mode === 'draw' ? 'crosshair' : 'default'
    this.bar.hidden = false
    this.bar.innerHTML = `<span></span><button>Done</button>`
    this.bar.querySelector('span')!.textContent = hint
    this.bar.querySelector('button')!.onclick = () => this.stop()
    this.update()
  }

  /** Canvas rect relative to the host element. */
  private rect(): { x: number; y: number; w: number; h: number } {
    const c = this.canvas.getBoundingClientRect()
    const hr = this.host.getBoundingClientRect()
    return { x: c.left - hr.left, y: c.top - hr.top, w: c.width, h: c.height }
  }

  private uv(e: PointerEvent): [number, number] {
    const c = this.canvas.getBoundingClientRect()
    return [(e.clientX - c.left) / c.width, (e.clientY - c.top) / c.height]
  }

  private shape(): Record<ShapeKey, number> {
    const p = this.inst!.params
    return Object.fromEntries(Object.entries(SHAPE_PARAMS).map(([k, d]) => [k, Number(p[k] ?? d.default)])) as Record<ShapeKey, number>
  }

  /** Redraw outline + handles from the instance (call every frame: keyframes may be moving the shape). */
  update(): void {
    if (!this.mode) return
    const r = this.rect()
    Object.assign(this.svg.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` })
    this.svg.setAttribute('viewBox', `0 0 ${r.w} ${r.h}`)
    this.svg.replaceChildren()
    if (this.mode === 'draw') this.drawPolys(r)
    if (this.mode === 'ai')
      for (const [u, v, l] of this.aiPoints) this.el('circle', { cx: u * r.w, cy: v * r.h, r: 6, class: l ? 'ai-pt in' : 'ai-pt out' })
    if (this.mode !== 'shape' || !this.inst) return
    const s = this.shape()
    const ex = this.inst.mask.expand
    const cx = s['mask.cx'] * r.w
    const cy = s['mask.cy'] * r.h
    const hw = (s['mask.w'] * r.w * ex) / 2
    const hh = (s['mask.h'] * r.h * ex) / 2
    const a = s['mask.angle']
    const n = 12 + (2 - 12) * s['mask.round']
    const rot = (x: number, y: number): [number, number] => [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)]
    // Superellipse outline, same formula as the shader.
    const pts: string[] = []
    for (let i = 0; i <= 96; i++) {
      const t = (i / 96) * Math.PI * 2
      const c = Math.cos(t)
      const sn = Math.sin(t)
      const [x, y] = rot(Math.sign(c) * Math.abs(c) ** (2 / n) * hw, Math.sign(sn) * Math.abs(sn) ** (2 / n) * hh)
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    }
    this.el('polygon', { points: pts.join(' '), class: 'outline' })
    const [rx, ry] = rot(0, -hh - 22)
    const [tx, ty] = rot(0, -hh)
    this.el('line', { x1: tx, y1: ty, x2: rx, y2: ry, class: 'guide' })
    this.el('circle', { cx, cy, r: 9, class: 'handle move', 'data-h': 'move' })
    const [kx, ky] = rot(hw, hh)
    this.el('rect', { x: kx - 6, y: ky - 6, width: 12, height: 12, class: 'handle', 'data-h': 'size' })
    this.el('circle', { cx: rx, cy: ry, r: 6, class: 'handle', 'data-h': 'rotate' })
  }

  private drawPolys(r: { w: number; h: number }): void {
    const toPts = (poly: number[]): string => {
      const out: string[] = []
      for (let i = 0; i < poly.length; i += 2) out.push(`${(poly[i] * r.w).toFixed(1)},${(poly[i + 1] * r.h).toFixed(1)}`)
      return out.join(' ')
    }
    for (const poly of this.inst?.mask.polys ?? []) this.el('polygon', { points: toPts(poly), class: 'outline' })
    if (this.stroke.length) this.el('polyline', { points: toPts(this.stroke), class: 'outline live' })
  }

  private el(tag: string, attrs: Record<string, string | number>): SVGElement {
    const e = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
    this.svg.appendChild(e)
    return e
  }

  private down(e: PointerEvent): void {
    e.preventDefault()
    this.svg.setPointerCapture(e.pointerId)
    const [u, v] = this.uv(e)
    if (this.mode === 'pick') {
      this.onPick(u, v)
      this.stop()
      return
    }
    if (this.mode === 'ai') {
      const label = e.button === 2 ? 0 : 1
      this.aiPoints.push([u, v, label])
      this.update()
      this.ai?.point(u, v, label)
      return
    }
    if (this.mode === 'draw') {
      this.stroke = [u, v]
      this.update()
      return
    }
    if (this.mode === 'shape') {
      const h = (e.target as SVGElement).getAttribute('data-h') as 'move' | 'size' | 'rotate' | null
      const s = this.shape()
      // Clicking inside the outline also moves; clicking empty space recenters there.
      this.drag = { kind: h ?? 'move', ox: u, oy: v, cx: s['mask.cx'], cy: s['mask.cy'] }
      if (!h) {
        this.onEdit('mask.cx', u)
        this.onEdit('mask.cy', v)
        this.drag = { kind: 'move', ox: u, oy: v, cx: u, cy: v }
      }
    }
  }

  private move(e: PointerEvent): void {
    const [u, v] = this.uv(e)
    if (this.mode === 'draw' && this.stroke.length) {
      const n = this.stroke.length
      const r = this.rect()
      if (Math.hypot((u - this.stroke[n - 2]) * r.w, (v - this.stroke[n - 1]) * r.h) > 3) {
        this.stroke.push(u, v)
        this.update()
      }
      return
    }
    if (this.mode !== 'shape' || !this.drag || !this.inst) return
    const d = this.drag
    const s = this.shape()
    const r = this.rect()
    if (d.kind === 'move') {
      this.onEdit('mask.cx', d.cx + (u - d.ox))
      this.onEdit('mask.cy', d.cy + (v - d.oy))
    } else {
      // Work in screen pixels so rotation and aspect ratio behave.
      const px = (u - s['mask.cx']) * r.w
      const py = (v - s['mask.cy']) * r.h
      if (d.kind === 'rotate') this.onEdit('mask.angle', Math.atan2(py, px) + Math.PI / 2)
      else {
        const a = -s['mask.angle']
        const lx = px * Math.cos(a) - py * Math.sin(a)
        const ly = px * Math.sin(a) + py * Math.cos(a)
        const ex = this.inst.mask.expand
        this.onEdit('mask.w', Math.max(0.01, (2 * Math.abs(lx)) / r.w / ex))
        this.onEdit('mask.h', Math.max(0.01, (2 * Math.abs(ly)) / r.h / ex))
      }
    }
    this.update()
  }

  private up(): void {
    if (this.mode === 'draw' && this.stroke.length >= 6) this.onPoly(this.stroke.map((x) => Math.min(1.2, Math.max(-0.2, x))))
    this.stroke = []
    this.drag = null
    this.update()
  }
}
