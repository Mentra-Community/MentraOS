# Design Doc: Cloud Prod Error Storm — All Fixes

## Overview

This document covers the implementation design for fixes identified in the [044 spec](./spec.md). Each fix is independent. Fixes 1, 2, 3, and 5 are implemented in this PR. Fix 4 is deferred to a separate PR that kills the dashboard mini app.

**Prerequisites:** Read the [spike](./spike.md) for root cause analysis and the [spec](./spec.md) for acceptance criteria.

**Scope:** Cloud monorepo (`MentraOS/cloud/`) only. No mobile app changes.

---

## Fix 1: Subscription Permission Rejection — Diagnostic Logging

### Problem

From the spike: at 19:06:48, `com.mentra.ai` had all 11 subscriptions rejected due to "missing permissions." The app's entire data stream was silently cut — transcription, audio, everything. Four seconds later, `com.mentra.recorder` had its subscriptions accepted on the same session. The user saw "AI not getting transcripts" with no indication of why.

### Root Cause

The original spec attributed this to a "timing race" with `App.findOne()` being slow during reconnect. This is incorrect. The permission check is deterministic:

1. `App.findOne({ packageName })` returns the app's document from MongoDB
2. `SimplePermissionChecker.filterSubscriptions()` checks if the app's `permissions` array includes the required types for each requested stream
3. If the app has `PermissionType.ALL`, everything passes. If it lacks the specific permission (e.g., `MICROPHONE` for `AUDIO_CHUNK`), the subscription is rejected.

Speed of the MongoDB query is irrelevant — the result is the same whether it takes 1ms or 500ms. The **only** way subscriptions get rejected is if the App document in MongoDB actually lacks the required permissions.

Possible root causes (need prod data to confirm):

1. **`com.mentra.ai`'s App document has an empty or missing `permissions` field.** The checker does `app.permissions?.some(...)` — if `permissions` is undefined/null/empty array, every permission check fails and all subscriptions are rejected.
2. **The permission migration (`migrate-permissions.ts`) didn't cover `com.mentra.ai`.** The migration script adds `PermissionType.ALL` to legacy apps. If this app was missed, it would have no permissions.
3. **The app was registered without proper permissions.** Developer console or API registration flow might not set permissions correctly for system apps.

### Design

#### 1.1 Elevate rejection log from `warn` to `error`

A rejected subscription is a data-loss event — the app silently loses its entire data stream. This should be immediately visible in BetterStack, not buried in warnings.

#### 1.2 Add rich diagnostic context to the rejection log

Include the app's actual permissions alongside what was required, so we can diagnose the problem from a single log line without needing a separate DB query:

```
{
  userId, packageName, rejectedCount, rejected,
  appPermissions: ["microphone", "location", ...],  // what the app actually has
  requestedSubscriptions: ["audio_chunk", "transcription:en-US", ...]  // what it asked for
}
```

#### 1.3 Log when App document is not found

If `App.findOne()` returns null, log it explicitly at `warn` level. Today the code silently allows everything when the app isn't in the DB — which is correct behavior, but we should know it's happening.

### Files Changed

