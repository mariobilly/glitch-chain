import { AutoProcessor, RawImage, SamModel, pipeline, type Tensor } from '@huggingface/transformers'
import './hfEnv'

const SAM_ID = 'Xenova/sam-vit-base'
const DINO_ID = 'onnx-community/grounding-dino-tiny-ONNX'

/** A binary mask at the analyzed frame's size (0 or 255 per pixel), plus its bounding box. */
export interface SegMask {
  w: number
  h: number
  data: Uint8Array
  score: number
  /** [x0, y0, x1, y1] in pixels, or null if empty. */
  box: [number, number, number, number] | null
}

export interface Prompt {
  /** [x, y, label]: label 1 = include, 0 = exclude. Pixels of the analyzed frame. */
  points?: [number, number, number][]
}

type Detector = (image: RawImage, labels: string[], o: { threshold: number }) => Promise<{ score: number; label: string; box: { xmin: number; ymin: number; xmax: number; ymax: number } }[]>

/**
 * Segment Anything (click / box prompts) and Grounding DINO (text prompts), run in-app with ONNX on WebGPU.
 * `setImage` encodes a frame once; any number of prompts on that frame are then cheap.
 */
export class Segmenter {
  device: 'webgpu' | 'wasm' | null = null
  private sam: SamModel | null = null
  private proc: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null
  private dino: Detector | null = null
  private loadingSam: Promise<void> | null = null
  private loadingDino: Promise<void> | null = null
  private raw: RawImage | null = null
  private embeds: Record<string, Tensor> | null = null

  constructor(private status: (s: string) => void = () => {}) {}

  private async pick<T>(load: (device: 'webgpu' | 'wasm') => Promise<T>): Promise<T> {
    if ('gpu' in navigator) {
      try {
        const m = await load('webgpu')
        this.device ??= 'webgpu'
        return m
      } catch (err) {
        console.warn('WebGPU load failed, using CPU:', err)
      }
    }
    this.device = 'wasm'
    return load('wasm')
  }

  loadSam(): Promise<void> {
    this.loadingSam ??= (async () => {
      this.status('Loading Segment Anything…')
      this.sam = (await this.pick((device) => SamModel.from_pretrained(SAM_ID, { device, dtype: 'fp16' }))) as SamModel
      this.proc = await AutoProcessor.from_pretrained(SAM_ID)
      this.status('')
    })().catch((err) => {
      this.loadingSam = null
      throw err
    })
    return this.loadingSam
  }

  loadDino(): Promise<void> {
    this.loadingDino ??= (async () => {
      this.status('Loading Grounding DINO…')
      this.dino = (await this.pick((device) => pipeline('zero-shot-object-detection', DINO_ID, { device, dtype: 'q4f16' }))) as unknown as Detector
      this.status('')
    })().catch((err) => {
      this.loadingDino = null
      throw err
    })
    return this.loadingDino
  }

  /** Encode a frame (canvas at the analysis size). */
  async setImage(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
    await this.loadSam()
    this.raw = RawImage.fromCanvas(canvas).rgb()
    const inputs = await this.proc!(this.raw)
    this.embeds = (await this.sam!.get_image_embeddings(inputs)) as unknown as Record<string, Tensor>
  }

  /** Find objects described by `text` on the current image; boxes in its pixels, best first. */
  async detect(text: string, threshold = 0.3): Promise<{ box: [number, number, number, number]; score: number }[]> {
    if (!this.raw) throw new Error('setImage first')
    await this.loadDino()
    // Grounding DINO expects lowercase phrases ending with a period; "a . b" means two separate things.
    const labels = text
      .toLowerCase()
      .split(/[.,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => `${s}.`)
    const found = await this.dino!(this.raw, labels, { threshold })
    return found
      .sort((a, b) => b.score - a.score)
      .map((d) => ({ box: [d.box.xmin, d.box.ymin, d.box.xmax, d.box.ymax] as [number, number, number, number], score: d.score }))
  }

  /** One decoder run for a set of points: low-res candidates (3 masks, 256x256 logits) + their scores. */
  private async decode(points: [number, number, number][]): Promise<DecodeRun> {
    const inputs = (await this.proc!(this.raw!, {
      input_points: [[points.map(([x, y]) => [x, y])]],
      input_labels: [[points.map(([, , l]) => l)]]
    })) as SamInputs
    const out = (await this.sam!({ ...this.embeds, input_points: inputs.input_points, input_labels: inputs.input_labels })) as DecodeRun['out']
    return { out, inputs }
  }

  /** Upscale candidate `index` of a decoder run to a full-resolution binary mask. */
  private async finish(run: DecodeRun, index: number): Promise<SegMask> {
    const masks = await (this.proc as unknown as { post_process_masks: (m: Tensor, o: unknown, r: unknown) => Promise<Tensor[]> }).post_process_masks(
      run.out.pred_masks,
      run.inputs.original_sizes,
      run.inputs.reshaped_input_sizes
    )
    const m = masks[0] // [1, 3, H, W]
    const [, , h, w] = m.dims as number[]
    const src = m.data as Uint8Array
    const data = new Uint8Array(w * h)
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    const off = index * w * h
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!src[off + y * w + x]) continue
        data[y * w + x] = 255
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
    return { w, h, data, score: (run.out.iou_scores.data as Float32Array)[index], box: x1 >= 0 ? [x0, y0, x1, y1] : null }
  }

  /** SAM from clicked points (label 1 include, 0 exclude); keeps its most confident candidate. */
  async segment(p: Prompt): Promise<SegMask> {
    if (!this.raw || !this.embeds) throw new Error('setImage first')
    if (!p.points?.length) throw new Error('segment needs at least one point')
    const run = await this.decode(p.points)
    const scores = run.out.iou_scores.data as Float32Array
    let best = 0
    for (let i = 1; i < 3; i++) if (scores[i] > scores[best]) best = i
    return this.finish(run, best)
  }

