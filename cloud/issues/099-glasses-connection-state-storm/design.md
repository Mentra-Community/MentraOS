# Design: Device-State Storm — Cloud Dedup + Rate Limit Implementation

## Overview

**What this doc covers:** File-by-file implementation plan for the cloud-side Phase 1 fix in [spec.md](./spec.md). The mobile-side refactor (Part 2 in the spec) is a separate mobile-repo change and is not designed here; a brief sketch is included at the end for coordination.

**Why this doc exists:** We need the cloud hotfix in prod today. The spec locked behavior; this doc locks code shape.

**What you need to know first:** [spike.md](./spike.md) for evidence, [spec.md](./spec.md) for behavior.

**Who should read this:** PR reviewers.

---

## Changes Summary

| Component         | File                                                                                    | What changes                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DeviceManager     | `cloud/packages/cloud/src/services/session/DeviceManager.ts`                            | Add equality guard, compute `effectiveDiff`, expose counters, drive cascade from diff not payload |
| MicrophoneManager | `cloud/packages/cloud/src/services/session/MicrophoneManager.ts`                        | Track `lastKnownConnectionState`; `forceResync` only on transition                                |
| Device-state REST | `cloud/packages/cloud/src/api/hono/client/device-state.api.ts`                          | Per-session rate limit middleware (10/sec, 429)                                                   |
| Vitals logger     | `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`                       | Publish four pod-global counters                                                                  |
| Admin endpoint    | `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts` via `MemoryTelemetryService` | Include counters in `/api/admin/memory/now`                                                       |
| bstack            | `cloud/tools/bstack/bstack.ts`                                                          | New `device-state` command                                                                        |

No SDK changes. No mobile changes in this PR.

---

## DeviceManager Changes

### Change 1: Equality guard at the top of `updateDeviceState`

**File:** `cloud/packages/cloud/src/services/session/DeviceManager.ts`

**Current (L110–175, abbreviated):**

```typescript
async updateDeviceState(payload: Partial<GlassesInfo>): Promise<void> {
  this.logger.info({ userId, payload, feature: "device-state" }, "Updating device state");

  // Infer connection state from modelName
  if (payload.modelName && payload.connected === undefined) {
    payload.connected = true;
  } else if ((payload.modelName === null || payload.modelName === "") && payload.connected === undefined) {
    payload.connected = false;
  }

  const modelChanged = payload.modelName && payload.modelName !== this.deviceState.modelName;
  this.deviceState = { ...this.deviceState, ...payload };

  if (payload.connected !== undefined) {
    if (payload.connected && payload.modelName) {
      await this.handleGlassesConnectionState(payload.modelName, "CONNECTED");
    } else {
      await this.handleGlassesConnectionState(null, "DISCONNECTED");
    }
    this.userSession.microphoneManager?.handleConnectionStateChange(
      payload.connected ? "CONNECTED" : "DISCONNECTED",
    );
  } else if (modelChanged && payload.modelName) {
    await this.updateModelAndCapabilities(payload.modelName);
  }

  this.logger.info({ ... }, "Device state updated successfully");
  this.broadcastDeviceStateToApps(payload);
}
```

**New:**

