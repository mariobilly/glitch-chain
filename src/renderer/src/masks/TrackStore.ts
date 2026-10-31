/** A precomputed per-frame mask sequence (AI object selection), stored as PNGs in source space. */
export interface MaskTrack {
  id: string
  label: string
  /** What produced it (e.g. "GroundingDINO + SAM: red cup"). */
  engine: string
  sourcePath: string
  /** Frames were analyzed at this rate starting at t = 0; missing frames hold the previous mask. */
  fps: number
  frames: (Blob | null)[]
}

/**
 * Holds mask tracks and keeps one GPU texture per track showing the frame for the current time. Preview calls
 * `sync` (non-blocking, decodes in the background); offline renders `await prepare` for exact frames.
 */
export class TrackStore {
  private tracks = new Map<string, MaskTrack>()
  private gpu = new Map<string, { tex: WebGLTexture; frame: number; loading: number }>()
  onChange: () => void = () => {}

  constructor(private gl: WebGL2RenderingContext) {}

  list(): MaskTrack[] {
    return [...this.tracks.values()]
  }
  get(id: string): MaskTrack | undefined {
    return this.tracks.get(id)
  }

  add(t: MaskTrack): void {
    this.tracks.set(t.id, t)
    this.onChange()
  }

  remove(id: string): void {
    this.tracks.delete(id)
    const g = this.gpu.get(id)
    if (g) this.gl.deleteTexture(g.tex)
    this.gpu.delete(id)
    this.onChange()
  }

  /** Index of the stored frame to show at time t (holds the last analyzed frame). */
  frameAt(t: MaskTrack, time: number): number {
    let i = Math.min(t.frames.length - 1, Math.max(0, Math.round(time * t.fps)))
    while (i > 0 && !t.frames[i]) i--
    return t.frames[i] ? i : -1
  }

  private entry(id: string): { tex: WebGLTexture; frame: number; loading: number } {
    let g = this.gpu.get(id)
    if (!g) {
      const gl = this.gl
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      g = { tex, frame: -1, loading: -1 }
      this.gpu.set(id, g)
    }
    return g
  }

  private async upload(id: string, frame: number, blob: Blob): Promise<void> {
    const g = this.entry(id)
    g.loading = frame
    const bmp = await createImageBitmap(blob)
    // A newer request may have started meanwhile; only the latest one wins.
    if (g.loading !== frame) return bmp.close()
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, g.tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp) // rows stay top-down, like the person mask
    bmp.close()
    g.frame = frame
    g.loading = -1
  }

  /** Preview: start decoding the right frame for each id; returns whatever textures are ready now. */
  sync(ids: string[], time: number): Record<string, WebGLTexture> {
    const out: Record<string, WebGLTexture> = {}
    for (const id of ids) {
      const t = this.tracks.get(id)
      if (!t) continue
      const f = this.frameAt(t, time)
      if (f < 0) continue
      const g = this.entry(id)
      if (g.frame !== f && g.loading !== f) void this.upload(id, f, t.frames[f]!)
      if (g.frame >= 0) out[id] = g.tex
    }
    return out
  }

  /** Offline render: make sure each id shows exactly the frame for `time`. */
  async prepare(ids: string[], time: number): Promise<Record<string, WebGLTexture>> {
    const out: Record<string, WebGLTexture> = {}
    for (const id of ids) {
      const t = this.tracks.get(id)
      if (!t) continue
      const f = this.frameAt(t, time)
      if (f < 0) continue
      const g = this.entry(id)
      if (g.frame !== f) await this.upload(id, f, t.frames[f]!)
      out[id] = g.tex
    }
    return out
  }
}

/** Track ids referenced by enabled effects in these chains. */
export const trackIds = (chains: { enabled: boolean; mask: { source: string; track: string } }[][]): string[] => [
  ...new Set(
    chains
      .flat()
      .filter((i) => i.enabled && i.mask.source === 'track' && i.mask.track)
      .map((i) => i.mask.track)
  )
]
