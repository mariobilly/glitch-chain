import { RawImage, pipeline } from '@huggingface/transformers'
import './hfEnv'

const MODEL = 'onnx-community/depth-anything-v2-small'
/** Frames are shrunk to this before estimation (the model works at ~518 px anyway). */
export const DEPTH_SIDE = 640

type DepthPipe = (image: RawImage) => Promise<{ depth: RawImage }>

/**
 * Depth Anything V2 (small, fp16) on WebGPU with a CPU fallback. Output is relative depth as an 8-bit image
 * the size of the input: bright = near, dark = far.
 */
export class DepthEstimator {
  device: 'webgpu' | 'wasm' | null = null
  private pipe: DepthPipe | null = null
  private loading: Promise<void> | null = null

  constructor(private status: (s: string) => void = () => {}) {}

  load(): Promise<void> {
    this.loading ??= (async () => {
      this.status('Loading Depth Anything…')
      try {
        if (!('gpu' in navigator)) throw new Error('no WebGPU')
        this.pipe = (await pipeline('depth-estimation', MODEL, { device: 'webgpu', dtype: 'fp16' })) as unknown as DepthPipe
        this.device = 'webgpu'
      } catch (err) {
        console.warn('Depth on WebGPU failed, using CPU:', err)
        this.pipe = (await pipeline('depth-estimation', MODEL, { device: 'wasm', dtype: 'fp16' })) as unknown as DepthPipe
        this.device = 'wasm'
      }
      this.status('')
    })().catch((err) => {
      this.loading = null
      throw err
    })
    return this.loading
  }

  /**
   * Depth of a frame; rows top-down, one byte per pixel, histogram-equalized: a value v means "a fraction v of
   * the frame is farther than this". Order is unchanged, but thresholds like "the far 45%" now behave the same
   * on every shot instead of depending on how the model happened to scale this one.
   */
  async estimate(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<{ w: number; h: number; data: Uint8Array }> {
    await this.load()
    const out = await this.pipe!(RawImage.fromCanvas(canvas))
    const d = out.depth
    return { w: d.width, h: d.height, data: equalize(d.data as Uint8Array) }
  }
}

/** Rank-based remap (histogram equalization) of 8-bit depth. */
export function equalize(src: Uint8Array): Uint8Array {
  const hist = new Uint32Array(256)
  for (let i = 0; i < src.length; i++) hist[src[i]]++
  const map = new Uint8Array(256)
  let acc = 0
  for (let v = 0; v < 256; v++) {
    // Mid-rank of the bin, so a flat region maps to the middle of its range rather than its top.
    map[v] = Math.round(((acc + hist[v] / 2) / src.length) * 255)
    acc += hist[v]
  }
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i++) out[i] = map[src[i]]
  return out
}
