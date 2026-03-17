# Spec: Cloud Prod Error Storm — Remaining Fixes

## Overview

**What this doc covers:** Specifications for the five non-ping/pong issues identified in the [044 spike](./spike.md): subscription permission rejection on reconnect, UDP encryption key transition, Soniox 408 timeout mitigation, dashboard WebSocket CLOSED log spam, and MongoDB VersionError on `installedApps` mutations.

**Why this doc exists:** The spike identified six cascading failure modes. The root cause (missing mobile ping/pong → Cloudflare idle timeout) is being fixed separately by cherry-picking the handler from `cloud/sdk-hono`. The stale WS close guard (`f005ec7f8`) is also a separate cherry-pick. This spec covers everything else.

**What you need to know first:** [044 spike](./spike.md) — especially sections 5–8 and the severity table.

**Who should read this:** Cloud team, mobile team. Each fix is independent — skip to the section you own.

## The Problem in 30 Seconds

Even after the ping/pong fix eliminates ~60% of disconnects, the remaining ~40% (iOS backgrounding, network transitions, pod restarts) still cascade into five user-facing or ops-impacting failures:

1. **Subscription permissions rejected on reconnect** → apps lose all data streams (transcription, audio) with no recovery until next reconnect
2. **UDP encryption key mismatch** → old-key packets arrive after reconnect, server drops them, user hears silence gaps
3. **Soniox 408 timeouts** → 5-second transcription gaps affecting 50.7% of users, increasing with load
4. **Dashboard CLOSED spam** → 237K error logs in 4 hours, drowning real errors in noise
5. **MongoDB VersionError** → concurrent `installedApps` mutations fail silently, corrupting app install state

## Spec

---

### Fix 1: Subscription Permission Check — Reconnect Grace Window

#### Problem

During reconnect, apps re-send their subscription updates. The `SubscriptionManager.processSubscriptionUpdate()` calls `App.findOne({ packageName })` to look up the app's declared permissions. If this MongoDB query is slow or the app document hasn't been cached, the permission check races against the reconnect grace window logic in `AppSession`.

When subscriptions are rejected, the app's entire data stream is cut — transcription, audio, everything. The app gets no notification that its subscriptions were rejected; it just stops receiving data. The user sees "AI not getting transcripts" with no indication of why.

From the spike: at 19:06:48, `com.mentra.ai` had all 11 subscriptions rejected. Four seconds later, `com.mentra.recorder` had its subscriptions accepted. Same user, same reconnect window — pure timing.

#### Current behavior

```
App reconnects → sends subscription_update
  → SubscriptionManager.processSubscriptionUpdate()
    → App.findOne({ packageName })          ← can be slow (MongoDB)
    → SimplePermissionChecker.filterSubscriptions()
      → if rejected: warn log, but silently drops subscriptions
    → appSession.updateSubscriptions(allowedProcessed, ...)
      → if allowedProcessed is empty: clears all streams
```

`packages/cloud/src/services/session/SubscriptionManager.ts` L270–282:

```typescript
const { allowed, rejected } = SimplePermissionChecker.filterSubscriptions(app, processed);
if (rejected.length > 0) {
  this.logger.warn(
    { userId, packageName, rejectedCount: rejected.length, rejected },
    "Rejected subscriptions due to missing permissions",
  );
}
allowedProcessed = allowed;
```

The rejection is logged as a warning but the app is never told. The `catch` block at L285 falls through to "continue with all requested" — but the happy-path rejection doesn't.

#### Specified behavior

**A. Cache app permissions in-memory per session.** On first successful permission lookup for an app, cache the result in `SubscriptionManager` (or a shared in-memory cache scoped to the UserSession). Subsequent subscription updates for the same app skip MongoDB entirely. Cache invalidates on session teardown.

**B. On permission check failure during reconnect, fall back to allowing all requested subscriptions.** The current `catch` block already does this for exceptions. Extend this philosophy: if the app was previously allowed subscriptions in this session (i.e., it had active subscriptions before the disconnect), trust the previous permission grant rather than re-querying MongoDB in the critical reconnect path.

