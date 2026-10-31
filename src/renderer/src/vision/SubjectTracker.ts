import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'
import faceModelUrl from '../assets/models/blaze_face_short_range.tflite?url'
import personModelUrl from '../assets/models/selfie_segmenter.tflite?url'
import partsModelUrl from '../assets/models/selfie_multiclass_256x256.tflite?url'
import handModelUrl from '../assets/models/hand_landmarker.task?url'
import poseModelUrl from '../assets/models/pose_landmarker_full.task?url'
import objectModelUrl from '../assets/models/efficientdet_lite2.tflite?url'
import VisionWorker from './tracker.worker?worker'
import { anyNeed, type Capsule, type Face, type LimbKind, type MaskData, type Needs, type ObjBox, type VisionResult } from './types'

export { anyNeed, maskNeeds, MAX_CAPSULES, MAX_FACES, MAX_BOXES, OBJECT_LABELS } from './types'
export type { Capsule, Face, LimbKind, Needs, ObjBox } from './types'

// Absolute URLs: the worker resolves relative paths against its own script location, not the page.
const abs = (u: string): string => new URL(u, document.baseURI).href

type Out =
  | { type: 'status'; text: string }
  | { type: 'done'; id: number; ready?: boolean; devices?: Record<string, 'GPU' | 'CPU'> }
  | { type: 'result'; id: number; result: VisionResult }
  | { type: 'error'; id: number; message: string }

/**
 * Main-thread face of the vision worker. Live preview calls `update` (fire-and-forget: at most one frame in
 * flight, the preview never waits); offline renders `await analyzeNow` for every frame so output is exact.
 * Masks arrive as bytes and are uploaded to textures here, since only this thread owns the GL context.
 */
export class SubjectTracker {
  faces: Face[] = []
  caps: Record<LimbKind, Capsule[]> = { hands: [], fingers: [], legs: [], arms: [] }
  handCount = 0
  poseCount = 0
  objects: ObjBox[] = []
  /** Person confidence (R8, source space, top-down rows). */
  readonly maskTex: WebGLTexture
  /** Body parts (RGBA: hair, skin, clothes, person). */
  readonly partsTex: WebGLTexture
  hasMask = false
  hasParts = false
  status = ''
  onStatus: (s: string) => void = () => {}

  /** Processor each worker model runs on (shared by all trackers, filled as models load). */
  static devices: Record<string, 'GPU' | 'CPU'> = {}
  private static shared: { worker: Worker; seq: number; pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>; listeners: Set<(s: string) => void> } | null = null
  private ready = { face: false, person: false, parts: false, hands: false, pose: false, objects: false }
  private ensuring: Promise<void> | null = null
  private busy = false
  private lastKey = ''

  /** One worker (and one copy of each model) serves every tracker; `stream` keeps their tracking apart. */
  private static client(): NonNullable<typeof SubjectTracker.shared> {
    if (SubjectTracker.shared) return SubjectTracker.shared
    const worker = new VisionWorker()
    const shared = { worker, seq: 0, pending: new Map(), listeners: new Set<(s: string) => void>() }
    SubjectTracker.shared = shared
    worker.onmessage = (e: MessageEvent<Out>) => {
      const m = e.data
      if (m.type === 'status') {
        for (const l of shared.listeners) l(m.text)
        return
      }
      const p = shared.pending.get(m.id)
      if (!p) return
      shared.pending.delete(m.id)
      if (m.type === 'error') p.reject(new Error(m.message))
      else {
        if (m.type === 'done' && m.devices) Object.assign(SubjectTracker.devices, m.devices)
        p.resolve(m.type === 'result' ? m.result : m.ready)
      }
    }
    worker.postMessage({
      type: 'init',
      urls: {
        loader: abs(wasmLoaderPath),
        wasm: abs(wasmBinaryPath),
        face: abs(faceModelUrl),
        person: abs(personModelUrl),
        parts: abs(partsModelUrl),
        hand: abs(handModelUrl),
        pose: abs(poseModelUrl),
        object: abs(objectModelUrl)
      }
    })
    return shared
  }