```typescript
// Module-scoped counters shared across all DeviceManager instances on this pod.
// See SystemVitalsLogger changes below for where these get sampled.
let deviceStateUpdatesTotal = 0;
let deviceStateUpdatesDeduped = 0;
let deviceStateUpdatesApplied = 0;

export function getDeviceStateCounters() {
  return {
    total: deviceStateUpdatesTotal,
    deduped: deviceStateUpdatesDeduped,
    applied: deviceStateUpdatesApplied,
  };
}
export function resetDeviceStateCounters() {
  deviceStateUpdatesTotal = 0;
  deviceStateUpdatesDeduped = 0;
  deviceStateUpdatesApplied = 0;
}

// ...

async updateDeviceState(payload: Partial<GlassesInfo>): Promise<void> {
  deviceStateUpdatesTotal++;

  // --- S1.1 equality guard ---
  // Compute effective diff BEFORE any inference or merge.
  const effectiveDiff: Partial<GlassesInfo> = {};
  for (const key of Object.keys(payload) as (keyof GlassesInfo)[]) {
    if (payload[key] !== this.deviceState[key]) {
      (effectiveDiff as any)[key] = payload[key];
    }
  }

  if (Object.keys(effectiveDiff).length === 0) {
    deviceStateUpdatesDeduped++;
    // No log. We want this path to be silent on the hot path.
    return;
  }

  deviceStateUpdatesApplied++;
  this.logger.info(
    { userId: this.userSession.userId, effectiveDiff, feature: "device-state" },
    "Updating device state",
  );

  // --- original inference logic, now on effectiveDiff ---
  if (effectiveDiff.modelName && effectiveDiff.connected === undefined) {
    effectiveDiff.connected = true;
  } else if (
    (effectiveDiff.modelName === null || effectiveDiff.modelName === "") &&
    effectiveDiff.connected === undefined
  ) {
    effectiveDiff.connected = false;
  }

  const modelChanged = Boolean(effectiveDiff.modelName);

  // Merge real changes into canonical state
  this.deviceState = { ...this.deviceState, ...effectiveDiff };

  if (effectiveDiff.connected !== undefined) {
    if (effectiveDiff.connected && this.deviceState.modelName) {
      await this.handleGlassesConnectionState(this.deviceState.modelName, "CONNECTED");
    } else {
      await this.handleGlassesConnectionState(null, "DISCONNECTED");
    }
    this.userSession.microphoneManager?.handleConnectionStateChange(
      effectiveDiff.connected ? "CONNECTED" : "DISCONNECTED",
    );
  } else if (modelChanged && effectiveDiff.modelName) {
    await this.updateModelAndCapabilities(effectiveDiff.modelName);
  }

  this.logger.info(
    {
      userId: this.userSession.userId,
      connected: this.deviceState.connected,
      modelName: this.deviceState.modelName,
      feature: "device-state",
    },
    "Device state updated successfully",
  );

  this.broadcastDeviceStateToApps(effectiveDiff);
}
```

**Key differences from the original:**

1. Fast path returns with zero logging, zero allocation beyond a counter increment. The spec's 60–80% volume reduction target comes from this branch.
2. `effectiveDiff` drives inference, merge, cascade decisions, and broadcast — not the incoming `payload`. This fixes the spike's Finding 2 double-cascade pattern.
3. `broadcastDeviceStateToApps` receives only the changed fields, so subscribed apps stop getting redundant state.

**Intentional non-changes:**

- `handleGlassesConnectionState` is untouched. It is correct when it runs — it just runs too often.
- `stopIncompatibleApps`, PostHog, and Mongo calls inside `handleGlassesConnectionState` are untouched. They need to happen on real connection transitions.

---

## MicrophoneManager Changes

### Change 2: Track last-known connection state, fire `forceResync` only on transition

**File:** `cloud/packages/cloud/src/services/session/MicrophoneManager.ts`

**Current (~L289–305):**

```typescript
handleConnectionStateChange(status: string): void {
  if (status === "CONNECTED" || status === "RECONNECTED") {
    this.logger.info({ status, previousMicEnabled: this.enabled }, `Glasses ${status}, forcing mic state resync`);
    this.forceResync();
  }
}
```

**New:**

```typescript
private lastKnownConnectionState: "CONNECTED" | "DISCONNECTED" | null = null;

handleConnectionStateChange(status: string): void {
  const normalized: "CONNECTED" | "DISCONNECTED" =
    status === "CONNECTED" || status === "RECONNECTED" ? "CONNECTED" : "DISCONNECTED";

  if (normalized === this.lastKnownConnectionState) {
    // No transition — skip the resync. This is the common case under storm.
    return;
  }

  const previous = this.lastKnownConnectionState;
  this.lastKnownConnectionState = normalized;

  if (normalized === "CONNECTED") {
    this.logger.info(
      { status, previous, previousMicEnabled: this.enabled },
      "Glasses transitioned to CONNECTED, forcing mic state resync",
    );
    this.forceResync();
  }
  // DISCONNECTED transition: no resync needed; next CONNECTED will resync.
}
```

**Why safe:** the original comment says `forceResync` is needed "because the mobile app may have lost track of mic state during the reconnection process." That reasoning only applies to a real transition, so this change preserves the intent.

