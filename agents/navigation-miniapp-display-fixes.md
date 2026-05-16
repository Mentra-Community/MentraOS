# Navigation miniapp & local display pipeline — fixes

**Date:** 2026-04-30
**Author:** Aryan Farhang
**Branch:** `mentra-miniapp-sdk-aryan`

Everything here was driven by one user-visible symptom: text sent from the **Navigation miniapp** (`com.mentra.navigation`) via `session.display.showTextWall(...)` rendered correctly on **simulated glasses** but never reached **real Even Realities G2** glasses, and on graceful unmount the screen failed to clear (and once we fixed the clear, a stale frame flickered back).

Walking the bug down the pipe surfaced four real defects spanning the SDK, the mobile React-Native client, and the Android native bridge. This doc lists them in order of root cause.

---

## TL;DR

| # | Layer | Bug | Fix |
|---|---|---|---|
| 1 | RN ↔ native bridge | `undefined` field in display payload silently rejected by Expo `AsyncFunction` coercion | Omit `durationMs` from the bridge object when undefined |
| 2 | Mobile runtime | Display state not torn down when a miniapp's websocket dies | `LocalMiniappRuntime.unregisterApp` now calls `LocalDisplayManager.onUnmount` |
| 3 | SDK + mobile + miniapp | No graceful-shutdown channel — miniapp dispose couldn't flush a final `display.clear()` because the socket was already closed | New `WILL_DISCONNECT` protocol message + `beforeDisconnect` SDK event + `gracefullyUnregisterApp` 50ms grace window on mobile |
| 4 | Mobile display arbiter | Stale `coreAppDisplay` snapshot survived `onCoreAppChange(null)` and got restored on a subsequent unmount, causing a flicker | Null `coreAppDisplay` whenever the core app goes to null |

Bonus cleanup: removed a duplicate `localDisplayManager.onUnmount` call between `MiniappHost.unmount` and `LocalMiniappRuntime.unregisterApp` — without it, the snapshot restore was firing twice.

---

## How the pipe is supposed to work

```
Miniapp (WebView)                    Mobile (RN)                            Glasses
  │                                    │                                     │
  session.display.showTextWall("…")   │                                     │
  └─ DisplayModule.send  ────WS──▶  LocalMiniappRuntime.handleDisplay        │
                                       └─ LocalDisplayManager.request        │
                                            └─ arbitrateAndSend              │
                                                 └─ throttledSend → sendNow  │
                                                      └─ sendToNative        │
                                                           └─ CoreModule.    │
                                                              displayEvent ──┴─▶  CoreManager.displayEvent
                                                                                     └─ sendCurrentState
                                                                                          └─ sgc.sendTextWall(text)
```

There are arbitration / throttle / head-up gates at multiple layers; each one is a potential silent-drop.

---

## Bug 1 — `undefined` field rejected by the RN ↔ native bridge

### Symptom

System messages like `"Starting Navigation…"` (sent during boot via `LocalDisplayManager.onMount`) reached the glasses fine. Miniapp-initiated calls like `display.showTextWall("hello world")` produced a `LOCAL_DISPLAY: → CoreModule.displayEvent {…}` log — *but no corresponding `MAN: displayEvent ENTER` log* on the native side. The native function was never invoked.

### Root cause

`LocalDisplayManager.sendNow` built the payload as:

```ts
const rawEvent = {
  view: payload.view ?? "main",
  layout: payload.layout,
  durationMs: payload.durationMs,   // ← undefined for plain showTextWall
}
```

`CoreModule.displayEvent` is registered as an Expo `AsyncFunction("displayEvent") { params: Map<String, Any> -> ... }`. Expo strict-coerces `params`. When a top-level field is `undefined`, the bridge **rejects the promise without invoking the native function** — and because the call site is fire-and-forget, the rejection is silently swallowed.

The boot path (`onMount`) was never affected because it never set `durationMs`:

```ts
const bootEvent = { view: "main", layout: {layoutType: "text_wall", text: …} }
this.sendToNative(SYSTEM_BOOT_PKG, bootEvent, null)
```

### Fix

`mobile/src/services/LocalDisplayManager.ts` — only include `durationMs` when it has a value:

```ts
const rawEvent: Record<string, unknown> = {
  view: payload.view ?? "main",
  layout: payload.layout,
}
if (payload.durationMs !== undefined) {
  rawEvent.durationMs = payload.durationMs
}
```

### Diagnostic instrumentation that found it

Added `Bridge.log("MAN: displayEvent ENTER ...")` at the top of native `CoreManager.displayEvent` plus bail-reason logs inside `sendCurrentState`. The absence of the `ENTER` log for miniapp-originated calls — while the JS-side `→ CoreModule.displayEvent` log fired — pinpointed the bridge as the suspect. Logs are committed in `9b8dcf1ff`.

---

## Bug 2 — Display state leaked when a miniapp's websocket died

### Symptom

After Bug 1 was fixed, normal `showTextWall` worked, but when the miniapp navigated away or its WebView crashed, the glasses were left displaying stale text. The miniapp's own `User.dispose() → display.clear()` ran but never reached the phone.

### Root cause

`User.dispose()` calls `display.clear()` and then `session.disconnect()`. By the time it ran, the WebSocket was often already closed (HMR client `disconnected` fires before React's unmount completes). Inside `MiniappSession.enqueueOrSend`:

```ts
if (this.ready) { transport.send(raw) }
else { this.outboundQueue.push(raw) }   // queued, never flushed
```

The `clear_view` envelope landed in `outboundQueue` and was abandoned. Meanwhile, `LocalMiniappRuntime.unregisterApp` did not delegate to `LocalDisplayManager.onUnmount` — only `MiniappHost.unmount` did, and only on the React-host path. Ping-timeout / network-drop unregisters left the screen untouched.

### Fix

`mobile/src/services/LocalMiniappRuntime.ts` — `unregisterApp` now calls `localDisplayManager.onUnmount(packageName)` so *every* unregister path (graceful, ping timeout, runtime cleanup) clears the screen if the unmounting app owned the current frame.

`LocalDisplayManager.onUnmount` already had the right logic:

```ts
if (this.currentDisplay?.packageName === packageName) {
  this.currentDisplay = null
  this.tryRestoreCoreDisplay()
  if (!this.currentDisplay) this.sendClear()
}
```

It just wasn't being reached on every code path.

---

## Bug 3 — No graceful-disconnect channel; final messages were undeliverable

### Symptom

Even after Bug 2's fix made phone-side cleanup robust, miniapps still couldn't perform their *own* shutdown work (stop a navigation trip, release sensor leases, post a final status frame). Anything async-roundtripped (`session.sendRequest`) was dead on arrival — `disconnect()` ran `failAllPending` immediately and rejected every in-flight Promise with `REQUEST_ABORTED`.

### Root cause

The SDK only exposed `session.on("disconnect", …)` — fired *after* the transport closed. Too late to send anything. There was no signal between "phone decided to unregister this miniapp" and "transport gone."

### Fix — three coordinated changes

**SDK protocol**: add a phone→miniapp push.
`sdk/miniapp/src/protocol.ts`:
```ts
WILL_DISCONNECT = "miniapp_will_disconnect",
```

**SDK session**: add a `beforeDisconnect` event + public hook.
`sdk/miniapp/src/session.ts`:
- New `beforeDisconnect: (reason: string) => void` in `SessionEmitterEvents`.
- Emitted at the *top* of `disconnect()` (before `failAllPending` / `transport.close`).
- Emitted on inbound `WILL_DISCONNECT` from the phone.
- New public method `onBeforeDisconnect(handler)` — convenience wrapper.

```ts
this.session.onBeforeDisconnect((reason) => {
  // Synchronous sendOneShot still flushes through the open transport.
  this.display.clear()
})
```

The contract: **handlers are synchronous**. Any `sendOneShot` issued inside the handler can still flush; async work won't complete before the socket closes.

**Mobile runtime**: graceful unregister.
`mobile/src/services/LocalMiniappRuntime.ts`:
```ts
public async gracefullyUnregisterApp(packageName: string, reason = "unregistering"): Promise<void> {
  this.sendToMiniapp(packageName, {type: MiniappResponseType.WILL_DISCONNECT, reason})
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  this.unregisterApp(packageName)
}
```

50ms grace was chosen as imperceptible to humans but generous enough for the miniapp's `beforeDisconnect` handler to fire and one round-trip `sendOneShot` to land.

**MiniappHost**: switch the React-host unmount path to the graceful version. Sync teardown was previously ripping the WebView out before the heads-up could even round-trip.
`mobile/src/components/miniapp/MiniappHost.tsx`:
```ts
void localMiniappRuntime.gracefullyUnregisterApp(packageName, "miniapp unmounted").finally(() => {
  // … then tear down WebView, refs, etc.
})
```

The ungraceful paths (ping timeout, `cleanup()`) intentionally still call plain `unregisterApp` — sending `WILL_DISCONNECT` to a dead socket would be pointless, and Bug 2's fix already covers display cleanup for those cases.

### Wired into the Navigation miniapp

`sdk/Navigation/src/backend/session/User.ts` constructor registers the listener once at session start:

```ts
this.session.onBeforeDisconnect((reason) => {
  console.log("[User] beforeDisconnect:", reason, "— running dispose")
  this.dispose()
})
```

`User.dispose()` was already idempotent (`if (this.disposed) return`), so the recursion that occurs when `dispose()` calls `session.disconnect()` (which re-fires `beforeDisconnect`) is safe — the second invocation early-returns.

---

## Bug 4 — Stale snapshot flickered back after the user-initiated clear

### Symptom

After Bugs 1–3 were fixed, the unmount sequence cleared the glasses correctly… and ~30ms later the previous frame (`"go left"`) was redrawn, then nothing. A visible flicker.

### Root cause

`LocalDisplayManager` keeps a `coreAppDisplay` snapshot — the foreground app's last frame — so a transient toast from a background app can be replaced by the foreground app's content when the toast expires. Two related defects compounded:

1. **`onCoreAppChange(null)` only nulled `this.coreApp`, not `this.coreAppDisplay`.** When the user backed out of the miniapp the foreground state went null but the snapshot of `"go left"` survived in memory.

2. **`onUnmount` was being called twice** — once from `MiniappHost.unmount` directly, once from `LocalMiniappRuntime.unregisterApp` (the Bug 2 fix). Each call ran `tryRestoreCoreDisplay()`, and because of (1) the snapshot was still populated, so the previous frame was re-pushed — twice.

The trace in the logs:

```
LOCAL_DISPLAY: onCoreAppChange(null)             ← coreApp=null, coreAppDisplay still "go left"
LOCAL_MINIAPP: gracefullyUnregisterApp ... — sending WILL_DISCONNECT
LOCAL_DISPLAY: request ... clear_view            ← user clear
MAN: sendCurrentState dispatch layoutType=clear_view   ← ✅ glasses blank
LOCAL_MINIAPP: unregisterApp
LOCAL_DISPLAY: onUnmount                          ← first call
LOCAL_DISPLAY: → CoreModule.displayEvent ... text:"go left"   ← ❌ snapshot restored
LOCAL_DISPLAY: onUnmount                          ← duplicate call
LOCAL_DISPLAY: → CoreModule.displayEvent ... text:"go left"   ← restored again
```

### Fix

**`LocalDisplayManager.onCoreAppChange`**: when the core goes to null, drop the snapshot too — there's no app left to restore *for*.

```ts
if (packageName === null) {
  this.coreAppDisplay = null
}
```

**`MiniappHost.unmount`**: removed the duplicate `localDisplayManager.onUnmount(packageName)` call. The runtime path (`gracefullyUnregisterApp` → `unregisterApp` → `onUnmount`) is the single source of truth.

---

## Files changed (uncommitted)

```
mobile/src/components/miniapp/MiniappHost.tsx                        — drop dup onUnmount; use gracefullyUnregisterApp
mobile/src/services/LocalDisplayManager.ts                           — Bug 1 (undefined fix), Bug 4 (snapshot null on core-null)
mobile/src/services/LocalMiniappRuntime.ts                           — gracefullyUnregisterApp, Bug 2 onUnmount call in unregisterApp
sdk/Navigation/src/backend/hooks/useUser.ts                          — minor follow-on
sdk/Navigation/src/backend/session/User.ts                           — onBeforeDisconnect → dispose
sdk/Navigation/src/frontend/pages/NavigationPage/NavigationPage.tsx  — display.showText(...) HUD effect; "Send 'go left'" dev button
sdk/Navigation/src/frontend/pages/NavigationPage/components/NavMap/NavMap.tsx — UI tweaks
sdk/miniapp/src/protocol.ts                                          — WILL_DISCONNECT enum value
sdk/miniapp/src/session.ts                                           — beforeDisconnect event, onBeforeDisconnect API, emit sites
```

The SDK package was rebuilt (`bun run build` in `sdk/miniapp/`) and the freshly-built `dist/` was copied into `mobile/node_modules/@mentra/miniapp/dist/` so the mobile typechecker sees the new enum value.

## Earlier related commit

- `9b8dcf1ff fixed the display issue now` — landed the native + RN diagnostic logs and the `undefined durationMs` fix (Bug 1). The instrumentation was the lever that found Bug 1 in the first place; everything above grew from following the trail those logs opened up.

---

## How to verify end-to-end

```bash
cd mobile && bun android
```

In the Navigation miniapp on G2s:

1. **Send a frame** — open the Floating Dev Panel, tap **"🧪 Send 'go left' to glasses"**. Glasses should show "go left".
2. **Back out of the miniapp.** Glasses should clear and stay blank — no flicker.
3. **Tail logs while doing #1 and #2:**
   ```bash
   adb logcat | grep -E "LOCAL_DISPLAY|LOCAL_MINIAPP|MAN: displayEvent|MAN: sendCurrentState"
   ```

Expected unmount sequence:

```
LOCAL_DISPLAY: onCoreAppChange(null)                          ← also nulls coreAppDisplay now
LOCAL_MINIAPP: gracefullyUnregisterApp ... — sending WILL_DISCONNECT
LOCAL_DISPLAY: request ... clear_view ... isCore=false
LOCAL_DISPLAY: → CoreModule.displayEvent {... clear_view ...}
MAN: displayEvent ENTER view=main layoutType=clear_view
MAN: sendCurrentState dispatch layoutType=clear_view          ← glasses blank
LOCAL_MINIAPP: unregisterApp(com.mentra.navigation)
LOCAL_DISPLAY: onUnmount(com.mentra.navigation)               ← only ONE call
(no more "go left" re-pushes)
```

---

## Open follow-ups

- The `[User] navigation.stop during dispose failed: REQUEST_ABORTED` warning is harmless (the STOP message reached the phone before the abort; only the round-trip ack was rejected) but is noisy. Convert `dispose()`'s `navigation.stop()` to fire-and-forget or filter the abort code in the catch.
- The `NavigationPage` HUD effect at line 92-97 unconditionally pushes `"hello world "` while `running=false`. Currently dedupe on the native side hides this from the user, but if it's not the long-term placeholder it should be removed or moved into a one-shot transition.
- The `frontend error: "Script error."` line that appeared in the dev terminal once is unrelated to dispose — likely cross-origin scrubbing of a Maps SDK error. Worth a separate look only if it recurs.