| File                                                               | Change                                                                                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud/packages/cloud/src/services/session/SubscriptionManager.ts` | Elevate rejection log to `error`, add `appPermissions` and `requestedSubscriptions` to log context, add explicit log when App document not found |

### Follow-Up Investigation (Not Part of This PR)

- [ ] Query prod MongoDB for `com.mentra.ai`'s App document — check `permissions` field
- [ ] Query prod MongoDB for all apps with empty/null `permissions` — how widespread is this?
- [ ] If `com.mentra.ai` lacks permissions: run the migration script or fix the app registration
- [ ] Audit the developer console's app creation/update flow — does it set `permissions` correctly?
- [ ] Consider whether system apps (dashboard, recorder, AI) should bypass permission checks entirely since they're not third-party apps

### Risks

None. This is a logging-only change. No behavioral change to the permission system.

---

## Fix 2: UDP Encryption Key — Skip Rotation on Reconnect

### Problem

On reconnect, the server generates a new encryption key. In-flight UDP packets encrypted with the old key fail decryption → dropped → silence gap until the mobile app starts using the new key.

### Root Cause

In `handleGlassesOpen()` in `bun-websocket.ts`:

```
async function handleGlassesOpen(ws) {
  const { userId, udpEncryptionRequested } = ws.data;
  const { userSession, reconnection } = await UserSession.createOrReconnect(ws, userId);

  // THIS runs on EVERY open, including reconnects:
  if (udpEncryptionRequested) {
    userSession.udpAudioManager.initializeEncryption();  // ← generates NEW key unconditionally
  }
}
```

`initializeEncryption()` is called on **every** connection open, including reconnects. On a reconnect, the session already has a working key from the original connection. The new key is sent in `CONNECTION_ACK`, the mobile calls `udp.setEncryption()` with the new key, but in-flight UDP packets are still encrypted with the old key → decryption failure → dropped → silence gap.

There is no security reason to rotate the key on reconnect. The key is per-session, the session survives the reconnect, and the key is re-transmitted over a fresh TLS WebSocket connection. The key rotation on reconnect is accidental — nobody decided "we need a new key on reconnect," it's just that `initializeEncryption()` is called on every open without checking if encryption is already set up.

### Design

Skip `initializeEncryption()` on reconnect when encryption is already initialized. The existing key is still valid. The mobile gets the same key back in `CONNECTION_ACK`, calls `udp.setEncryption()` with the same key it already has — no transition, no in-flight packet problem, zero silence gap.

```
// handleGlassesOpen — AFTER fix:
if (udpEncryptionRequested && !userSession.udpAudioManager.encryptionEnabled) {
  userSession.udpAudioManager.initializeEncryption();
}
// Reconnect with existing key → reuse it (sent in CONNECTION_ACK as before)
```

Edge case: mobile app fully restarts → connects to an existing cloud session. The mobile has no key, but the server sends the existing key in `CONNECTION_ACK`. Mobile calls `udp.setEncryption()` with that key. Works perfectly — same key, no transition.

### Files Changed

| File                                                           | Change                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` | Guard `initializeEncryption()` call with `!encryptionEnabled` check     |
| `cloud/packages/cloud/src/services/session/UdpAudioManager.ts` | JSDoc comment on `initializeEncryption()` explaining the reconnect skip |

### Risks

None. Reusing the existing key on reconnect is strictly simpler than rotating. The mobile already handles receiving the same key (it just calls `setEncryption` again — idempotent). No protocol change, no mobile update needed.

---

## Fix 3: Soniox 408 Timeout — Auto-Pause During Audio Gaps

### Problem

The Soniox SDK stream (`SonioxSdkStream`) has no keepalive mechanism. When Mentra Live glasses' hardware VAD suppresses audio during silence, the cloud stops sending audio to Soniox, but the stream stays open. Soniox times out after ~20 seconds → 408 → full stream teardown + recreation → transcription gap.

The old WebSocket-based stream sent `{"type":"keepalive"}` every 15 seconds. The new SDK stream (migrated in issue 041) has nothing — a regression.

### Root Cause

The `@soniox/node` SDK provides built-in keepalive via `session.pause()`:

- **`session.pause()`** — keeps the connection alive (auto-sends keepalive), auto-finalizes pending tokens, drops audio while paused
- **`session.resume()`** — resume sending audio
- **`session.sendKeepalive()`** — manual keepalive (for advanced use)

The SDK migration replaced the raw WebSocket with the official SDK but didn't use the SDK's pause/resume feature — so the connection had no keepalive at all during audio gaps.

### Design

#### 3.1 Auto-pause on audio gap detection

Add a 1-second interval that tracks when audio was last written. After 2 seconds of no audio, call `session.pause()`. The SDK handles keepalive and finalization automatically:

```
File: cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts

class SonioxSdkStream {
  // Gap detection state
  private gapCheckInterval: NodeJS.Timeout | null = null;
  private lastAudioWriteTime: number = Date.now();
  private pausedForGap = false;

  // Configuration
  private static readonly GAP_CHECK_INTERVAL_MS = 1000;   // Check every 1s
  private static readonly AUDIO_GAP_THRESHOLD_MS = 2000;   // 2s of no audio → pause
}
```