**C. Integrate with issue 008 queue.** The subscription race condition fix (008) adds `AppSession.enqueue()` to serialize subscription updates. This fix should work within that queue — the permission cache lookup happens inside the queued operation, not outside it.

**D. Log rejection as error, not warn.** A rejected subscription during reconnect is a data-loss event. Elevate the log level and include the session's previous subscription state for debugging.

#### Acceptance criteria

- An app that had active subscriptions before disconnect gets the same subscriptions back on reconnect, even if the `App.findOne()` query is slow
- The permission cache is populated on first subscription update and reused for subsequent updates in the same session
- `App.findOne()` is called at most once per `(packageName, sessionId)` pair
- If `App.findOne()` fails (timeout, error), subscriptions are allowed (fail-open), matching the existing catch-block behavior
- No new external dependencies

---

### Fix 2: UDP Encryption Key Transition

#### Problem

On reconnect, the server generates a new symmetric encryption key in `UdpAudioManager.initializeEncryption()` and sends it in `CONNECTION_ACK`. But the mobile app is still sending UDP packets encrypted with the **old key** — these are in-flight packets that were sent before the reconnect completed.

The server correctly identifies these as decryption failures and drops them:

`packages/cloud/src/services/udp/UdpAudioServer.ts` L159–176:

```typescript
const decrypted = session.udpAudioManager.decryptAudio(new Uint8Array(audioData));
if (!decrypted) {
  this.decryptionFailures++;
  this.packetsDropped++;
  // ... log warning ...
  return; // ← packet dropped
}
```

