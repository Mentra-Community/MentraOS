/**
 * Collapse a stream of box measurements into the few that matter.
 *
 * A layout animation fires ResizeObserver every frame. Bursts inside one frame are merged with
 * `requestAnimationFrame`, and a size is only applied once it has held still for the settle
 * window. Hiding (a zero box) and the first measurement apply at once: the first so the preview
 * starts without a delay, hiding so production stops as soon as nobody can see it.
 */

export interface PreviewBox {
  width: number
  height: number
}

export interface ResizeCoalescerOptions {
  apply: (box: PreviewBox) => void
  settleMs?: number
  requestFrame?: (cb: () => void) => unknown
  setTimer?: (cb: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const RESIZE_SETTLE_MS = 250

function isZero(box: PreviewBox): boolean {
  return !(box.width > 0) || !(box.height > 0)
}

export class ResizeCoalescer {
  private latest: PreviewBox | null = null
  private lastApplied: PreviewBox | null = null
  private framePending = false
  private timer: unknown = null
  private cancelled = false
  private readonly settleMs: number
  private readonly requestFrame: (cb: () => void) => unknown
  private readonly setTimer: (cb: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly options: ResizeCoalescerOptions) {
    this.settleMs = options.settleMs ?? RESIZE_SETTLE_MS
    this.requestFrame =
      options.requestFrame ??
      ((cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => cb()) : setTimeout(cb, 16)))
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  push(box: PreviewBox): void {
    if (this.cancelled) return
    this.latest = box
    if (!this.lastApplied || isZero(box) || isZero(this.lastApplied)) {
      this.clearSettle()
      this.applyLatest()
      return
    }
    if (this.framePending) return
    this.framePending = true
    this.requestFrame(() => {
      this.framePending = false
      if (this.cancelled) return
      this.clearSettle()
      this.timer = this.setTimer(() => {
        this.timer = null
        this.applyLatest()
      }, this.settleMs)
    })
  }

  cancel(): void {
    this.cancelled = true
    this.clearSettle()
  }

  private applyLatest(): void {
    const box = this.latest
    if (!box || this.cancelled) return
    if (this.lastApplied && this.lastApplied.width === box.width && this.lastApplied.height === box.height) return
    this.lastApplied = box
    this.options.apply(box)
  }

  private clearSettle(): void {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }
}