The gap check interval:

```
startGapDetection():
  this.gapCheckInterval = setInterval(() => {
    if (this.disposed || session not connected || already paused) return;

    if (Date.now() - this.lastAudioWriteTime >= 2000) {
      this.session.pause();       // SDK: auto-keepalive + auto-finalize
      this.pausedForGap = true;
    }
  }, 1000);
```

**Why 2 seconds?** The Soniox docs note "SDK will finalize audio on pause — make sure to adjust your VAD sensitivity to have enough silence before pause." 2 seconds of no audio is a safe threshold — the user has definitely stopped speaking. We won't cut off mid-word.

**Why `pause()` instead of `sendKeepalive()`?** `session.pause()` does two things we need: keepalive AND finalization. If we only sent keepalive, pending tokens would accumulate during the gap and stitch new speech onto old context when audio resumes. `pause()` handles both in one call.

#### 3.2 Auto-resume in writeAudio()

When `writeAudio()` is called while the session is paused, resume before sending:

```
writeAudio(data):
  this.lastAudioWriteTime = Date.now();

  if (this.pausedForGap) {
    this.session.resume();
    this.pausedForGap = false;
    // Reset utterance tracking so new speech starts clean
    this.stablePrefixText = "";
    this.prevWindowFinalLen = 0;
    this.lastEmittedInterimText = "";
  }

  this.session.sendAudio(data);
```

The resume happens synchronously before `sendAudio()` — no audio is lost. The SDK docs confirm that after `resume()`, `sendAudio()` works normally.

#### 3.3 Cleanup

Stop the gap check interval in `close()`, `handleError()`, and `startGapDetection()` (idempotent clear before restart).

### Files Changed

| File                                                                                   | Change                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts` | Add `gapCheckInterval`, `lastAudioWriteTime`, `pausedForGap`; add `startGapDetection()` / `stopGapDetection()`; auto-resume in `writeAudio()`; cleanup in `close()` and `handleError()` |

### Risks

- **Resume latency:** `session.resume()` is synchronous in the SDK. No measurable delay before `sendAudio()` works. First audio chunk after a gap is delivered immediately.
- **Pause during speech:** If audio stops for exactly 2 seconds during a natural pause in speech (e.g., thinking), the session will pause and finalize. When speech resumes, the new utterance starts fresh. This is correct behavior — a 2-second silence is a natural utterance boundary.
- **SDK version:** We're on `@soniox/node ^1.1.1` which resolves to `1.1.2` (published 10 days ago). The `pause()` / `resume()` / `sendKeepalive()` methods exist in this version — TypeScript shows zero errors on the calls.

---

## Fix 4: Dashboard WebSocket CLOSED Log Spam — DEFERRED

### Problem

237K error-level log entries in 4 hours from the dashboard system. These aren't user-facing failures — the user is already disconnected. But they drown real errors in BetterStack, consume log budget, and trigger false alerts.

### Root Cause

The dashboard is a **separate mini app** (`apps/Dashboard`) that connects to the cloud like any third-party app. It has a 60-second `setInterval` per user session that generates time/weather/battery/notification text and sends it to the cloud via `DASHBOARD_SYSTEM_UPDATE` messages through the SDK.

When a user's glasses WebSocket disconnects:

1. The mini app's SDK connection to the cloud **stays alive** (the mini app server is still running — it has no way to know the user's glasses are disconnected)
2. The mini app's 60s interval keeps firing → sends `DASHBOARD_SYSTEM_UPDATE` via the SDK's `AppSession.send()`
3. The SDK's `send()` throws because the WebSocket is in a bad state
4. The **mini app's** catch block in `updateDashboardSections()` (`apps/Dashboard/src/index.ts` line 451) re-logs the thrown error at `error` level

The 237K errors originate in the **mini app repo** (`apps/Dashboard`) and the **SDK** (`packages/sdk/src/app/session/index.ts`), not in the cloud-side `DashboardManager`.

### Why This Is Deferred

The correct fix is architectural: kill the dashboard mini app entirely and bring its logic (time formatting, weather, battery, notifications) into the cloud-side `DashboardManager` as an OS service. This eliminates the problem by design:

- No external mini app → no SDK WebSocket round-trip → no blind updates to disconnected users
- `DashboardManager` can check WebSocket state itself before doing any work
- No 60-second interval ticking for disconnected users

Tracked under [040-cloud-v3-cleanup §5](../040-cloud-v3-cleanup/maintainability.md). Separate PR.

### Files Changed

None in this PR.

---

## Fix 5: MongoDB VersionError on `installedApps` Mutations

### Problem

Multiple code paths modify `user.installedApps` concurrently: auto-install pre-installed apps, auto-delete apps, settings updates, developer auto-install, manual install/uninstall. All use `user.save()` with Mongoose optimistic concurrency. When two paths read the same version and both save, the second gets `VersionError`. 45K VersionErrors in 4 hours.

### Root Cause

Mongoose's `save()` uses optimistic concurrency — it reads the document version, modifies in-memory, then writes with a version check. When multiple code paths call `save()` concurrently on the same user document, only the first succeeds. The rest get `VersionError`.

The fix is to use MongoDB atomic operations (`$push`, `$pull`, `$set`) which don't require version checks — they operate directly on the document in the database.

### Design

#### 5.1 Convert installApp / uninstallApp to atomic operations

```
// BEFORE: installApp
UserSchema.methods.installApp = async function(packageName) {
  if (!this.isAppInstalled(packageName)) {
    this.installedApps.push({ packageName, installedDate: new Date() });
    await this.save();  // ← VersionError risk
  }
};

