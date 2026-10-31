/** Small dropdown menu anchored under a button. */
export interface MenuItem {
  label: string
  run?: () => void
  danger?: boolean
  /** Keyboard hint shown on the right. */
  hint?: string
  disabled?: boolean
  /** A non-clickable section title. */
  heading?: boolean
}

export function attachMenu(button: HTMLElement, items: MenuItem[] | (() => MenuItem[] | Promise<MenuItem[]>)): void {
  button.onclick = async (e) => {
    e.stopPropagation()
    document.querySelector('.menu')?.remove()
    const list = typeof items === 'function' ? await items() : items
    const m = document.createElement('div')
    m.className = 'menu'
    for (const it of list) {
      if (it.heading) {
        const h = document.createElement('div')
        h.className = 'menu-heading'
        h.textContent = it.label
        m.appendChild(h)
        continue
      }
      const b = document.createElement('button')
      b.innerHTML = `<span></span>${it.hint ? `<kbd>${it.hint}</kbd>` : ''}`
      b.querySelector('span')!.textContent = it.label
      b.title = it.label
      if (it.danger) b.classList.add('danger')
      b.disabled = !!it.disabled
      b.onclick = () => {
        m.remove()
        it.run?.()
      }
      m.appendChild(b)
    }
    const r = button.getBoundingClientRect()
    m.style.top = `${r.bottom + 4}px`
    if (r.left < window.innerWidth / 2) m.style.left = `${r.left}px`
    else m.style.right = `${window.innerWidth - r.right}px`
    document.body.appendChild(m)
    const off = (): void => {
      m.remove()
      window.removeEventListener('pointerdown', outside, true)
    }
    const outside = (ev: PointerEvent): void => {
      if (!m.contains(ev.target as Node)) off()
    }
    window.addEventListener('pointerdown', outside, true)
  }
}
