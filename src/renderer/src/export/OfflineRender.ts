import type { Pipeline } from '../gl/Pipeline'
import type { Codec } from '../../../preload'
import { preloadFonts } from '../effects/fontLayer'

export interface RenderJob {
  out: string
  width: number
  height: number
  fps: number
  duration: number
  codec: Codec
  audioPath?: string
}

export interface RenderContext {
  pipeline: Pipeline
  /** Once before the first frame (load models, reset trackers). */
  prepare: () => Promise<void>
  /** Draw the frame for time t (seek sources, detect subjects, render all layers). */
  frame: (t: number) => Promise<void>
  /** After the last frame (or on cancel/failure): put sources back for the preview. */
  restore: () => void
}

/**
 * Seek and wait until the new frame is actually presented. 'seeked' alone can fire before the decoder
 * has the frame, which makes texImage2D upload the previous one (non-deterministic output).
 */
export function seekVideo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 1e-4 && v.readyState >= 2) return resolve()
    let finished = false
    const done = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, 3000)
    v.requestVideoFrameCallback(() => done())
    v.currentTime = t
  })
}

/** Frame-exact render: frame i is drawn at exactly t = i / fps and piped to ffmpeg. */
export async function renderOffline(
  job: RenderJob,
  ctx: RenderContext,
  onProgress: (frame: number, total: number) => void,
  signal: AbortSignal
): Promise<string> {
  const { pipeline } = ctx
  const total = Math.max(1, Math.round(job.duration * job.fps))
  const prevSize: [number, number] = [pipeline.width, pipeline.height]
  await preloadFonts()
  await ctx.prepare()
  await window.api.renderStart(job)
  pipeline.resize(job.width, job.height)
  let px: Uint8Array | undefined
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Render cancelled', 'AbortError')
      await ctx.frame(i / job.fps)
      px = pipeline.readPixels(px)
      await window.api.renderFrame(px)
      onProgress(i + 1, total)
    }
    return await window.api.renderFinish()
  } catch (err) {
    await window.api.renderCancel()
    throw err
  } finally {
    pipeline.resize(prevSize[0], prevSize[1])
    ctx.restore()
  }
}