// AFTER: installApp — atomic, no VersionError possible
UserSchema.methods.installApp = async function(packageName) {
  const User = this.constructor as any;
  const result = await User.updateOne(
    {
      _id: this._id,
      "installedApps.packageName": { $ne: packageName }  // guard: only if not already installed
    },
    {
      $push: {
        installedApps: { packageName, installedDate: new Date() }
      }
    }
  );

  if (result.modifiedCount > 0) {
    if (!this.installedApps) this.installedApps = [];
    this.installedApps.push({ packageName, installedDate: new Date() });
  }
};

// BEFORE: uninstallApp
UserSchema.methods.uninstallApp = async function(packageName) {
  if (this.isAppInstalled(packageName)) {
    this.installedApps = this.installedApps.filter(app => app.packageName !== packageName);
    await this.save();  // ← VersionError risk
  }
};

// AFTER: uninstallApp — atomic
UserSchema.methods.uninstallApp = async function(packageName) {
  const User = this.constructor as any;
  const result = await User.updateOne(
    { _id: this._id },
    { $pull: { installedApps: { packageName } } }
  );

  if (result.modifiedCount > 0) {
    if (this.installedApps) {
      this.installedApps = this.installedApps.filter(app => app.packageName !== packageName);
    }
  }
};
```

**Why `$addToSet` isn't used:** `$addToSet` compares entire subdocuments, including `installedDate`. Since each call generates a new `Date()`, MongoDB considers them different. Instead, we use `$push` with a `$ne` guard on `packageName` to achieve the same idempotency.

#### 5.2 Convert auto-install in findOrCreateByEmail to atomic operations

The auto-install block is the highest-volume path (fires on every session creation):

```
// BEFORE:
if (missingPreInstalled.length > 0) {
  for (const packageName of missingPreInstalled) {
    user.installedApps.push({ packageName, installedDate: new Date() });
  }
  await user.save();  // ← VersionError risk — HIGHEST VOLUME
}

// AFTER: atomic per-app install
if (missingPreInstalled.length > 0) {
  for (const packageName of missingPreInstalled) {
    await User.updateOne(
      { _id: user._id, "installedApps.packageName": { $ne: packageName } },
      { $push: { installedApps: { packageName, installedDate: new Date() } } }
    );
  }
}
```

#### 5.3 Convert auto-delete in findOrCreateByEmail to atomic operation

```
// BEFORE:
user.installedApps = user.installedApps.filter(app => !packagesToDelete.includes(app.packageName));
await user.save();  // ← VersionError risk

