# Spike: Cloud Prod Error Storm

## Overview

**What this doc covers:** Investigation into elevated error rates on cloud-prod and a user-reported incident where transcription, microphone, and miniapp launch all failed simultaneously. Includes system-wide error breakdowns from BetterStack telemetry, per-user timeline reconstruction, root cause analysis for each failure mode, and concrete numbers on how many users are affected.

**Why this doc exists:** On 2026-03-04, user `israelov+test2022@mentra.glass` filed three back-to-back severity-5 bug reports: (1) Mentra AI not getting transcripts despite PCM data flowing, (2) loud static noise from microphone/recorder, (3) can't start miniapps. Parallel investigation revealed system-wide error rates of ~2,500 errors/minute across 229 active users, with 50.7% of users hitting transcription failures.

**Who should read this:** Cloud team, mobile team, anyone debugging prod reliability. No cloud-specific knowledge assumed — each failure mode is explained from scratch.

## Background

### How audio and transcription flow

```
Glasses → (BLE) → Phone → (WebSocket) → Cloud Pod
                                           ├── UdpAudioManager (receives encrypted UDP audio)
                                           ├── AudioManager (decodes LC3 → PCM)
                                           ├── TranscriptionManager (PCM → Soniox SDK → text)
                                           └── AppManager (delivers transcripts to apps via WebSocket)
```

Each glasses connection gets a **symmetric encryption key** for UDP audio. On reconnect, the server generates a **new key** and sends it in the CONNECTION_ACK. Old UDP packets encrypted with the previous key arrive during the handover window.

### How app subscriptions work

Apps declare what data they want (transcription, audio, location, etc.) via subscription updates. The cloud's `SubscriptionManager` validates permissions and routes data accordingly. If an app's subscriptions are **rejected** (missing permissions), it receives no data. During reconnection, there's a **grace window** where empty subscription updates are ignored to prevent premature teardown — but this doesn't cover all race conditions (see [008-subscription-race-condition](../008-subscription-race-condition/)).

### How the dashboard app works

`system.augmentos.dashboard` is an always-on system app that pushes UI updates to the glasses via WebSocket. It runs on a 60-second scheduled update loop. If the user's WebSocket is closed, every update attempt generates 3 error log lines (message send error + dashboard update error + session error).

## Findings

### 1. System-wide error rates: ~2,500/min, five dominant patterns

Queried BetterStack for the last 4 hours (15:00–19:00 UTC, 2026-03-04). **229 distinct active users** connected during this window.

| Error pattern                                 | Count (4hr) | % of errors | Affected users             | Root cause                               |
| --------------------------------------------- | ----------- | ----------- | -------------------------- | ---------------------------------------- |
| Dashboard WebSocket CLOSED                    | 236,950     | 48.8%       | Most users                 | Dashboard pushes to disconnected users   |
| MongoDB VersionError (installedApps)          | 44,997      | 9.3%        | Unknown (no userId logged) | Concurrent auto-install/auto-delete race |
| HTTP 503 (no session found)                   | 15,821      | 3.3%        | Many                       | Requests arrive before session ready     |
| Soniox SDK stream error                       | 13,755      | 2.8%        | 116 (50.7%)                | Soniox 408 timeouts                      |
| GOOGLE_WEATHER_API_KEY missing                | 5,207       | 1.1%        | 1 (cemart@gmail.com)       | Missing env var                          |
| App connection timeout (5s)                   | 1,101       | 0.2%        | Several                    | App WebSocket handshake too slow         |
| Dashboard reconnection failed                 | 966         | 0.2%        | Several                    | Connection timeout after WS drop         |
| WebSocket error (generic)                     | 951         | 0.2%        | Several                    | Various WS failures                      |
| Dashboard WS connection failed (Expected 101) | 827         | 0.2%        | Several                    | WS upgrade rejected                      |
| Stream creation failed (no provider)          | 298         | 0.06%       | Several                    | All transcription providers down         |
| Non-retryable transcription error             | 289         | 0.06%       | Several                    | Soniox gave up permanently               |

**Total: ~486K errors in 4 hours.** The dashboard WebSocket CLOSED error alone accounts for nearly half — it's a log noise amplifier, not a user-facing failure.

### 2. Glasses WebSocket disconnects: 97.8% of users affected

**Important clarification:** "Glasses WebSocket" is the **Phone → Cloud** WebSocket connection (`/glasses-ws`), not the BLE link between glasses and phone. The phone opens a persistent WebSocket to the cloud and proxies all glasses data over it. When this connection drops, BLE between glasses and phone may be perfectly healthy — the break is between the phone and the cloud server.

