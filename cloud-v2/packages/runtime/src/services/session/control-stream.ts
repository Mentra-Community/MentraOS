/**
 * @fileoverview Per-user control stream (`{user:X}:control`).
 *
 * The decided routing for subscription changes is "Option 2a": REST, delivered
 * to the owning worker through a Redis stream, no pub/sub. We use a DEDICATED
 * control stream rather than mixing control entries into the audio stream so
 * the audio hot path never has to branch on entry type. The hash tag
 * `{user:X}` keeps it on the same shard as the audio stream, ownership key, and
 * subscription key.
 *
 * A control entry is only a NUDGE: it tells the owning worker "the subscription
 * key changed, re-read it." The worker reconciles from the subscription key
 * (the source of truth), never from the entry payload alone. That is what makes
 * a REST write landing on a non-owner pod still correct: the non-owner writes
 * the key and XADDs the nudge here; the owner's worker, which already reads this
 * stream, picks up the nudge in order and reconciles from the key.
 *
 * Entries carry a `kind` field so future control entry types (codec change,
 * etc.) can ride the same stream; today the only kind is
 * `subscriptions-changed`.
 */

import { getRedis } from "../../clients/redis.client";

/** Per-user control stream key. Hash-tagged to share a shard with the user's other keys. */
export function controlStreamKey(mentraUserId: string): string {
  return `{user:${mentraUserId}}:control`;
}

/** Consumer group the owning worker joins to read control entries. */
export const CONTROL_STREAM_GROUP = "control-workers";

/**
 * Length cap on the control stream. Control entries are rare (a subscription
 * change is a human-paced event, not tens-per-second like audio), so a small
 * cap is plenty; it exists only to keep the key from growing without bound if
 * an owner is briefly absent.
 */
export const CONTROL_STREAM_MAXLEN = 100;

/**
 * XADD a `subscriptions-changed` nudge to the user's control stream. Called by
 * the REST handler after it accepts a write to the subscription key. The
 * `version` is carried for logging and tracing only; the worker still re-reads
 * the key rather than trusting this number.
 */
export async function publishSubscriptionsChanged(
  mentraUserId: string,
  version: number,
): Promise<void> {
  await getRedis().xadd(
    controlStreamKey(mentraUserId),
    "MAXLEN",
    "~",
    String(CONTROL_STREAM_MAXLEN),
    "*",
    "kind",
    "subscriptions-changed",
    "version",
    String(version),
  );
}
