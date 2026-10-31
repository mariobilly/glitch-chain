/**
 * The one clock for preview, keyframes, audio and export. When music or a video is loaded it is the
 * master (its currentTime is the playhead); otherwise time advances by frame delta. Loops at `duration`.
 */
export class Transport {
  t = 0
  duration = 10
  playing = true
  video: HTMLVideoElement | null = null
  music: HTMLAudioElement | null = null

  get master(): HTMLMediaElement | null {
    return this.music ?? this.video
  }

  /** Longest allowed comp: a video master can't be extended past its own length (it would wrap early). */
  get maxDuration(): number {
    if (this.music) return this.music.duration || 600
    if (this.video) return this.video.duration || 600
    return 600
  }

  tick(dt: number): void {
    if (!this.playing) return
    const m = this.master
    if (m && !m.paused && m.readyState >= 2) this.t = m.currentTime
    else this.t += dt
    if (this.t >= this.duration) this.seek(0)
  }

  seek(t: number): void {
    this.t = Math.min(Math.max(0, t), Math.max(0, this.duration - 1e-3))
    if (this.music) this.music.currentTime = Math.min(this.t, this.music.duration || this.t)
    if (this.video && this.video.duration) this.video.currentTime = this.t % this.video.duration
  }

  setPlaying(p: boolean): void {
    this.playing = p
    for (const el of [this.video, this.music]) {
      if (!el) continue
      if (p) el.play().catch(() => {})
      else el.pause()
    }
  }

  /** Called when media changes: re-derive duration and resync. */
  attach(video: HTMLVideoElement | null, music: HTMLAudioElement | null, keepDuration = false): void {
    this.video = video
    this.music = music
    if (!keepDuration && this.master?.duration) this.duration = this.master.duration
    this.duration = Math.min(this.duration, this.maxDuration)
    this.seek(0)
    this.setPlaying(this.playing)
  }
}

export const fmtTime = (s: number): string => {
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`
}