```
224 of 229 active users experienced at least 1 Phone→Cloud WS disconnect in 4 hours
3,518 total disconnects → average 15.7 per user (roughly 1 every 15 min)
```

Top disconnectors:

| User                                      | Disconnects (4hr) | Rate     |
| ----------------------------------------- | ----------------- | -------- |
| 2xb5fcgjtv@privaterelay.appleid.com       | 230               | ~1/min   |
| nathanskim113@gmail.com                   | 158               | ~1/90s   |
| zi12121ster@gmail.com                     | 154               | ~1/90s   |
| matt@mentra.glass (internal)              | 133               | ~2/min   |
| israelov+test2022@mentra.glass (reporter) | 12                | ~1/20min |

The reporter's 12 disconnects are actually below average. The issue isn't that they disconnect _more_ — it's that the **cascading failures on each disconnect** are severe enough to break the entire experience.

Likely disconnect causes (none involve BLE):

- **iOS backgrounding** — iOS suspends the app when not in foreground, killing the TCP WebSocket
- **Network transitions** — WiFi ↔ cellular handoffs drop the TCP connection
- **Cloudflare/nginx proxy timeouts** — issues [034-ws-liveness](../034-ws-liveness/) and [035-nginx-ws-timeout](../035-nginx-ws-timeout/) already addressed this on dev; unclear if deployed to prod
- **Server-side pod restarts** — Kubernetes rolling updates or scaling events

### 3. Soniox transcription: 408 timeouts hitting 50.7% of users

Every Soniox error in the last hour has this shape:

```
{
  "error": {
    "name": "NetworkError",
    "code": "network_error",
    "statusCode": 408,
    "message": "Audio data decode timeout"  // or "Request timeout."
  }
}
```

These are **Soniox-side timeouts** — the Soniox service is returning 408 when it can't decode audio data in time or the request takes too long. The system retries (successfully most of the time), but during the retry window (~5 seconds), no transcription flows to apps.

Soniox errors per 15-minute bucket have been **increasing through the day**:

```
07:00 UTC — ~470/15min (morning baseline)
12:00 UTC — ~530/15min
15:00 UTC — ~800/15min
17:30 UTC — ~1,096/15min (peak)
19:00 UTC — ~900/15min (current)
```

This roughly tracks user count growth through the day, suggesting it may be **load-related** rather than a Soniox outage. The retry mechanism works — streams reconnect in 140ms–2.8s — but during the gap, apps get nothing.

### 4. The reporter's failure cascade (reconstructed timeline)

Full timeline for `israelov+test2022@mentra.glass` from 18:50–19:07 UTC, reconstructed from BetterStack logs:

**18:50–18:51** — Normal operation. UDP audio stats flowing, dashboard updates running.

**18:52:02** — `Glasses WebSocket closed`. Connection drops.

- Soniox stream errors (audio feed cut)
- `Default provider not available` → falls back to Soniox (same provider, different path)
- Soniox reconnects after 5s: `🚀 STREAM CREATED: [SONIOX] for "transcription:en-US" (148ms)`
- **But:** `Display request not sent - DisplayManager is not ready` (8 rapid occurrences) — dashboard can't render because glasses aren't connected

**18:52:23** — Glasses reconnect. New encryption key generated.

- `Decryption failed - invalid data or wrong key` — **old UDP packets arrive with previous key → garbled audio → STATIC NOISE** ← Bug Report #2
- Connection re-established, mic resync'd, LC3 decoder re-initialized

**18:52:33** — Glasses WebSocket closed again (10 seconds after reconnect). Cycle repeats.

**18:52:52** — Reconnects again. Same `Decryption failed` warnings. Another disconnect at 18:52:58 (6 seconds).

**18:53–18:56** — More disconnect/reconnect cycles. Each one:

1. Generates new encryption key (old packets = static)
2. Triggers Soniox stream error + retry
3. DisplayManager never reaches ready state
4. Dashboard connection timeout errors

**18:56:31** — `requireUserSession: No active session found` → HTTP 503 for location and device state updates. The session was torn down between disconnect cycles.

**18:56:17** — `Connection timeout after 5000ms` for dashboard. `Reconnection failed for user israelov+test2022@mentra.glass` ← Bug Report #3 (can't start miniapps — dashboard/display system is down)

**19:06:48** — The critical moment:

