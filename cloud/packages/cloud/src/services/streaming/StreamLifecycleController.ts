import { Logger } from "pino";

interface StreamLifecycleCallbacks {
  sendKeepAlive: (ackId: string) => Promise<void> | void;
  onTimeout: () => Promise<void> | void;
  onKeepAliveSent?: (ackId: string) => void;
  onKeepAliveAcked?: (ackId: string, ageMs: number) => void;
  onKeepAliveMissed?: (
    ackId: string,
    ageMs: number,
    missedCount: number,
  ) => void;
}

export interface StreamLifecycleOptions {
  logger: Logger;
  streamId: string;
  keepAliveIntervalMs: number;
  ackTimeoutMs: number;
  maxMissedAcks: number;
  shouldSendKeepAlive?: () => boolean;
  now?: () => number;
}

interface PendingAckInfo {
  sentAt: number;
  timeout: NodeJS.Timeout;
}

/**
 * Generic keep-alive lifecycle controller that drives RTMP stream liveliness checks.
 * Both managed and unmanaged streaming adapters should build on top of this class
 * so that timeout semantics stay consistent across the platform.
 */
export class StreamLifecycleController {
  private keepAliveTimer?: NodeJS.Timeout;
  private pendingAcks: Map<string, PendingAckInfo> = new Map();
  private missedAcks = 0;
  private lastActivityMs: number;
  private active = false;
  private disposed = false;

  private readonly logger: Logger;
  private readonly streamId: string;
  private readonly keepAliveIntervalMs: number;
  private readonly ackTimeoutMs: number;
  private readonly maxMissedAcks: number;
  private readonly shouldSendKeepAlive?: () => boolean;
  private readonly now: () => number;

  constructor(
    options: StreamLifecycleOptions,
    private readonly callbacks: StreamLifecycleCallbacks,
  ) {
    this.logger = options.logger.child({ component: "StreamLifecycle" });
    this.streamId = options.streamId;
    this.keepAliveIntervalMs = options.keepAliveIntervalMs;
    this.ackTimeoutMs = options.ackTimeoutMs;
    this.maxMissedAcks = options.maxMissedAcks;
    this.shouldSendKeepAlive = options.shouldSendKeepAlive;
    this.now = options.now ?? (() => Date.now());
    this.lastActivityMs = this.now();
  }

  /**
   * Activate or deactivate the lifecycle. Activating schedules keep-alives; deactivating cancels them.
   */
  setActive(active: boolean): void {
    if (this.disposed || this.active === active) {
      return;
    }

    this.logger.debug(
      { streamId: this.streamId, active },
      "Updating lifecycle active state",
    );

    this.active = active;
    if (active) {
      this.startTimer();
    } else {
      this.stopTimer();
      this.clearPendingAcks();
      this.missedAcks = 0;
    }
  }

  /**
   * Records activity from the stream (status update, ACK) and resets missed ACK counters.
   */
  recordActivity(): void {
    this.lastActivityMs = this.now();
    this.missedAcks = 0;
  }

  /**
   * Handles a keep-alive acknowledgement.
   */
  handleAck(ackId: string): void {
    if (this.disposed) return;

    const ackInfo = this.pendingAcks.get(ackId);
    if (!ackInfo) {
      this.logger.warn(
        { streamId: this.streamId, ackId },
        "Received unknown keep-alive ACK",
      );
      return;
    }

    clearTimeout(ackInfo.timeout);
    this.pendingAcks.delete(ackId);
    this.recordActivity();

    this.callbacks.onKeepAliveAcked?.(ackId, this.now() - ackInfo.sentAt);
  }

  /**
   * Cleanly dispose of the lifecycle controller.
   */
  dispose(): void {
    if (this.disposed) return;

    this.disposed = true;
    this.stopTimer();
    this.clearPendingAcks();
    this.logger.debug({ streamId: this.streamId }, "Lifecycle disposed");
  }

  /**
   * Returns the timestamp of the last observed activity.
   */
  getLastActivityMs(): number {
    return this.lastActivityMs;
  }

  private startTimer(): void {
    if (this.keepAliveTimer) return;

    this.keepAliveTimer = setInterval(() => {
      void this.tick();
    }, this.keepAliveIntervalMs);

    this.logger.debug({ streamId: this.streamId }, "Keep-alive timer started");
  }

  private stopTimer(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
      this.logger.debug(
        { streamId: this.streamId },
        "Keep-alive timer stopped",
      );
    }
  }

  private async tick(): Promise<void> {
    if (this.disposed || !this.active) {
      return;
    }

    if (this.shouldSendKeepAlive && !this.shouldSendKeepAlive()) {
      this.logger.warn(
        { streamId: this.streamId },
        "Skipping keep-alive send because transport is unavailable",
      );
      return;
    }

    const ackId = this.createAckId();
    const sentAt = this.now();

    const timeout = setTimeout(() => {
      this.onAckTimeout(ackId, sentAt);
    }, this.ackTimeoutMs);

    this.pendingAcks.set(ackId, { sentAt, timeout });
    this.callbacks.onKeepAliveSent?.(ackId);

    try {
      await this.callbacks.sendKeepAlive(ackId);
    } catch (error) {
      this.logger.error(
        { streamId: this.streamId, ackId, error },
        "Error sending keep-alive",
      );
    }
  }

  private onAckTimeout(ackId: string, sentAt: number): void {
    if (this.disposed) return;

    this.pendingAcks.delete(ackId);
    this.missedAcks += 1;
    const ageMs = this.now() - sentAt;

    this.logger.warn(
      {
        streamId: this.streamId,
        ackId,
        missedAcks: this.missedAcks,
        ageMs,
      },
      "Keep-alive ACK timeout",
    );

    this.callbacks.onKeepAliveMissed?.(ackId, ageMs, this.missedAcks);

    if (this.missedAcks >= this.maxMissedAcks) {
      this.logger.error(
        {
          streamId: this.streamId,
          missedAcks: this.missedAcks,
          maxMissedAcks: this.maxMissedAcks,
        },
        "Maximum missed ACKs reached; triggering timeout",
      );

      void this.callbacks.onTimeout();
    }
  }

  private clearPendingAcks(): void {
    for (const { timeout } of this.pendingAcks.values()) {
      clearTimeout(timeout);
    }
    this.pendingAcks.clear();
  }

  private createAckId(): string {
    return `a${this.now().toString(36).slice(-5)}`;
  }
}
