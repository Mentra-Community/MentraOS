# Developer Feedback Tickets — Leo (Camera/WHEP Mini App)

Each ticket below is ready to paste into Linear. The first line is the title, then the description body follows.

Suggested labels for all tickets: `dev-feedback`, `leo-camera-app`

**Context:** A developer (Leo / ryan3040@gmail.com) put dozens of hours into building a camera/recording mini app (`com.leo.glasses` — server-side WHEP consumer, ffmpeg pipeline) on the v2 SDK. He hit 11 issues, documented all of them, and told us he's pausing until we're ready.

---

## Ticket 1

SDK: Camera cleanup has no completion signal

When a session ends and a new one starts before the SDK finishes cleaning up the camera, `camera.startManagedStream()` throws `"Error: Camera module cleanup."` There is no callback, polling API, or documentation to detect when cleanup is done.

37 occurrences on a single user account.

The only workaround is arbitrary retry delays with exponential backoff — which is a guess, not a solution.

### Root cause

`CameraManager.destroy()` clears local state synchronously (pending promises, event listeners, boolean flags) but does NOT send a `MANAGED_STREAM_STOP` message to the cloud. The cloud-side stream is orphaned. There is no `onCleanupComplete()` callback or `isReady()` promise anywhere in the SDK.

### Fix

Add one or both of:

- `camera.onCleanupComplete(callback)` — fires when the camera is ready for the next session
- `camera.isReady()` — returns a Promise that resolves when cleanup is done

The cloud side also needs to handle orphaned streams from destroyed sessions — either via a keep-alive timeout or explicit cleanup on session dispose.

### Code pointers

- `cloud/packages/sdk/src/session/managers/CameraManager.ts` — `destroy()` (L731-763)
- `cloud/packages/sdk/src/app/session/modules/camera-managed-extension.ts` — V2 equivalent
- Cloud-side stream lifecycle: grep for `MANAGED_STREAM_STOP` in `cloud/packages/cloud/src/`
- Prior art: `cloud/issues/085-orphaned-stream-cleanup/`

### Acceptance criteria

- [ ] A developer can start a new managed stream after a session ends without retry loops
- [ ] The SDK either exposes a readiness signal or handles the race internally
- [ ] Cloud-side orphaned streams are cleaned up

---

## Ticket 2

SDK: EPIPE crash on session teardown kills entire server

Calling `session.camera.stopManagedStream()` inside `onStop()` — exactly as the SDK instructs — throws an unhandled EPIPE because the SDK has already closed the WebSocket before the developer can run cleanup. This crashes the entire Node.js process. Not just the session that ended — every active session dies.

The developer's workaround was a global `process.on('uncaughtException')` handler. No production app should need that because of an SDK bug.

### Root cause

The V2 `AppSession.send()` checks `ws.readyState` and throws if not OPEN (L2056-2062). The WebSocket is already closed by the time `onStop()` fires. The throw becomes an unhandled exception at the OS level (EPIPE on the underlying socket write) and kills the process.

The V3 `WebSocketTransport.send()` silently drops messages on a closed socket (L87-95) — this is the correct behavior, but V2 doesn't have it.

### Fix

1. The SDK must not close the WebSocket until after `onStop()` completes (or `send()` must never throw on a closed socket)
2. `stopManagedStream()` called on a closed connection should resolve gracefully, not throw

### Code pointers

- `cloud/packages/sdk/src/app/session/index.ts` — `send()` (L2056-2062), throws on non-OPEN WS
- `cloud/packages/sdk/src/transport/WebSocketTransport.ts` — V3 `send()` (L87-95), correctly silent
- `cloud/packages/sdk/src/session/managers/CameraManager.ts` — `stopStream()` (L389-406)
- Prior art: `cloud/issues/070-soniox-timeout-crash/` (global unhandledRejection handler)

### Acceptance criteria

- [ ] Calling `stopManagedStream()` in `onStop()` never crashes the server
- [ ] Works in both V2 and V3 SDK paths

---

## Ticket 3

SDK: Duplicate 'active' events fired on managed stream start

`camera.onManagedStreamStatus()` fires with `status: 'active'` multiple times for a single stream activation. Without a developer-side guard, this spawns multiple WHEP connections and multiple ffmpeg processes writing to the same files — corrupting recordings.

### Root cause

`CameraManager.handleManagedStreamStatus()` always emits to event listeners at L689 — there is no "has status changed?" guard. The pending promise is only resolved once (because `pendingManagedStreamRequest` is nulled after the first resolve), but `onManagedStreamStatus()` / `onStreamStatus()` listeners fire on every duplicate from the cloud.

### Fix

One-line guard: before emitting `managed_stream_status`, compare against `this.managedStreamStatus`. If the status hasn't changed, don't emit.

