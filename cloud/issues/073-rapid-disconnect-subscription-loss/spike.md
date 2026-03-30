# Spike: Rapid Disconnect Subscription Loss — Translation/Captions Failure

## Overview

**What this doc covers:** Investigation of a real user incident where captions/translation stopped working due to rapid WebSocket disconnects that prevented subscriptions from being re-established. User `cayden@mentra.glass` experienced 4 disconnects in 4 minutes on March 30, 2026 at ~16:18-16:23 UTC, each killing the active translation stream. The reconnect grace window logic (`Ignoring empty subscription update within reconnect grace window`) combined with mic state drift (`forcing mic off`) created a failure loop where translation could never stabilize.
**Why this doc exists:** This is a different disconnect pattern from the "client went silent for 30+ seconds" pattern we documented in issue 066. Cayden's `timeSinceLastClientMessage` was only 1-2 seconds before each 1006 close — the client was actively communicating right before the connection died. This suggests either Cloudflare killing the connection, a mobile app bug, or a network condition that causes rapid drops even while data is flowing. The user impact is severe — apps restart on every reconnect but subscriptions don't re-establish, so captions/translation silently stop.
**Who should read this:** Cloud engineers, mobile engineers, anyone working on app lifecycle or translation/transcription streams.

**Depends on:**

- [066-ws-disconnect-churn](../066-ws-disconnect-churn/) — client-side disconnect investigation, liveness monitor disabled
- [069-ws-disconnect-observability](../069-ws-disconnect-observability/) — the instrumentation that captured this incident
- [034-ws-liveness](../034-ws-liveness/) — server app-level pings, reconnect grace window

---

## Background

When a user's glasses WebSocket disconnects and reconnects within the 60-second grace period, `createOrReconnect()` reuses the existing session. Apps that were running enter a "resurrection" flow — they get new webhooks, reconnect their app WebSockets, and re-establish subscriptions.

The problem: during this resurrection, there's a **reconnect grace window** where the AppSession ignores empty subscription updates. This is designed to prevent apps from losing their subscriptions during a brief reconnect. But if the app sends an empty subscription update during this window (which happens on fresh connect before the app sets up handlers), the update is silently dropped. The app thinks it has no subscriptions. The server thinks it has subscriptions from the previous session. The mic sends audio, but the translation subscription isn't active, so the server forces the mic off.

---

## Findings

### 1. Cayden's timeline (March 30, 16:18-16:23 UTC)

| Time     | Event                                   | Detail                                                                                                               |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 16:18:43 | Translation started                     | `com.mentra.translation` connected in 220ms, Soniox stream created (`en-US-to-ja-JP`), stream ready. **Working.**    |
| 16:19:11 | **Disconnect #1**                       | Code 1006, `timeSinceLastClientMessage: 1857ms`. Client was active 2 seconds ago.                                    |
| 16:19:14 | DashboardManager/MicrophoneManager fail | "Cannot send — WebSocket not open." Display and mic state lost.                                                      |
| 16:19:35 | Translation app restarts                | Reconnects, but `Ignoring empty subscription update within reconnect grace window`.                                  |
| 16:20:17 | **Mic forced off**                      | "Receiving unauthorized audio (no subscriptions) — forcing mic off immediately." Audio stops flowing to translation. |
| 16:20:23 | **Disconnect #2**                       | Code 1006, `timeSinceLastClientMessage: 2015ms`. Another quick death.                                                |
| 16:20:32 | Translation restarts again              | Same pattern — subscription ignored during grace window.                                                             |
| 16:22:11 | **Disconnect #3**                       | Code 1000 (clean close), `timeSinceLastClientMessage: 1174ms`. Session 16,541s old, reconnect #3.                    |
| 16:22:12 | Apps try to resurrect                   | `com.mentra.mentraai.beta2` and `com.augmentos.calendarreminder` not found (deleted/renamed apps).                   |
| 16:22:28 | **Mic state drift**                     | "Mic marked disabled but receiving audio — state drift detected, forcing resync."                                    |
| 16:22:41 | **Disconnect #4**                       | Code 1006, session only **30 seconds old**. Fresh session died almost immediately.                                   |
| 16:23:11 | **Session disposed**                    | Grace period expired. Cayden is gone.                                                                                |

### 2. This is NOT the typical "client went dark" pattern

Comparing to the issue 066 pattern:

| Metric                             | Typical 066 pattern                | Cayden's pattern                    |
| ---------------------------------- | ---------------------------------- | ----------------------------------- |
| `timeSinceLastClientMessage`       | 10,000-140,000ms (10s-2min)        | **1,174-2,015ms (1-2s)**            |
| Close code                         | 1006 (always)                      | 1006 and 1000 (mixed)               |
| Session duration before disconnect | 70-180 seconds                     | 30 seconds to 4.5 hours             |
| Reconnect count                    | 0-3                                | **4 in 4 minutes**                  |
| Client was actively communicating? | No — went silent long before death | **Yes — active 1-2 seconds before** |

The short `timeSinceLastClientMessage` (1-2 seconds) means the client was actively sending data right before the connection died. The server didn't cause this — it was sending pings every 2 seconds and the client was responding. Something killed the TCP connection while data was actively flowing.

### 3. The subscription loss chain

The actual failure that makes translation stop:

```
Disconnect → Reconnect → App resurrection via webhook
  → App connects to app-ws → Sends empty subscription update (fresh state)
  → AppSession: "Ignoring empty subscription update within reconnect grace window"
  → App thinks: "I have no subscriptions" (correct from app's perspective)
  → Server thinks: "App has old subscriptions" (stale from previous connection)
  → Mic sends audio → Server checks subscriptions → "No active subscription for translation"
  → Server: "Receiving unauthorized audio — forcing mic off"
  → Translation stream gets no audio → Captions stop
```

The grace window is designed to protect against losing subscriptions during a brief blip. But it creates a worse problem: the app's empty subscription update (which is the app's honest state after a fresh connect) gets silently dropped, causing a subscription mismatch.

### 4. The "App not found" errors

During reconnect #3:

- `com.mentra.mentraai.beta2` — not found
- `com.augmentos.calendarreminder` — not found

These are apps that were previously running but their packages no longer exist (renamed, deleted, or moved). The resurrection logic tries to restart them and fails. This is harmless but noisy — should be downgraded from `error` to `warn`.

### 5. Possible causes of the rapid 1006 with short silence

| Cause                                                        | Likelihood | Evidence                                                                                                                           |
| ------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare killing the connection**                        | Medium     | The connection dies while data is flowing — not a client timeout. Cloudflare may be rotating connections or hitting a rate limit.  |
| **Mobile app WebSocket implementation bug**                  | Medium     | React Native's WebSocket API on iOS can drop connections during background/foreground transitions, even if the app appears active. |
| **Network condition (cell tower handoff during active use)** | Medium     | User was actively using translation — possibly walking, driving, or on unstable WiFi.                                              |
| **nginx ingress closing connection**                         | Low        | Our proxy timeouts are 3600s. No reason to close an active connection.                                                             |
| **Server-side event loop block**                             | Low        | `timeSinceLastClientMessage` was only 1-2 seconds, and zero event loop gaps were detected.                                         |

---

## The User Impact

This is what the user experiences:

1. Translation/captions are working fine
2. Suddenly, captions disappear — no error message, no notification
3. The app appears to be "running" (it reconnected, the UI shows it's active)
4. But nothing is being transcribed/translated
5. User has to manually stop and restart the app to fix it
6. If disconnects keep happening, the cycle repeats every 1-2 minutes

This is the "apps stopped working but look like they're running" complaint that users report. It's not that the app crashed — it's that the subscription state got corrupted during reconnection.

---

## Conclusions

| Finding                                                                                     | Confidence                                                                                   |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Translation stopped because subscription was silently dropped during reconnect grace window | **Confirmed** — logs show `Ignoring empty subscription update` followed by `forcing mic off` |
| Cayden's disconnects were rapid (4 in 4 minutes) with short client silence (1-2 seconds)    | **Confirmed** — ws-close logs from issue 069 observability                                   |
| The client was actively communicating before each disconnect                                | **Confirmed** — `timeSinceLastClientMessage` was 1-2 seconds, not 30+ seconds                |
| The reconnect grace window logic can cause subscription mismatch                            | **Confirmed** — empty subscription update dropped, server retains stale subscriptions        |
| Mic forced off due to "unauthorized audio" is the proximate cause of translation failure    | **Confirmed** — log at 16:20:17                                                              |
| Server was healthy (zero gaps, GC normal, budget low)                                       | **Confirmed** — diagnostics during the incident                                              |

---

## Recommendations

### 1. Fix the subscription grace window logic

The grace window should NOT ignore empty subscription updates indefinitely. Options:

- **Accept the empty update after a short delay** (e.g., 2 seconds after reconnect). If the app hasn't sent a real subscription update by then, the empty one is intentional.
- **Clear stale subscriptions on app reconnect** instead of preserving them. If the app needs subscriptions, it will re-register them.
- **Send the app's previous subscriptions in the CONNECTION_ACK** so the app can decide whether to keep them or clear them.

### 2. Investigate the rapid 1006 with short silence

This is a different disconnect pattern from issue 066. The 1-2 second silence suggests the connection is being killed externally (Cloudflare, network, or OS) while data is actively flowing. Need to:

- Check if this pattern correlates with specific iOS versions or phone models
- Check if it happens on WiFi vs cellular
- Check Cloudflare analytics for connection terminations from their side
- Check if the mobile app has any background/foreground transition logic that could kill the WebSocket

### 3. Don't force mic off on subscription mismatch

Instead of "forcing mic off immediately" when receiving audio without subscriptions, consider:

- Keeping the mic on for a grace period (e.g., 5 seconds) to allow subscriptions to re-establish
- Logging a warning but not taking action for the first N occurrences
- Checking if the session just reconnected — if so, wait for subscription setup

### 4. Clean up "App not found" errors

`com.mentra.mentraai.beta2` and `com.augmentos.calendarreminder` should not be in the resurrection list if they no longer exist. Either:

- Remove deleted apps from the `previouslyRunningApps` list on session reconnect
- Validate app existence before attempting resurrection
- Downgrade "App not found during resurrection" from `error` to `warn`

---

## Next Steps

1. File a spec for the subscription grace window fix (highest impact — directly causes the user-facing failure)
2. Investigate the rapid-disconnect pattern with the mobile team (different root cause from 066)
3. Add a `bstack` command or query for finding users with this specific pattern (rapid disconnects + subscription loss + mic forced off)
4. Consider adding a `feature: "subscription-mismatch"` log event when the server detects stale subscriptions after reconnect