// AFTER: atomic bulk delete
await User.updateOne(
  { _id: user._id },
  { $pull: { installedApps: { packageName: { $in: packagesToDelete } } } }
);
```

#### 5.4 Convert updateAppLastActive to atomic operation

```
// BEFORE: read-modify-save with retry loop
const app = user.installedApps.find(...);
app.lastActive = new Date();
await user.save();  // ← VersionError risk, retry loop

// AFTER: atomic $set on subdocument
await User.updateOne(
  { _id: user._id, "installedApps.packageName": packageName },
  { $set: { "installedApps.$.lastActive": new Date() } }
);
```

#### 5.5 Log context enrichment

All remaining VersionError logs include `{ userId, email, packageName, attempt, maxRetries }` for debugging.

### Files Changed

| File                                            | Change                                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/packages/cloud/src/models/user.model.ts` | Rewrite `installApp`, `uninstallApp`, `updateAppLastActive` to atomic ops; rewrite auto-install/auto-delete in `findOrCreateByEmail` to atomic ops; enrich VersionError log context |

### Risks

- **In-memory state drift:** After atomic operations, the in-memory Mongoose document is stale. We manually update the in-memory arrays after each atomic op. Code that reads `user.installedApps` immediately after an install/uninstall in the same request will see the correct state.
- **Validator bypass:** The custom validator on `installedApps` (no duplicate packageNames) runs on `save()` but not on `updateOne()`. Our `$ne` guard on `packageName` serves the same purpose — it prevents duplicates at the query level.
- **Bulk install ordering:** If two concurrent `findOrCreateByEmail` calls both try to auto-install the same missing app, the `$ne` guard ensures only one succeeds. The other is a no-op. No error, no duplicate.

---

## Implementation Order

1. **Fix 5** (MongoDB VersionError) — smallest blast radius, most mechanical change
2. **Fix 1** (Subscription permissions) — logging-only, zero behavioral risk
3. **Fix 2** (UDP key transition) — one-line fix, isolated to one call site
4. **Fix 3** (Soniox 408) — single file, uses SDK's intended API

Fix 4 is deferred to the dashboard mini app kill PR.

---

## Testing Strategy

### Fix 1: Subscription Permission Logging

- Manual: deploy and check BetterStack for rejection logs with `appPermissions` context
- Manual: verify `App.findOne()` null case logs at warn level

### Fix 2: UDP Key Reuse on Reconnect

- Manual: connect → disconnect → reconnect → verify no audio gap
- Verify: CONNECTION_ACK on reconnect contains same key as original connection
- Edge case: full mobile restart connecting to existing session — verify key is sent in ACK

### Fix 3: Soniox Auto-Pause

- Verify: `@soniox/node ^1.1.1` resolves to 1.1.2 which has `session.pause()` / `session.resume()`
- Manual: leave glasses idle for >20s, verify no 408 in logs (pause should prevent timeout)
- Manual: speak → 2s silence → speak again → verify no transcription gap (resume before sendAudio)
- Manual: verify utterance tracking resets after gap (new speech starts fresh, no stale context)

### Fix 5: Atomic installedApps

- Unit test: installApp with concurrent calls — no VersionError, no duplicates
- Unit test: uninstallApp with concurrent calls — no VersionError
- Unit test: auto-install in findOrCreateByEmail uses atomic ops
- Integration: verify installedApps array integrity under concurrent mutations

---

## Out of Scope

- **Dashboard mini app kill (Fix 4):** Separate PR. Requires moving weather, notification summarization, calendar formatting from `apps/Dashboard` into cloud's `DashboardManager`. Tracked under [040-cloud-v3-cleanup §5](../040-cloud-v3-cleanup/maintainability.md).
- **Mobile ping/pong handler:** Separate cherry-pick, already identified in the spike.
- **Stale WS close guard (`f005ec7f8`):** Separate cherry-pick.
- **Org creation fix deployment:** Not a code change — just needs merge to `main` (see [spike-org-creation-not-deployed.md](./spike-org-creation-not-deployed.md)).
