import type { Codec } from '../../../preload'
import type { Sequence } from '../sequence'
import { fmtTime } from '../Transport'

export interface QueueJob {
  id: number
  label: string
  sourcePath: string
  sourceName: string
  musicPath: string
  /** Full editor state (chain, source settings, output, duration) captured when the job was added. */
  snapshot: string
  sequence: Sequence
  output: string
  scale: number
  fps: number
  codec: Codec
  includeAudio: boolean
  duration: number
  status: 'queued' | 'rendering' | 'done' | 'failed' | 'cancelled'
  progress: number
  outFile?: string
  error?: string
}

interface Handlers {
  run: () => void
  cancel: () => void
  reveal: (path: string) => void
  changed: () => void
}

const ICON: Record<QueueJob['status'], string> = { queued: '•', rendering: '▶', done: '✓', failed: '✕', cancelled: '–' }

/** Modal list of queued renders. Returns a refresh function the runner calls as jobs progress. */
export function openQueuePanel(jobs: QueueJob[], running: () => boolean, h: Handlers): () => void {
  document.querySelector('.modal.queue')?.remove()
  const wrap = document.createElement('div')
  wrap.className = 'modal queue'
  wrap.innerHTML = `<div class="modal-box queue-box">
    <div class="browser-head"><div class="modal-title">Render queue</div><span class="meta count"></span><button data-a="close">✕</button></div>
    <div class="queue-list"></div>
    <div class="modal-actions">
      <button data-a="clear">Clear finished</button>
      <span class="spacer"></span>
      <button data-a="cancel" hidden>Stop</button>
      <button data-a="run" class="primary">Choose folder & render all</button>
    </div>
  </div>`
  const list = wrap.querySelector<HTMLDivElement>('.queue-list')!
  const refresh = (): void => {
    if (!wrap.isConnected) return
    const busy = running()
    const waiting = jobs.filter((j) => j.status === 'queued').length
    wrap.querySelector('.count')!.textContent = `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${waiting} waiting`
    wrap.querySelector<HTMLButtonElement>('[data-a=run]')!.disabled = busy || !waiting
    wrap.querySelector<HTMLButtonElement>('[data-a=cancel]')!.hidden = !busy
    list.innerHTML = jobs.length ? '' : '<div class="meta">Empty. In the Render dialog use “Add to queue” or “Social pack”.</div>'
    for (const j of jobs) {
      const row = document.createElement('div')
      row.className = `queue-item ${j.status}`
      row.innerHTML = `<span class="st">${ICON[j.status]}</span>
        <div class="info"><div class="name"></div><div class="meta sub"></div></div>
        <div class="bar"><div style="width:${Math.round(j.progress * 100)}%"></div></div>
        <button data-a="x" title="Remove">✕</button>`
      row.querySelector('.name')!.textContent = j.label
      row.querySelector('.sub')!.textContent =
        j.status === 'failed'
          ? j.error ?? 'failed'
          : `${j.output.split(' · ')[0]} · ${j.fps} fps · ${j.codec.toUpperCase()} · ${fmtTime(j.duration)}${j.outFile ? ' · ' + j.outFile : ''}`
      const x = row.querySelector<HTMLButtonElement>('[data-a=x]')!
      x.disabled = j.status === 'rendering'
      x.onclick = () => {
        jobs.splice(jobs.indexOf(j), 1)
        h.changed()
        refresh()
      }
      if (j.outFile && j.status === 'done') {
        row.classList.add('link')
        row.querySelector<HTMLDivElement>('.info')!.onclick = () => h.reveal(j.outFile!)
      }
      list.appendChild(row)
    }
  }
  wrap.querySelector<HTMLButtonElement>('[data-a=run]')!.onclick = () => h.run()
  wrap.querySelector<HTMLButtonElement>('[data-a=cancel]')!.onclick = () => h.cancel()
  wrap.querySelector<HTMLButtonElement>('[data-a=clear]')!.onclick = () => {
    for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status !== 'queued' && jobs[i].status !== 'rendering') jobs.splice(i, 1)
    h.changed()
    refresh()
  }
  wrap.querySelector<HTMLButtonElement>('[data-a=close]')!.onclick = () => wrap.remove()
  document.body.appendChild(wrap)
  refresh()
  return refresh
}
