# Spike: Mobile WebSocket Reconnect Storm (Real Root Cause)

## Overview

**What this doc covers:** Deep root-cause investigation of why some mobile clients enter a WebSocket reconnect loop at ~90 opens per minute on the dev-channel / v2.10 build. Traces the storm to one small, specific bug: `WebSocketManager.this.url` is only assigned inside `connect()` and is never updated when the `backend_url` Zustand setting changes. Axios reads `backend_url` live on every request (via `getRestUrl()`), so REST calls immediately follow a backend change. The WebSocket does not. It reconnects to `this.url`, which is whatever URL the WS was originally connected to. When these diverge, every REST call returns 503 `NO_ACTIVE_SESSION` from the new backend (which doesn't have the session) while the WS keeps reconnecting to the old backend (which does). Combined with PR #2565's retry-on-503 loop, this turns into a self-sustaining 90-opens-per-minute storm that one phone can drive for as long as the divergence persists.

**Why this doc exists:** On 2026-04-21 one client (`isaiahballah@gmail.com`, reproducer) drove **1,910 WebSocket opens in 22 minutes** (~87/minute sustained) after changing the backend URL in dev settings. The server recorded 24 REST 503s in a single 1.2-second window across three endpoints, interleaved with 3 full WS reconnect cycles. Initial investigation blamed Cloudflare LB cookie mismatch between REST and WS. That hypothesis was proved wrong by source-reading the React Native WebSocket polyfills (both iOS `NSHTTPCookieStorage sharedHTTPCookieStorage` and Android `ForwardingCookieHandler` share the HTTP cookie jar with axios, so CF affinity cookies ARE carried on the WS handshake). The real cause is simpler and more actionable: a single stale variable in the mobile client.

**Who should read this:** Mobile engineers (primary), cloud engineers, SRE, anyone triaging the cloud OOM incidents. This identifies a one-line-category bug that explains the observed behavior end-to-end.

**Depends on:**

- [099](../099-glasses-connection-state-storm/): the downstream REST-side device-state storm. Amplified by the issue identified here.
- PR #2565 (`dirty-pod-alignment-fix`, merged into `dev` 2026-04-16, tagged v2.10): introduced the retry-on-503 code path that turns this bug into a reconnect storm. Current production code on the app stores.

---

## The Problem In One Sentence

`WebSocketManager.url` is only ever assigned inside `connect()`, so it becomes stale the moment Zustand's `backend_url` setting changes; axios picks up the new URL instantly via `getRestUrl()`, while any subsequent WebSocket reconnect goes back to the stale URL. And when REST and WS land on different backends, the retry-on-503 loop from PR #2565 reopens the WS against the wrong URL forever at ~90 cycles per minute.

---

## Architecture Background You Need First

### There are many `*api.mentra.glass` hostnames, each a different deployment

Observed in production log data:

```
Region label        → hostname (mobile app targets)
us-central          → api.mentra.glass (via Cloudflare LB) + uscentralapi.mentra.glass (direct)
us-central-staging  → stagingapi.mentraglass.com
us-central-dev      → devapi.mentra.glass
us-central-debug    → debug.augmentos.cloud
france              → franceapi.mentra.glass
asiaeast            → asiaeastapi.mentra.glass
us-west             → uswestapi.mentra.glass / uswestapi.mentraglass.com
us-east             → useastapi.mentra.glass
```

Several of these DNS-resolve to the **same IP** (e.g. `128.203.164.18`) because they're different Porter deployments on the same Kubernetes cluster, distinguished only by Host header. From the client's perspective they're different servers: different Kubernetes pods, different in-memory `UserSession` maps, different BetterStack `region` labels.

### Each pod has its own in-memory `UserSession` map

`cloud/packages/cloud/src/services/session/UserSession.ts` L52:

```typescript
export class UserSession {
  private static sessions: Map<string, UserSession> = new Map();
  // ...
}
```

Not replicated across pods. When REST middleware calls `UserSession.getById(userId)` and the pod has no entry, the middleware returns 503 `NO_ACTIVE_SESSION` (`cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts` L172).

A session is created the first time a user's WebSocket lands on a pod. Disposed 60 s after the last WebSocket close (grace period). Between WS close and disposal, REST still works (the session is "disconnected" but still in the map).

### The mobile client has one `backend_url` setting used by both REST and WS

`mobile/src/stores/settings.ts` defines `SETTINGS.backend_url` with `saveOnServer: false, persist: true`. Helpers:

```typescript
getRestUrl: () => {
  const serverUrl = get().getSetting(SETTINGS.backend_url.key)
  const url = new URL(serverUrl)
  const secure = url.protocol === "https:"
  return `${secure ? "https" : "http"}://${url.hostname}:${url.port || (secure ? 443 : 80)}`
},
getWsUrl: () => {
  const serverUrl = get().getSetting(SETTINGS.backend_url.key)
  const url = new URL(serverUrl)
  const secure = url.protocol === "https:"
  return `${secure ? "wss" : "ws"}://${url.hostname}:${url.port || (secure ? 443 : 80)}/glasses-ws`
},
```

Both are derived from the same setting. They should always agree.

### Axios reads the backend URL live per request; WSM caches it

`mobile/src/services/RestComms.ts` L80–L98:

```typescript
private makeRequest<T>(config: RequestConfig): AsyncResult<T, Error> {
  const baseUrl = useSettingsStore.getState().getRestUrl()   // ← fresh read per call
  const url = `${baseUrl}${endpoint}`
  // ...
}
```

`mobile/src/services/WebSocketManager.ts` L102–L112:

```typescript
public connect(url: string, coreToken: string) {
  console.log(`WSM: connect: ${url}`)
  this.manuallyDisconnected = false
  this.url = url                  // ← cached, only written here
  this.coreToken = coreToken
  // ... opens a new WebSocket to `url` ...
}