### Code pointers

- `cloud/packages/sdk/src/session/managers/CameraManager.ts` — `handleManagedStreamStatus()` (L655-689), emits unconditionally at L689
- `cloud/packages/sdk/src/app/session/modules/camera-managed-extension.ts` — V2 equivalent, same pattern

### Acceptance criteria

- [ ] `onStreamStatus()` / `onManagedStreamStatus()` fires exactly once per status transition
- [ ] Duplicate `active` messages from the cloud are suppressed by the SDK

---

## Ticket 4

SDK: onSession() webhook timeout is undocumented

The `onSession()` handler is awaited by the SDK with no documented time limit. The cloud's webhook caller has its own HTTP timeout (~5-30 seconds). If a developer's startup logic takes longer — which starting a managed WebRTC stream routinely does — the cloud times out and the phone shows "Can't connect."

The SDK examples show synchronous-looking patterns that lead developers directly into this trap. There is no mention of any timeout anywhere in the documentation.

### Root cause

In `MiniAppServer`, the webhook handler does `await this.onSession(session, sessionId, userId)` (L740-751) with no `Promise.race`, no `setTimeout` wrapper. The base implementation is a no-op. The cloud webhook caller has its own HTTP timeout, so a slow `onSession()` causes the cloud to see a failed webhook even though session setup is in progress.

### Fix

1. **Document the timeout.** Explicitly state: "Your `onSession()` handler must return within N seconds. Move slow setup (stream initialization, ffmpeg startup) to a background task after `onSession()` returns."
2. **Consider responding to the webhook immediately** and running `onSession()` asynchronously so the cloud gets its 200 OK regardless of setup duration.

### Code pointers

- `cloud/packages/sdk/src/app/server/index.ts` — webhook handler (L740-751)
- Cloud-side webhook caller: `cloud/packages/cloud/src/services/core/app.service.ts`
- SDK docs: `docs/app-devs/getting-started/quickstart.mdx`

### Acceptance criteria

- [ ] The timeout is documented with a clear recommended pattern
- [ ] Ideally the SDK handles it internally so developers don't need to know

---

## Ticket 5

Docs: WHEP has three undocumented hard requirements

Server-side WHEP stream consumption requires all three of the following. None are documented:

1. **Full ICE gathering must complete** (`iceGatheringState === 'complete'`) before sending the SDP offer. Sending earlier causes silent failure.
2. **`Accept: application/sdp` header is required** in the POST request. Omitting it causes rejection with no useful error.
3. **The stream URL is session-scoped** and changes on every glasses connect. A stale URL returns `409 Conflict: "Live broadcast not started yet"` — with no indication the URL needs to be re-fetched from each new `onActive` callback.

Each is a silent failure with a cryptic error. Each one cost the developer hours.

### Fix

Add a "Server-Side WHEP Consumption" guide to the SDK docs covering:

- Complete WHEP flow with code example
- ICE gathering: must wait for `complete` state
- Required HTTP headers
- URL lifecycle: re-fetch from every stream status callback
- Common error codes and what they mean (409, missing header, ICE failure)

### Code pointers

- WHEP endpoint: grep for `whep` in `cloud/packages/cloud/src/`
- Cloudflare Stream integration: grep for `cloudflare` and `stream` in `cloud/packages/cloud/src/`
- Prior art: `cloud/issues/087-managed-stream-status-not-delivered-on-reconnect/`
- Docs directory: `docs/app-devs/`

### Acceptance criteria

- [ ] A developer can implement server-side WHEP consumption by following the documentation without trial and error
- [ ] All three requirements are documented with code examples
- [ ] Common error codes are listed with causes and fixes

---

## Ticket 6

Developer Console: "Use custom URL" toggle does not persist

The "Use custom URL" toggle in the developer console resets to OFF every time the page is saved and reloaded. The custom URL field continues to show the URL text even when the toggle is OFF — giving false confidence the configuration is active when it isn't.

### Root cause (confirmed)

There is no `useCustomUrl` boolean persisted on the backend. The toggle state is derived by comparing the saved `webviewURL` against a computed default (`${publicUrl}/webview`). The save handler auto-fills the default URL when the custom URL field is empty — so after a round-trip, the saved value always matches the default, and the toggle shows OFF.

The bug is in the submit handler in both `EditMiniApp.tsx` (L486-498) and `CreateMiniApp.tsx` (~L249): when the toggle is OFF, `webviewURL` is set to `""`, then the save logic fills it with the default `${publicUrl}/webview`. On reload, the derived check sees `value === defaultUrl` → toggle OFF.

### Fix

