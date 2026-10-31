/// <reference lib="webworker" />
// Runs all MediaPipe detection off the main thread. Bundled as a classic (iife) worker because MediaPipe's
// WASM loader uses importScripts(), which module workers don't have.
import { Models, VisionEngine } from './engine'
import type { ModelUrls, Needs, VisionResult } from './types'

// `stream` separates temporal state per layer; the models themselves are shared.
type In =
  | { type: 'init'; urls: ModelUrls }
  | { type: 'ensure'; id: number; need: Needs; stream: string }
  | { type: 'analyze'; id: number; bitmap: ImageBitmap; w: number; h: number; need: Needs; still: boolean; stream: string }
  | { type: 'reset'; id: number; stream: string }

const scope = self as unknown as DedicatedWorkerGlobalScope
let urls: ModelUrls | null = null
const models = new Models()
const engines = new Map<string, VisionEngine>()
const engineFor = (stream: string): VisionEngine => {
  if (!urls) throw new Error('vision worker not initialized')
  let e = engines.get(stream)
  if (!e) {
    e = new VisionEngine(urls, (text) => scope.postMessage({ type: 'status', text }), models)
    engines.set(stream, e)
  }
  return e
}

scope.onmessage = async (e: MessageEvent<In>) => {
  const m = e.data
  try {
    if (m.type === 'init') {
      urls = m.urls
      return
    }
    const engine = engineFor(m.stream)
    if (m.type === 'ensure') {
      await engine.ensure(m.need)
      scope.postMessage({ type: 'done', id: m.id, ready: engine.has(m.need), devices: engine.devices })
    } else if (m.type === 'reset') {
      engine.reset()
      scope.postMessage({ type: 'done', id: m.id })
    } else if (m.type === 'analyze') {
      let result: VisionResult
      try {
        result = engine.analyze(m.bitmap, m.w, m.h, m.need, m.still)
      } finally {
        m.bitmap.close()
      }
      const transfer: Transferable[] = []
      if (result.person) transfer.push(result.person.data.buffer)
      if (result.parts) transfer.push(result.parts.data.buffer)
      scope.postMessage({ type: 'result', id: m.id, result }, transfer)
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: 'id' in m ? m.id : -1, message: (err as Error).message })
  }
}