1. `com.mentra.ai` sends subscription update with 11 subscriptions
2. `Rejected subscriptions due to missing permissions` ← **Subscriptions rejected**
3. `All subscriptions cleared` for com.mentra.ai
4. `No active subscriptions - all streams cleaned up`
5. `Receiving unauthorized audio (no subscriptions) - forcing mic off immediately`
6. `Failed to send transcription data to App com.mentra.ai` ← Bug Report #1

**19:06:53** — `com.mentra.recorder` sends subscription update, gets accepted. Recorder starts working but `com.mentra.ai` is still locked out.

**19:06:57** — Another Soniox stream error → retry → success within seconds. `com.mentra.recorder` gets transcription: _"Test, test, test. One, two, three. This is a test, and it seems to work fine."_

So the recorder worked because its subscriptions were accepted. The AI app didn't because its permissions were rejected during the reconnect window.

### 5. UDP encryption key mismatch → static audio

On every glasses reconnect, `UdpAudioManager` generates a new symmetric encryption key:

```
UDP encryption initialized - symmetric key generated
```

But UDP packets are fire-and-forget. Packets sent with the **old key** arrive after the new key is active, and the server logs:

```
Decryption failed - invalid data or wrong key
```

These failed-to-decrypt packets either produce silence or garbage PCM data depending on how the decryption failure is handled downstream. The user hears this as **loud static noise** in the recorder miniapp.

This happens on **every single reconnect** for **every user**. With an average of 15.7 reconnects per user per 4 hours, that's a lot of static noise windows.

### 6. Subscription permission rejection during reconnect

At 19:06:48, `com.mentra.ai` tried to subscribe to transcription and got `Rejected subscriptions due to missing permissions`. This is the **direct cause** of Bug Report #1 ("AI not getting transcripts").

The rejection cleared all of com.mentra.ai's subscriptions, which caused:

- `No active subscriptions - all streams cleaned up`
- `Receiving unauthorized audio (no subscriptions) - forcing mic off immediately`

Meanwhile, `com.mentra.recorder` (which reconnected ~4 seconds later) had its subscriptions accepted and worked fine. This suggests a **timing-dependent permission check** during the reconnect grace window — similar to the race condition documented in [008-subscription-race-condition](../008-subscription-race-condition/).

### 7. MongoDB VersionError storm: 45K in 4 hours

The auto-install/auto-delete app logic modifies the user document's `installedApps` array. With optimistic concurrency control (Mongoose versioning), concurrent modifications fail:

```
VersionError: No matching document found for id "68a861078312887239b622fb"
  version 18897 modifiedPaths "installedApps"
    at user.model.js:530
    at DeviceManager.js:172 (setCurrentModel)
    at UserSettingsManager.js:219 (applyDefaultWearable)
    at UserSettingsManager.js:148 (onSettingsUpdatedViaRest)
    at user-settings.api.js:108 (updateUserSettings)
```

The call chain: settings update → apply default wearable → set current model → modify `installedApps` → **version conflict**. This fires on nearly every settings/device state change when other concurrent operations (auto-install, auto-delete) are also touching `installedApps`.

Note: version 18,897 on a single document means this document has been modified ~19K times. This is likely a heavily-used test account or a document that gets hit by every user's auto-install cycle.

### 8. Dashboard error amplifier: 237K errors from a fundamentally broken pattern

The dashboard update system (`system.augmentos.dashboard`) runs on a 60-second interval for every user. When a user's WebSocket is closed (which happens to 97.8% of users), each update cycle generates **3 error lines**:

1. `Message send error: WebSocket not connected (current state: CLOSED)`
2. `❌ Error updating dashboard sections for user X`
3. `❌ [Session X-system.augmentos.dashboard] Error:`

With ~224 users having at least some disconnected time, and the dashboard ticking every 60 seconds, this generates **massive log noise** — 237K errors in 4 hours. These aren't user-facing failures (the user is already disconnected), but they:

- Inflate error metrics, making real problems harder to spot
- Consume log ingestion budget (BetterStack has 7-day retention on this source)
- Make dashboards/alerts useless if you can't filter them out

### 9. Protocol mismatch: `device_state_update` not recognized

The dashboard app session handler doesn't recognize `device_state_update` messages:

```
Unrecognized message type: device_state_update
Unrecognized message type: capabilities_update
Unrecognized message type: request_telemetry
```

These are newer message types that the dashboard session handler hasn't been updated to handle (or explicitly ignore). Not a functional problem — they're warnings — but they contribute to the noise.

### 10. Root cause found: released mobile app doesn't respond to server pings

The `cloud/sdk-hono` branch deploys to `cloud-debug`. The `main` branch deploys to `cloud-prod`. Both have the 034/035 WS liveness fixes (app-level pings every 2s, `PONG_TIMEOUT_ENABLED = false`, nginx proxy timeouts set to 3600s). Prod was redeployed Mar 2 (2 days ago), not stale.

