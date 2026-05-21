/**
 * @fileoverview AppLikeSession — shared interface for AppSession and PhoneSession.
 *
 * AppSession has private members that prevent TypeScript structural assignability
 * with a standalone PhoneSession class. This interface defines the subset of
 * methods that SubscriptionManager and stream delivery paths need so both
 * implementations can be handled uniformly where appropriate.
 */

import type { ExtendedStreamType } from "@mentra/sdk";

import type { AppConnectionState, LocationRate } from "./AppSession";

export interface AppLikeSession {
  readonly packageName: string;
  readonly isDisposed: boolean;
  state: AppConnectionState;
  subscriptions: Set<ExtendedStreamType>;
  locationRate: LocationRate | null;

  hasSubscription(sub: ExtendedStreamType): boolean;
  getSubscriptions(): ExtendedStreamType[];
  updateSubscriptions(
    newSubscriptions: ExtendedStreamType[],
    locationRate?: LocationRate | null,
  ): { applied: boolean; reason?: string };
  enqueue<T>(operation: () => Promise<T>): Promise<T>;
  cleanup(): void;
}