  constructor(
    private gl: WebGL2RenderingContext,
    readonly stream = 'base'
  ) {
    this.maskTex = this.tex()
    this.partsTex = this.tex()
    // Only the first tracker reports model-loading status (it's the same shared worker for all).
    const shared = SubjectTracker.client()
    if (!shared.listeners.size)
      shared.listeners.add((text) => {
        this.status = text
        this.onStatus(text)
      })
  }

  dispose(): void {
    this.gl.deleteTexture(this.maskTex)
    this.gl.deleteTexture(this.partsTex)
  }

  private tex(): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const shared = SubjectTracker.client()
    const id = ++shared.seq
    return new Promise<T>((resolve, reject) => {
      shared.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      shared.worker.postMessage({ ...msg, id, stream: this.stream }, transfer)
    })
  }

  private covered(need: Needs): boolean {
    return (Object.keys(need) as (keyof Needs)[]).every((k) => !need[k] || this.ready[k])
  }

  /** Load whatever models `need` requires (no-op once loaded). */
  ensure(need: Needs): Promise<void> {
    if (this.covered(need)) return Promise.resolve()
    if (this.ensuring) return this.ensuring
    this.ensuring = this.call<boolean>({ type: 'ensure', need })
      .then(() => {
        for (const k of Object.keys(need) as (keyof Needs)[]) if (need[k]) this.ready[k] = true
      })
      .finally(() => (this.ensuring = null))
    return this.ensuring
  }

  /** Clear temporal state (start of an offline render). */
  async reset(): Promise<void> {
    await this.call({ type: 'reset' })
    this.faces = []
    this.caps = { hands: [], fingers: [], legs: [], arms: [] }
    this.handCount = this.poseCount = 0
    this.objects = []
    this.hasMask = this.hasParts = false
    this.lastKey = ''
  }

  /** Live preview: analyze this frame if it's new and nothing is in flight. Never blocks. */
  update(el: TexImageSource, w: number, h: number, key: string, need: Needs, still = false): void {
    if (!w || !h || !anyNeed(need)) return
    if (!this.covered(need)) {
      this.ensure(need).catch(() => {})
      return
    }
    const k = `${key}|${JSON.stringify(need)}`
    if (this.busy || k === this.lastKey) return
    this.lastKey = k
    this.busy = true
    this.run(el, w, h, need, still)
      .catch(() => (this.lastKey = ''))
      .finally(() => (this.busy = false))
  }

  /** Offline render / thumbnails: analyze and wait for the result. */
  async analyzeNow(el: TexImageSource, w: number, h: number, need: Needs, still: boolean): Promise<void> {
    if (!w || !h || !anyNeed(need)) return
    await this.ensure(need)
    while (this.busy) await new Promise((r) => setTimeout(r, 2))
    this.busy = true
    try {
      await this.run(el, w, h, need, still)
    } finally {
      this.busy = false
    }
  }

  private async run(el: TexImageSource, w: number, h: number, need: Needs, still: boolean): Promise<void> {
    const bitmap = await createImageBitmap(el as ImageBitmapSource)
    const r = await this.call<VisionResult>({ type: 'analyze', bitmap, w, h, need, still }, [bitmap])
    this.faces = r.faces
    this.caps = r.caps
    this.handCount = r.handCount
    this.poseCount = r.poseCount
    this.objects = r.objects
    if (r.person) {
      this.upload(this.maskTex, r.person, 1)
      this.hasMask = true
    }
    if (r.parts) {
      this.upload(this.partsTex, r.parts, 4)
      this.hasParts = true
    }
  }

  private upload(t: WebGLTexture, m: MaskData, channels: 1 | 4): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, m.w, m.h, 0, gl.RED, gl.UNSIGNED_BYTE, m.data)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, m.w, m.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, m.data)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
  }
}