|                           | cloud-debug      | cloud-prod                |
| ------------------------- | ---------------- | ------------------------- |
| Branch                    | `cloud/sdk-hono` | `main`                    |
| Last deploy               | Mar 3            | Mar 2                     |
| Active users (4hr window) | 1                | 229                       |
| WS disconnects (session)  | **0**            | **3,518** (avg 15.7/user) |
| Soniox errors             | 39 (in 17 min)   | 13,755 (in 4 hr)          |

**The debug connection has been stable for 17+ minutes with zero disconnects.** Meanwhile, prod averages one disconnect every 15 minutes per user.

#### Close codes on prod (last 4 hours)

| Code | Count       | Meaning                                                                                                                      |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1006 | 1,952 (60%) | **Abnormal closure** — TCP connection died without a WebSocket close handshake. Cloudflare killed the connection.            |
| 1000 | 1,294 (40%) | **Normal closure** — phone initiated a clean close. Likely the mobile liveness monitor (on dev builds) or iOS backgrounding. |

#### The smoking gun: released mobile app v2.6.0 doesn't send pongs

Checked the mobile client code on `main` (the branch the released app is built from) vs `cloud/sdk-hono` (the branch the debug user runs):

|                            | `main` (released app v2.6.0) | `cloud/sdk-hono` (debug user)                             |
| -------------------------- | ---------------------------- | --------------------------------------------------------- |
| `WebSocketManager.ts`      | 223 lines                    | 331 lines                                                 |
| Liveness monitor           | ❌ **Missing**               | ✅ `startLivenessMonitor()`, 4s timeout                   |
| `lastMessageTime` tracking | ❌ **Missing**               | ✅ Reset on every `onmessage`                             |
| `handle_ping` → send pong  | ❌ **Missing**               | ✅ `SocketComms.handle_ping()` sends `{"type":"pong"}`    |
| `detachAndCloseSocket()`   | ❌ **Missing**               | ✅ Nulls handlers before close to prevent stale `onclose` |

The server sends `{"type":"ping"}` every 2 seconds to the client. On `cloud/sdk-hono`, the client responds with `{"type":"pong"}` via `SocketComms.handle_ping()`. On `main`, the client **silently ignores the ping** — there is no ping handler. No pong is sent back.

This means the traffic flow on prod is:

```
Server → Client: {"type":"ping"} every 2s  ✅ (keeps server→client direction alive)
Client → Server: NOTHING after audio moved to UDP  ❌
```

**Cloudflare has a 100-second idle timeout on WebSocket connections.** It tracks idle time bidirectionally. With no client→server traffic, Cloudflare kills the connection after ~100 seconds with no close frame — producing close code **1006 (abnormal closure)**.

This perfectly explains:

- **Why 60% of disconnects are 1006** — Cloudflare TCP-resets the connection after 100s of client→server silence
- **Why debug works (0 disconnects)** — the debug user runs a mobile build from `cloud/sdk-hono` which sends pongs
- **Why prod fails (865 disconnects/hr)** — all prod users run v2.6.0 from `main` which never sends pongs
- **Why the 034/035 server-side fixes didn't help** — server pings keep the server→client direction alive, but without client pongs, the client→server direction goes idle and Cloudflare kills it

The 1000 (normal closure) codes (40%) are likely iOS backgrounding or user-initiated disconnects — these are expected and less concerning.

#### Commit `f005ec7f8` (last night) — not yet deployed to either server

The latest commit on `cloud/sdk-hono` adds two things, but the `[app-ping]` diagnostic logs don't appear in debug telemetry, confirming **the commit hasn't been deployed yet**:

1. **Stale WebSocket close guard** (`bun-websocket.ts`) — when a close event fires for an old WebSocket that's already been replaced by a newer reconnect, ignore it instead of marking the session as disconnected. This prevents a race where:
   - User reconnects → new WS assigned
   - Old WS close event fires AFTER new WS is active
   - Without guard: old close event tears down the new session's state
   - With guard: old close event is silently ignored

2. **App-level ping diagnostics** (`UserSession.ts`) — logs the first 3 pings per session with `send()` return value, plus skip reasons.

#### Soniox errors are independent of WS disconnects

On debug, with a **perfectly stable connection** (0 disconnects), the single user still sees Soniox errors every ~25 seconds — the exact same `408 Audio data decode timeout` pattern as prod. This confirms Soniox stream instability is a **separate problem**, not just a side effect of the disconnect cycle. It may be related to audio quality, Soniox infrastructure, or how we feed audio to the Soniox SDK.

