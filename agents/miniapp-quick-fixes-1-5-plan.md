# Live Reload + WebView Console Bridge — Implementation Plan

Implementation plan for sections #1 and #5 of [`miniapp-quick-fixes-spec.md`](./miniapp-quick-fixes-spec.md). They share infrastructure (one phone↔laptop WebSocket multiplexed for both reload signals and log forwarding), so they ship together.

This doc is the *how*. The *what* and *why* are in the spec — read that first if you haven't.

---

## Architecture

```
                      ┌────────────────────────┐
                      │ Developer's laptop     │
                      │                        │
  user's server.ts ───┤  port 3000 (miniapp)   │
                      │                        │
                      │  port 3001 (sidecar)   │
                      │   ws://__mentra_dev    │
                      └──────────┬─────────────┘
                                 │ WebSocket
                                 │
            ┌────────────────────┴───────────────────┐
            │ Phone (MentraOS app)                   │
            │                                        │
            │  DevServerBridge.ts ─────┐             │
            │   (per-package WS)       │             │
            │                          ▼             │
            │  MiniappHost.tsx → LocalMiniappRuntime │
            │   ↓ injects shim                       │
            │  WebView                               │
            │   • console.* tap (forward → bridge)   │
            │   • reload listener (recv from bridge) │
            └────────────────────────────────────────┘
```

Two channels multiplexed on one WebSocket:

- **Phone → laptop**: `{type: "log", level, args, packageName, timestamp}` (forwarded console calls).
- **Laptop → phone**: `{type: "reload"}` (filesystem watcher fired). Future commands extend with new `type` strings.

---

## Components

### 1. Sidecar dev server — `sdk/miniapp-cli/src/dev-server.ts` (new)

A separate `Bun.serve` started by `mentra-miniapp dev`, on port `<userPort + 1>` (default 3001 when miniapp is on 3000). Doesn't touch the user's `server.ts`.

Responsibilities:
- WebSocket upgrade at `/__mentra_dev`.
- Filesystem watcher on the project root (chokidar or `Bun.watch`); debounced 100ms; broadcasts `{type: "reload"}` on change.
- Routes incoming `{type: "log", ...}` to stdout, formatted with package name + timestamp + ANSI color.
- `GET /__mentra_dev/health` for liveness checks.
- Listens on `127.0.0.1` AND `0.0.0.0` so phone (LAN) can reach it.

**Why sidecar, not patching user's server:**
- Works regardless of what the dev server uses (Bun.serve, Vite, Next, Express, custom).
- Doesn't pollute user code.
- Can also host the `/__mentra_dev/files` endpoint for the dev-applets caching spec — single dev surface.

### 2. CLI changes — `sdk/miniapp-cli/src/dev.ts`

- After spawning the user's `bun run --hot server.ts`, also start the sidecar.
- Encode the sidecar port into the QR URL: `mentra-miniapp://dev?url=<miniapp>&name=<n>&package=<p>&dev=<sidecar-port>`. The `dev` param is optional — phones with older CLIs ignore it and run without live reload / console bridge.
- Print both URLs + the QR.

### 3. Phone-side WebSocket bridge — `mobile/src/services/DevServerBridge.ts` (new)

Singleton service. Per-package state map. API:

```ts
devServerBridge.connect(packageName: string, devUrl: string, devPort: number): void
devServerBridge.disconnect(packageName: string): void
devServerBridge.forwardLog(packageName: string, level: string, args: any[], timestamp: number): void
```

Internal state per packageName:
- `WebSocket | null`
- State: `idle | connecting | connected | disconnected | closed`
- Outgoing-log ring buffer (~100 entries, ~32KB cap; drop oldest)
- Reload listener for inbound `{type: "reload"}` envelopes

On receipt of `{type: "reload"}` from the dev server, the bridge calls into `MiniappHost` to trigger a `WebView.reload()` for that package.

### 4. QR URL parser — `mobile/src/app/miniapps/settings/miniapp-developer-scanner.tsx`

Extract the `dev` query param. If present, pass it to the dev-applet route: `replace("/applet/local", {packageName, devUrl, appName, iconUrl, devPort})`.