// Later, `reconnectNow` uses this.url:
private reconnectNow(reason: string) {
  // ...
  if (this.url && this.coreToken) {
    this.connect(this.url, this.coreToken)    // ← reconnects to cached URL
    return
  }
}
```

`this.url` is written in `connect()` and read by `reconnectNow()`. No setter, no subscription to the settings store. If `backend_url` Zustand changes without a subsequent call to `connect(newUrl, ...)`, `this.url` keeps pointing at the old backend for the lifetime of the process.

### PR #2565 added a retry-on-503 that drives the WS reconnect

From `mobile/src/services/RestComms.ts` on `dev`:

```typescript
return Res.try_async(async () => {
  try {
    const res = await this.axiosInstance.request<T>(axiosConfig);
    return res.data;
  } catch (error) {
    if (!this.isNoActiveSessionError(error)) {
      throw error;
    }
    const waitPromise = this.waitForNextConnected(8_000);
    GlobalEventEmitter.emit("NO_ACTIVE_SESSION"); // ← triggers WSM.reconnectNow
    try {
      await waitPromise;
    } catch (waitErr) {
      throw error;
    }
    const retryRes = await this.axiosInstance.request<T>({ ...axiosConfig, headers: retryHeaders });
    return retryRes.data;
  }
});
```

And `mobile/src/services/WebSocketManager.ts` listens:

```typescript
private constructor() {
  super()
  GlobalEventEmitter.on("NO_ACTIVE_SESSION", this.handleNoActiveSession)
}

