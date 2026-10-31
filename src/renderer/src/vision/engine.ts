import { FaceDetector, HandLandmarker, ImageSegmenter, ObjectDetector, PoseLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision'
import { LIMB_KINDS, MAX_BOXES, MAX_FACES, type Capsule, type Face, type LimbKind, type MaskData, type ModelUrls, type Needs, type ObjBox, type VisionResult } from './types'

/** Frames the engine analyzes: decoded bitmaps (from the main thread) or its own crop canvases. */
type Img = ImageBitmap | OffscreenCanvas

interface Box {
  x: number
  y: number
  w: number
  h: number
  score: number
  eyes: { x: number; y: number }[] | null
}

const iou = (a: Box, b: Box): number => {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter)
}

// Hand landmarks: 0 wrist, 1-4 thumb, 5-8 index, 9-12 middle, 13-16 ring, 17-20 pinky (tip last).
const FINGER_BONES = [[2, 3], [3, 4], [5, 6], [6, 7], [7, 8], [9, 10], [10, 11], [11, 12], [13, 14], [14, 15], [15, 16], [17, 18], [18, 19], [19, 20]]
// Palm as thick capsules fanning out from the wrist; third value = radius as a fraction of hand size.
const PALM = [[0, 1, 0.3], [1, 2, 0.2], [0, 5, 0.3], [0, 9, 0.34], [0, 13, 0.32], [0, 17, 0.3], [5, 9, 0.22], [9, 13, 0.22], [13, 17, 0.22]]
// Pose: 23/24 hips, 25/26 knees, 27/28 ankles, 29/30 heels, 31/32 foot tips. Radius vs thigh length.
const LEG_BONES = [[23, 25, 0.3], [25, 27, 0.22], [27, 29, 0.13], [29, 31, 0.11], [27, 31, 0.13], [24, 26, 0.3], [26, 28, 0.22], [28, 30, 0.13], [30, 32, 0.11], [28, 32, 0.13]]
// Pose: 11/12 shoulders, 13/14 elbows, 15/16 wrists, 17-22 pinky/index/thumb. Radius vs upper-arm length.
const ARM_BONES = [[11, 13, 0.24], [13, 15, 0.2], [15, 17, 0.12], [15, 19, 0.12], [15, 21, 0.1], [12, 14, 0.24], [14, 16, 0.2], [16, 18, 0.12], [16, 20, 0.12], [16, 22, 0.1]]

/** Landmark in full-image pixels with visibility. */
type Pt = { x: number; y: number; v: number }
const pdist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, v: Math.min(a.v, b.v) })

/** Overlapping search tiles: squares for hands, full-height strips for bodies (a standing person must fit). */
function tiles(w: number, h: number, group: 'hands' | 'pose'): [number, number, number, number][] {
  const out: [number, number, number, number][] = []
  const tw = group === 'hands' ? Math.min(w, h) / 2 : Math.min(w, h * 0.45)
  const th = group === 'hands' ? tw : h
  const step = tw * (group === 'hands' ? 0.6 : 0.5)
  for (let y = 0; ; y += step) {
    const sy = Math.min(y, h - th)
    for (let x = 0; ; x += step) {
      out.push([Math.min(x, w - tw), sy, tw, th])
      if (x + tw >= w) break
    }
    if (y + th >= h) break
  }
  return out
}

const emptyCaps = (): Record<LimbKind, Capsule[]> => ({ hands: [], fingers: [], legs: [], arms: [] })

/**
 * All detection, runnable off the main thread. Holds the temporal state (smoothing, hold-on-miss, tile
 * cadence), so an offline render that resets it first gets the same result regardless of the preview.
 */
/** Loaded models, shared by every stream (layer): each model is loaded once. */
export class Models {
  detector: FaceDetector | null = null
  segmenter: ImageSegmenter | null = null
  parts: ImageSegmenter | null = null
  hands: HandLandmarker | null = null
  pose: PoseLandmarker | null = null
  objectDet: ObjectDetector | null = null
  loading = new Map<string, Promise<void>>()
  /** Which processor each loaded model actually runs on (GPU unless it had to fall back). */
  devices: Record<string, 'GPU' | 'CPU'> = {}
}

export class VisionEngine {
  private m: Models
  private boxes: ObjBox[] = []
  private boxMissed = 0

  private faces: Face[] = []
  private caps = emptyCaps()
  private handCount = 0
  private poseCount = 0
  private missed = 0
  private limbMissed = { hands: 0, pose: 0 }
  private analyzed = { hands: 0, pose: 0 }
  private lastSets = { hands: 0, pose: 0 }
  private crop = new OffscreenCanvas(256, 256)
  private limbCrop = new OffscreenCanvas(512, 512)

