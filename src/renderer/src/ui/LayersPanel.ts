import { BLEND_MODES } from '../effects/layer'

export interface LayerRow {
  id: string
  name: string
  visible: boolean
  blend: number
  opacity: number
  media: string
}

export interface LayersHost {
  select: (id: string) => void
  toggle: (id: string, visible: boolean) => void
  rename: (id: string) => void
  remove: (id: string) => void
  /** New order, bottom first. */
  reorder: (ids: string[]) => void
  add: () => void
  duplicate: (id: string) => void
}

const BLEND_NAME = Object.fromEntries(Object.entries(BLEND_MODES).map(([k, v]) => [v, k]))

/** Layer stack (top layer listed first, like most editors). */
export class LayersPanel {
  private drag = ''

  constructor(
    private root: HTMLElement,
    private host: LayersHost
  ) {}

  render(rows: LayerRow[], active: string): void {
    this.root.innerHTML = ''
    const list = document.createElement('div')
    list.className = 'layers'
    for (const r of [...rows].reverse()) {
      const el = document.createElement('div')
      el.className = `layer-row${r.id === active ? ' active' : ''}${r.visible ? '' : ' hidden-layer'}`
      el.draggable = true
      el.dataset.id = r.id
      el.innerHTML = `<button class="eye" title="Show / hide">${r.visible ? '◉' : '○'}</button>
        <div class="lname"><span class="n"></span><span class="meta m"></span></div>
        <span class="meta blend"></span>
        <button class="x" title="Delete layer" ${rows.length < 2 ? 'disabled' : ''}>✕</button>`
      el.querySelector('.n')!.textContent = r.name
      el.querySelector('.m')!.textContent = r.media || 'no media'
      el.querySelector('.blend')!.textContent = `${BLEND_NAME[r.blend] ?? 'normal'}${r.opacity < 0.999 ? ` ${Math.round(r.opacity * 100)}%` : ''}`
      el.onclick = () => this.host.select(r.id)
      el.ondblclick = () => this.host.rename(r.id)
      el.querySelector<HTMLButtonElement>('.eye')!.onclick = (e) => {
        e.stopPropagation()
        this.host.toggle(r.id, !r.visible)
      }
      el.querySelector<HTMLButtonElement>('.x')!.onclick = (e) => {
        e.stopPropagation()
        this.host.remove(r.id)
      }
      el.ondragstart = (e) => {
        this.drag = r.id
        e.dataTransfer!.effectAllowed = 'move'
      }
      el.ondragover = (e) => {
        if (!this.drag) return
        e.preventDefault()
        const b = el.getBoundingClientRect()
        el.classList.toggle('drop-before', e.clientY < b.top + b.height / 2)
        el.classList.toggle('drop-after', e.clientY >= b.top + b.height / 2)
      }
      el.ondragleave = () => el.classList.remove('drop-before', 'drop-after')
      el.ondrop = (e) => {
        if (!this.drag) return
        e.preventDefault()
        e.stopPropagation()
        const above = el.classList.contains('drop-before')
        el.classList.remove('drop-before', 'drop-after')
        // Work in display order (top first), then convert back to bottom-first.
        const order = [...rows].reverse().map((x) => x.id).filter((id) => id !== this.drag)
        order.splice(order.indexOf(r.id) + (above ? 0 : 1), 0, this.drag)
        this.drag = ''
        this.host.reorder(order.reverse())
      }
      list.appendChild(el)
    }
    const bar = document.createElement('div')
    bar.className = 'layer-bar'
    bar.innerHTML = `<button data-a="add" title="Add a layer from an image or video">＋ Layer</button><button data-a="dup" title="Duplicate the selected layer">Duplicate</button>`
    bar.querySelector<HTMLButtonElement>('[data-a=add]')!.onclick = () => this.host.add()
    bar.querySelector<HTMLButtonElement>('[data-a=dup]')!.onclick = () => this.host.duplicate(active)
    this.root.append(list, bar)
  }
}
