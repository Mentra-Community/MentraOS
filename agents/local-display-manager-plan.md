# Local Display Manager Plan

Branch: `mentra-miniapp-sdk`
Scope: phone-side only; local miniapp path only. Cloud path is untouched.

## Goal

Introduce a `LocalDisplayManager` on the phone that sits between `LocalMiniappRuntime.handleDisplay` and `CoreModule.displayEvent`, matching the user-facing behavior of the cloud `DisplayManager6.1.ts` for the features we actually want: boot message, throttle, duration expiry, and foreground arbitration. Fully isolated from cloud — during dev the two systems may race on the glasses; that's acceptable.

## Scope — in

1. Boot message on the glasses when a local miniapp starts ("Starting <AppName>…"), until it's ready (bounded).
2. Per-miniapp throttle (trailing-edge, ~300 ms like cloud).
3. `durationMs` auto-clear.
4. Core-app vs background-app arbitration, matching cloud semantics. Both can render; the core (foreground) app has priority, background apps can hold the display via a lock when the core app isn't actively showing. Not "drop background requests" — background requests render under the cloud-style rules.
5. Boot queue — display requests arriving during boot are held and only the latest per-app is replayed on boot complete.
6. A single display path for local miniapps: all display envelopes go through `LocalDisplayManager.request(...)`; nothing else calls `CoreModule.displayEvent` for local miniapps.
7. All timers use `BackgroundTimer` from `@/utils/timers` (established convention in this repo — `ThemeContext`, `DeeplinkContext`, `wifi/scan`, `check-for-updates`, etc.). `setTimeout`/`clearTimeout` on the JS timer queue are not used for boot, throttle, or expiry.

## Scope — out

- **Cloud coordination.** Do not try to arbitrate against cloud displays. If a local and cloud miniapp fight over the glasses during dev, last-write-wins at the native layer is fine.
- **Dashboard view.** Local dashboard rendering is currently a stub (`DASHBOARD_CONTENT_UPDATE → NOT_IMPLEMENTED` in `LocalMiniappRuntime.ts`). LocalDisplayManager should accept `view:"dashboard"` and pass it through to `CoreModule.displayEvent`/`useDisplayStore` unchanged, with no dashboard-specific throttle/queue logic. Dashboard is a separate future workstream.
- **Multi-device / capabilities.** Already handled upstream by `DisplayProcessor`; we reuse it, don't reimplement.
- **Onboarding gating.** Not relevant on the local path right now.

## Lifecycle signals we already have

From `mobile/src/components/miniapp/MiniappHost.tsx` and `mobile/src/services/LocalMiniappRuntime.ts`:

| Signal | Source | Use for |
|---|---|---|
| Mount started (`mount()` / `mountDev()` called) | `MiniappHost.setApps` | Start boot message |
| WebView `onLoadEnd` → `markLoaded()` sets `isLoaded:true` | `MiniappHost` line ~483 | First boot-ready signal |
| `CONNECT` envelope received, `CONNECT_ACK` replied | `LocalMiniappRuntime.handleConnect` ~484-512 | Strong "SDK is up" signal |
| `isForeground` flip | `MiniappHost` state | Arbitration |
| `unmount()` / terminate / error | `MiniappHost` ~195-212, ~359-382 | Clear boot state, clear display |
| First `DISPLAY` envelope from the miniapp | `LocalMiniappRuntime.handleDisplay` | Definitive "app wants to render" signal |

**Decision:** boot message shows from `mount()` until the **first of**: (a) miniapp sends its first `DISPLAY` envelope, (b) a hard timeout (1500 ms, mirroring cloud `BOOT_DURATION`). We do not wait for `CONNECT_ACK` alone — an app that connects but doesn't render yet should not leave stale boot text indefinitely, and an app that renders quickly without calling `connect()` first (unlikely but possible) shouldn't be blocked. "First display OR timeout" is the cleanest rule.

## Design

### File

