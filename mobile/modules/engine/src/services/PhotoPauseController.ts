/**
 * Longer than a full-size photo over the glasses hotspot (upload has been seen at ~45s)
 * plus the still hold. A shorter ceiling restarts the camera while the shutter still has it.
 */
export const PHOTO_PAUSE_CEILING_MS = 90_000

let pauseSeq = 0

function mintPauseId(): string {
  pauseSeq = (pauseSeq + 1) % 0xffffffff
  const random = Math.floor(Math.random() * 0xffffffff).toString(16)
  return `photo-${Date.now().toString(16)}-${pauseSeq.toString(16)}-${random}`
}

export interface PhotoPauseDeps {
  stopPublisher: () => Promise<void>
  startPublisher: () => Promise<void>
  ceilingMs?: number
  onExpired?: (pauseId: string) => void
}

/**
 * One photo shutter's ownership of the glasses publisher.
 *
 * A resume with a stale id does nothing. Leave, End, and a new join cancel the
 * pause and do not start the publisher again — the call teardown already stopped
 * it. The ceiling resumes a pause the wearer never closed.
 */
export class PhotoPauseController {
  private active: {id: string; timer: ReturnType<typeof setTimeout>} | null = null

  constructor(private readonly deps: PhotoPauseDeps) {}

  holding(): boolean {
    return this.active !== null
  }

  pauseId(): string | null {
    return this.active?.id ?? null
  }

  async pause(): Promise<{pauseId: string}> {
    if (this.active) return {pauseId: this.active.id}
    const pauseId = mintPauseId()
    const timer = setTimeout(() => {
      void this.expire(pauseId)
    }, this.deps.ceilingMs ?? PHOTO_PAUSE_CEILING_MS)
    this.active = {id: pauseId, timer}
    await this.deps.stopPublisher()
    return {pauseId}
  }

  /** Stale ids are a no-op. A current id starts the publisher again. */
  async resume(pauseId: string): Promise<"resumed" | "stale"> {
    if (!this.active || this.active.id !== pauseId) return "stale"
    this.clear()
    await this.deps.startPublisher()
    return "resumed"
  }

  /** Drop the pause without starting the publisher. Used when the call itself is ending. */
  cancel(): void {
    this.clear()
  }

  private async expire(pauseId: string): Promise<void> {
    if (!this.active || this.active.id !== pauseId) return
    this.clear()
    await this.deps.startPublisher()
    this.deps.onExpired?.(pauseId)
  }

  private clear(): void {
    if (!this.active) return
    clearTimeout(this.active.timer)
    this.active = null
  }
}