This is the correct behavior — garbage data doesn't reach the audio pipeline. The user doesn't hear static (the spike's initial hypothesis was wrong — confirmed by code review showing the `return` on failed decryption). What the user actually experiences is a **silence gap** during the transition window until the mobile app starts sending packets with the new key.

With ~15.7 reconnects per user per 4 hours, and each transition window lasting anywhere from 100ms to several seconds depending on UDP packet timing, this adds up to noticeable audio dropout.

#### Current behavior

```
Reconnect:
  1. Server generates new key, sends in CONNECTION_ACK
  2. Mobile receives CONNECTION_ACK, stores new key
  3. Mobile starts encrypting with new key
  4. In-flight packets (old key) arrive at server → decryption fails → dropped
  5. Gap: no valid audio until step 3 completes and new packets arrive
```

#### Specified behavior

**A. Keep the previous key for a grace window.** After generating a new key, store the old key for 2 seconds. During this window, if decryption with the current key fails, attempt decryption with the previous key.

**B. Implementation location:** `UdpAudioManager`. Add a `_previousEncryptionState` field alongside `_encryptionState`. When `initializeEncryption()` is called, move the current state to previous before generating the new one.

**C. `decryptAudio()` change:**

```
decryptAudio(encryptedData):
  1. Try decrypt with current key
  2. If fails AND _previousEncryptionState exists AND within grace window:
     a. Try decrypt with previous key
     b. If succeeds: return decrypted data, log at debug level
  3. If both fail: return null (existing behavior)
```

**D. Grace window expiry.** Store a `_previousKeyExpiresAt` timestamp. After 2 seconds, clear `_previousEncryptionState` — no memory leak, no indefinite fallback.

**E. Metrics.** Add a counter for "decrypted with previous key" events. If this is consistently high, it means the mobile app is slow to adopt the new key, which is a separate problem.

#### Acceptance criteria

- Packets encrypted with the old key are successfully decrypted during the 2-second grace window after a reconnect
- Packets encrypted with the old key are dropped after the grace window expires
- The previous key is cleared from memory after the grace window
- No change to the encryption protocol — the mobile app doesn't need to know about this
- Decryption failure count (the metric that currently fires on every reconnect) drops to near-zero during normal reconnects

---

### Fix 3: Soniox 408 Timeout Mitigation

#### Problem

Soniox returns HTTP 408 ("Audio data decode timeout" / "Request timeout") when it can't process audio in time. This affected 50.7% of users (116/229) during the spike window. The rate increases through the day, correlating with user count — suggesting load-related backpressure.

The existing retry mechanism works: streams reconnect in 140ms–2.8s via `TranscriptionManager.handleStreamError()`. But during the retry window, no transcription flows to apps. With multiple retries per hour per user, the cumulative gap is noticeable.

**Important:** The spike confirmed that Soniox 408s are **independent of WebSocket disconnects**. They happen on the debug server (which has stable connections) too. This is not a cascading failure from disconnects.

#### Likely root cause: no keepalive in the SDK stream during audio gaps (hypothesis)

The old WebSocket-based `SonioxTranscriptionStream` sends a `{"type":"keepalive"}` every 15 seconds (Soniox requires at least one every 20 seconds — see `SonioxTranscriptionProvider.ts` L1092–1139). The new SDK-based `SonioxSdkStream` (migrated in issue 041) has **no keepalive mechanism at all** — it relies entirely on audio data flowing to keep the connection alive.

This wasn't a problem with G1/display glasses because there was no on-glasses VAD — audio always flowed continuously from glasses → phone → cloud → Soniox. With **Mentra Live glasses**, the glasses have a **hardware VAD** that suppresses audio during silence. Crucially:

- **The cloud does NOT receive glasses VAD events.** The `handleVad()` code in `glasses-message-handler.ts` only fires for the phone-side VAD (phone mic / G1 audio source). The Mentra Live glasses VAD operates silently at the phone level — the mobile client simply stops sending audio chunks to the cloud. The cloud has no signal that audio stopped or why.
- **The Soniox SDK stream stays open but starved.** Since the cloud doesn't know about the silence, it doesn't tear down the stream. The `SonioxSdkStream` just sits there connected, receiving no audio and sending no keepalive, until Soniox's server-side idle timeout fires → 408.
- **In the future**, the mobile client will forward glasses VAD events to the cloud. But today it doesn't, so the cloud can't distinguish "user is in a quiet room" from "glasses VAD suppressed audio."

```
Mentra Live glasses VAD → silence detected
  → Phone stops sending audio chunks to cloud
  → Cloud doesn't know (no VAD event received)
  → SonioxSdkStream sits idle — no audio, no keepalive
  → ~20s later: Soniox server times out → 408

  ...time passes...

  → Glasses VAD → speech detected
  → Phone resumes sending audio chunks
  → Cloud pushes audio to the (now dead) SonioxSdkStream → error
  → handleStreamError() → full stream teardown + recreation
  → ~140ms–2.8s gap with no transcription
```

**Key difference between the two Soniox integrations:**

| | Old WebSocket stream | New SDK stream |
|---|---|---|
| Keepalive | `{"type":"keepalive"}` every 15s | **None** |
| During audio gaps | Stream stays alive (keepalive sustains it) | Stream idles → Soniox times out after ~20s |
| After timeout | N/A (doesn't time out) | Full teardown + recreation on next audio |

**Open question: stream continuity after silence.** If we add keepalive and the stream survives a long silence, when audio resumes will Soniox try to stitch the new speech onto the old context? Or does it treat the gap as an implicit endpoint? The old WebSocket protocol let us send `session.finalize()` explicitly. The SDK exposes `session.finalize()` too (used by `forceFinalizePendingTokens()`), but it's unclear whether we should call it when we detect an audio gap — since the cloud doesn't know about the gap in the first place. This needs investigation with Soniox docs or testing. Worst case, we may need to detect audio gaps ourselves (e.g., "no audio received for N seconds → call `session.finalize()`") to prevent Soniox from producing garbled transcription when audio resumes.

**Also unclear: does the Soniox Node SDK (`@soniox/node`) handle keepalive internally?** The old raw WebSocket integration required manual keepalive. The SDK might handle it under the hood — or it might not. The SDK source isn't available locally to verify. This is the first thing to check before implementing a manual keepalive.

#### Current behavior

```
Soniox stream → 408 timeout
  → handleStreamError()
    → cleanupStream()           ← stream is torn down
    → isSonioxRateLimit(error)  ← checks for rate limit (not 408)
    → isRetryableError(error)   ← 408 is retryable
    → scheduleStreamRetry()     ← retry with exponential backoff
      → _performStreamCreation() ← full stream creation from scratch
```

The retry recreates the entire stream, including Soniox SDK initialization, WebSocket handshake, and audio pipeline setup. This is heavyweight for a transient timeout.

#### Specified behavior

**A. Investigate whether `@soniox/node` SDK handles keepalive internally.** Before implementing anything, check the SDK source/docs to determine if `RealtimeSttSession` sends its own WebSocket keepalive. If it does and the timeout is still happening, the problem is elsewhere (e.g., Soniox server-side audio processing timeout, not connection idle timeout). If it doesn't, proceed with B.

**B. Add keepalive to `SonioxSdkStream`.** If the SDK does not handle keepalive internally, add a keepalive mechanism to `SonioxSdkStream`. Send a keepalive every 15 seconds while the stream is connected but not receiving audio. Options in priority order:
1. Check if the SDK's `RealtimeSttSession` exposes a `keepalive()` or `ping()` method
2. Try sending a zero-length or silence audio buffer via `session.sendAudio(new Uint8Array(0))` — may work as an implicit keepalive
3. If neither works, raise with Soniox as a feature request for `@soniox/node` — the old WebSocket protocol supported `{"type":"keepalive"}` and the SDK should too

**C. Add cloud-side audio gap detection.** Since the cloud doesn't receive glasses VAD events today, detect audio gaps by tracking the last `writeAudio()` timestamp in `SonioxSdkStream`. If no audio arrives for N seconds (e.g., 5s), call `session.finalize()` to flush any pending transcription. This prevents Soniox from trying to stitch old context onto new speech when audio eventually resumes after a long silence. The finalization resets the utterance state cleanly — when audio returns, Soniox treats it as a fresh utterance.

**D. Classify 408 as a transient error with fast retry.** The current retry path treats 408 the same as other retryable errors. Add a specific fast-path: if the error is a 408 timeout and the stream was previously healthy (had produced transcriptions), retry immediately (no backoff delay on first attempt) and skip provider failover.

**E. Buffer audio during retry.** When a Soniox stream enters the retry path due to 408, buffer incoming PCM audio (up to 5 seconds / ~160KB at 16kHz 16-bit mono) instead of dropping it. On successful retry, flush the buffer to the new stream. This eliminates the transcription gap for short retries.

**F. Cap the buffer.** If the retry takes longer than 5 seconds, start dropping the oldest audio from the buffer (ring buffer behavior). This prevents memory growth during extended outages.

**G. Track 408 rate per user.** Add a per-session counter for 408 errors. If a user exceeds 10 in 5 minutes, log an error-level event with audio format details (sample rate, codec, frame size). This helps correlate 408s with specific audio configurations or device types.

**H. Do NOT switch providers on first 408.** The current code in `handleStreamError()` L1306–1315 checks `isSonioxRateLimit()` and immediately fails over to Azure. A 408 timeout is not a rate limit — it's a transient processing delay. Only fail over to Azure after 3 consecutive 408s for the same stream.

#### Acceptance criteria

- Soniox SDK stream stays alive during audio gaps (keepalive prevents idle timeout)
- After a silence gap >5s, pending tokens are finalized so new speech starts a fresh utterance
- When audio resumes after a gap, it flows to the existing stream without reconnect overhead
- First 408 retries immediately (no backoff), retaining Soniox as provider
- Audio is buffered during retry and flushed on success, eliminating the transcription gap for retries under 5 seconds
- Provider failover to Azure happens only after 3 consecutive 408s
- Per-session 408 counter is logged at error level when threshold (10/5min) is exceeded
- No change to the retry behavior for non-408 errors

---

### Fix 4: Dashboard WebSocket CLOSED Log Spam

#### Problem

The dashboard app (`system.augmentos.dashboard`) runs on a 60-second update interval for every user. When a user's WebSocket is disconnected, each tick generates error-level log lines:

1. `Message send error: WebSocket not connected (current state: CLOSED)` — from the SDK's `AppSession.send()`
2. `Error updating dashboard sections for user X` — from `DashboardManager.updateDashboard()`
3. Session-level error propagation

With 224 users experiencing disconnects, this produced **237K error-level log entries in 4 hours** — 48.8% of all errors. These aren't user-facing failures (the user is already disconnected), but they:

- Make BetterStack error dashboards useless (real errors are drowned)
- Consume log ingestion budget (7-day retention on this source)
- Trigger false-positive alerting

**Note:** The `DisplayManager6.1.ts` code already has a `ConnectionValidator` guard in `sendToWebSocket()` that logs at **debug** level. The spam is coming from the upstream callers that catch the exception and log it at error level before the guard is even reached, or from the SDK-side `AppSession.send()` which throws when `readyState !== 1`.

#### The real fix: kill the dashboard mini app

The dashboard is currently a separate mini app that connects to the cloud like any third-party app. This architecture is the root cause of the log spam (it goes through the full SDK `AppSession.send()` path), but it's also a broader maintainability and reliability problem:

- It's hard to test dashboard changes because you have to think about `SYSTEM_DASHBOARD_PACKAGE_NAME` and special-case routing
- If the dashboard mini app server goes down, users have no dashboard
- The webhook round-trip to the dashboard app adds latency and a failure point
- The cloud already has all the data the dashboard needs (time, battery, location, notifications, calendar)

This is documented in [040-cloud-v3-cleanup/maintainability.md §5](../040-cloud-v3-cleanup/maintainability.md) ("Dashboard mini app needs to die — cloud takes over") and [040-cloud-v3-cleanup/reliability.md §6](../040-cloud-v3-cleanup/reliability.md) ("Dashboard reliability").

**The proper fix is to deprecate the dashboard mini app and refactor `DashboardManager` to do what the mini app does directly** — weather, notification summarization, calendar formatting, etc. All this logic already exists in the mini app; it just needs to be relocated into the `DashboardManager` rewrite. The rewritten manager composes the dashboard layout directly and sends it to `ViewType.DASHBOARD` via the `DisplayManager`, bypassing the SDK `AppSession` path entirely. This eliminates the CLOSED spam by design — no WebSocket send, no error.

**This is a larger refactor that will be specced separately.** The dashboard mini app code will be provided as input for that spec. For now, a short-term mitigation stops the bleeding.

#### Specified behavior (short-term mitigation)

**A. Check connection state before attempting dashboard update.** In `DashboardManager.updateDashboard()`, check `this.userSession.websocket?.readyState === 1` (or use `ConnectionValidator`) before generating the layout and calling `sendDisplayRequest()`. If disconnected, return silently — don't generate layout, don't attempt send, don't log.

**B. Pause the dashboard interval on disconnect.** When the user's glasses WebSocket closes, pause the dashboard update timer. Resume it on reconnect. This eliminates the 60-second tick entirely for disconnected users.

Implementation: `DashboardManager` already has access to `this.userSession`. Listen for the session's disconnect event (or check connection state in the interval callback). Use `clearInterval` / `setInterval` rather than a flag check, to avoid any CPU cost from the tick.

**C. Downgrade remaining send errors to debug.** Any `Message send error: WebSocket not connected` log from the dashboard app session should be at debug level, not error. The dashboard is a best-effort display — failing to send when disconnected is expected behavior, not an error.

**D. Do NOT suppress errors for non-dashboard apps.** The `AppSession.send()` error logging in the SDK (`packages/sdk/src/app/session/index.ts` L1955) already distinguishes disconnect errors from real errors (the `isDisconnectError` check). This fix only changes the dashboard-specific callers.

#### Specified behavior (long-term — separate spec)

**E. Kill the dashboard mini app.** Rewrite `DashboardManager` to be a self-contained OS service. Move weather (OpenWeatherMap), notification summarization (LLM agent), calendar formatting, etc. from the mini app into the manager. Kill `SYSTEM_DASHBOARD_PACKAGE_NAME` and all its special-case routing. This will be specced separately once the mini app code is reviewed.

#### Acceptance criteria (short-term)

- Zero error-level log lines from the dashboard system when users are disconnected
- Dashboard updates resume within one interval tick (60s) after reconnect
- Non-dashboard app WebSocket errors still log at their current levels
- No change to the dashboard update frequency or content when connected

---

### Fix 5: MongoDB VersionError on `installedApps` Mutations

#### Problem

Multiple code paths modify `user.installedApps` concurrently:

- **Auto-install pre-installed apps** — runs on every `findOrCreateByEmail()` call (`user.model.ts` L601–633)
- **Auto-delete apps** — runs on every `findOrCreateByEmail()` call (`user.model.ts` L637–675)
- **Settings update → apply default wearable → set current model** — modifies `installedApps` as a side effect
- **Developer auto-install** — `developer.routes.ts`, `console.apps.service.ts`
- **Manual install/uninstall** — `user.model.ts` L296–315

All of these call `user.save()` which uses Mongoose optimistic concurrency (the `__v` field). When two paths read the same document version and both try to save, the second one gets `VersionError`.

From the spike: 45K VersionErrors in 4 hours. One document had version 18,897 — meaning ~19K successful saves. The error fires on nearly every settings/device state change when concurrent operations are touching `installedApps`.

**Two methods already have retry logic:** `removeRunningApp` (L340–373) and `updateAppLastActive` (L484–520) use a retry loop with exponential backoff. The `installedApps` mutation paths do not.

#### Specified behavior

**A. Add retry-on-VersionError to `installApp` and `uninstallApp`.** Follow the existing pattern from `removeRunningApp`:

```
1. Re-fetch fresh document: User.findOne({ _id: this._id })
2. Apply mutation to fresh document
3. Save
4. On VersionError: retry up to 3 times with exponential backoff (50ms, 100ms, 200ms)
```

**B. Use `$addToSet` and `$pull` atomic operations where possible.** Instead of:

```typescript
user.installedApps.push({ packageName, installedDate: new Date() });
await user.save();
```

Use:

```typescript
await User.updateOne(
  { "_id": user._id, "installedApps.packageName": { $ne: packageName } },
  { $push: { installedApps: { packageName, installedDate: new Date() } } },
);
```

This is an atomic MongoDB operation that doesn't require reading the document version. It eliminates the VersionError entirely for install/uninstall.

**C. Refactor auto-install and auto-delete in `findOrCreateByEmail` to use atomic operations.** The current code at L601–633 reads the user, pushes to the array, and saves. Convert to `$addToSet` for installs and `$pull` for deletes. This is the highest-volume mutation path (fires on every session creation).

**D. Add retry logic to the settings update path.** The call chain `updateUserSettings → applyDefaultWearable → setCurrentModel → modify installedApps` needs the same retry-on-VersionError pattern. This is the path identified in the spike's stack trace (L530, L172, L219, L148, L108).

**E. Log VersionError at warn level with user context.** The current errors don't include userId, making it impossible to correlate with specific users. Add `{ userId, email, packageName, attempt, maxRetries }` to the log context.

#### Acceptance criteria

- `installApp` and `uninstallApp` never throw `VersionError` to callers (retry internally)
- Auto-install and auto-delete in `findOrCreateByEmail` use atomic MongoDB operations (`$addToSet`, `$pull`)
- Settings update path retries on VersionError up to 3 times
- All VersionError retry logs include userId and packageName
- The 45K errors/4hr rate drops to near-zero under the same load

---

## Decision Log

| Decision                                                 | Alternatives considered                                                                                                           | Why we chose this                                                                                                                                                                                               |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cache app permissions in SubscriptionManager per session | (a) Query MongoDB every time, (b) global permission cache with TTL, (c) pre-load all permissions on session start | Per-session cache is simple, has no staleness issues within a session, and doesn't require a cache invalidation strategy. Global cache adds complexity for marginal benefit since permission changes are rare. |
| Keep previous UDP key for 2s grace window | (a) Mobile sends key-version header in UDP packets, (b) server keeps last N keys, (c) ignore — silence is acceptable | 2s grace window is server-only (no mobile change needed), covers the typical transition period, and has bounded memory cost. Key-version header requires mobile app update and UDP protocol change. |
| Add keepalive to SonioxSdkStream + auto-finalize on audio gap | (a) Do nothing (current — stream idles out), (b) add keepalive only, (c) keepalive + auto-finalize after silence gap | The old WS stream had keepalive every 15s; the SDK stream has none. Mentra Live glasses have on-device VAD that stops audio at the phone — cloud has no signal. Stream stays open but starved → Soniox times out. Keepalive prevents timeout; auto-finalize prevents garbled context when audio resumes after a gap. |
| Buffer audio during Soniox retry | (a) Accept the 5s gap, (b) send audio to Azure during Soniox retry, (c) buffer and replay | Buffering is simplest — no dual-provider complexity, no audio loss for short retries, and the 160KB memory cost is trivial. Dual-provider streaming adds significant complexity. |
| Short-term dashboard mitigation + long-term kill the mini app | (a) Only pause interval, (b) only downgrade logs, (c) pause interval now, kill mini app later (040 §5) | Pausing the interval stops the bleeding immediately. The real fix is killing the dashboard mini app entirely (040-cloud-v3-cleanup §5, §6) — the dashboard should be an OS service inside the cloud, not a separate app going through the SDK AppSession path. Separate spec once mini app code is reviewed. |
| Use `$addToSet`/`$pull` for installedApps | (a) Retry-on-VersionError only, (b) atomic ops only, (c) both | Atomic ops eliminate the race condition entirely for simple add/remove operations. Retry is still needed for complex mutations (settings path) where atomic ops aren't practical. Belt and suspenders. |
| 408 retries immediately without provider failover | (a) Treat 408 like rate limit (immediate Azure failover), (b) standard exponential backoff, (c) immediate retry, failover after 3 | 408 is transient — Soniox recovers quickly. Immediate failover to Azure wastes Azure credits and may have worse latency. Standard backoff adds unnecessary delay. 3-strike threshold catches persistent issues. |

## Priority Order

Implement in this order based on user impact:

1. **Fix 1 (Subscription permissions)** — highest user impact, causes complete data loss for affected apps
2. **Fix 2 (UDP key transition)** — affects every reconnect, audible silence gaps
3. **Fix 4 (Dashboard log spam)** — blocks effective error monitoring for all other fixes
4. **Fix 5 (MongoDB VersionError)** — silent data corruption, 45K errors/4hr
5. **Fix 3 (Soniox 408)** — lower priority because retry already works, but buffer improves UX

Fixes 1, 4, and 5 are independent and can be developed in parallel. Fix 2 is also independent. Fix 3's keepalive investigation (A, B) and audio gap detection (C) should be done first as they likely address the root cause; the retry/buffer improvements (D–H) are defense-in-depth.

**Note:** Fix 4's long-term solution (kill the dashboard mini app, rewrite `DashboardManager` as an OS service) is a larger refactor tracked under [040-cloud-v3-cleanup §5](../040-cloud-v3-cleanup/maintainability.md). It will be specced separately once the dashboard mini app code is reviewed. The short-term mitigation (A–D) stops the log spam immediately.