- New: `mobile/src/services/LocalDisplayManager.ts` — singleton, same pattern as `LocalMiniappRuntime` and `MicStateCoordinator`.
- Change: `mobile/src/services/LocalMiniappRuntime.ts` `handleDisplay` (currently ~lines 667-707) stops calling `CoreModule.displayEvent`/`useDisplayStore` directly and calls `localDisplayManager.request(packageName, payload)` instead. `DisplayProcessor` still runs inside the manager (not at the runtime) so the manager sees unprocessed layouts and can re-wrap on device profile changes if ever needed.
- Change: `MiniappHost` notifies `localDisplayManager` of lifecycle transitions: `onMount(packageName)`, `onForegroundChange(packageName, isForeground)`, `onUnmount(packageName)`. No other mobile code should need to change.

### Public API (sketch, not final)

```ts
class LocalDisplayManager {
  // Lifecycle — called from MiniappHost
  onMount(packageName: string, displayName: string): void   // starts boot window; displayName used in boot message
  onCoreAppChange(packageName: string | null): void         // which app is the "core" (foreground) — mirrors cloud's mainApp
  onUnmount(packageName: string): void                      // clears boot, clears display if this app owned it, releases bg lock

  // Display — called from LocalMiniappRuntime.handleDisplay
  request(packageName: string, payload: DisplayPayload): void
}
```

### State (mirrors cloud DisplayManager6.1 naming where it maps 1:1)

- `coreApp: packageName | null` — the foreground/main miniapp (cloud calls this `mainApp`).
- `coreAppDisplay: {packageName, processedEvent, expiresAt} | null` — the core app's last display, restored when background apps stop holding the lock.
- `currentDisplay: {packageName, processedEvent, expiresAt} | null` — what's actually on the glasses right now.
- `backgroundLock: {packageName, acquiredAt, expiresAt, lastActiveTime} | null` — background app currently allowed to render. Cloud's rule: first background display acquires it; released on unmount, on lock expiry (lease-based), or when the core app preempts and the lock holder isn't actively displaying.
- `bootingApp: {packageName, displayName, startedAt} | null`
- `bootQueue: Map<packageName, DisplayPayload>` — requests captured during boot window (last-write-wins per app).
- `pendingThrottledByApp: Map<packageName, DisplayPayload>` — last request per app held during the 300 ms throttle window.
- Timer handles: `bootTimerId`, `throttleTimerId`, `expiryTimerId` — all `BackgroundTimer` ids.

### Request lifecycle

```
LocalDisplayManager.request(pkg, payload)
  if bootingApp:
    bootQueue.set(pkg, payload)
    if pkg === bootingApp.packageName → end boot early, then process bootQueue
    return
  route through arbitration (core vs background + throttle)
```

Arbitration on send, mirroring cloud `DisplayManager6.1`:

- **Core app request** (pkg === coreApp):
  - Save into `coreAppDisplay` so it can be restored later.
  - If a background app holds the lock and is currently displaying → blocked (stays saved; will surface when the bg app stops).
  - Otherwise send, and if the lock holder isn't actively on the glasses, release the lock.
- **Background app request** (pkg !== coreApp):
  - If `backgroundLock` is null or expired → acquire it for this app.
  - If another background app already holds the lock → blocked (log, no-op).
  - If this app holds the lock → bump `lastActiveTime`, send.

All "send" paths go through the throttle (trailing-edge, 300 ms):
- Leading edge: if no send in the last 300 ms, send immediately.
- Else: `pendingThrottledByApp.set(pkg, payload)`; on trailing timer fire, send the latest pending for whichever app won arbitration.
- A newer request from the same app replaces the pending one. Cloud does this per-app.

Send (the only place `CoreModule.displayEvent` is called on the local path):
```
const processed = displayProcessor.processDisplayEvent(rawEvent)
CoreModule.displayEvent(processed)
useDisplayStore.getState().setDisplayEvent(JSON.stringify(processed))
currentDisplay = {packageName, processedEvent, expiresAt: payload.durationMs ? now + durationMs : null}
if expiresAt → schedule expiry via BackgroundTimer
```

Expiry (per cloud semantics — applies to any app, core or background):
- On timer fire, if `currentDisplay.packageName` still owns it and `now >= expiresAt`:
  - If it was the core app, clear (no restore).
  - If it was a background app, try to restore `coreAppDisplay` if it still has remaining duration; otherwise clear.
- Background apps' expiries must run — they can render, so they get the same lifecycle as the core app.

