/**
 * @fileoverview Ownership: deciding which server instance is in charge of a user.
 *
 * Background. This service is the cloud side of live transcription: a user's
 * glasses stream audio up, and we stream transcripts back down. To handle many
 * users and to survive a machine dying, the service runs as many identical
 * copies at once. Each copy is a "pod" (one running container), and a load
 * balancer spreads incoming traffic across them.
 *
 * The problem this file solves. A user's audio packets can land on ANY pod (the
 * load balancer doesn't care which), but the actual transcription for that user
 * has to run on exactly ONE pod at a time: the one holding that user's WebSocket
 * connection. We call that pod the user's "owner". So the pods need a way to
 * agree on who owns each user, and to hand a user off automatically when the
 * owner crashes.
 *
 * How it works. There is one Redis key per user that acts as a claim ticket:
 * `{user:<id>}:owner` holds the owning pod's id. Two rules make it safe:
 *
 *   1. A pod can only take the key if nobody else holds it (Redis `SET ... NX`),
 *      so at most one pod owns a user at a time. This is a "distributed lock":
 *      a single shared flag that only one party can hold.
 *
 *   2. The key is set to expire after a few seconds (Redis `SET ... EX 5`). While
 *      a pod is alive it resets that timer every 1.5s. If it crashes, hangs, or
 *      loses its network, it stops resetting the timer, the key expires on its
 *      own, and another pod is free to claim the user. A missing refresh is the
 *      single signal for "the owner is gone", so we need no separate health check.
 *
 * Why the Lua scripts at the bottom. "Refresh" and "release" both mean "do
 * something only if I'm still the owner". They run as Redis Lua scripts so the
 * check and the action happen as one atomic step, otherwise another pod's claim
 * could slip in between reading the key and acting on it, and we'd extend or
 * delete a claim that is no longer ours.
 */

import { createLogger } from "@mentra/cloud-shared";
import { getRedis } from "../../clients/redis.client";

const logger = createLogger("audio").child({ service: "ownership.service" });

/** TTL on the ownership key. Beyond this, the claim is forfeit. */
export const OWNERSHIP_TTL_SEC = 5;

/** How often the owner pod renews its claim. Comfortably inside TTL. */
export const OWNERSHIP_REFRESH_INTERVAL_MS = 1_500;

function ownerKey(mentraUserId: string): string {
  return `{user:${mentraUserId}}:owner`;
}

export type ClaimResult = "claimed" | "already-ours" | "owned-by-other";

/**
 * Try once to become this user's owner. Returns one of:
 *   - "claimed":        we just took ownership (the key was free, our SET won).
 *   - "already-ours":   the key was already set to our own pod id, so we still
 *                       effectively own it. Calling this twice in a row is safe.
 *   - "owned-by-other": a different pod currently owns this user. The caller
 *                       decides what to do next: retry and wait for that claim
 *                       to expire, or give up and report the conflict.
 */
export async function tryClaimOwnership(
  mentraUserId: string,
  podId: string,
): Promise<ClaimResult> {
  const redis = getRedis();
  const set = await redis.set(
    ownerKey(mentraUserId),
    podId,
    "EX",
    OWNERSHIP_TTL_SEC,
    "NX",
  );
  if (set === "OK") return "claimed";

  // Failed. Was it us or someone else?
  const current = await redis.get(ownerKey(mentraUserId));
  if (current === podId) return "already-ours";
  if (current === null) {
    const retry = await redis.set(
      ownerKey(mentraUserId),
      podId,
      "EX",
      OWNERSHIP_TTL_SEC,
      "NX",
    );
    if (retry === "OK") return "claimed";
    const afterRetry = await redis.get(ownerKey(mentraUserId));
    if (afterRetry === podId) return "already-ours";
  }
  return "owned-by-other";
}