**Why necessary:** with the equality guard in place, `handleConnectionStateChange` will only be called when `connected` actually changes — but that guard lives in `DeviceManager`. `MicrophoneManager.handleConnectionStateChange` is also called from `UserSession.updateWebSocket` and potentially elsewhere, so an independent transition check here is a belt-and-suspenders.

---

## REST Endpoint Changes

### Change 3: Per-session rate limit on `POST /api/client/device/state`

**File:** `cloud/packages/cloud/src/api/hono/client/device-state.api.ts`

**Current:**

```typescript
app.post("/", clientAuth, requireUserSession, updateDeviceState);
```

**New:** add a rate-limit middleware between `requireUserSession` and the handler.

```typescript
// Module-scoped; shared across all requests on this pod.
const RATE_LIMIT_MAX_PER_SEC = 10;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_WARN_THROTTLE_MS = 60_000;

type RateLimitEntry = { count: number; windowStart: number; lastWarnAt: number };
const rateLimitState = new Map<string, RateLimitEntry>();

let deviceStateUpdatesRateLimited = 0;
export function getDeviceStateRateLimitCount() {
  return deviceStateUpdatesRateLimited;
}
export function resetDeviceStateRateLimitCount() {
  deviceStateUpdatesRateLimited = 0;
}

// Periodic cleanup of stale entries so the map doesn't grow unbounded.
setInterval(() => {
  const cutoff = Date.now() - 5 * 60_000;
  for (const [userId, entry] of rateLimitState) {
    if (entry.windowStart < cutoff) rateLimitState.delete(userId);
  }
}, 60_000).unref();

async function rateLimit(c: AppContext, next: () => Promise<void>) {
  const userSession = c.get("userSession")!;
  const userId = userSession.userId;
  const now = Date.now();

  let entry = rateLimitState.get(userId);
  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    entry = { count: 1, windowStart: now, lastWarnAt: entry?.lastWarnAt ?? 0 };
    rateLimitState.set(userId, entry);
    await next();
    return;
  }

  entry.count += 1;
  if (entry.count > RATE_LIMIT_MAX_PER_SEC) {
    deviceStateUpdatesRateLimited++;
    if (now - entry.lastWarnAt > RATE_LIMIT_WARN_THROTTLE_MS) {
      entry.lastWarnAt = now;
      logger.warn(
        { userId, feature: "device-state", count: entry.count, windowMs: RATE_LIMIT_WINDOW_MS },
        "Rate-limited /api/client/device/state — client is sending too many updates",
      );
    }
    return c.json({ error: "Too Many Requests" }, 429, { "Retry-After": "1" });
  }

  await next();
}

app.post("/", clientAuth, requireUserSession, rateLimit, updateDeviceState);
```

**Why these numbers:**

- Window 1 s: the storm is sub-second; any coarser window misses bursts.
- Cap 10/s: covers real BLE reconnect bursts (~5/s max observed) with 2× headroom.
- Warn throttle 60 s: one log line per user per minute when they're being limited. Avoids log amplification.
- Cleanup every 60 s, entries older than 5 min: prevents the Map from leaking for users who leave.

**Why per-user-in-memory:** cheapest correct answer. Sessions are pod-sticky. A user routed to two pods simultaneously gets double budget, which is acceptable.

---

## Metrics / Observability Changes

### Change 4: Publish counters in `system-vitals`

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Import the getters and include the four counters in the vitals payload. Reset them after each sample so the values are deltas per vitals tick (30 s by default).

```typescript
import { getDeviceStateCounters, resetDeviceStateCounters } from "../session/DeviceManager";
import { getDeviceStateRateLimitCount, resetDeviceStateRateLimitCount } from "../../api/hono/client/device-state.api";

// Inside the periodic vitals tick, alongside existing fields:
const ds = getDeviceStateCounters();
const rateLimited = getDeviceStateRateLimitCount();
resetDeviceStateCounters();
resetDeviceStateRateLimitCount();

const vitals = {
  // ...existing fields...
  deviceStateUpdatesTotal: ds.total,
  deviceStateUpdatesDeduped: ds.deduped,
  deviceStateUpdatesApplied: ds.applied,
  deviceStateUpdatesRateLimited: rateLimited,
};
```

### Change 5: Include counters in `/api/admin/memory/now`

**File:** `cloud/packages/cloud/src/services/debug/MemoryTelemetryService.ts`

