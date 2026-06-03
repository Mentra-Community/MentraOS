/**
 * @fileoverview User-ownership claim primitives.
 *
 * Exactly one pod is the "owner" of any given user at any given time. The
 * owner is the pod that holds the user's WebSocket and is therefore the
 * pod responsible for sending transcripts back. All other pods may receive
 * UDP packets (stateless ingress) and write them to the user's Redis Stream,
 * but only the owner reads from the stream and dispatches to workers.
 *
 * Ownership is recorded in Redis at `{user:X}:owner = podId` with a short
 * TTL. The owner refreshes the TTL on a timer well inside its expiry. The
 * universal failure signal is "TTL expires" — works for crashes, hangs,
 * partitions, all the same way.
 *
 * **Atomicity matters here.** Refresh ("extend TTL only if I still own it")
 * and release ("delete only if I still own it") are Lua scripts so they
 * don't race against another pod's claim arriving between the GET and the
 * EXPIRE/DEL.
 *
 * Spec: docs/issues/003-audio/spec.md ("Fault tolerance model" / "TTL'd claims")
 */

import { createLogger } from "@mentra/cloud-shared";
import { getRedis } from "../connections/redis.connection";

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
 * Attempt a single claim. Returns:
 *   - "claimed"        — we got it (SET NX succeeded)
 *   - "already-ours"   — the key was already set to our podId (idempotent)
 *   - "owned-by-other" — a different pod owns the user; the caller decides
 *                        whether to retry, wait for TTL, or surface conflict
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
  return "owned-by-other";
}

/**
 * Try to claim; if blocked by another pod, retry briefly to let a dying
 * owner's TTL expire. Default deadline is `2 × TTL` so a crashed pod's
 * claim always expires inside this window.
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
 * Lua-atomic refresh: extend the TTL iff we're still the owner. Returns
 * true on successful refresh, false if some other pod took it over (which
 * means we crashed/hung past the TTL and should treat this user as
 * forfeited).
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
 * Lua-atomic release: delete the key iff we're still the owner. No-op if
 * someone else has it (means our claim already expired and got grabbed —
 * stomping their claim would be wrong).
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

/** Pure read. Useful for tests and diagnostics. */
export async function getOwner(mentraUserId: string): Promise<string | null> {
  return getRedis().get(ownerKey(mentraUserId));
}

// === Lua scripts ===

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
 * Start the periodic refresh loop. The provided `getOwnedUserIds()` is
 * invoked on each tick — typically returns the keys of session.service's
 * `Map<userId, ...>` tracking owned sessions.
 *
 * Idempotent: calling twice is a no-op (the second call is ignored).
 */
export function startOwnershipRefreshLoop(opts: {
  podId: string;
  getOwnedUserIds: () => Iterable<string>;
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
            "ownership refresh failed — claim no longer ours",
          );
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