/**
 * Like `tryClaimOwnership`, but if another pod currently owns the user, keep
 * retrying for a short while. This gives a crashed owner's claim time to expire
 * on its own so we can then take over. The default deadline is twice the key's
 * expiry, which is long enough that a dead owner's claim is always gone before
 * we give up.
 */
export async function claimOwnershipWithRetry(
  mentraUserId: string,
  podId: string,
  deadlineMs = OWNERSHIP_TTL_SEC * 2 * 1000,
): Promise<ClaimResult> {
  const deadline = Date.now() + deadlineMs;
  let result: ClaimResult = "owned-by-other";
  while (Date.now() < deadline) {
    result = await tryClaimOwnership(mentraUserId, podId);
    if (result !== "owned-by-other") return result;
    await Bun.sleep(500);
  }
  return result;
}

/**
 * Reset the expiry timer on our claim, but only if we still own it. The owner
 * pod calls this on a timer so its claim never expires while it is healthy.
 * Returns true if the refresh worked. Returns false if some other pod has
 * already taken the user over, which means we were too slow (our claim expired
 * and someone grabbed it), and we should stop treating this user as ours.
 */
export async function refreshOwnership(
  mentraUserId: string,
  podId: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = (await redis.eval(
    REFRESH_SCRIPT,
    1,
    ownerKey(mentraUserId),
    podId,
    String(OWNERSHIP_TTL_SEC),
  )) as number;
  return result === 1;
}

/**
 * Give up ownership of a user, but only if we still own it. Called on a clean
 * disconnect so the user can be claimed elsewhere right away instead of waiting
 * for the timer to expire. If some other pod already holds the claim (ours
 * expired and got grabbed), this does nothing, deleting their claim would be
 * wrong.
 */
export async function releaseOwnership(
  mentraUserId: string,
  podId: string,
): Promise<boolean> {
  const redis = getRedis();
  const result = (await redis.eval(
    RELEASE_SCRIPT,
    1,
    ownerKey(mentraUserId),
    podId,
  )) as number;
  return result === 1;
}

/** Read which pod currently owns this user, or null if nobody does. A plain
 * read with no claiming; handy for tests and diagnostics. */
export async function getOwner(mentraUserId: string): Promise<string | null> {
  return getRedis().get(ownerKey(mentraUserId));
}

// === Lua scripts ===
//
// These run inside Redis as a single atomic step. Each one reads the owner key
// and only acts if the stored pod id matches ours (KEYS[1] is the key, ARGV[1]
// is our pod id). Doing the read and the action together is what stops two pods
// from racing on the same claim.

const REFRESH_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  return 1
else
  return 0
end
`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  redis.call("DEL", KEYS[1])
  return 1
else
  return 0
end
`;

// === Refresh loop ===

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start a background timer that keeps all of this pod's claims alive. On each
 * tick it asks the caller which users this pod currently owns (via the
 * `getOwnedUserIds` callback, normally the set of live WebSocket sessions) and
 * refreshes each one's claim. Call this once at startup; calling it again does
 * nothing, so a second call cannot create a duplicate timer.
 */
export function startOwnershipRefreshLoop(opts: {
  podId: string;
  getOwnedUserIds: () => Iterable<string>;
  onLostOwnership?: (mentraUserId: string) => void;
}): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    try {
      for (const userId of opts.getOwnedUserIds()) {
        const ok = await refreshOwnership(userId, opts.podId);
        if (!ok) {
          // We thought we owned this user but Redis disagrees. Could be a
          // partition, could be a missed refresh that let TTL expire and
          // someone else grabbed it. Either way, log; later batches will
          // hand off the affected sessions cleanly.
          logger.warn(
            { mentraUserId: userId, podId: opts.podId },
            "ownership refresh failed, claim no longer ours",
          );
          opts.onLostOwnership?.(userId);
        }
      }
    } catch (err) {
      logger.error({ err }, "ownership refresh loop threw");
    }
  }, OWNERSHIP_REFRESH_INTERVAL_MS);
}

export function stopOwnershipRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
