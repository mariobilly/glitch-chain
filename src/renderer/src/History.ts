/**
 * Snapshot undo/redo. Polls a serializer and commits once the state has been stable briefly, so every
 * kind of edit (sliders, keys, modulators, reorder, presets) is captured without wiring each one up,
 * and a slider drag becomes one step instead of hundreds.
 */
export class History {
  private stack: string[] = []
  private idx = -1
  private pending = ''
  private pendingAt = 0

  constructor(
    private serialize: () => string,
    private restore: (snapshot: string) => void,
    private onChange: () => void,
    private settleMs = 350,
    private limit = 200
  ) {}

  reset(): void {
    const s = this.serialize()
    this.stack = [s]
    this.idx = 0
    this.pending = s
    this.onChange()
  }

  poll(now = performance.now()): void {
    const s = this.serialize()
    if (s !== this.pending) {
      this.pending = s
      this.pendingAt = now
      return
    }
    if (s !== this.stack[this.idx] && now - this.pendingAt >= this.settleMs) this.push(s)
  }

  private push(s: string): void {
    this.stack.splice(this.idx + 1)
    this.stack.push(s)
    if (this.stack.length > this.limit) this.stack.shift()
    this.idx = this.stack.length - 1
    this.onChange()
  }

  /** Commit an edit that hasn't settled yet so undo returns to the state before it. */
  private flush(): void {
    const s = this.serialize()
    if (s !== this.stack[this.idx]) this.push(s)
  }

  get canUndo(): boolean {
    return this.idx > 0 || this.serialize() !== this.stack[this.idx]
  }
  get canRedo(): boolean {
    return this.idx < this.stack.length - 1
  }

  undo(): void {
    this.flush()
    if (this.idx <= 0) return
    this.go(this.idx - 1)
  }

  redo(): void {
    if (!this.canRedo) return
    this.go(this.idx + 1)
  }

  private go(i: number): void {
    this.idx = i
    this.restore(this.stack[i])
    // Normalize: if restoring re-serializes slightly differently, don't let poll() treat it as a new edit.
    this.stack[i] = this.pending = this.serialize()
    this.onChange()
  }
}