**Minimal (no backend change):** Stop auto-filling the default URL at save time. Remove the fallback logic in `EditMiniApp.tsx` and `CreateMiniApp.tsx` that fills `webviewURL` with `${publicUrl}/webview` when it's empty. Let the client compute the default at runtime if `webviewURL` is missing.

**Proper:** Add a `useCustomWebviewUrl: boolean` field to the app model so the toggle state is explicit.

### Code pointers

- `cloud/websites/console/src/pages/EditMiniApp.tsx` — save handler (L486-498)
- `cloud/websites/console/src/pages/CreateMiniApp.tsx` — same pattern (~L249)
- `cloud/websites/console/src/components/forms/WebviewUrlToggle.tsx` — toggle derivation (L59-61)
- Backend model: grep for `webviewURL` in `cloud/packages/cloud/src/models/`

### Acceptance criteria

- [ ] Toggle ON → enter URL → save → reload → toggle is ON with the URL
- [ ] Toggle OFF → save → reload → toggle is OFF

---

## Ticket 7

Docs: @roamhq/wrtc silently fails on Node 22 / Linux

On Linux with Node 22, `@roamhq/wrtc` installs without error but `RTCVideoSink` and `RTCAudioSink` return `undefined` — the native bindings fail silently. The package only works on Node 18-20. Any developer building server-side WebRTC on Linux hits this immediately with zero indication of why.

### Fix

Add to the WebRTC / WHEP documentation:

- **Required:** Node 18 or 20 for server-side `@roamhq/wrtc` on Linux
- Node 22 installs cleanly but native bindings fail silently at runtime
- Recommend specific known-working versions

### Code pointers

- Docs: `docs/app-devs/`
- Example apps: `docs/app-devs/getting-started/example-apps.mdx`

### Acceptance criteria

- [ ] Node version requirement is documented in the WebRTC/WHEP guide
- [ ] Known-working version combinations are listed

---

## Ticket 8

Cloud: False 1008 disconnect — "not connected to WiFi" when glasses are connected

WebSocket closed with code 1008: `"Cannot process stream request — smart glasses are not connected."`

This happened while the glasses were on a dedicated WiFi hotspot that never dropped. The glasses were connected. The cloud decided they weren't and killed the session. The error message blames the user for a platform-side failure.

1008 is "Policy Violation" — the server actively rejected the connection. The SDK provides no recovery path for 1008 closures.

### Fix

1. Investigate what condition triggers the "smart glasses are not connected" check — glasses WebSocket state? heartbeat? something else?
2. Add tolerance for transient connectivity gaps (glasses WS briefly drops during WiFi handoff but is back within seconds)
3. Log the actual glasses WS state at the moment the cloud decides to kill the stream

### Code pointers

- Grep for `"not connected"` and `"smart glasses"` and `1008` in `cloud/packages/cloud/src/`
- WS liveness system: `cloud/issues/034-ws-liveness/`
- Close code reference: `cloud/tools/bstack/runbooks/client-disconnect.md`
- Related: Aryan's WS Liveness Error Codes work may overlap

### Acceptance criteria

- [ ] The cloud does not kill streams based on transient glasses connectivity gaps
- [ ] 1008 only fires when glasses are genuinely gone (powered off, BLE disconnected >30s)
- [ ] Glasses WS state is logged when stream requests are rejected

---

## Ticket 9

Docs: DNS resolution failure for Cloudflare Stream subdomains under Tailscale

Under Tailscale DNS, the Cloudflare Stream subdomain (`customer-*.cloudflarestream.com`) fails to resolve — making managed stream startup impossible. The developer needed an explicit Google DNS override at runtime to fix it. The platform's dependency on Cloudflare Stream subdomains is not documented.

### Fix

Add to streaming/WHEP documentation:

- The platform depends on Cloudflare Stream subdomains for managed streams
- Known DNS resolution issues with custom resolvers (Tailscale, corporate VPNs, Pi-hole)
- Workaround: explicit DNS override to `8.8.8.8` or `1.1.1.1`

### Code pointers

- Cloudflare Stream integration: grep for `cloudflarestream` in `cloud/packages/cloud/src/`
- Managed stream flow: `cloud/packages/sdk/src/session/managers/CameraManager.ts`

### Acceptance criteria

- [ ] DNS dependency is documented
- [ ] Workaround for non-standard DNS is included

---

## Ticket 10

Cloud: Spontaneous disconnect reported as "user_disabled" — wrong reason code

Sessions terminate spontaneously and the platform reports the reason as `user_disabled` — even when the user did nothing. The Mentra app was open and foregrounded. The glasses were on and connected. No action was taken. The platform killed the session and blamed the user.

This breaks auto-recovery logic. When the SDK says `user_disabled`, a developer suppresses reconnect attempts — because the user asked to stop. If that reason code fires erroneously on platform-side drops, auto-recovery never triggers when it should.