Boot:
- `onMount(pkg, displayName)`:
  - Cancel any in-flight boot.
  - Build boot layout: `TEXT_WALL` with text `Starting ${displayName}…` (matches cloud's "starting" pattern, attributed to a reserved sentinel package name like `system.boot`).
  - Push it directly through send(), bypassing throttle and arbitration. (Boot is a system display; it is not a miniapp display.)
  - Start 1500 ms `BackgroundTimer`.
  - During the boot window: any `request()` for any app goes into `bootQueue`. A `request()` from `pkg` itself ends the boot early.
  - On boot end: clear `bootingApp`, drain `bootQueue` — core app first if queued (matches cloud line ~288-297), then any background apps per arbitration rules above.

### Resolved questions

1. **Boot content.** "Starting <AppName>…". Requires `MiniappHost` to pass the manifest display name into `onMount`. Read it from the manifest that `Composer` already resolves for the mount; plumb it through.
2. **MiniappHost → manager wiring.** Direct singleton import, same pattern as `LocalMiniappRuntime` and `MicStateCoordinator`. No callback parameter on `registerRuntime`.
3. **Background app expiry timers.** Yes, they run. Background apps can display; the lock + core-restore rules (above) handle the hand-off.

## Implementation steps

1. **Create `LocalDisplayManager.ts`** with the API above, state, throttle, boot, expiry, core/background arbitration. All timers use `BackgroundTimer` from `@/utils/timers`. Move the `DisplayProcessor.processDisplayEvent` + `CoreModule.displayEvent` + `useDisplayStore.setDisplayEvent` calls into its private `send()` — nothing else in the local path should call these.
2. **Update `LocalMiniappRuntime.handleDisplay`** (~line 667-707): remove direct processor/native/store calls, call `localDisplayManager.request(packageName, payload)`, keep the envelope validation and the `sendResult` reply.
3. **Wire lifecycle from `MiniappHost`**: call `localDisplayManager.onMount(pkg, displayName)` in `setApps` when a new app is added (pull displayName from the resolved manifest), `onCoreAppChange(pkg | null)` when the foreground app flips (core app = whichever is `isForeground`, or null if none), `onUnmount(pkg)` in `unmount` and the auto-unmount paths.
4. **Arbitration verification.** Mount two local miniapps, make one core and one background. Confirm: background can acquire the lock when core is idle; core preempts when the bg app stops displaying; only one background app at a time can hold the lock.
5. **Tests.** Unit-test the manager in isolation with a fake `BackgroundTimer` + mocked `CoreModule.displayEvent` and `DisplayProcessor`:
   - Boot shows "Starting <name>…" for up to 1500 ms; first request from that app ends it early; boot queue is drained core-first.
   - Throttle: 5 requests in 100 ms → 2 native calls (leading + trailing, last wins).
   - `durationMs`: display clears at the right time; a new request before expiry cancels the clear.
   - Core app request while background holds lock and is displaying → blocked; core surfaces when bg clears.
   - Background app request when no lock → acquires lock and renders; second bg app's request → blocked.
   - Core app expiry on the glasses while bg lock exists → bg holder can render; core returns when it issues a new request.
   - Unmounting the lock holder → lock released, coreAppDisplay restored if it still has duration.
   - Foreground flip carries over nothing (new core starts clean, old throttle pending for the previous core is dropped).
6. **Manual verification on device.** Mount `sdk/example-miniapp`, exercise `DisplayPage` with rapid-fire `showTextWall` and `durationMs` values. Confirm "Starting <AppName>…" appears briefly and clears on first render or at 1500 ms.

## Files touched

- New: `mobile/src/services/LocalDisplayManager.ts`
- Edit: `mobile/src/services/LocalMiniappRuntime.ts` (handleDisplay body)
- Edit: `mobile/src/components/miniapp/MiniappHost.tsx` (lifecycle notifications to the new manager)
- New: `mobile/src/services/__tests__/LocalDisplayManager.test.ts` (or wherever mobile unit tests live — verify convention before placing)

## Non-goals reminder

No cloud-path changes. No changes to `DisplayProcessor`, `display.ts` store shape, or `CoreModule` native bridge. No dashboard work. No previous-display restore stack.