#### Prod crash note

The Porter UI shows "The service exited with a non-zero exit code" on Mar 2 at 6:39 PM, ~2 hours after the deploy. No fatal/crash-specific logs found in BetterStack around that time. Log volume shows a minor dip but no total blackout — Porter likely auto-recovered. Worth monitoring but not the root cause of the disconnect storm.

## Conclusions

### Severity assessment

| Problem                                  | User impact                               | Scale                              | Fix complexity                                                                                 |
| ---------------------------------------- | ----------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| Soniox 408 timeouts                      | Transcription gaps (5s per retry)         | 50.7% of users                     | Low (retry works, but investigate Soniox load)                                                 |
| UDP key mismatch on reconnect            | Static audio noise                        | Every reconnect for every user     | Medium (need key transition window or packet discard)                                          |
| Subscription permission rejection        | App loses all data (transcription, audio) | Timing-dependent, any user         | Medium (permission check race in reconnect path)                                               |
| MongoDB VersionError                     | App install state corrupted silently      | Every settings/device state change | Medium (need retry-on-conflict or atomic updates)                                              |
| Dashboard WS CLOSED spam                 | Log noise, obscures real errors           | 237K errors/4hr                    | Low (check WS state before attempting send)                                                    |
| Glasses WS disconnect rate (Phone→Cloud) | Everything above cascades from this       | 97.8% of users, avg 1/15min        | **Low — root cause identified** (mobile app doesn't send pongs → Cloudflare 100s idle timeout) |

### What's urgent

1. **Merge the mobile-side ping/pong handler into `main`** — this is the single highest-impact fix. The `handle_ping` function in `SocketComms.ts` and the liveness monitor in `WebSocketManager.ts` exist on `cloud/sdk-hono` but not `main`. Without client pongs, Cloudflare kills every connection after ~100 seconds of client→server silence. This is the root cause of ~60% of all disconnects, which cascade into every other problem in this doc.

2. **The subscription permission rejection** is the most impactful user-facing bug after disconnects — it completely kills an app's data access with no recovery until the next reconnect. This is likely the same class of bug as [008-subscription-race-condition](../008-subscription-race-condition/) which was documented but not fully shipped.

3. **The UDP encryption key mismatch** causes audible static on every reconnect. With reconnects happening every 15 minutes on average, users hear static regularly.

4. **The Soniox 408 rate** (increasing through the day) could become a bigger problem as user count grows. The retry mechanism works but the 5-second gap is noticeable.

### What can wait

4. **Dashboard WS CLOSED spam** — pure log noise, not user-facing. But it should be fixed to make error monitoring useful.

5. **MongoDB VersionErrors** — causes silent data corruption (wrong installed apps list) but doesn't crash anything. Should be fixed with retry logic.

6. **Glasses WS disconnect rate** — **Root cause found.** The released mobile app (v2.6.0, built from `main`) does not respond to server-sent `{"type":"ping"}` messages. The `handle_ping` handler and liveness monitor exist on `cloud/sdk-hono` but were never merged to `main`. Without client→server pong traffic, Cloudflare's 100-second idle timeout kills every connection. This is proven by debug (which has pong handling) having 0 disconnects vs prod having 865/hour.

## Next Steps

- [ ] **🔴 Merge mobile ping/pong handler to `main` and release** — cherry-pick `handle_ping` from `SocketComms.ts` (sends `{"type":"pong"}` on server ping) and the `WebSocketManager.ts` liveness monitor (`startLivenessMonitor`, `stopLivenessMonitor`, `detachAndCloseSocket`, `lastMessageTime` tracking) from `cloud/sdk-hono` into the release branch. This is the single fix that will eliminate ~60% of all disconnects (the 1006 codes) and dramatically reduce the cascading failures.
- [ ] **Deploy the stale WS close guard to prod** — merge `f005ec7f8`'s `bun-websocket.ts` guard into `main`. This prevents old close events from corrupting reconnected sessions during the remaining 40% of disconnects (iOS backgrounding, etc).
- [ ] Spec for subscription permission check fix during reconnect (builds on 008)
- [ ] Spec for UDP encryption key transition (discard packets with old key instead of decrypting to garbage)
- [ ] Investigate Soniox 408 rate — confirmed independent of WS disconnects (happens on debug with stable connection too). Likely audio quality or Soniox infra.
- [ ] Fix dashboard update to check WebSocket state before sending (trivial)
- [ ] Add retry-on-VersionError for `installedApps` mutations