### Root cause

`user_disabled` is set in `app.service.ts` → `triggerStopByPackageName()` (L215-221). This is the ONLY place this reason is set. The method constructs a `sessionId` from `${userId}-${packageName}` when no explicit sessionId is given — this fallback format could mismatch actual session IDs. There is also no guard against calling `triggerStopByPackageName` when the app isn't actually running.

Valid reasons in the type system are: `user_disabled | system_stop | error`. There is no reason code for "the platform killed your session but the user didn't ask for it."

### Fix

1. Audit every call site of `triggerStopByPackageName()` — ensure it's only called on explicit user action (phone UI "stop app" button)
2. If the cloud kills a session for any other reason (timeout, pod restart, glasses disconnect), use `system_stop` or `error`, not `user_disabled`
3. Consider adding a `platform_disconnect` reason code for drops that aren't user-initiated and aren't errors

### Code pointers

- `cloud/packages/cloud/src/services/core/app.service.ts` — `triggerStopByPackageName()` (L215-221)
- `cloud/packages/sdk/src/types/webhooks.ts` — `StopWebhookRequest` (L58-61)
- Related: Aryan's WS Liveness Error Codes work covers the same session lifecycle clarity

### Acceptance criteria

- [ ] `user_disabled` only fires on explicit user action
- [ ] Platform-caused drops use a distinct reason code
- [ ] Developers can reliably distinguish "user stopped the app" from "platform killed the session"

---

## Ticket 11

SDK: No local development or sandbox mode

There is no way to test the SDK without physical glasses on your face. No emulator, no mock server, no CLI test client. Every code change requires: rebuild → restart → put glasses on → open phone app → wait for connection → observe → take glasses off → read logs.

### Options

1. **Mock glasses client** — a CLI or script that simulates a glasses connection, sends fake audio/camera data, and receives display updates. Developers run it alongside their mini app server.
2. **`mentra dev` command** — wraps ngrok + mock client so a developer goes from code change to testing with zero hardware.
3. **Test harness** — programmatic API for integration tests: create a fake session, send events, assert on responses.

### Related work

- `mentra init` and `mentra dev` commands are already in the backlog
- Cloud testing plan: `cloud/issues/999-cloud-plan/plans/cloud-testing.md`
- Testing plan spike: OS-1267
- CLI: `cloud/packages/cli/`

### Acceptance criteria

- [ ] A developer can make a code change and test it without putting on glasses
- [ ] At minimum: a mock client that sends fake audio and displays received text

---

## Suggested priority order

If we're trying to win Leo back, this is the sequence that matters:

**Week 1 — Stop the bleeding (crashes and silent failures):**

1. Ticket 2 — EPIPE crash (his server literally dies)
2. Ticket 4 — Document onSession timeout (hours lost to invisible failure)
3. Ticket 1 — Camera cleanup signal (37 occurrences, core to his app)

**Week 2 — Make WHEP work:** 4. Ticket 5 — Document WHEP hard requirements (blocks every WHEP developer) 5. Ticket 3 — Deduplicate active events (one-line fix, corrupted recordings) 6. Ticket 7 — Document Node version requirement (one paragraph, saves hours)

**Week 3 — Platform trust:** 7. Ticket 10 — Fix user_disabled reason code (breaks auto-recovery) 8. Ticket 8 — False 1008 disconnects (platform blamed user incorrectly) 9. Ticket 6 — Fix custom URL toggle (console credibility) 10. Ticket 9 — Document DNS dependency (one paragraph)

**Later:** 11. Ticket 11 — Local dev / sandbox mode (large scope, already in backlog)

---

## Overlap with existing work

| Ticket  | Existing item                                      | Notes                                                                                                                              |
| ------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1, 2, 3 | SDK v3 Testing (OS-1262)                           | V3 CameraManager has the same issues. V3 silently drops instead of crashing (2) but still doesn't clean up (1) or deduplicate (3). |
| 4       | SDK v3 Ship (048)                                  | Timeout needs documenting regardless of version. Consider fixing in webhook handler for v3.                                        |
| 5, 7, 9 | SDK Documentation backlog                          | Pure docs. Can be done by anyone with WHEP knowledge.                                                                              |
| 6       | Developer Console                                  | Standalone fix. Root cause already identified.                                                                                     |
| 8       | WS Liveness Error Codes (Aryan)                    | Aryan's liveness work may address the root cause.                                                                                  |
| 10      | WS Liveness Error Codes (Aryan)                    | `user_disabled` vs `system_stop` is part of the session lifecycle clarity Aryan is working on.                                     |
| 11      | Cloud Testing Plan (OS-1267), `mentra dev` backlog | Feeds into testing infrastructure.                                                                                                 |
