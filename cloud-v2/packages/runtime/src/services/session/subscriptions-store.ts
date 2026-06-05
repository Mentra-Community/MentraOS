/**
 * @fileoverview Subscription source of truth in Redis.
 *
 * The authoritative audio subscription set for a user lives in one Redis key,
 * `{user:X}:subscriptions`. It holds the full subscription set plus the last
 * accepted `sessionId` and `version`. The hash tag `{user:X}` matches the
 * ownership key (`{user:X}:owner`) and the control stream (`{user:X}:control`)
 * so all of one user's keys land on the same Redis Cluster shard.
 *
 * Why a single guarded key instead of applying REST writes directly to a
 * worker: the legacy system had two scars this design closes.
 *   1. Out-of-order application. A retried or reordered REST write could apply
 *      an older snapshot on top of a newer one. The monotonic `version` guard
 *      discards anything not strictly newer than what we already accepted.
 *   2. A reconnect's empty snapshot wiping a live set. After reconnect the
 *      client briefly has an empty set; if that landed late it could clear a
 *      newer, populated set. Because an empty set must still carry a newer
 *      version for the current session to be accepted, a stale empty can never
 *      win against a live set.
 *
 * The key is also the source of truth the owning worker reconciles from. REST
 * writes additionally drop a nudge into the control stream (see
 * `control-stream.ts`); the worker reads that nudge and then re-reads THIS key,
 * never trusting the nudge payload alone. That keeps a single source of truth
 * and avoids the derived-cache drift the legacy system suffered.
 */

import { getRedis } from "../../clients/redis.client";
import type { AudioSubscription } from "../../protocol/audio";

/**
 * Subscription key TTL. Refreshed by the owner while the session is live and
 * deleted on clean disconnect. The TTL is the backstop: if a pod crashes
 * without releasing, the abandoned set vanishes within this window so a later
 * session for the same user starts clean rather than inheriting stale subs.
 */
export const SUBSCRIPTIONS_TTL_SEC = 60;

/** What the subscription key holds, decoded. */
export interface SubscriptionRecord {
  subscriptions: AudioSubscription[];
  /** The session that last wrote this set (from `connection.ack.sessionId`). */
  sessionId: string;
  /** Monotonic per snapshot. A write must be strictly newer to be accepted. */
  version: number;
}

/** Outcome of a guarded write. */
export interface WriteResult {
  applied: boolean;
  /** The version now in effect (the accepted one, or the existing one if rejected). */
  version: number;
  /** Present when `applied` is false: why the write was rejected. */
  reason?: "stale-session" | "stale-version";
}

function subscriptionsKey(mentraUserId: string): string {
  return `{user:${mentraUserId}}:subscriptions`;
}

/** Read the current subscription record, or null if none exists yet. */
export async function readSubscriptions(
  mentraUserId: string,
): Promise<SubscriptionRecord | null> {
  const raw = await getRedis().get(subscriptionsKey(mentraUserId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SubscriptionRecord;
  } catch {
    return null;
  }
}

/**
 * Seed the key for a brand-new session, unconditionally. Called from
 * `connection.init` so the initial subscription set is in place before any
 * audio flows. A fresh handshake establishes a new `sessionId` baseline at
 * `version` 0; subsequent REST writes for that session are then guarded
 * against it by `writeSubscriptions`. Seeding is unconditional because a new
 * session legitimately replaces whatever a prior (now gone) session left
 * behind, which the session guard would otherwise reject.
 */
export async function seedSubscriptions(
  mentraUserId: string,
  record: SubscriptionRecord,
): Promise<void> {
  await getRedis().set(
    subscriptionsKey(mentraUserId),
    JSON.stringify(record),
    "EX",
    SUBSCRIPTIONS_TTL_SEC,
  );
}

/**
 * Guarded write of a full subscription snapshot, used by the REST endpoint.
 *
 * The read-check-write runs as one atomic Lua step so two concurrent REST
 * writes (retry plus original, two pods) cannot interleave and accept an older
 * snapshot. The guard rejects a write whose `sessionId` is not the current
 * session, and any write whose `version` is not strictly greater than the last
 * accepted version. An empty subscription set is just a normal snapshot under
 * these rules: it is honored only when it is the newest version for the current
 * session, so a stale empty can never wipe a live set.
 *
 * If no record exists yet (the seed somehow never ran, e.g. a write racing
 * ahead of `connection.init`), the write is accepted and establishes the
 * baseline, so a subscription change is never silently lost.
 */
export async function writeSubscriptions(
  mentraUserId: string,
  record: SubscriptionRecord,
): Promise<WriteResult> {
  const result = (await getRedis().eval(
    WRITE_SCRIPT,
    1,
    subscriptionsKey(mentraUserId),
    JSON.stringify(record.subscriptions),
    record.sessionId,
    String(record.version),
    String(SUBSCRIPTIONS_TTL_SEC),
  )) as [number, string, number];

  const [appliedFlag, reason, effectiveVersion] = result;
  if (appliedFlag === 1) {
    return { applied: true, version: effectiveVersion };
  }
  return {
    applied: false,
    version: effectiveVersion,
    reason: reason === "stale-session" ? "stale-session" : "stale-version",
  };
}

/** Refresh the key's TTL while the owner holds the session. */
export async function refreshSubscriptions(mentraUserId: string): Promise<void> {
  await getRedis().expire(subscriptionsKey(mentraUserId), SUBSCRIPTIONS_TTL_SEC);
}

/** Delete the key on clean disconnect so the next session starts fresh. */
export async function deleteSubscriptions(mentraUserId: string): Promise<void> {
  await getRedis().del(subscriptionsKey(mentraUserId));
}

// === Lua ===
//
// Atomic guarded write. KEYS[1] is the subscription key. ARGV: [1] the new
// subscription set as JSON, [2] the writer's sessionId, [3] the new version,
// [4] the TTL in seconds. Returns a 3-tuple [applied, reason, version]:
//   - applied: 1 if written, 0 if rejected
//   - reason:  "" when applied; "stale-session" or "stale-version" when not
//   - version: the version now in effect (the new one if applied, else the
//              existing one) so the caller can echo the authoritative version
//              back to the client.
//
// We store the record as a JSON object so a single GET in the read path
// recovers everything. The Lua decodes only the two scalar guard fields it
// needs (sessionId, version) and rewrites the whole object on accept.
const WRITE_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
local newSubs = ARGV[1]
local newSession = ARGV[2]
local newVersion = tonumber(ARGV[3])
local ttl = ARGV[4]

if existing then
  local decoded = cjson.decode(existing)
  if decoded.sessionId ~= newSession then
    return {0, "stale-session", decoded.version}
  end
  if newVersion <= decoded.version then
    return {0, "stale-version", decoded.version}
  end
end

local record = string.format(
  '{"subscriptions":%s,"sessionId":%s,"version":%d}',
  newSubs, cjson.encode(newSession), newVersion
)
redis.call("SET", KEYS[1], record, "EX", ttl)
return {1, "", newVersion}
`;
