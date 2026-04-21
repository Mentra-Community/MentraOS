import type { Logger } from "pino";
import { AppToCloudMessageType } from "../../types/message-types";

export interface _SubscriptionManagerDeps {
  logger: Logger;
  isConnected: () => boolean;
  sendMessage: (message: unknown) => void;
  getPackageName: () => string;
  getSessionId: () => string;
}

export class _SubscriptionManager {
  private readonly deps: _SubscriptionManagerDeps;
  private readonly subscriptions = new Set<string>();
  private syncScheduled = false;

  constructor(deps: _SubscriptionManagerDeps) {
    this.deps = deps;
  }

  add(stream: string): void {
    if (this.subscriptions.has(stream)) return;
    this.subscriptions.add(stream);
    this.scheduleSync();
  }

  remove(stream: string): void {
    if (!this.subscriptions.has(stream)) return;
    this.subscriptions.delete(stream);
    this.scheduleSync();
  }

  /**
   * Send the full subscription set to the cloud immediately.
   * Called directly after CONNECTION_ACK / RECONNECT_ACK to ensure
   * the cloud and SDK are in sync. Bypasses the microtask batch.
   */
  sync(): void {
    this.syncScheduled = false;
    this.deps.sendMessage({
      type: AppToCloudMessageType.SUBSCRIPTION_UPDATE,
      packageName: this.deps.getPackageName(),
      sessionId: this.deps.getSessionId(),
      subscriptions: this.snapshot(),
      timestamp: new Date(),
    });
  }

  snapshot(): string[] {
    return Array.from(this.subscriptions);
  }

  clear(): void {
    this.subscriptions.clear();
    this.syncScheduled = false;
  }

  /**
   * Batch multiple add/remove calls within the same microtask into a
   * single SUBSCRIPTION_UPDATE message. If onSession registers 5
   * subscriptions synchronously, only one message is sent at the end
   * of the current tick instead of 5.
   */
  private scheduleSync(): void {
    if (!this.deps.isConnected() || this.syncScheduled) return;
    this.syncScheduled = true;
    queueMicrotask(() => {
      if (!this.syncScheduled) return;
      this.syncScheduled = false;
      if (this.deps.isConnected()) {
        this.sync();
      }
    });
  }
}
