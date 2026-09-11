/**
 * Drives RTMP stream liveliness checks via a keep-alive heartbeat:
 * `setActive(true)` starts the timer; each tick sends a keep-alive with a
 * fresh ackId; `maxMissedAcks` consecutive timeouts fire `onTimeout`.
 *
 * Phone-owned successor to the retired cloud stream lifecycle controller.
 * It uses the local `LifecycleLogger` interface because pino is not a phone
 * dependency.
 */

export interface LifecycleLogger {
  child(bindings: Record<string, unknown>): LifecycleLogger
  debug(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

interface StreamLifecycleCallbacks {
  sendKeepAlive: (ackId: string) => Promise<void> | void
  onTimeout: () => Promise<void> | void
  onKeepAliveSent?: (ackId: string) => void
  onKeepAliveAcked?: (ackId: string, ageMs: number) => void
  onKeepAliveMissed?: (ackId: string, ageMs: number, missedCount: number) => void
}

export interface StreamLifecycleOptions {
  logger: LifecycleLogger
  streamId: string
  keepAliveIntervalMs: number
  ackTimeoutMs: number
  maxMissedAcks: number
  shouldSendKeepAlive?: () => boolean
  now?: () => number
}

interface PendingAckInfo {
  sentAt: number
  timeout: ReturnType<typeof setTimeout>
}

/**
 * Drives RTMP stream liveliness checks. Activate to start the heartbeat;
 * each tick sends a keep-alive with a fresh ackId and arms a timeout. When
 * `maxMissedAcks` consecutive timeouts fire, `onTimeout` is invoked and the
 * caller is expected to tear the stream down.
 */
export class StreamLifecycleController {
  private keepAliveTimer?: ReturnType<typeof setInterval>
  private pendingAcks: Map<string, PendingAckInfo> = new Map()
  private missedAcks = 0
  private lastActivityMs: number
  private active = false
  private disposed = false

  private readonly logger: LifecycleLogger
  private readonly streamId: string
  private readonly keepAliveIntervalMs: number
  private readonly ackTimeoutMs: number
  private readonly maxMissedAcks: number
  private readonly shouldSendKeepAlive?: () => boolean
  private readonly now: () => number

  constructor(
    options: StreamLifecycleOptions,
    private readonly callbacks: StreamLifecycleCallbacks,
  ) {
    this.logger = options.logger.child({component: "StreamLifecycle"})
    this.streamId = options.streamId
    this.keepAliveIntervalMs = options.keepAliveIntervalMs
    this.ackTimeoutMs = options.ackTimeoutMs
    this.maxMissedAcks = options.maxMissedAcks
    this.shouldSendKeepAlive = options.shouldSendKeepAlive
    this.now = options.now ?? (() => Date.now())
    this.lastActivityMs = this.now()
  }

  setActive(active: boolean): void {
    if (this.disposed || this.active === active) return

    this.logger.debug({streamId: this.streamId, active}, "Updating lifecycle active state")

    this.active = active
    if (active) {
      this.startTimer()
    } else {
      this.stopTimer()
      this.clearPendingAcks()
      this.missedAcks = 0
    }
  }

  recordActivity(): void {
    this.lastActivityMs = this.now()
    this.missedAcks = 0
  }

  handleAck(ackId: string): void {
    if (this.disposed) return

    const ackInfo = this.pendingAcks.get(ackId)
    if (!ackInfo) {
      this.logger.warn({streamId: this.streamId, ackId}, "Received unknown keep-alive ACK")
      return
    }

    clearTimeout(ackInfo.timeout)
    this.pendingAcks.delete(ackId)
    this.recordActivity()

    this.callbacks.onKeepAliveAcked?.(ackId, this.now() - ackInfo.sentAt)
  }

  dispose(): void {
    if (this.disposed) return

    this.disposed = true
    this.stopTimer()
    this.clearPendingAcks()
    this.logger.debug({streamId: this.streamId}, "Lifecycle disposed")
  }

  getLastActivityMs(): number {
    return this.lastActivityMs
  }

  private startTimer(): void {
    if (this.keepAliveTimer) return
    this.keepAliveTimer = setInterval(() => {
      void this.tick()
    }, this.keepAliveIntervalMs)
    this.logger.debug({streamId: this.streamId}, "Keep-alive timer started")
  }

  private stopTimer(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = undefined
      this.logger.debug({streamId: this.streamId}, "Keep-alive timer stopped")
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.active) return

    if (this.shouldSendKeepAlive && !this.shouldSendKeepAlive()) {
      this.logger.warn(
        {streamId: this.streamId},
        "Skipping keep-alive send because transport is unavailable",
      )
      return
    }

    const ackId = this.createAckId()
    const sentAt = this.now()

    const timeout = setTimeout(() => {
      this.onAckTimeout(ackId, sentAt)
    }, this.ackTimeoutMs)

    this.pendingAcks.set(ackId, {sentAt, timeout})
    this.callbacks.onKeepAliveSent?.(ackId)

    try {
      await this.callbacks.sendKeepAlive(ackId)
    } catch (error) {
      this.logger.error({streamId: this.streamId, ackId, error}, "Error sending keep-alive")
    }
  }

  private onAckTimeout(ackId: string, sentAt: number): void {
    if (this.disposed) return

    // Race guard: handleAck may have processed the ACK between the timeout
    // being scheduled and this callback running. In that case the ackId is
    // no longer pending — counting it as missed would falsely escalate.
    if (!this.pendingAcks.has(ackId)) return

    this.pendingAcks.delete(ackId)
    this.missedAcks += 1
    const ageMs = this.now() - sentAt

    this.logger.warn(
      {streamId: this.streamId, ackId, missedAcks: this.missedAcks, ageMs},
      "Keep-alive ACK timeout",
    )

    this.callbacks.onKeepAliveMissed?.(ackId, ageMs, this.missedAcks)

    if (this.missedAcks >= this.maxMissedAcks) {
      this.logger.error(
        {
          streamId: this.streamId,
          missedAcks: this.missedAcks,
          maxMissedAcks: this.maxMissedAcks,
        },
        "Maximum missed ACKs reached; triggering timeout",
      )

      void this.callbacks.onTimeout()
    }
  }

  private clearPendingAcks(): void {
    for (const {timeout} of this.pendingAcks.values()) {
      clearTimeout(timeout)
    }
    this.pendingAcks.clear()
  }

  private createAckId(): string {
    return `a${this.now().toString(36).slice(-5)}`
  }
}