Add a `deviceState` field to the snapshot shape exposed by `getCurrentStats()`:

```typescript
{
  // ...existing fields (process, sessions, memoryCensus)...
  deviceState: {
    updatesTotalSinceLastReset: deviceStateUpdatesTotal,
    updatesDedupedSinceLastReset: deviceStateUpdatesDeduped,
    updatesAppliedSinceLastReset: deviceStateUpdatesApplied,
    updatesRateLimitedSinceLastReset: rateLimited,
  }
}
```

Because the vitals logger also resets the counters, `/api/admin/memory/now` only shows the count since the last vitals tick, not lifetime. If we want lifetime we add a second pair of counters. Delta is what we actually want for debugging, so single-counter-with-reset is fine.

---

## bstack Changes

### Change 6: `bstack device-state` command

**File:** `cloud/tools/bstack/bstack.ts`

Add a new command between existing commands, registered via the normal dispatch table.

```typescript
async function cmdDeviceState(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central");
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"));
  const source = getSourceForRegion(region);

  console.log(`📟 Device-State Storm — ${region} (last ${duration})\n`);

  // Pod-wide volume
  const vol = await runSql(`
    SELECT
      toStartOfInterval(dt, INTERVAL 1 MINUTE) AS bucket,
      round(avg(JSONExtract(raw, 'deviceStateUpdatesTotal', 'Nullable(Float64)')), 1) AS total_per_tick,
      round(avg(JSONExtract(raw, 'deviceStateUpdatesDeduped', 'Nullable(Float64)')), 1) AS deduped,
      round(avg(JSONExtract(raw, 'deviceStateUpdatesApplied', 'Nullable(Float64)')), 1) AS applied,
      round(avg(JSONExtract(raw, 'deviceStateUpdatesRateLimited', 'Nullable(Float64)')), 1) AS rate_limited
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
      AND JSONHas(raw, 'deviceStateUpdatesTotal')
    GROUP BY bucket
    ORDER BY bucket DESC
    LIMIT 30
  `);
  console.log("Volume by minute (pod-global per-tick counters, avg):");
  printTable(vol.data);

  // Top emitters (pre-dedup, from device-state 'Updating device state' log)
  const top = await runSql(`
    SELECT
      JSONExtract(raw, 'userId', 'Nullable(String)') AS userId,
      count() AS updates
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'device-state'
      AND JSONExtract(raw, 'message', 'Nullable(String)') = 'Updating device state'
    GROUP BY userId
    ORDER BY updates DESC
    LIMIT 10
  `);
  console.log("\nTop emitters:");
  printTable(top.data);
}
```

Register with the dispatch table in `main()` and add a short description line to `cmdHelp()`.

---

## Testing

### Unit-adjacent checks

- Add a small test harness (or a one-off script) that instantiates a `DeviceManager` with a stubbed `UserSession`, calls `updateDeviceState` twice with identical payload, and asserts the second call is deduped (counter increments, no cascade side-effects). A `cloud/tests` script is enough — no Jest fixture needed.
- Add a case for the inference bug: `updateDeviceState({ modelName: "G1" })` first (sets `connected: true` by inference, applies), then `updateDeviceState({ modelName: "G1" })` again (should dedup despite the inference path — the equality check runs _before_ inference).

### Local integration

See the "Local verification" section of `spec.md`. The cases are: dedup, partial diff, rate limit, `/api/admin/memory/now`.

### Production verification

1. Baseline (pre-deploy):

   ```
   bstack device-state --region us-central --duration 1h
   ```

   Record `total_per_tick`, per-minute volume, top emitters.

2. Deploy cloud-debug, verify counters appear, verify dedup ratio > 0.

3. Deploy us-central. Wait one hour. Re-run the bstack command. Expect:
   - `total_per_tick` within 10% of pre-deploy (clients still POSTing)
   - `deduped / total > 0.6`
   - `applied / total < 0.4`
   - `rate_limited / total < 0.05`
   - Session-vitals RSS not climbing on the scale we saw before

4. If `deduped / total < 0.3`, something about the equality check is wrong. Likely causes: a field is being serialized with different representation (string vs number, `Date` vs ISO string), or a phone is POSTing a larger payload than the cloud has internally. Fix by tightening the diff function or normalizing inputs; do not revert the whole change.