  /**
   * SAM guided by a box. This decoder export only accepts points, so: try positive points inside the box
   * (a 3x3 grid plus any `hints`, e.g. interior points of last frame's mask), score every low-res candidate by
   * how well it fills the box, and upscale only the winner.
   */
  async segmentInBox(box: [number, number, number, number], hints: [number, number][] = []): Promise<SegMask | null> {
    if (!this.raw || !this.embeds) throw new Error('setImage first')
    const [bx0, by0, bx1, by1] = box
    const bw = bx1 - bx0
    const bh = by1 - by0
    const tries: [number, number, number][][] = []
    if (hints.length) tries.push(hints.map(([x, y]) => [x, y, 1]))
    for (const [x, y] of hints) tries.push([[x, y, 1]])
    for (const fy of [0.3, 0.5, 0.7]) for (const fx of [0.3, 0.5, 0.7]) tries.push([[bx0 + bw * fx, by0 + bh * fy, 1]])
    let best: { run: DecodeRun; index: number; score: number } | null = null
    for (let t = 0; t < tries.length; t++) {
      // Hints (last frame's interior) usually nail it: skip the grid when they already fit the box well.
      if (hints.length && t === hints.length + 1 && best && best.score > 0.45) break
      const pts = tries[t]
      const run = await this.decode(pts)
      const [rh, rw] = run.inputs.reshaped_input_sizes[0]
      const [oh, ow] = run.inputs.original_sizes[0]
      const lo = run.out.pred_masks.data as Float32Array
      const dims = run.out.pred_masks.dims as number[]
      const mh = dims[dims.length - 2]
      const mw = dims[dims.length - 1]
      const ious = run.out.iou_scores.data as Float32Array
      // Low-res cell -> original pixel: the grid spans the padded 1024 input, of which the image is rw x rh.
      const sx = (1024 / mw) * (ow / rw)
      const sy = (1024 / mh) * (oh / rh)
      for (let k = 0; k < 3; k++) {
        let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, total = 0, inside = 0
        const off = k * mw * mh
        for (let y = 0; y < mh; y++) {
          for (let x = 0; x < mw; x++) {
            if (lo[off + y * mw + x] <= 0) continue
            const px = (x + 0.5) * sx
            const py = (y + 0.5) * sy
            if (px >= ow || py >= oh) continue
            total++
            if (px >= bx0 && px <= bx1 && py >= by0 && py <= by1) inside++
            if (px < x0) x0 = px
            if (px > x1) x1 = px
            if (py < y0) y0 = py
            if (py > y1) y1 = py
          }
        }
        if (!total) continue
        const ix = Math.max(0, Math.min(x1, bx1) - Math.max(x0, bx0))
        const iy = Math.max(0, Math.min(y1, by1) - Math.max(y0, by0))
        const inter = ix * iy
        const iou = inter / ((x1 - x0) * (y1 - y0) + bw * bh - inter)
        const score = iou * (inside / total) * Math.max(0.05, ious[k])
        if (!best || score > best.score) best = { run, index: k, score }
      }
    }
    return best && best.score > 0.05 ? this.finish(best.run, best.index) : null
  }
}

type SamInputs = Record<string, Tensor> & { original_sizes: [number, number][]; reshaped_input_sizes: [number, number][] }
interface DecodeRun {
  out: { pred_masks: Tensor; iou_scores: Tensor }
  inputs: SamInputs
}

/** A few points well inside a mask (away from its edges), for prompting SAM on the next frame. */
export function interiorPoints(m: SegMask, max = 3): [number, number][] {
  if (!m.box) return []
  const [x0, y0, x1, y1] = m.box
  const r = Math.max(3, Math.round(Math.min(x1 - x0, y1 - y0) * 0.08))
  const at = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < m.w && y < m.h && m.data[y * m.w + x] > 0
  const found: [number, number][] = []
  const step = Math.max(4, Math.round(Math.min(x1 - x0, y1 - y0) / 12))
  for (let y = y0; y <= y1; y += step)
    for (let x = x0; x <= x1; x += step) if (at(x, y) && at(x - r, y) && at(x + r, y) && at(x, y - r) && at(x, y + r)) found.push([x, y])
  if (!found.length) return []
  // Spread them out: first, middle, last of the scan.
  return [...new Set([0, Math.floor(found.length / 2), found.length - 1])].slice(0, max).map((i) => found[i])
}

/** Union of several masks of the same size. */
export function unionMasks(ms: SegMask[], w: number, h: number): SegMask {
  const data = new Uint8Array(w * h)
  let box: SegMask['box'] = null
  for (const m of ms) {
    for (let i = 0; i < data.length; i++) if (m.data[i]) data[i] = 255
    if (m.box) box = box ? [Math.min(box[0], m.box[0]), Math.min(box[1], m.box[1]), Math.max(box[2], m.box[2]), Math.max(box[3], m.box[3])] : m.box
  }
  return { w, h, data, score: ms.length ? Math.max(...ms.map((m) => m.score)) : 0, box }
}

/** Grayscale PNG of a mask (what tracks store). */
export async function maskToPng(m: SegMask): Promise<Blob> {
  const c = new OffscreenCanvas(m.w, m.h)
  const g = c.getContext('2d')!
  const img = g.createImageData(m.w, m.h)
  for (let i = 0; i < m.data.length; i++) {
    const v = m.data[i]
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c.convertToBlob({ type: 'image/png' })
}