private handleNoActiveSession = () => {
  if (this.previousStatus === WebSocketStatus.CONNECTING) return
  this.reconnectNow("REST request returned NO_ACTIVE_SESSION")
}
```

Intent: reconnect the WS on the assumption that the new connection will land on the pod that owns this user's session. Works correctly when REST and WS share the same backend URL. **Does not** notice that `this.url` is stale.

---

## Evidence And Trace

### The reproducer triggered the bug at 20:38:49 UTC

From BetterStack, for `isaiahballah@gmail.com` on 2026-04-21:

Before 20:38:49 , everything on `us-central` (prod):

```
20:37:33  us-central  WS upgrade, session #1 created
20:37:33  us-central  POST /api/client/user/settings  200
20:37:33  us-central  POST /api/client/device/state   200
20:37:35  us-central  GET  /api/client/apps           200
20:38:35  us-central  POST /api/client/user/settings  200
```

At 20:38:49, something (a settings write) changed `backend_url` to a dev-pointing URL:

```
20:38:49  us-central-dev  POST /api/client/user/settings  200  ← new URL landed here
```

That POST went through without 503 because `user/settings` doesn't require a session (it uses a different middleware). But immediately afterwards:

```
20:38:55.117  us-central-dev  GET  /api/client/apps          503 NO_ACTIVE_SESSION
20:38:55.206  us-central      WS CLOSED code=1000, silent=1446ms, session=82s, reconnects=0
20:38:55.520  us-central      WS REOPENED (!) , reconnect #1 lands on us-central again
20:38:55.521  us-central      UDP encryption ACK sent
20:38:55.664  us-central-dev  GET  /api/client/apps          503 ← still hitting dev, still no session there
20:38:55.666  us-central-dev  POST /api/client/device/state  503
20:38:55.748  us-central      WS CLOSED again (retry-on-503 fired again)
```

**The WS close at 20:38:55.206 was triggered by the 503-retry loop at 20:38:55.117. The reopen at 20:38:55.520 went back to `us-central` because `wsManager.url` still held the prod URL.** Every subsequent cycle repeats this:

- REST goes to `us-central-dev` (read from fresh Zustand) → 503
- `NO_ACTIVE_SESSION` event fires
- `reconnectNow()` runs → closes the WS, calls `connect(this.url, ...)` with the stale prod URL
- WS reopens on `us-central` → CONNECTED
- `WebsocketStatus.useEffect` fires `refreshApplets()` → REST goes to `us-central-dev` → 503
- Repeat

From 20:38:55 onward, this cycle ran at ~500–700 ms intervals for the next 22 minutes. Each cycle is one full WS tear-down and handshake plus 3–5 REST 503s. Total: **1,910 WS opens / 22 min** before the reproducer stopped.

### The cloud side shows no overlap: it is a clean sequential loop

Server-side logs: close code is **1000 (clean client-initiated)**, `session=207s` and climbing (the cloud's `UserSession` on `us-central` has been alive for 207+ seconds and just keeps getting its WS reconnected), `reconnects=225, 226, 227` on consecutive closes. The cloud never disposed this session. The user was never actually offline for more than the ~500 ms handshake gap. **The cloud has no idea anything is wrong on the prod pod. It just keeps servicing reconnects.**

The 503s are coming from a **different pod** (`us-central-dev`) that also has this user's JWT (same auth secret across deployments) but no matching in-memory `UserSession`. From the cloud's perspective this looks like a user who is well-connected to one deployment and also randomly hammering another deployment from a different pod. Nothing flags it as a single client with mis-aligned URLs.

### The alternative hypothesis (CF cookie mismatch) was checked and rejected

Earlier investigation hypothesized that the `__cflb` Cloudflare LB session-affinity cookie travels with axios but not with the React Native WebSocket, causing CF to route REST and WS to different pods. Verified by reading:

- `mobile/node_modules/react-native/Libraries/WebSocket/WebSocket.js` L148 , delegates to native module with `{headers}` option.
- `mobile/node_modules/react-native/ReactAndroid/.../WebSocketModule.kt` L94–L96 , Android: reads cookies via `ForwardingCookieHandler.get(url)` and adds `Cookie` header to the upgrade.
- `mobile/node_modules/react-native/React/CoreModules/RCTWebSocketModule.mm` L82–L83 , iOS: reads `NSHTTPCookieStorage sharedHTTPCookieStorage` and attaches cookies to the upgrade request.

Both platforms share the HTTP cookie jar with axios. The CF `__cflb` cookie, if set during REST calls, is carried on subsequent WS upgrades. CF affinity aligns REST and WS. That hypothesis does not explain the observed behavior.

More importantly, the reproducer's divergence is between `us-central` and `us-central-dev`, which are **not** members of the same CF LB pool: they are on different hostnames entirely (`api.mentra.glass` vs `devapi.mentra.glass`). CF affinity is scoped per-hostname; a cookie for `api.mentra.glass` cannot redirect anything to `devapi.mentra.glass`. The divergence here is at a higher level: **the client targets different hostnames from REST vs WS because one cached the URL and the other didn't.**

---

## Findings

### 1. The root cause is stale `WebSocketManager.url`

One line of code. `this.url` is written only inside `connect()`. Nothing in the WSM subscribes to `useSettingsStore` or the `backend_url` setting. When a caller updates `setSetting(SETTINGS.backend_url.key, newUrl)` without immediately calling `ws.connect(newUrl, ...)`, the WSM's cached URL diverges from the Zustand setting.

Any subsequent reconnect (whether from the retry-on-503 path, the liveness-timeout path, or the `onclose` handler's `startReconnectInterval`) uses `this.url`, not the current Zustand value. The WS sticks on the old backend forever.

### 2. Divergence can be triggered without going through `BackendUrl.tsx handleSaveUrl`

`handleSaveUrl` in `mobile/src/components/dev/BackendUrl.tsx` correctly orchestrates backend change: `setBackendUrl(newUrl)` → `showAlert` → `mantle.cleanup()` → `replaceAll("/")` → `InitScreen` → `mantle.init()` → `socketComms.connectWebsocket()` → `ws.connect(newUrl, ...)`. That last call updates `this.url` correctly.

But other paths exist that update `backend_url` without `mantle.cleanup() + mantle.init()`:

- `BackendUrl.tsx handleResetUrl`: calls `setBackendUrl(null)` then `replaceAll("/")`. No `mantle.cleanup()`.
- `InitScreen.handleResetUrl`: calls `setBackendUrl(defaultUrl)` then `checkCloudVersion(true)`. No `mantle.cleanup()`.
- A server-side settings snapshot that happens to include a `backend_url`-shaped key (in practice it shouldn't because `saveOnServer: false`, but this is guarded only by string-key lookup).
- **Any direct `useSettingsStore.getState().setSetting(SETTINGS.backend_url.key, ...)` call** , no enforcement that the WSM gets informed.

Any such path lands you in the divergent state.

### 3. PR #2565's retry-on-503 turns divergence into a self-sustaining storm

Without #2565: REST would 503 forever until the user notices and force-closes the app. Bad UX, minimal cloud impact.

With #2565: each 503 triggers a WS reconnect, which doesn't fix the divergence but does trigger `WebsocketStatus.useEffect` → `refreshApplets()` → more REST → more 503s → more reconnects. The loop runs at ~500–700 ms per cycle = 85–120 opens per minute. The cloud absorbs this as a flood of session-init cascades on the same pod.

So the retry didn't cause the bug. It dramatically amplified its cost: from "REST broken" to "client is DDoSing the cloud."

### 4. `WebsocketStatus.useEffect` is a significant amplifier of the storm cost

`mobile/src/components/error/WebsocketStatus.tsx` calls `refreshApplets()` on every CONNECTED transition unconditionally. Under the storm, every cycle fires a new REST call, which 503s, which triggers another reconnect. Even a divergence that might otherwise self-limit (one failed retry and stop) instead keeps the loop going because the reconnect fires fresh REST calls.

This is not the root cause. The root cause is stale `this.url`. But fixing the amplifier is cheap and valuable defense in depth.

### 5. `detachAndCloseSocket()` does not await the close, causing occasional server-side overlap

`mobile/src/services/WebSocketManager.ts` L95–L104 detaches handlers and calls `ws.close()`, then `connect()` proceeds to `new WebSocket(...)` in the same tick. For a short window (50–500 ms) both the old and new WebSockets are active at the cloud. Logged as `"Glasses connection closed (stale, newer WebSocket already active, ignoring)"` in `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` L489.

Not a driver of the current storm (the reproducer saw only 2 stale closes in 22 minutes), but real for other users whose cycle is tighter. Belt-and-suspenders concern.

---

## Why The Original Hypothesis Was Wrong And What That Means

First pass at this investigation blamed the CF session-affinity cookie for not being carried on the WS upgrade. Source-reading the RN polyfills proved that wrong. More importantly, the reproducer's divergence was between two **different hostnames** (`api.mentra.glass` vs `devapi.mentra.glass`) , CF's per-hostname session affinity can't produce that divergence regardless of cookie handling.

Takeaway: "band-aid" mitigations like exponential backoff or refresh debouncing would have made the storm slower but left the underlying divergence permanent. The user would still be "broken" after the CF cookie TTL expired. The only real fix is to make the WSM follow the settings store.

---

## Conclusions

| Finding                                                                                                | Confidence                                                                                    |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `WebSocketManager.url` never updates from the settings store                                           | **Confirmed from source code**                                                                |
| Axios reads `backend_url` live per request, so REST follows settings immediately                       | **Confirmed from source code**                                                                |
| Divergence between `wsManager.url` and `backend_url` causes REST 503s on an apparently healthy session | **Confirmed in production** (full trace of reproduction at 20:38:49–20:41:02)                 |
| PR #2565's retry-on-503 amplifies divergence into a 90/min reconnect storm                             | **Confirmed in production** (1,910 opens / 22 min, same cycle pattern throughout)             |
| `WebsocketStatus.useEffect` firing `refreshApplets()` on every CONNECTED sustains the storm            | **High** (present in code, matches observed cycle shape)                                      |
| CF session-affinity cookie hypothesis is incorrect                                                     | **High** (source-read RN polyfills on both platforms; cross-hostname divergence rules it out) |

---

## Implications For The Fix

Non-goals: approaches that only mask the bug:

- Exponential backoff on WS reconnect
- Debouncing `refreshApplets` to once per N seconds
- Capping retry attempts per call
- Server-side rate limit on WS upgrades
- Adding a "same connection already tried" guard

All of those slow the storm but leave REST permanently broken until force-close. The user experience is the same: "I switched backends and now nothing works." The cloud impact is smaller but still present.

Goals: approaches that fix the root cause:

- **Make `WebSocketManager.this.url` reactive to `backend_url` changes.** Subscribe on construction, disconnect-and-reconnect when the URL changes. This removes the cached-URL footgun entirely.
- **Remove `this.url` as a cached field.** Always derive the URL freshly from `useSettingsStore.getState().getWsUrl()` when reconnecting. Matches how `RestComms` does it.

Either fixes the real bug. The second is simpler: no subscription, no event handler, just "read the current URL from the source of truth every time we need one."

Secondary: fix the amplifier so a similar class of bug cannot produce a 90/min storm in the future.

- `WebsocketStatus.useEffect` should not unconditionally fire `refreshApplets()` on every CONNECTED. Either (a) only fire on the first CONNECTED after a disconnect longer than some threshold, or (b) guard via the Zustand `connectionGeneration`-style counter so we don't re-fire within the same "session."

Tertiary: close the server-side overlap window.

- `detachAndCloseSocket()` should await the `close` event (with a short timeout) before `connect()` creates a new WebSocket.

---

## Next Steps

1. **Write spec** , concrete behavior for the root-cause fix plus the amplifier fix plus the overlap fix.
2. **Write design** , file-by-file implementation. Small scope because the fixes are small.
3. **Open PR to `dev`** , v2.10 is on the stores right now; the fix needs to ship in v2.10.1 or v2.11 fast.
4. **Backport to `main`** once validated so any future main-based hotfix release inherits the fix.
