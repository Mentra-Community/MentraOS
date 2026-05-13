/**
 * @fileoverview PhoneSession — synthetic session for the `__phone__` subscriber.
 *
 * The phone (MentraOS mobile app) subscribes to cloud streams (transcription,
 * translation) on behalf of local miniapps. From the cloud's perspective this
 * is "just another subscriber" that sits alongside real AppSessions in the
 * subscription delivery path.
 *
 * PhoneSession implements AppLikeSession so SubscriptionManager can iterate
 * over it uniformly. It does NOT extend AppSession — AppSession's private
 * lifecycle machinery (heartbeat, grace period, resurrection) is not applicable.
 */

import { Logger } from "pino";
import { ExtendedStreamType, StreamType } from "@mentra/sdk";

import { AppConnectionState, LocationRate } from "./AppSession";
import { AppLikeSession } from "./AppLikeSession";

export const PHONE_PACKAGE_NAME = "__phone__";

export class PhoneSession implements AppLikeSession {
  public readonly packageName = PHONE_PACKAGE_NAME;
  private _subscriptions: Set<ExtendedStreamType> = new Set();
  private _locationRate: LocationRate | null = null;
  private _state: AppConnectionState = AppConnectionState.RUNNING;
  private _disposed = false;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ service: "PhoneSession" });
    this.logger.info("PhoneSession created");
  }

  // ------------------------------------------------------------------
  // AppLikeSession implementation
  // ------------------------------------------------------------------

  get state(): AppConnectionState {
    return this._state;
  }

  set state(value: AppConnectionState) {
    this._state = value;
  }

  get subscriptions(): Set<ExtendedStreamType> {
    return this._subscriptions;
  }

  set subscriptions(value: Set<ExtendedStreamType>) {
    this._subscriptions = value;
  }

  get locationRate(): LocationRate | null {
    return this._locationRate;
  }

  set locationRate(value: LocationRate | null) {
    this._locationRate = value;
  }

  get isDisposed(): boolean {
    return this._disposed;
  }

  hasSubscription(sub: ExtendedStreamType): boolean {
    if (this._subscriptions.has(sub)) return true;
    if (this._subscriptions.has(StreamType.WILDCARD)) return true;
    if (this._subscriptions.has(StreamType.ALL)) return true;
    return false;
  }

  getSubscriptions(): ExtendedStreamType[] {
    return Array.from(this._subscriptions);
  }

  updateSubscriptions(
    newSubscriptions: ExtendedStreamType[],
    locationRate?: LocationRate | null,
  ): { applied: boolean; reason?: string } {
    const oldSubs = this._subscriptions;
    this._subscriptions = new Set(newSubscriptions);

    if (locationRate !== undefined) {
      this._locationRate = locationRate;
    } else if (!this._subscriptions.has(StreamType.LOCATION_STREAM)) {
      this._locationRate = null;
    }

    this.logger.info(
      {
        oldCount: oldSubs.size,
        newCount: this._subscriptions.size,
        subscriptions: newSubscriptions,
        locationRate: this._locationRate,
      },
      "Phone subscriptions updated",
    );

    return { applied: true };
  }

  /** Trivial queue — phone is the sole updater; no serialization needed. */
  async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return operation();
  }

  cleanup(): void {
    this._subscriptions.clear();
    this._locationRate = null;
    this._disposed = true;
    this.logger.info("PhoneSession cleaned up");
  }
}
