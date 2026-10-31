const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|ogv|avi)$/i

/** Holds the current input: an image, a looping video, or a generated placeholder. */
export class Source {
  el: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
  kind: 'placeholder' | 'image' | 'video' | 'camera' = 'placeholder'
  name = 'placeholder'
  /** Filesystem path, used to mux original audio into exports. */
  path = ''
  dirty = true
  private url = ''

  constructor() {
    this.el = makePlaceholder()
  }

  get width(): number {
    return this.el instanceof HTMLVideoElement ? this.el.videoWidth : this.el instanceof HTMLImageElement ? this.el.naturalWidth : this.el.width
  }
  get height(): number {
    return this.el instanceof HTMLVideoElement ? this.el.videoHeight : this.el instanceof HTMLImageElement ? this.el.naturalHeight : this.el.height
  }
  get video(): HTMLVideoElement | null {
    return this.el instanceof HTMLVideoElement ? this.el : null
  }
  /** True when a new frame should be uploaded. */
  get ready(): boolean {
    const v = this.video
    return v ? v.readyState >= 2 : this.dirty
  }

  async load(blob: Blob, name: string, path = ''): Promise<void> {
    const isVideo = blob.type.startsWith('video/') || VIDEO_EXT.test(name)
    const url = URL.createObjectURL(blob)
    let el: HTMLImageElement | HTMLVideoElement
    if (isVideo) {
      const v = document.createElement('video')
      v.src = url
      v.loop = true
      v.muted = true
      v.playsInline = true
      await new Promise<void>((res, rej) => {
        v.onloadeddata = () => res()
        v.onerror = () => rej(new Error('Could not decode video: ' + name))
      })
      await v.play().catch(() => {})
      el = v
    } else {
      const img = new Image()
      img.src = url
      await img.decode()
      el = img
    }
    this.dispose()
    this.el = el
    this.url = url
    this.kind = isVideo ? 'video' : 'image'
    this.name = name
    this.path = path
    this.dirty = true
  }

  /** Live webcam. Not seekable, so it can be previewed and snapshotted but not offline-rendered. */
  async loadCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
    const v = document.createElement('video')
    v.srcObject = stream
    v.muted = true
    v.playsInline = true
    await v.play()
    this.dispose()
    this.el = v
    this.kind = 'camera'
    this.name = stream.getVideoTracks()[0]?.label || 'Camera'
    this.path = ''
    this.dirty = true
  }

  /** The video element when the source is a seekable video file (not the webcam). */
  get fileVideo(): HTMLVideoElement | null {
    return this.kind === 'video' ? this.video : null
  }

  /** Back to the "drop an image" placeholder (new project). */
  reset(): void {
    this.dispose()
    this.el = makePlaceholder()
    this.kind = 'placeholder'
    this.name = 'placeholder'
    this.path = ''
    this.dirty = true
  }

  private dispose(): void {
    const v = this.video
    if (v?.srcObject instanceof MediaStream) {
      v.srcObject.getTracks().forEach((t) => t.stop())
      v.srcObject = null
    }
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
    if (this.url) URL.revokeObjectURL(this.url)
    this.url = ''
  }
}

function makePlaceholder(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 1080
  c.height = 1350
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 0, c.height)
  grad.addColorStop(0, '#1b1b22')
  grad.addColorStop(1, '#050507')
  g.fillStyle = grad
  g.fillRect(0, 0, c.width, c.height)
  const r = g.createRadialGradient(540, 560, 40, 540, 560, 420)
  r.addColorStop(0, '#f2f2f2')
  r.addColorStop(0.55, '#8a8a8a')
  r.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = r
  g.beginPath()
  g.ellipse(540, 580, 300, 380, 0, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#e8e8e8'
  g.font = '700 64px "Segoe UI", sans-serif'
  g.textAlign = 'center'
  g.fillText('DROP AN IMAGE', 540, 1120)
  g.fillText('OR VIDEO', 540, 1200)
  return c
}