### 5. Local applet route — `mobile/src/app/applet/local.tsx`

Read `devPort` from search params. After `miniappHost.mountDev(...)`:

```ts
if (devPort) {
  devServerBridge.connect(packageName, devUrl, devPort)
}
```

The unmount cleanup calls `devServerBridge.disconnect(packageName)`.

### 6. Console-tap injection — `mobile/src/utils/miniappGlobals.ts`

Extend `BuildMiniappGlobalsOptions` with `injectDevConsoleTap?: boolean`. When true, append the console-wrap shim to the returned script *after* the existing `window.MentraOS` setup.

The shim:

```js
if (window.MentraOS && window.MentraOS.miniappDeveloperMode) {
  ['log', 'warn', 'error', 'info', 'debug'].forEach(level => {
    const original = console[level];
    console[level] = function(...args) {
      original.apply(console, args);
      try {
        var serialized = args.map(function(a) {
          if (a instanceof Error) return {__error: true, message: a.message, stack: a.stack};
          if (typeof a === 'object') return JSON.stringify(a, getCircularReplacer());
          return a;
        });
        window.ReactNativeWebView.postMessage(JSON.stringify({
          payload: {type: "dev_log", level: level, args: serialized, packageName: window.MentraOS.packageName, timestamp: Date.now()}
        }));
      } catch(e) { /* swallow */ }
    };
  });
}
```

`getCircularReplacer` is a small WeakSet-based circular-ref handler.

### 7. MiniappHost wiring — `mobile/src/components/miniapp/MiniappHost.tsx`

In the WebView render, pass `injectDevConsoleTap: app.developerMode` when calling `buildMiniappGlobalsScript`. Already gates on `developerMode` — production WebViews don't get the shim.

### 8. LocalMiniappRuntime hand-off — `mobile/src/services/LocalMiniappRuntime.ts`

In `handleRawMessage`: if envelope `payload.type === "dev_log"`, route to `devServerBridge.forwardLog(packageName, ...)` and **return without further processing**. Don't pass to the SDK as a normal envelope.

### 9. SDK auto-injected reload listener — `sdk/miniapp/src/index.ts` or new `sdk/miniapp/src/dev-reload.ts`

When the SDK initializes and detects `window.MentraOS.miniappDeveloperMode === true`, register a listener on `window.message` events. On `{type: "reload"}`, call `location.reload()`.

This is symmetrical to the console-tap (which is phone-injected) — the reload listener is SDK-injected because it lives entirely inside the WebView's JS world.

The phone-side bridge, on receiving `{type: "reload"}` from the laptop, calls `webView.injectJavaScript('window.dispatchEvent(new MessageEvent("message", {data: ...}))')` — same mechanism `MiniappHost` already uses for `miniapp_color_scheme_change` and `miniapp_before_evict`.

---

## Reconnect state machine (DevServerBridge)

```
                    ┌───────┐
                    │ idle  │
                    └───┬───┘
                  connect()
                        │
                        ▼
                  ┌──────────┐  open       ┌────────────┐
                  │connecting│────────────►│ connected  │
                  └────┬─────┘             └─────┬──────┘
                       │ error                    │ close
                       │                          │
                       ▼                          ▼
                  ┌────────────────────────────────┐
                  │       disconnected             │
                  │  (exp backoff: 1s,2s,4s..30s)  │
                  └─────────┬──────────────────────┘
                            │ retry
                            └───► connecting

   any state ── disconnect() ──► closed (terminal)
```

Backoff: `min(30s, 1s * 2^(attempt - 1)) * (1 ± 0.2)` (jittered exponential, capped).

Retry forever — dev server is the developer's machine; they want to come back. No hard cap.

While `disconnected`: outgoing logs go into the ring buffer; on reconnect, flush. Inbound reload signals during `disconnected` are impossible (no connection).

`closed` state is terminal. Reached via explicit `bridge.disconnect(packageName)` (called from `MiniappHost.unmount`).

---

## Wire format

Two message types in V1:

```ts
// Laptop → phone
{ type: "reload" }

// Phone → laptop
{
  type: "log",
  level: "log" | "warn" | "error" | "info" | "debug",
  args: any[],   // serialized; Errors become {__error: true, message, stack}
  packageName: string,
  timestamp: number  // ms since epoch
}
```

Future expansion: new `type` strings (`{type: "reload-css"}`, `{type: "open-devtools"}`, etc.). Both ends ignore unknown types — forward-compat.

---

## File touches summary

| File | Change |
|---|---|
| `sdk/miniapp-cli/src/dev-server.ts` | **NEW** sidecar Bun.serve |
| `sdk/miniapp-cli/src/dev.ts` | Spawn sidecar, encode `dev` port in QR |
| `sdk/miniapp/src/dev-reload.ts` | **NEW** SDK-injected reload listener |
| `sdk/miniapp/src/index.ts` | Wire dev-reload listener into auto-init |
| `mobile/src/services/DevServerBridge.ts` | **NEW** singleton bridge service |
| `mobile/src/utils/miniappGlobals.ts` | Add `injectDevConsoleTap` option, append shim |
| `mobile/src/components/miniapp/MiniappHost.tsx` | Pass `injectDevConsoleTap: developerMode` |
| `mobile/src/services/LocalMiniappRuntime.ts` | Route `dev_log` envelopes to bridge |
| `mobile/src/app/miniapps/settings/miniapp-developer-scanner.tsx` | Parse `dev` query param |
| `mobile/src/app/miniapps/settings/miniapp-developer-url.tsx` | Capture `dev` port from manual URL entry (or skip — manual URL is for advanced users only) |
| `mobile/src/app/applet/local.tsx` | Call `devServerBridge.connect/disconnect` |

11 files; 3 new files. Most touches are small.

---

## Sequencing

1. **Sidecar dev server** — standalone, testable in isolation. Ship first as the sidecar can run before the phone-side bridge exists; it just won't have any clients.
2. **CLI integration** — spawn sidecar from `mentra-miniapp dev`, encode `dev` in QR.
3. **Phone DevServerBridge** — reconnect logic, ring buffer, multiplexed message handling.
4. **Console-tap injection** — extend `miniappGlobals.ts`, wire from `MiniappHost`.
5. **LocalMiniappRuntime routing** — `dev_log` short-circuit.
6. **SDK reload listener** — auto-injected, dev-mode-gated.
7. **End-to-end test** — scan QR, modify a file, observe reload; modify code with console.warn, observe message in dev terminal.

Estimated 5-7 days end-to-end. Steps 1-2 can run in parallel with steps 3-6 since they're across the laptop/phone boundary.

---

## Risks and rollback

- **Risk: ReactNativeWebView.postMessage rate cap.** The shim could DoS the bridge if the user logs in a tight loop. Mitigation: phone-side rate limit (~100 logs/sec/package), drop excess.
- **Risk: Sidecar port conflict.** If port `userPort + 1` is taken, fall back to a random ephemeral port. CLI prints which port it chose.
- **Risk: WebSocket `open` succeeds but server is wrong process.** Mitigation: on connect, send `{type: "hello", protocol: "mentra-dev/1"}`; sidecar replies `{type: "hello-ack"}`. If no ack within 1s, treat as wrong server, close.
- **Rollback:** if the bridge has issues, set `injectDevConsoleTap: false` and skip the bridge connection in `local.tsx`. The miniapp still works; no live reload, no console forwarding. The path matches the "older CLI without `dev` param" fallback already designed in.

---

## Open during implementation

- Whether the SDK's reload listener should `location.reload()` or attempt softer HMR (state-preserving). V1: `location.reload()`. HMR is a future enhancement.
- Whether the bridge's outgoing-log ring buffer should be in IndexedDB or in-memory. V1: in-memory; small enough that loss-on-app-bg is acceptable.
- Whether to add a `Reset connection` button to the dev tile's long-press menu (for when the laptop's IP changed and the bridge is stuck retrying old IP). V1: skip — re-scan QR achieves the same result.

These do not block starting implementation; resolve during the work.
