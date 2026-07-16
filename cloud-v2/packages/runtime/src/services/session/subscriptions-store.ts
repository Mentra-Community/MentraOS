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
import type { AudioSubscription } from "@mentra/cloud-protocol/audio";

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
  /**
   * Present when rejected with "stale-session": the sessionId currently
   * holding the key. The caller can check whether that session is actually
   * alive and take over a dead session's record (see audio.api.ts).
   */
  currentSessionId?: string;
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
 * Seed the key for a brand-new session without clobbering a live session. Called from
 * `connection.init` so the initial subscription set is in place before any
 * audio flows. A fresh handshake establishes a new `sessionId` baseline at
 * `version` 0; subsequent REST writes for that session are then guarded
 * against it by `writeSubscriptions`.
 *
 * If another live socket already seeded the user's key, this returns false
 * rather than replacing that socket's session guard. The existing key TTL is
 * refreshed by the owner and removed on clean last-session close.
 */
export async function seedSubscriptions(
  mentraUserId: string,
  record: SubscriptionRecord,
): Promise<boolean> {
  const applied = (await getRedis().eval(
    SEED_SCRIPT,
    1,
    subscriptionsKey(mentraUserId),
    JSON.stringify(record),
    SUBSCRIPTIONS_TTL_SEC,
    record.sessionId,
  )) as number;
  return applied === 1;
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
  )) as [number, string, number, string?];

  const [appliedFlag, reason, effectiveVersion, currentSessionId] = result;
  if (appliedFlag === 1) {
    return { applied: true, version: effectiveVersion };
  }
  return {
    applied: false,
    version: effectiveVersion,
    reason: reason === "stale-session" ? "stale-session" : "stale-version",
    ...(currentSessionId ? { currentSessionId } : {}),
  };
}

/**
 * Unconditional snapshot write that REPLACES whatever record exists. Reserved
 * for taking over a DEAD session's record: the caller must have verified that
 * the record's sessionId no longer corresponds to a live socket (and that this
 * pod owns the user) before forcing. Establishes a fresh version baseline.
 */
export async function takeoverSubscriptions(
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
 * Refresh the key's TTL — but only when the record still belongs to the
 * refreshing session. An unconditional refresh would let ANY open socket for
 * the user keep a DEAD session's record alive forever (each reconnect's
 * refresh loop re-arms the TTL), permanently wedging seeding and REST writes
 * behind a session that no longer exists. Session-scoped refresh restores the
 * TTL's role as the dead-record backstop: a record whose session is gone
 * expires within {@link SUBSCRIPTIONS_TTL_SEC}.
 */
export async function refreshSubscriptions(
  mentraUserId: string,
  sessionId: string,
): Promise<void> {
  await getRedis().eval(
    REFRESH_IF_SESSION_SCRIPT,
    1,
    subscriptionsKey(mentraUserId),
    sessionId,
    String(SUBSCRIPTIONS_TTL_SEC),
  );
}

/** Delete the key on clean disconnect so the next session starts fresh. */
export async function deleteSubscriptions(mentraUserId: string): Promise<void> {
  await getRedis().del(subscriptionsKey(mentraUserId));
}

/**
 * Delete the key only if it is still owned by one of the given sessions.
 * Used when a pod loses user ownership: its sessions are being torn down, but
 * the new owner may have already seeded this key for a NEWER session — an
 * unconditional delete from the stale pod would wipe the live owner's
 * subscription state cluster-wide. Returns true when the key was deleted.
 */
export async function deleteSubscriptionsIfSessionIn(
  mentraUserId: string,
  sessionIds: string[],
): Promise<boolean> {
  if (sessionIds.length === 0) return false;
  const deleted = (await getRedis().eval(
    DELETE_IF_SESSION_SCRIPT,
    1,
    subscriptionsKey(mentraUserId),
    JSON.stringify(sessionIds),
  )) as number;
  return deleted === 1;
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
    return {0, "stale-session", decoded.version, decoded.sessionId}
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

// Conditional delete. ARGV[1] is a JSON array of sessionIds being torn down;
// the key is removed only when its record's sessionId is one of them.
const DELETE_IF_SESSION_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if not existing then
  return 0
end
local decoded = cjson.decode(existing)
local sessions = cjson.decode(ARGV[1])
for _, id in ipairs(sessions) do
  if decoded.sessionId == id then
    redis.call("DEL", KEYS[1])
    return 1
  end
end
return 0
`;

// Conditional TTL refresh. ARGV: [1] the refreshing session's id, [2] TTL
// seconds. Only re-arms the TTL when the record still belongs to that session.
const REFRESH_IF_SESSION_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
if not existing then
  return 0
end
local decoded = cjson.decode(existing)
if decoded.sessionId ~= ARGV[1] then
  return 0
end
redis.call("EXPIRE", KEYS[1], ARGV[2])
return 1
`;

const SEED_SCRIPT = `
local existing = redis.call("GET", KEYS[1])
local record = ARGV[1]
local ttl = ARGV[2]
local newSession = ARGV[3]

if existing then
  local decoded = cjson.decode(existing)
  if decoded.sessionId ~= newSession then
    return 0
  end
end

redis.call("SET", KEYS[1], record, "EX", ttl)
return 1
`;