---

## Rollout

1. **Branch:** `cloud/issues-099-glasses-connection-state-storm` (already created). Land Changes 1–5 in one PR.
2. **cloud-debug deploy:** verify counters and dedup ratio. 30-minute soak.
3. **cloud-prod deploy:** rolling across regions. Watch us-central first since it had the worst storm.
4. **`bstack device-state` follow-up PR** (Change 6) on the same branch. Not deploy-blocking.
5. **Mobile refactor** per spec §2, coordinated with mobile engineering. Separate repo, separate PR, separate release cycle.

---

## Decision Log

| Decision                                                                            | Alternatives considered                             | Why we chose this                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module-scoped counters with reset on read                                           | Per-`DeviceManager` counters; OpenTelemetry metrics | No need to attribute per-session yet. Pod-global is the level the problem manifests at. Reset-on-read lines up with 30 s vitals cadence.                                                                               |
| Compute `effectiveDiff` before inference                                            | Filter after inference                              | Inference writes fields that weren't in the original payload, which breaks equality. Order matters.                                                                                                                    |
| Broadcast only `effectiveDiff` to apps                                              | Broadcast full `payload`                            | Reduces app-facing notification churn. If an app only cares about battery, it stops seeing redundant model updates.                                                                                                    |
| `MicrophoneManager.lastKnownConnectionState: "CONNECTED" \| "DISCONNECTED" \| null` | Reuse `isEnabled`                                   | These are different properties. Mic-enabled is about user/app intent. Connection state is about the physical device.                                                                                                   |
| `setInterval(...).unref()` for rate-limit cleanup                                   | Clean up on every incoming request                  | The per-request cleanup would run 100+/s during the storm and allocate. Background sweep is cheaper.                                                                                                                   |
| Return 429 with `Retry-After: 1`                                                    | 503; 200 no-op                                      | 429 is the correct semantic. Many HTTP clients back off automatically on 429 with `Retry-After`. The mobile app currently does not — but it should, and this gives it the right header to act on once mobile §2 lands. |
| Rate-limit in a middleware, not inside `updateDeviceState`                          | In-handler check                                    | Middleware lets the handler stay linear. Also makes the rate limit observable via `c.res.status === 429` without reading handler internals.                                                                            |
| Share counters via module-level `let` + getter fns                                  | Dependency-injected counter service                 | Over-engineering for pod-local counters. Vitals logger pulls via an import, admin endpoint pulls via `MemoryTelemetryService`, both read-only.                                                                         |
| Drop `HISTORY_PRUNE_INTERVAL_MS` idea of persisting rate-limit state                | Redis / Mongo                                       | Sessions are pod-sticky. Pod restart resets the counter — that's acceptable; the phone's own behavior should converge within 1 s after reconnect anyway.                                                               |
| Do not touch `handleGlassesConnectionState` body                                    | Inline dedup check inside the cascade               | The cascade is correct; it just runs too often. Guard upstream.                                                                                                                                                        |

---

## Coordination Sketch (Mobile-Side, Out of This PR)

Per `spec.md` §2. Not designed here; written as a checklist so the mobile PR author knows what "done" looks like.

- `mobile/src/services/MantleManager.ts`: split single subscription on `getGlasesInfoPartial` into three narrower subscriptions (connection, battery, wifi) with independent debouncers (250 / 2000 / 1000 ms).
- Each debounced subscription tracks its own "last sent value" and skips the POST when the debounced value equals the previous send.
- Skip POST if the diff is empty or if `batteryLevel: -1` is the only delta (known → unknown blip).
- Audit `useGlassesStore.subscribe(... , shallow)` equality: the spike showed `modelName: "Even Realities G1"` bumping 13 times in 3 s with no change. Likely a native-bridge string-allocation issue; may need to intern strings or explicit `===` on primitives before calling `setGlassesInfo`.
- Remove `SocketComms.sendGlassesConnectionState()` dead code.
- 429 handling: respect `Retry-After` and back off. Without this, mobile will keep slamming 429s during storms until the client-side fix lands; the cloud is still protected by the rate limit but logs will be noisier than ideal.

Coordination target: mobile PR merged within 2 weeks of the cloud PR. Cloud-side metrics will show whether the mobile fix actually moved the needle.