  constructor(
    private urls: ModelUrls,
    private status: (s: string) => void,
    models?: Models
  ) {
    this.m = models ?? new Models()
  }

  get devices(): Record<string, 'GPU' | 'CPU'> {
    return this.m.devices
  }

  has(need: Needs): boolean {
    return (
      (!need.face || !!this.m.detector) &&
      (!need.person || !!this.m.segmenter) &&
      (!need.parts || !!this.m.parts) &&
      (!need.hands || !!this.m.hands) &&
      (!need.pose || !!this.m.pose) &&
      (!need.objects || !!this.m.objectDet)
    )
  }

  ensure(need: Needs): Promise<void> {
    const jobs: Promise<void>[] = []
    if (need.face && !this.m.detector) jobs.push(this.load('face'))
    if (need.person && !this.m.segmenter) jobs.push(this.load('person'))
    if (need.parts && !this.m.parts) jobs.push(this.load('body parts'))
    if (need.hands && !this.m.hands) jobs.push(this.load('hand'))
    if (need.pose && !this.m.pose) jobs.push(this.load('pose'))
    if (need.objects && !this.m.objectDet) jobs.push(this.load('object'))
    return Promise.all(jobs).then(() => {})
  }

  private load(kind: 'face' | 'person' | 'body parts' | 'hand' | 'pose' | 'object'): Promise<void> {
    let p = this.m.loading.get(kind)
    if (p) return p
    this.status(`loading ${kind} model…`)
    const fileset = { wasmLoaderPath: this.urls.loader, wasmBinaryPath: this.urls.wasm }
    const bytes = async (url: string): Promise<Uint8Array> => new Uint8Array(await (await fetch(url)).arrayBuffer())
    const create = async <T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>): Promise<T> => {
      try {
        const m = await make('GPU')
        this.m.devices[kind] = 'GPU'
        return m
      } catch {
        const m = await make('CPU')
        this.m.devices[kind] = 'CPU'
        return m
      }
    }
    p = (async () => {
      if (kind === 'face') {
        const buf = await bytes(this.urls.face)
        this.m.detector = await create((delegate) =>
          FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetBuffer: buf, delegate }, runningMode: 'IMAGE', minDetectionConfidence: 0.45 })
        )
      } else if (kind === 'hand') {
        const buf = await bytes(this.urls.hand)
        // CPU on purpose: the GPU delegate loads fine but silently returns zero hands under WebGL
        // (verified on an RTX 4070; the same image gives 1 hand at 0.96 on CPU).
        this.m.devices[kind] = 'CPU'
        this.m.hands = await HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetBuffer: buf, delegate: 'CPU' },
          runningMode: 'IMAGE',
          numHands: 4,
          minHandDetectionConfidence: 0.4,
          minHandPresenceConfidence: 0.4
        })
      } else if (kind === 'object') {
        const buf = await bytes(this.urls.object)
        this.m.objectDet = await create((delegate) =>
          ObjectDetector.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: buf, delegate },
            runningMode: 'IMAGE',
            scoreThreshold: 0.3,
            maxResults: 40
          })
        )
      } else if (kind === 'pose') {
        const buf = await bytes(this.urls.pose)
        this.m.pose = await create((delegate) =>
          PoseLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: buf, delegate },
            runningMode: 'IMAGE',
            numPoses: 4,
            minPoseDetectionConfidence: 0.4,
            minPosePresenceConfidence: 0.4
          })
        )
      } else {
        const buf = await bytes(kind === 'person' ? this.urls.person : this.urls.parts)
        const seg = await create((delegate) =>
          ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: buf, delegate },
            runningMode: 'IMAGE',
            outputConfidenceMasks: true,
            outputCategoryMask: false
          })
        )
        if (kind === 'person') this.m.segmenter = seg
        else this.m.parts = seg
      }
    })()
      .catch((err) => this.status(`${kind} model failed: ${(err as Error).message}`))
      .finally(() => {
        this.m.loading.delete(kind)
        if (!this.m.loading.size) this.status('')
      })
    this.m.loading.set(kind, p)
    return p
  }

  reset(): void {
    this.faces = []
    this.caps = emptyCaps()
    this.handCount = this.poseCount = 0
    this.boxes = []
    this.boxMissed = 0
    this.missed = 0
    this.limbMissed = { hands: 0, pose: 0 }
    this.analyzed = { hands: 0, pose: 0 }
    this.lastSets = { hands: 0, pose: 0 }
  }

  analyze(img: ImageBitmap, w: number, h: number, need: Needs, still: boolean, smooth = 0.5): VisionResult {
    const out: VisionResult = { faces: this.faces, caps: this.caps, handCount: 0, poseCount: 0, objects: this.boxes }
    if (need.face && this.m.detector) this.detectFaces(img, w, h, smooth)
    if (need.person && this.m.segmenter) out.person = this.personMask(img)
    if (need.parts && this.m.parts) out.parts = this.partsMask(img)
    if (need.hands && this.m.hands) this.detectHands(img, w, h, smooth, still)
    if (need.pose && this.m.pose) this.detectPose(img, w, h, smooth, still)
    if (need.objects && this.m.objectDet) this.detectObjects(img, smooth)
    return { ...out, faces: this.faces, caps: this.caps, handCount: this.handCount, poseCount: this.poseCount, objects: this.boxes }
  }

  // ---------- objects ----------

  private detectObjects(img: Img, smooth: number): void {
    const found: ObjBox[] = this.m.objectDet!.detect(img)
      .detections.filter((d) => d.boundingBox && d.categories[0])
      .map((d) => ({
        label: d.categories[0].categoryName,
        score: d.categories[0].score,
        x: d.boundingBox!.originX,
        y: d.boundingBox!.originY,
        w: d.boundingBox!.width,
        h: d.boundingBox!.height
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_BOXES * 2)
    if (!found.length) {
      if (++this.boxMissed > 8) this.boxes = []
      return
    }
    this.boxMissed = 0
    // Ease each box toward the same-label box it most likely was last frame (center distance vs size).
    this.boxes = found.map((b) => {
      const cx = b.x + b.w / 2
      const cy = b.y + b.h / 2
      let best: ObjBox | null = null
      let bestD = Infinity
      for (const p of this.boxes) {
        if (p.label !== b.label) continue
        const d = Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy)
        if (d < Math.max(b.w, b.h) * 0.5 && d < bestD) {
          best = p
          bestD = d
        }
      }
      if (!best) return b
      const m = (a: number, c: number): number => a * smooth + c * (1 - smooth)
      return { ...b, x: m(best.x, b.x), y: m(best.y, b.y), w: m(best.w, b.w), h: m(best.h, b.h) }
    })
  }

  // ---------- segmentation ----------

  private personMask(img: Img): MaskData | undefined {
    const res = this.m.segmenter!.segment(img)
    try {
      const m = res.confidenceMasks?.[0]
      if (!m) return
      const f = m.getAsFloat32Array()
      const data = new Uint8Array(f.length)
      for (let i = 0; i < f.length; i++) data[i] = f[i] * 255
      return { w: m.width, h: m.height, data }
    } finally {
      res.close()
    }
  }

  /** Multiclass selfie model: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 accessories. */
  private partsMask(img: Img): MaskData | undefined {
    const res = this.m.parts!.segment(img)
    try {
      const ms = res.confidenceMasks
      if (!ms || ms.length < 5) return
      const [bg, hair, body, face, clothes] = ms.slice(0, 5).map((m) => m.getAsFloat32Array())
      const n = hair.length
      const data = new Uint8Array(n * 4)
      for (let i = 0; i < n; i++) {
        data[i * 4] = hair[i] * 255
        data[i * 4 + 1] = Math.max(body[i], face[i]) * 255
        data[i * 4 + 2] = clothes[i] * 255
        data[i * 4 + 3] = (1 - bg[i]) * 255
      }
      return { w: ms[0].width, h: ms[0].height, data }
    } finally {
      res.close()
    }
  }

  // ---------- hands & pose ----------

  private detectHands(img: Img, w: number, h: number, smooth: number, still: boolean): void {
    const sets = this.searchLimbs((src) => this.m.hands!.detect(src).landmarks, img, w, h, 'hands', still, (lm) => ({
      x: lm[0].x,
      y: lm[0].y,
      scale: pdist(lm[0], lm[9])
    }))
    const hands: Capsule[] = []
    const fingers: Capsule[] = []
    for (const lm of sets) {
      const size = pdist(lm[0], lm[9]) // wrist -> middle knuckle
      const cap = (a: number, b: number, r: number): Capsule => [lm[a].x, lm[a].y, lm[b].x, lm[b].y, r]
      for (const [a, b] of FINGER_BONES) fingers.push(cap(a, b, size * 0.13))
      for (const [a, b, r] of PALM) hands.push(cap(a, b, size * r))
    }
    hands.push(...fingers)
    this.handCount = sets.length
    this.setLimbs('hands', { hands, fingers }, smooth)
  }

  private detectPose(img: Img, w: number, h: number, smooth: number, still: boolean): void {
    const sets = this.searchLimbs((src) => this.m.pose!.detect(src).landmarks, img, w, h, 'pose', still, (lm) => {
      const hip = mid(lm[23], lm[24])
      return { x: hip.x, y: hip.y, scale: pdist(mid(lm[11], lm[12]), hip) }
    })
    const legs: Capsule[] = []
    const arms: Capsule[] = []
    let people = 0
    for (const lm of sets) {
      const seen = (i: number): boolean => lm[i].v >= 0.5
      const avg = (pairs: number[][], fallback: number): number => {
        const d = pairs.filter(([a, b]) => seen(a) && seen(b)).map(([a, b]) => pdist(lm[a], lm[b]))
        return d.length ? d.reduce((x, y) => x + y) / d.length : fallback
      }
      // Fall back to torso / shoulder width when the reference bone is hidden (sitting, cropped).
      const thigh = avg([[23, 25], [24, 26]], pdist(lm[11], lm[23]) * 0.8)
      const upperArm = avg([[11, 13], [12, 14]], pdist(lm[11], lm[12]) * 0.6)
      let any = false
      for (const [a, b, r] of LEG_BONES) {
        if (!seen(a) || !seen(b)) continue
        legs.push([lm[a].x, lm[a].y, lm[b].x, lm[b].y, thigh * r])
        any = true
      }
      for (const [a, b, r] of ARM_BONES) {
        if (!seen(a) || !seen(b)) continue
        arms.push([lm[a].x, lm[a].y, lm[b].x, lm[b].y, upperArm * r])
        any = true
      }
      if (any) people++
    }
    this.poseCount = people
    this.setLimbs('pose', { legs, arms }, smooth)
  }

  /**
   * Landmark search in full-image pixels: whole frame every time, plus zoomed tiles when due (stills, every
   * 10th frame, or when a previously tracked subject went missing). Models shrink the frame to ~256 px, so
   * small hands/people only show up in tiles. Overlapping results are merged by their anchor point.
   */
  private searchLimbs(
    run: (src: Img) => NormalizedLandmark[][],
    img: Img,
    w: number,
    h: number,
    group: 'hands' | 'pose',
    still: boolean,
    anchor: (lm: Pt[]) => { x: number; y: number; scale: number }
  ): Pt[][] {
    const toPx = (found: NormalizedLandmark[][], sx: number, sy: number, sw: number, sh: number): Pt[][] =>
      found.map((lm) => lm.map((q) => ({ x: sx + q.x * sw, y: sy + q.y * sh, v: q.visibility ?? 1 })))
    let sets = toPx(run(img), 0, 0, w, h)
    const n = this.analyzed[group]++
    if (still || n % 10 === 0 || sets.length < this.lastSets[group]) {
      for (const [sx, sy, sw, sh] of tiles(w, h, group)) {
        const k = 512 / Math.max(sw, sh)
        this.limbCrop.width = Math.round(sw * k)
        this.limbCrop.height = Math.round(sh * k)
        this.limbCrop.getContext('2d')!.drawImage(img, sx, sy, sw, sh, 0, 0, this.limbCrop.width, this.limbCrop.height)
        sets.push(...toPx(run(this.limbCrop), sx, sy, sw, sh))
      }
      const keep: Pt[][] = []
      for (const set of sets) {
        const a = anchor(set)
        const dup = keep.some((kept) => {
          const b = anchor(kept)
          return Math.hypot(a.x - b.x, a.y - b.y) < Math.max(a.scale, b.scale) * 0.6
        })
        if (!dup) keep.push(set)
      }
      sets = keep
    }
    this.lastSets[group] = sets.length
    return sets
  }

  /** Ease capsules toward new detections when the layout matches; hold briefly when detection drops out. */
  private setLimbs(group: 'hands' | 'pose', next: Partial<Record<LimbKind, Capsule[]>>, smooth: number): void {
    const empty = Object.values(next).every((c) => !c!.length)
    const caps = { ...this.caps }
    if (empty) {
      if (++this.limbMissed[group] > 8) for (const k of Object.keys(next) as LimbKind[]) caps[k] = []
    } else {
      this.limbMissed[group] = 0
      for (const [k, list] of Object.entries(next) as [LimbKind, Capsule[]][]) {
        const prev = this.caps[k]
        caps[k] = prev.length === list.length ? list.map((c, i) => c.map((v, j) => prev[i][j] * smooth + v * (1 - smooth)) as Capsule) : list
      }
    }
    for (const k of LIMB_KINDS) caps[k] ??= []
    this.caps = caps
  }

  // ---------- faces ----------

  /** Detect in a sub-rectangle (scaled to the model's comfort zone); returns boxes in full-image pixels. */
  private detectIn(img: Img, sx: number, sy: number, sw: number, sh: number, full: boolean): Box[] {
    let src: Img = img
    let scale = 1
    if (!full) {
      const S = 256
      const g = this.crop.getContext('2d')!
      g.clearRect(0, 0, S, S)
      g.drawImage(img, sx, sy, sw, sh, 0, 0, S, S)
      src = this.crop
      scale = sw / S
    }
    const res = this.m.detector!.detect(src)
    return res.detections
      .filter((d) => d.boundingBox)
      .map((d) => {
        const bb = d.boundingBox!
        // Keypoints are normalized to the analyzed image (whole frame or crop) -> full-image pixels.
        const pts = d.keypoints.map((k) => ({ x: sx + k.x * sw, y: sy + k.y * sh }))
        return {
          x: sx + bb.originX * scale,
          y: sy + bb.originY * scale,
          w: bb.width * scale,
          h: bb.height * scale,
          score: d.categories[0]?.score ?? 0,
          eyes: pts.length >= 2 ? [pts[0], pts[1]] : null
        }
      })
  }

  /**
   * Face search: (1) crops around last frame's faces, (2) whole frame, (3) zoomed overlapping tiles.
   * The model works at 128 px, so small faces in a full frame vanish; tiles bring them back into range.
   */
  private findFaces(img: Img, w: number, h: number): Box[] {
    let boxes: Box[] = []
    for (const f of this.faces) {
      const side = Math.min(Math.max(w, h), Math.max(f.rx * w, f.ry * h) * 2 * 2.2)
      const sx = Math.max(0, Math.min(w - side, f.cx * w - side / 2))
      const sy = Math.max(0, Math.min(h - side, f.cy * h - side / 2))
      boxes.push(...this.detectIn(img, sx, sy, Math.min(side, w), Math.min(side, h), false))
    }
    if (!boxes.length) boxes = this.detectIn(img, 0, 0, w, h, true)
    if (!boxes.length) {
      const side = Math.min(w, h) / 1.5
      const step = side * 0.66
      for (let y = 0; y < h - 1; y += step) {
        for (let x = 0; x < w - 1; x += step) {
          boxes.push(...this.detectIn(img, Math.min(x, w - side), Math.min(y, h - side), side, side, false))
          if (x + side >= w) break
        }
        if (y + side >= h) break
      }
    }
    // Non-max suppression: overlapping boxes from neighbouring tiles are the same face.
    boxes.sort((a, b) => b.score - a.score)
    const keep: Box[] = []
    for (const bx of boxes) if (!keep.some((k) => iou(k, bx) > 0.3)) keep.push(bx)
    return keep
  }

  private detectFaces(img: Img, w: number, h: number, smooth: number): void {
    const found: Face[] = this.findFaces(img, w, h)
      .sort((a, b) => b.w * b.h - a.w * a.h)
      .slice(0, MAX_FACES)
      .map((b) => {
        // Eye keypoints (0 right, 1 left): tilt follows the eye line.
        const angle = b.eyes ? Math.atan2(b.eyes[1].y - b.eyes[0].y, b.eyes[1].x - b.eyes[0].x) : 0
        // BlazeFace boxes run brow→chin; widen and lift so the ellipse covers forehead and hairline.
        return { cx: (b.x + b.w / 2) / w, cy: (b.y + b.h * 0.42) / h, rx: (b.w * 0.62) / w, ry: (b.h * 0.78) / h, angle }
      })
    if (!found.length) {
      // Hold the last faces for a few frames so a single missed detection doesn't flash the effect off.
      if (++this.missed > 8) this.faces = []
      return
    }
    this.missed = 0
    // Match each new face to the nearest previous one and ease toward it.
    this.faces = found.map((f) => {
      const prev = this.faces.reduce<Face | null>((best, p) => {
        const d = Math.hypot(p.cx - f.cx, p.cy - f.cy)
        return d < 0.15 && (!best || d < Math.hypot(best.cx - f.cx, best.cy - f.cy)) ? p : best
      }, null)
      if (!prev) return f
      const m = (a: number, b: number): number => a * smooth + b * (1 - smooth)
      return { cx: m(prev.cx, f.cx), cy: m(prev.cy, f.cy), rx: m(prev.rx, f.rx), ry: m(prev.ry, f.ry), angle: m(prev.angle, f.angle) }
    })
  }
}
