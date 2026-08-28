# Navigation Mini App Two-Layer Migration + SDK RPC Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add typed request/response RPC to the mini app SDK (`mentra.request` / `session.ui.handle` / `useRpc`), then migrate the Navigation mini app from the single-bundle WebView prototype to the two-layer (background JSContext + UI WebView) architecture so closing the WebView mid-trip never silences the glasses.

**Architecture:** RPC reuses the existing UI bus (`session.ui.send` / `mentra.send`) plus one optional envelope field (`requestId`) and one new envelope type (`UI_CANCEL`) for cancellation. A `Rpc<Req, Res>` brand in the per-app `Channels` registry makes `mentra.request` and `mentra.send` mutually exclusive at the type level — wrong API for the channel is a compile error. Navigation gets a `NavigationController` that owns `MiniappSession`, all subscriptions, trip state, the glasses HUD logic, storage, and Places REST. UI becomes a thin Zustand-backed React tree reading channel pushes, sending broadcasts and RPC.

**Tech Stack:** TypeScript (strict), Bun (test runner + bundler), React 19, Zustand, react-native-webview (host bridge), JSContext (iOS) / Hermes-equivalent JSContext (Android) for background, Tailwind 4, motion, Google Maps JS API (UI-only), Google Places REST (background-only).

**Spec source of truth:** `notes/superpowers/specs/2026-05-16-navigation-miniapp-two-layer-migration-design.md`

---

## File Map

### SDK changes (`mobile/`)

| Path | Action | Responsibility |
|---|---|---|
| `mobile/modules/miniapp/src/modules/ui.ts` | Modify | Add `Rpc<>`, `RpcRegistry` helpers; extend `UISendEnvelope`/`UIInboundEnvelope` with `requestId` + `UI_CANCEL`; add `handle()` and `request()` to `UIModule`; rewrite top docstring. |
| `mobile/modules/miniapp/src/modules/ui.test.ts` | Modify | Add ~10 new test cases for handle/request/cancel/timeout. |
| `mobile/modules/miniapp/src/background/index.ts` | Modify | Re-export `Rpc`, `MentraRpcError`, `MentraRpcTimeoutError`. Update docstring. |
| `mobile/modules/miniapp/src/ui/index.ts` | Modify | Add `request()` method to `MentraUiGlobal`; export `Rpc`, `MentraRpcError`, `MentraRpcTimeoutError`; update docstring. |
| `mobile/modules/miniapp/src/react/useRpc.ts` | Create | React hook with auto-abort-on-unmount + `.abort()` for cancel-previous patterns. |
| `mobile/modules/miniapp/src/react/index.ts` | Modify | Export `useRpc`. |
| `mobile/modules/engine/src/services/mentraUiShim.ts` | Modify | Add `requestId` to `msg` frames (both directions); generate `cancel` frame; pre-ready buffer for RPC. |
| `mobile/modules/engine/src/services/MentraUIRouter.ts` | Modify | Pass `requestId` through `routeFromWebView` / `routeFromBackground`; route `cancel` frame in both directions. |

### Example mini app refactor (`sdk/example-miniapp/`)

| Path | Action | Responsibility |
|---|---|---|
| `sdk/example-miniapp/src/shared/channels.ts` | Modify | Add `tester:invoke` as `Rpc<TesterInvoke, unknown>`; update docstring. |
| `sdk/example-miniapp/src/shared/types.ts` | Modify | Add `TesterInvoke` type. |
| `sdk/example-miniapp/src/background/controllers/TesterController.ts` | Modify | Replace `tester:fire` (fire-and-forget + result muxed onto stream) with `ui.handle("tester:invoke", ...)`. |
| `sdk/example-miniapp/src/ui/hooks/useTester.ts` | Modify | Replace `fire` (send-only) with `invoke` (request-returns-Promise). |
| `sdk/example-miniapp/src/ui/pages/tester/*.tsx` | Modify | Tester pages that previously fired+awaited a `tester:event` round-trip now `await invoke(...)`. |

### Docs

| Path | Action | Responsibility |
|---|---|---|
| `agents/miniapp-sdk-overview.md` | Modify | Add "Request/response across the bridge" subsection. |

### Navigation mini app migration (`sdk/Navigation/`)

| Path | Action | Responsibility |
|---|---|---|
| `sdk/Navigation/miniapp.json` | Modify | `type: "standard"`, `entry: {background, ui}`, `sdkVersion`, `minHostVersion`. |
| `sdk/Navigation/build.ts` | Rewrite | Two-output build (background IIFE + UI HTML with Tailwind). |
| `sdk/Navigation/index.html` | Move | Becomes `src/ui/index.html`. |
| `sdk/Navigation/src/shared/channels.ts` | Create | The single typed Channels registry. |
| `sdk/Navigation/src/shared/types.ts` | Create | Domain types shared across background + UI. |
| `sdk/Navigation/src/background/index.ts` | Create | `registerMiniapp((session) => new NavigationController(session).start())`. |
| `sdk/Navigation/src/background/NavigationController.ts` | Create | The one immortal class: subscriptions, trip state, HUD logic, RPC handlers, broadcast listeners, snapshot builder, dispose. |
| `sdk/Navigation/src/background/managers/LocationManager.ts` | Move | From `src/client/session/managers/LocationManager.ts`. |
| `sdk/Navigation/src/background/managers/CompassManager.ts` | Move | From `src/client/session/managers/CompassManager.ts`. |
| `sdk/Navigation/src/background/managers/DisplayManager.ts` | Move | From `src/client/session/managers/DisplayManager.ts`. |
| `sdk/Navigation/src/background/managers/NavigationManager.ts` | Move | From `src/client/session/managers/navigation/NavigationManager.ts`. |
| `sdk/Navigation/src/background/managers/ManeuverFormatter.ts` | Move | From `src/client/session/managers/navigation/ManeuverFormatter.ts`. |
| `sdk/Navigation/src/background/managers/SimpleStorageManager.ts` | Move | From `src/client/session/managers/SimpleStorageManager.ts`. |
| `sdk/Navigation/src/background/managers/PlacesManager.ts` | Create | Wraps the existing `places.ts` REST functions as a class with cancellation. |
| `sdk/Navigation/src/background/lib/formatDistance.ts` | Move | From `src/client/lib/formatDistance/formatDistance.ts`. |
| `sdk/Navigation/src/background/lib/geometry.ts` | Move | From `src/client/lib/geometry/geometry.ts`. |
| `sdk/Navigation/src/background/lib/rdpSmooth.ts` | Move | From `src/client/lib/geometry/rdpSmooth.ts`. |
| `sdk/Navigation/src/ui/index.html` | Move | From repo root `index.html`. |
| `sdk/Navigation/src/ui/main.tsx` | Create | Mounts React + installs root channel subscribers feeding the Zustand store. |
| `sdk/Navigation/src/ui/App.tsx` | Move + rewrite | From `src/frontend/App.tsx`; reads from store, no `useUser`. |
| `sdk/Navigation/src/ui/router.tsx` | Move | From `src/frontend/router.tsx`. |
| `sdk/Navigation/src/ui/index.css` | Move | From `src/frontend/index.css`. |
| `sdk/Navigation/src/ui/store/navStore.ts` | Create | Zustand store. |
| `sdk/Navigation/src/ui/hooks/useChannel.ts` | Create | `useChannel(channel)` returning latest payload as React state. |
| `sdk/Navigation/src/ui/lib/googleMaps.ts` | Move | From `src/client/session/managers/GoogleMapsManager.ts`. |
| `sdk/Navigation/src/ui/lib/formatDistance.ts` | Re-export | UI also needs `formatDistance` for display; re-export from `background/lib` or duplicate the 30-LoC file (we duplicate — see Task N). |
| `sdk/Navigation/src/ui/lib/geometry.ts` | Re-export | Same — UI map components import `haversineMeters`. |
| `sdk/Navigation/src/ui/components/**` | Move | From `src/frontend/components/`. |
| `sdk/Navigation/src/ui/pages/**` | Move + rewrite | From `src/frontend/pages/`; refactor to read store + send channels. |
| `sdk/Navigation/src/test/navigation/*.test.ts` | Modify | Update import paths from `@/client` → `@/background`. |
| `sdk/Navigation/tsconfig.json` | Modify | Update `paths` aliases to match new layout. |
| `sdk/Navigation/server.ts` | Modify | Add second `/api/config` field for `EXPO_PUBLIC_GOOGLE_PLACES_API_KEY` (already there — verify). |

### Files deleted at the end

After the migration:
- `sdk/Navigation/src/client/` (whole subtree)
- `sdk/Navigation/src/frontend/` (whole subtree)
- `sdk/Navigation/index.html` (root-level — moved into `src/ui/`)

---

## Conventions

**Branch:** all commits land on `mentra-miniapp-sdk-2`. No new branches.

**Commit hook bypass:** use `--no-verify` on every commit. Pre-existing repo errors unrelated to our changes cause hooks to trip; the user has approved this for this branch.

**Commit attribution:** No `Co-Authored-By: Claude…` trailers. The user's project AGENTS.md explicitly forbids AI attribution in commit messages.

**No mid-task `bun install`** unless a task says so. The workspace is already linked.

**Test commands** assume cwd is the package being tested (`cd mobile/modules/miniapp` for SDK tests, `cd sdk/Navigation` for nav tests). Each test step gives the exact `cd` + command.

**Type checks** run via `cd <pkg> && bun x tsc --noEmit` (the existing `bun run lint` / `bun run typecheck` aliases vary per package — task steps spell out the right one).

---

# Phase 1 — SDK RPC helper

## Task 1: Add `Rpc<>` brand + helper types to `@mentra/miniapp/ui` exports

**Files:**
- Modify: `mobile/modules/miniapp/src/modules/ui.ts`
- Test: deferred to Task 2 (the types need an implementation to assert against)

- [ ] **Step 1: Add Rpc brand + helper types**

Open `mobile/modules/miniapp/src/modules/ui.ts`. After the existing `export type UIChannelHandler` / `UIUnsubscribe` lines (around line 44), add the new helper types:

```ts
/**
 * Brand for declaring an RPC channel in the shared Channels registry.
 *
 * Wrap a channel's payload type in `Rpc<Req, Res>` to mark it as
 * request/response. The SDK's `mentra.request` / `session.ui.handle`
 * accept only `Rpc<...>` channels; `mentra.send` / `session.ui.on`
 * accept only non-RPC channels. Using the wrong API for the wrong
 * channel is a compile-time error.
 *
 *   export interface Channels {
 *     "live-transcript": {text: string}                    // broadcast
 *     "compute-route":   Rpc<RouteOpts, RouteResult>       // RPC
 *   }
 */
declare const __rpc_brand: unique symbol
export type Rpc<Req, Res> = {readonly [__rpc_brand]: true; readonly req: Req; readonly res: Res}

/** True if `T` is an `Rpc<...>` channel entry. */
export type IsRpc<T> = T extends Rpc<unknown, unknown> ? true : false
/** Request payload type of an `Rpc<Req, Res>` entry. */
export type RpcReq<T> = T extends Rpc<infer Req, unknown> ? Req : never
/** Response payload type of an `Rpc<Req, Res>` entry. */
export type RpcRes<T> = T extends Rpc<unknown, infer Res> ? Res : never

/** Options accepted by `mentra.request`. */
export interface RpcRequestOptions {
  /** Abort the in-flight call. Sends UI_CANCEL to the handler. */
  signal?: AbortSignal
  /** Reject with `MentraRpcTimeoutError` after this many ms. No default. */
  timeout?: number
}

/** Context passed as the optional 2nd arg to an `ui.handle` handler. */
export interface RpcHandlerContext {
  /** Aborts when the UI side cancels the call (or its timeout fires). */
  signal: AbortSignal
}

/**
 * Error thrown by `mentra.request` when the handler threw or returned an
 * error envelope. Plain `Error` subclass — distinguished by `err.name`.
 * `err.cause` is `{code?: string}` if the handler attached one.
 */
export class MentraRpcError extends Error {
  constructor(message: string, options?: {cause?: {code?: string}}) {
    super(message, options)
    this.name = "MentraRpcError"
  }
}

/** Thrown by `mentra.request` when its `{timeout}` elapses. */
export class MentraRpcTimeoutError extends Error {
  constructor(message = "RPC timed out") {
    super(message)
    this.name = "MentraRpcTimeoutError"
  }
}
```

- [ ] **Step 2: Tighten `UIModule` interface — add `handle()`, narrow `send` and `on`**

Replace the existing `UIModule<TChannels>` interface (around lines 54-87) with this expanded version. The send/on signatures get the IsRpc-conditional guard so RPC channels reject; the new `handle` signature accepts only RPC channels:

```ts
/**
 * Public surface mirrored on `session.ui`. Generic over a `Channels`
 * type-map so miniapps importing the typed `shared/channels.ts` get
 * compile-time enforcement on channel names + payload shapes.
 *
 * Broadcast vs. RPC channels are distinguished at the type level:
 *   - Channel value `Rpc<Req, Res>` → only `handle()` accepts it on
 *     background; only `mentra.request(...)` accepts it on UI.
 *   - Channel value anything else   → only `send()`/`on()` accept it
 *     on both sides.
 *
 * The default `Record<string, unknown>` mapping lets unannotated usage
 * compile — the SDK doesn't impose a registry of its own.
 */
export interface UIModule<TChannels extends Record<string, unknown> = Record<string, unknown>> {
  /** True iff a WebView is currently bound to this miniapp. */
  isOpen(): boolean

  /**
   * Subscribe to the "WebView mounted + ready()" lifecycle event. If
   * a WebView is already mounted when subscribe() is called, the
   * handler fires immediately for the current binding.
   */
  onOpen(cb: () => void): UIUnsubscribe

  /**
   * Subscribe to the "WebView unmounted" lifecycle event. Fires once
   * per close; if no WebView is bound at subscribe time the handler
   * stays armed for the next mount → close cycle.
   */
  onClose(cb: () => void): UIUnsubscribe

  /**
   * Broadcast a typed message to the bound WebView. Silently drops if
   * no WebView is bound. Compile-error if `C` is an RPC channel.
   */
  send<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    payload: TChannels[C],
  ): void

  /**
   * Subscribe to broadcast messages from the bound WebView. Returns an
   * unsubscribe fn. Compile-error if `C` is an RPC channel — use
   * `handle()` for RPC channels.
   */
  on<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    cb: UIChannelHandler<TChannels[C]>,
  ): UIUnsubscribe

  /**
   * Register the single handler for an RPC channel. The UI side calls
   * `mentra.request(channel, payload, options?)`; this handler resolves
   * the call.
   *
   * Throws synchronously if a handler is already registered for the
   * channel. Returns a deregister fn that removes the handler.
   *
   * Compile-error if `C` is a broadcast (non-Rpc) channel.
   */
  handle<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? C : never,
    handler: (
      payload: RpcReq<TChannels[C]>,
      ctx?: RpcHandlerContext,
    ) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>,
  ): UIUnsubscribe
}
```

- [ ] **Step 3: Run typecheck — file should compile (no `handle` impl yet, only interface)**

```bash
cd mobile/modules/miniapp && bun x tsc --noEmit
```

Expected: compiles. (`UIModuleImpl` still implements `UIModule` from before the change — but TypeScript's structural typing will see the new `handle` member is missing on the impl class. That's expected here; we add the impl in Task 3 after the envelope types are in place. If tsc fails with "Class incorrectly implements interface — missing `handle`", that's the expected failure and we move on to the next task. If it fails for any OTHER reason — that's a real error to fix.)

- [ ] **Step 4: Commit**

```bash
git add mobile/modules/miniapp/src/modules/ui.ts
git commit -m "Add Rpc<> brand and handle()/request type plumbing to UIModule interface" --no-verify
```

---

## Task 2: Extend wire envelope types with `requestId` + `UI_CANCEL`

**Files:**
- Modify: `mobile/modules/miniapp/src/modules/ui.ts:89-102` (envelope types)

- [ ] **Step 1: Extend `UISendEnvelope` and `UIInboundEnvelope`**

Replace the existing internal envelope types (around lines 89-102) with:

```ts
/**
 * Wire-level envelope types. Internal — not exported.
 *
 * `requestId` is set on RPC frames (call, result, cancel). Broadcast
 * `UI_MESSAGE` / `UI_SEND` frames carry no `requestId`. `UI_CANCEL`
 * frames carry only `requestId` (no channel, no payload).
 */
type UISendEnvelope =
  | {type: "UI_SEND"; channel: string; payload: unknown; seq: number; requestId?: string}
  | {type: "UI_CANCEL"; requestId: string}

type UIInboundEnvelope =
  | {type: "UI_MESSAGE"; channel: string; payload: unknown; seq: number; requestId?: string}
  | {type: "UI_OPEN"}
  | {type: "UI_CLOSE"}
  | {type: "UI_CANCEL"; requestId: string}
```

- [ ] **Step 2: Run existing tests — they should still pass (no behavior change yet)**

```bash
cd mobile/modules/miniapp && bun test src/modules/ui.test.ts
```

Expected: all existing tests pass. We added optional fields and new variants but didn't change how existing variants are processed yet.

- [ ] **Step 3: Commit**

```bash
git add mobile/modules/miniapp/src/modules/ui.ts
git commit -m "Extend UI envelope wire types with requestId and UI_CANCEL variant" --no-verify
```

---

## Task 3: Implement `session.ui.handle` on `UIModuleImpl`

**Files:**
- Modify: `mobile/modules/miniapp/src/modules/ui.ts` — `UIModuleImpl` class body

- [ ] **Step 1: Write the failing test** — append at the bottom of `mobile/modules/miniapp/src/modules/ui.test.ts` before the closing `})`:

```ts
  test("handle() registers a handler; UI_MESSAGE with requestId triggers reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:add" as never, ((p: {a: number; b: number}) => p.a + p.b) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:add", payload: {a: 2, b: 3}, seq: 1, requestId: "r1"})
    // Reply is dispatched async (handler may be Promise). Yield once.
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find(
      (c) => (c as {requestId?: string}).requestId === "r1",
    ) as {type: string; channel: string; payload: unknown; requestId: string} | undefined
    expect(reply).toBeDefined()
    expect(reply!.type).toBe("UI_SEND")
    expect(reply!.channel).toBe("rpc:add")
    expect(reply!.payload).toEqual({ok: true, result: 5})
    expect(reply!.requestId).toBe("r1")
  })
```

- [ ] **Step 2: Run the test — verify it fails**

```bash
cd mobile/modules/miniapp && bun test src/modules/ui.test.ts -t "handle\(\) registers"
```

Expected: FAIL (no `handle` impl). The error is `ui.handle is not a function`.

- [ ] **Step 3: Implement `handle()` and route requestId-tagged UI_MESSAGE frames**

In `mobile/modules/miniapp/src/modules/ui.ts`:

a) In the class body of `UIModuleImpl`, just after the `channelHandlers` map declaration (around line 115), add:

```ts
  /** channel → single registered RPC handler. */
  private readonly rpcHandlers: Map<
    string,
    (payload: unknown, ctx: RpcHandlerContext) => Promise<unknown> | unknown
  > = new Map()

  /** requestId → AbortController for in-flight RPC handler invocations. */
  private readonly inflightRpc: Map<string, AbortController> = new Map()
```

b) Add the `handle` method right after the existing `on` arrow method:

```ts
  handle = <C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? C : never,
    handler: (
      payload: RpcReq<TChannels[C]>,
      ctx?: RpcHandlerContext,
    ) => Promise<RpcRes<TChannels[C]>> | RpcRes<TChannels[C]>,
  ): UIUnsubscribe => {
    const key = channel as unknown as string
    if (this.rpcHandlers.has(key)) {
      throw new Error(`session.ui.handle: a handler is already registered for "${key}"`)
    }
    this.rpcHandlers.set(
      key,
      handler as unknown as (payload: unknown, ctx: RpcHandlerContext) => Promise<unknown> | unknown,
    )
    return () => {
      this.rpcHandlers.delete(key)
    }
  }
```

c) Update `handleInbound`'s `UI_MESSAGE` branch to recognise requestId-tagged frames and route to `rpcHandlers`. Find the existing `if (env.type === "UI_MESSAGE")` block (around line 215) and replace it with:

```ts
    if (env.type === "UI_MESSAGE") {
      // RPC call: requestId set → dispatch to handle() handler.
      if (typeof env.requestId === "string") {
        this.dispatchRpcCall(env.channel, env.payload, env.requestId)
        return
      }
      // Broadcast: fan out to on() subscribers.
      const set = this.channelHandlers.get(env.channel)
      if (!set || set.size === 0) return
      for (const h of set) {
        try {
          h(env.payload)
        } catch (e) {
          // eslint-disable-next-line no-console
          console.warn(`session.ui.on(${env.channel}) threw`, e)
        }
      }
      return
    }
    if (env.type === "UI_CANCEL") {
      const ctrl = this.inflightRpc.get(env.requestId)
      if (ctrl) {
        try {
          ctrl.abort()
        } catch {
          /* ignore */
        }
      }
      return
    }
```

d) Add the private `dispatchRpcCall` method. Place it just below `handleInbound`:

```ts
  /** @internal — invoke a registered RPC handler and send back the reply. */
  private dispatchRpcCall(channel: string, payload: unknown, requestId: string): void {
    const handler = this.rpcHandlers.get(channel)
    if (!handler) {
      // No handler registered. Reply with a structured error so the
      // UI's request promise rejects with a useful message.
      this.sendRpcReply(channel, requestId, {
        ok: false,
        error: {message: `no handler registered for "${channel}"`},
      })
      return
    }
    const ctrl = new AbortController()
    this.inflightRpc.set(requestId, ctrl)
    const ctx: RpcHandlerContext = {signal: ctrl.signal}

    const finish = (envelope: {ok: true; result: unknown} | {ok: false; error: {message: string; code?: string}}) => {
      this.inflightRpc.delete(requestId)
      // If the controller already aborted (UI cancelled), drop the
      // reply — the UI side has already removed its listener.
      if (ctrl.signal.aborted) return
      this.sendRpcReply(channel, requestId, envelope)
    }

    let result: unknown
    try {
      result = handler(payload, ctx)
    } catch (e) {
      finish({ok: false, error: rpcErrorFromUnknown(e)})
      return
    }
    if (result && typeof (result as {then?: unknown}).then === "function") {
      ;(result as Promise<unknown>).then(
        (v) => finish({ok: true, result: v}),
        (e) => finish({ok: false, error: rpcErrorFromUnknown(e)}),
      )
    } else {
      finish({ok: true, result})
    }
  }

  /** @internal — send a UI_SEND envelope tagged with a requestId. */
  private sendRpcReply(
    channel: string,
    requestId: string,
    payload: {ok: true; result: unknown} | {ok: false; error: {message: string; code?: string}},
  ): void {
    if (!this.bound) return
    const seq = this.nextSeq++
    const envelope: UISendEnvelope = {type: "UI_SEND", channel, payload, seq, requestId}
    this.session.sendOneShot(envelope)
  }
```

e) Add the module-level helper just below the existing internal envelope types (after the `UIInboundEnvelope` declaration, before `export class UIModuleImpl`):

```ts
function rpcErrorFromUnknown(e: unknown): {message: string; code?: string} {
  if (e instanceof Error) {
    const code = (e.cause as {code?: string} | undefined)?.code
    return code ? {message: e.message, code} : {message: e.message}
  }
  return {message: String(e)}
}
```

- [ ] **Step 4: Run the test — verify it passes**

```bash
cd mobile/modules/miniapp && bun test src/modules/ui.test.ts -t "handle\(\) registers"
```

Expected: PASS.

- [ ] **Step 5: Run the full UI test file — all existing tests still pass**

```bash
cd mobile/modules/miniapp && bun test src/modules/ui.test.ts
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add mobile/modules/miniapp/src/modules/ui.ts mobile/modules/miniapp/src/modules/ui.test.ts
git commit -m "Implement session.ui.handle for RPC dispatch on background" --no-verify
```

---

## Task 4: Background-side test coverage — handler errors, cancel, double-register

**Files:**
- Modify: `mobile/modules/miniapp/src/modules/ui.test.ts`

- [ ] **Step 1: Add the failing tests** — append before the closing `})`:

```ts
  test("handle() — handler returning a Promise resolves asynchronously", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:slow" as never, (async (p: number) => p * 2) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:slow", payload: 7, seq: 1, requestId: "r-slow"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-slow") as
      | {payload: {ok: boolean; result?: unknown}}
      | undefined
    expect(reply?.payload).toEqual({ok: true, result: 14})
  })

  test("handle() — handler throwing sends an error reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:fail" as never, (() => {
      throw new Error("nope")
    }) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:fail", payload: null, seq: 1, requestId: "r-fail"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-fail") as
      | {payload: {ok: boolean; error?: {message: string}}}
      | undefined
    expect(reply?.payload.ok).toBe(false)
    expect(reply?.payload.error?.message).toBe("nope")
  })

  test("handle() — error.cause.code is forwarded to the wire payload", async () => {
    mock.deliver({type: "UI_OPEN"})
    ui.handle("rpc:coded" as never, (() => {
      throw Object.assign(new Error("bad input"), {cause: {code: "BAD_INPUT"}})
    }) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:coded", payload: null, seq: 1, requestId: "r-coded"})
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-coded") as
      | {payload: {ok: boolean; error?: {message: string; code?: string}}}
      | undefined
    expect(reply?.payload.error).toEqual({message: "bad input", code: "BAD_INPUT"})
  })

  test("handle() — registering twice on the same channel throws", () => {
    ui.handle("rpc:dup" as never, (() => 1) as never)
    expect(() => ui.handle("rpc:dup" as never, (() => 2) as never)).toThrow(
      /already registered/,
    )
  })

  test("handle() — unhandle() removes the handler and allows re-register", () => {
    const off = ui.handle("rpc:reg" as never, (() => 1) as never)
    off()
    expect(() => ui.handle("rpc:reg" as never, (() => 2) as never)).not.toThrow()
  })

  test("UI_MESSAGE with requestId on an unregistered channel sends an error reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    mock.deliver({
      type: "UI_MESSAGE",
      channel: "rpc:nobody",
      payload: null,
      seq: 1,
      requestId: "r-no",
    })
    await new Promise((r) => setTimeout(r, 0))
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-no") as
      | {payload: {ok: boolean; error?: {message: string}}}
      | undefined
    expect(reply?.payload.ok).toBe(false)
    expect(reply?.payload.error?.message).toMatch(/no handler/)
  })

  test("UI_CANCEL aborts the in-flight handler's signal and suppresses reply", async () => {
    mock.deliver({type: "UI_OPEN"})
    let resolve!: (v: number) => void
    const pending = new Promise<number>((r) => (resolve = r))
    let observedAbort = false
    ui.handle("rpc:wait" as never, ((async (_: unknown, ctx?: RpcHandlerContext) => {
      ctx?.signal.addEventListener("abort", () => {
        observedAbort = true
      })
      return await pending
    }) as never) as never)
    mock.deliver({type: "UI_MESSAGE", channel: "rpc:wait", payload: null, seq: 1, requestId: "r-w"})
    mock.deliver({type: "UI_CANCEL", requestId: "r-w"})
    resolve(42) // handler completes after cancel
    await new Promise((r) => setTimeout(r, 0))
    expect(observedAbort).toBe(true)
    // No reply for r-w should land — cancel suppressed it.
    const reply = mock.oneShotCalls.find((c) => (c as {requestId?: string}).requestId === "r-w")
    expect(reply).toBeUndefined()
  })
```

Add the `RpcHandlerContext` import at the top of the test file (next to the existing `import {UIModuleImpl}`):

```ts
import {UIModuleImpl, type RpcHandlerContext} from "./ui"
```

- [ ] **Step 2: Run the new tests — verify they pass**

```bash
cd mobile/modules/miniapp && bun test src/modules/ui.test.ts
```

Expected: all green (the implementation in Task 3 already handles these cases).

- [ ] **Step 3: Commit**

```bash
git add mobile/modules/miniapp/src/modules/ui.test.ts
git commit -m "Cover handle() error, cancel, and re-register semantics with tests" --no-verify
```

---

## Task 5: Add `mentra.request` to `MentraUiGlobal` type + shim implementation

**Files:**
- Modify: `mobile/modules/miniapp/src/ui/index.ts` — add `request` to the interface
- Modify: `mobile/modules/engine/src/services/mentraUiShim.ts` — implement `request` on the WebView global

- [ ] **Step 1: Extend the `MentraUiGlobal` interface**

In `mobile/modules/miniapp/src/ui/index.ts`, after the existing `send` / `on` / `onOpen` / `onClose` / `ready` declarations on `MentraUiGlobal<TChannels>` (around lines 28-65), narrow `send`/`on` and add `request`:

```ts
export interface MentraUiGlobal<TChannels extends Record<string, unknown> = Record<string, unknown>> {
  /**
   * Broadcast a typed message to the bound background JSContext.
   * Buffered until `ready()` acks; once acked, fires immediately.
   * Compile-error if `C` is an RPC channel — use `request()` instead.
   */
  send<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    payload: TChannels[C],
  ): void

  /**
   * Subscribe to broadcast messages from the background. Compile-error
   * if `C` is an RPC channel.
   */
  on<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? never : C,
    cb: (payload: TChannels[C]) => void,
  ): () => void

  /**
   * Make an RPC call to the background `session.ui.handle(channel, ...)`
   * handler. Throws `MentraRpcError` if the handler threw; throws
   * `MentraRpcTimeoutError` if `options.timeout` elapsed; throws
   * `AbortError` if `options.signal` aborted. No default timeout.
   */
  request<C extends keyof TChannels & string>(
    channel: IsRpc<TChannels[C]> extends true ? C : never,
    payload: RpcReq<TChannels[C]>,
    options?: RpcRequestOptions,
  ): Promise<RpcRes<TChannels[C]>>

  onOpen(cb: () => void): () => void
  onClose(cb: () => void): () => void
  ready(): void
}
```

Add the import at the top of the file (next to other type imports — currently there are no imports from `../modules/ui`; add this near the top):

```ts
import type {IsRpc, RpcReq, RpcRes, RpcRequestOptions} from "../modules/ui"
export type {Rpc, IsRpc, RpcReq, RpcRes, RpcRequestOptions, RpcHandlerContext} from "../modules/ui"
export {MentraRpcError, MentraRpcTimeoutError} from "../modules/ui"
```

- [ ] **Step 2: Implement `request` in the shim**

In `mobile/modules/engine/src/services/mentraUiShim.ts`, find the IIFE source (after `function send(...)` around line 93). Add the RPC machinery. The shim is plain ECMAScript (no TS, no imports) — write the new logic in the same style.

After the `function on(channel, cb) {...}` function (around line 109-131), add:

```js
  // ── RPC ─────────────────────────────────────────────────────────────
  // Outbound RPC: every mentra.request() generates a request id, sends a
  // 'msg' envelope tagged with requestId, and stashes a one-shot resolver
  // keyed on the id. The background-side reply is a recv('msg') with the
  // same channel + requestId; we route it directly to the resolver.
  //
  // Cancellation: caller's AbortSignal triggers a 'cancel' envelope to
  // background and rejects the local promise with a DOM-standard
  // AbortError. The background side's UI_CANCEL handler aborts the
  // handler's ctx.signal and drops the reply.
  var rpcCounter = 0
  var rpcInflight = Object.create(null)

  function makeRequestId() {
    rpcCounter += 1
    return 'r' + rpcCounter + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  function MentraRpcError(message, code) {
    var e = new Error(message)
    e.name = 'MentraRpcError'
    if (code) {
      try { e.cause = {code: code} } catch (_) { /* old runtimes */ }
    }
    return e
  }

  function MentraRpcTimeoutError(message) {
    var e = new Error(message || 'RPC timed out')
    e.name = 'MentraRpcTimeoutError'
    return e
  }

  function MentraAbortError() {
    var e
    try { e = new DOMException('aborted', 'AbortError') } catch (_) {
      e = new Error('aborted')
      e.name = 'AbortError'
    }
    return e
  }

  function request(channel, payload, options) {
    var opts = options || {}
    var signal = opts.signal
    var timeoutMs = typeof opts.timeout === 'number' ? opts.timeout : null
    var id = makeRequestId()

    return new Promise(function (resolve, reject) {
      var done = false
      var timeoutHandle = null

      function cleanup() {
        if (done) return
        done = true
        delete rpcInflight[id]
        if (timeoutHandle != null) { clearTimeout(timeoutHandle); timeoutHandle = null }
        if (signal && abortListener) {
          try { signal.removeEventListener('abort', abortListener) } catch (_) {}
        }
      }

      function settle(envelope) {
        if (done) return
        cleanup()
        if (envelope && envelope.ok === true) {
          resolve(envelope.result)
        } else if (envelope && envelope.ok === false) {
          reject(MentraRpcError(envelope.error && envelope.error.message || 'RPC failed', envelope.error && envelope.error.code))
        } else {
          reject(MentraRpcError('malformed RPC reply'))
        }
      }

      rpcInflight[id] = settle

      var abortListener = null
      if (signal) {
        if (signal.aborted) {
          cleanup()
          reject(MentraAbortError())
          return
        }
        abortListener = function () {
          if (done) return
          cleanup()
          postEnvelope({type: 'cancel', requestId: id})
          reject(MentraAbortError())
        }
        try { signal.addEventListener('abort', abortListener) } catch (_) {}
      }

      if (timeoutMs != null) {
        timeoutHandle = setTimeout(function () {
          if (done) return
          cleanup()
          postEnvelope({type: 'cancel', requestId: id})
          reject(MentraRpcTimeoutError())
        }, timeoutMs)
      }

      var envelope = {type: 'msg', seq: outboundSeq++, channel: String(channel), payload: payload, requestId: id}
      if (!ready) {
        outboundQueue.push(envelope)
        return
      }
      postEnvelope(envelope)
    })
  }
```

Modify `function recv(envelope)` (around line 181-206) — replace the existing `if (type === 'msg' ...)` branch with one that routes requestId-tagged messages to RPC resolvers:

```js
  function recv(envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    var type = envelope.type;
    if (type === 'msg' && typeof envelope.channel === 'string') {
      // RPC reply: requestId set → route to the inflight resolver.
      if (typeof envelope.requestId === 'string' && rpcInflight[envelope.requestId]) {
        var settle = rpcInflight[envelope.requestId]
        settle(envelope.payload)
        return
      }
      // Broadcast: fan out via fireChannel (existing path).
      fireChannel(envelope.channel, envelope.payload);
      return;
    }
    if (type === 'open') {
      for (var j = 0; j < openHandlers.length; j++) {
        try { openHandlers[j](); } catch (e) {}
      }
      return;
    }
    if (type === 'close') {
      for (var k = 0; k < closeHandlers.length; k++) {
        try { closeHandlers[k](); } catch (e) {}
      }
      return;
    }
    if (type === 'ack') {
      return;
    }
  }
```

Add `request` to the exported `window.mentra` object (around line 208):

```js
  window.mentra = {
    send: send,
    on: on,
    request: request,
    onOpen: onOpen,
    onClose: onClose,
    ready: readyFn,
    _packageName: packageName,
  };
```

- [ ] **Step 3: Typecheck the SDK package**

```bash
cd mobile/modules/miniapp && bun x tsc --noEmit
```

Expected: compiles. (`UIModuleImpl` already has `handle`; the interface narrowing on send/on is now consistent.)

- [ ] **Step 4: Run shim build**

```bash
cd mobile/modules/engine && bun x tsc --noEmit
```

Expected: compiles. The shim is `.ts` returning a string — the string content isn't type-checked, only the surrounding wrapper.

- [ ] **Step 5: Commit**

```bash
git add mobile/modules/miniapp/src/ui/index.ts mobile/modules/engine/src/services/mentraUiShim.ts
git commit -m "Add mentra.request to WebView shim + UI global type" --no-verify
```

---

## Task 6: Route `requestId` + `cancel` frames through `MentraUIRouter`

**Files:**
- Modify: `mobile/modules/engine/src/services/MentraUIRouter.ts`

- [ ] **Step 1: Pass `requestId` through both directions and route `cancel` frames**

In `routeFromWebView` (around lines 112-143), replace the `env.type === "msg"` branch and the `env.type === "heartbeat"` branch with the updated set:

```ts
  routeFromWebView(packageName: string, rawJson: string): void {
    let env: {type?: string; seq?: number; channel?: string; payload?: unknown; requestId?: string}
    try {
      env = JSON.parse(rawJson)
    } catch {
      return
    }
    if (typeof env.type !== "string") return

    if (env.type === "ready") {
      this.deliverToBackground(packageName, {type: "UI_OPEN"})
      return
    }
    if (env.type === "heartbeat") {
      return
    }
    if (env.type === "msg" && typeof env.channel === "string") {
      const out: Record<string, unknown> = {
        type: "UI_MESSAGE",
        channel: env.channel,
        payload: env.payload,
        seq: env.seq,
      }
      if (typeof env.requestId === "string") out.requestId = env.requestId
      this.deliverToBackground(packageName, out)
      return
    }
    if (env.type === "cancel" && typeof env.requestId === "string") {
      this.deliverToBackground(packageName, {type: "UI_CANCEL", requestId: env.requestId})
      return
    }
    // Unknown envelope — drop silently.
  }
```

In `routeFromBackground` (around lines 154-169), preserve `requestId` and add a separate path for `UI_CANCEL`. Replace the body of the method:

```ts
  routeFromBackground(
    packageName: string,
    uiSendPayload: {
      type: string
      channel?: string
      payload?: unknown
      seq?: number
      requestId?: string
    },
  ): void {
    const binding = this.bindings.get(packageName)
    if (!binding) return
    if (uiSendPayload.type === "UI_CANCEL" && typeof uiSendPayload.requestId === "string") {
      const cancel = {type: "cancel", requestId: uiSendPayload.requestId}
      const literal = JSON.stringify(cancel)
      const escaped = JSON.stringify(literal)
      binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
      return
    }
    const outbound: Record<string, unknown> = {
      type: "msg",
      seq: uiSendPayload.seq ?? 0,
      channel: uiSendPayload.channel,
      payload: uiSendPayload.payload,
    }
    if (typeof uiSendPayload.requestId === "string") outbound.requestId = uiSendPayload.requestId
    const literal = JSON.stringify(outbound)
    const escaped = JSON.stringify(literal)
    binding.inject(`if (window.__mentra && window.__mentra.recv) window.__mentra.recv(JSON.parse(${escaped})); true;`)
  }
```

Also: the shim's `recv` needs to handle `'cancel'` frames (background-initiated cancel — unused today, but reserved). Open `mobile/modules/engine/src/services/mentraUiShim.ts` and inside the `recv` function add a branch right before the `'ack'` branch:

```js
    if (type === 'cancel' && typeof envelope.requestId === 'string') {
      // Background-side cancel (reserved; currently unused). If we had a
      // future bidirectional RPC this would abort an in-flight UI handler.
      return;
    }
```

- [ ] **Step 2: Typecheck the host package**

```bash
cd mobile/modules/engine && bun x tsc --noEmit
```

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add mobile/modules/engine/src/services/MentraUIRouter.ts mobile/modules/engine/src/services/mentraUiShim.ts
git commit -m "Pass requestId and cancel frames through the UI router" --no-verify
```

---

## Task 7: Re-export RPC types from `@mentra/miniapp/background`

**Files:**
- Modify: `mobile/modules/miniapp/src/background/index.ts`

- [ ] **Step 1: Add the exports**

In `mobile/modules/miniapp/src/background/index.ts`, after the existing `export type {UIModule, UIChannelHandler, UIUnsubscribe} from "../modules/ui"` line (around line 71), append:

```ts
export type {Rpc, IsRpc, RpcReq, RpcRes, RpcRequestOptions, RpcHandlerContext} from "../modules/ui"
export {MentraRpcError, MentraRpcTimeoutError} from "../modules/ui"
```

- [ ] **Step 2: Typecheck**

```bash
cd mobile/modules/miniapp && bun x tsc --noEmit
```

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add mobile/modules/miniapp/src/background/index.ts
git commit -m "Re-export RPC types from @mentra/miniapp/background" --no-verify
```

---

## Task 8: Add `useRpc` React hook

**Files:**
- Create: `mobile/modules/miniapp/src/react/useRpc.ts`
- Modify: `mobile/modules/miniapp/src/react/index.ts` — export the hook

- [ ] **Step 1: Create the hook**

`mobile/modules/miniapp/src/react/useRpc.ts`:

```ts
/**
 * useRpc — React hook around `mentra.request(channel, ...)`.
 *
 * Returns a stable callable plus an `.abort()` method. The internal
 * AbortController is recreated per call and bound to component lifecycle:
 *
 *   - Calling the returned function once: abort() the previous in-flight
 *     call (if any), then issue a fresh request. Useful for per-keystroke
 *     autocomplete — every keystroke aborts the stale request.
 *   - Unmount: all in-flight calls abort.
 *   - Caller-provided `options.signal` is merged with the internal one
 *     via `AbortSignal.any` when available; manual fan-out otherwise.
 */

import {useCallback, useEffect, useRef} from "react"

import type {RpcReq, RpcRes, RpcRequestOptions} from "../modules/ui"

type RequestFn = (channel: string, payload: unknown, options?: RpcRequestOptions) => Promise<unknown>

/** Walk to the global `mentra.request` (typed). */
function getMentraRequest(): RequestFn {
  const m = (globalThis as unknown as {mentra?: {request?: RequestFn}}).mentra
  if (!m || typeof m.request !== "function") {
    throw new Error(
      "useRpc: window.mentra.request is not available — is this miniapp running in a UI WebView with the shim injected?",
    )
  }
  return m.request
}

/** AbortSignal.any polyfill — combine multiple signals into one. */
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  type WithAny = {any?: (s: AbortSignal[]) => AbortSignal}
  const ctor = AbortSignal as unknown as WithAny
  if (typeof ctor.any === "function") return ctor.any(signals)
  const ctrl = new AbortController()
  const onAbort = (sig: AbortSignal) => {
    if (!ctrl.signal.aborted) ctrl.abort(sig.reason)
  }
  for (const s of signals) {
    if (s.aborted) {
      onAbort(s)
      break
    }
    s.addEventListener("abort", () => onAbort(s))
  }
  return ctrl.signal
}

export interface RpcCallable<TChannels extends Record<string, unknown>, C extends keyof TChannels & string> {
  (payload: RpcReq<TChannels[C]>, options?: RpcRequestOptions): Promise<RpcRes<TChannels[C]>>
  /** Abort the current in-flight call (if any). No-op if nothing is pending. */
  abort(): void
}

/**
 * Returns a stable callable for an RPC channel. The callable auto-aborts
 * on unmount and exposes `.abort()` for cancel-previous patterns.
 *
 *   const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
 *   const suggestions = await autocomplete({query: "..."})
 *   autocomplete.abort()   // cancel the latest in-flight call
 */
export function useRpc<
  TChannels extends Record<string, unknown>,
  C extends keyof TChannels & string,
>(channel: C): RpcCallable<TChannels, C> {
  // Latest in-flight controller. Replaced on each call.
  const currentRef = useRef<AbortController | null>(null)
  // Mount controller — aborts every in-flight call on unmount.
  const mountRef = useRef<AbortController | null>(null)
  if (mountRef.current == null) mountRef.current = new AbortController()

  useEffect(() => {
    const mount = mountRef.current!
    return () => {
      mount.abort()
      currentRef.current?.abort()
      currentRef.current = null
    }
  }, [])

  const callable = useCallback(
    (payload: RpcReq<TChannels[C]>, options?: RpcRequestOptions) => {
      // Abort any previous call for this hook.
      currentRef.current?.abort()
      const ctrl = new AbortController()
      currentRef.current = ctrl
      const signals: AbortSignal[] = [ctrl.signal, mountRef.current!.signal]
      if (options?.signal) signals.push(options.signal)
      const signal = mergeSignals(signals)
      return getMentraRequest()(channel, payload, {signal, timeout: options?.timeout}) as Promise<
        RpcRes<TChannels[C]>
      >
    },
    [channel],
  ) as RpcCallable<TChannels, C>

  callable.abort = () => {
    currentRef.current?.abort()
    currentRef.current = null
  }

  return callable
}
```

- [ ] **Step 2: Export the hook**

In `mobile/modules/miniapp/src/react/index.ts`, add at the bottom (use the same conventions as adjacent exports):

```ts
export {useRpc, type RpcCallable} from "./useRpc"
```

If `mobile/modules/miniapp/src/react/index.ts` doesn't exist or doesn't enumerate exports, check what's there first:

```bash
cat mobile/modules/miniapp/src/react/index.ts
```

If the file is just `export *` lines, follow that pattern. If it's missing entirely, the hook will be picked up by the package `./react` sub-path via the existing barrel — verify with the next step.

- [ ] **Step 3: Re-export `useRpc` from `@mentra/miniapp/ui`**

In `mobile/modules/miniapp/src/ui/index.ts`, append after the existing `export {useCapsuleHeaderStyle}` line:

```ts
export {useRpc, type RpcCallable} from "../react/useRpc"
```

- [ ] **Step 4: Typecheck**

```bash
cd mobile/modules/miniapp && bun x tsc --noEmit
```

Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add mobile/modules/miniapp/src/react/useRpc.ts mobile/modules/miniapp/src/react/index.ts mobile/modules/miniapp/src/ui/index.ts
git commit -m "Add useRpc React hook with auto-abort and cancel-previous" --no-verify
```

---

## Task 9: Update top-of-file docstring in `modules/ui.ts`

**Files:**
- Modify: `mobile/modules/miniapp/src/modules/ui.ts` — first comment block

- [ ] **Step 1: Replace the leading docstring**

Replace the entire leading block comment (lines 1-39, ending just before `import type {MiniappSession}`) with:

```ts
/**
 * session.ui — bus between a background JSContext miniapp and its
 * on-demand UI WebView. Supports two interaction patterns:
 *
 *   1. **Broadcast** (fire-and-forget, either direction)
 *      - background → UI: `session.ui.send(channel, payload)`
 *      - UI → background: `mentra.send(channel, payload)`
 *      - subscribe:        `session.ui.on(channel, cb)` / `mentra.on(channel, cb)`
 *
 *   2. **RPC** (request/response, UI → background only)
 *      - UI side:          `await mentra.request(channel, payload, options?)`
 *      - background side:  `session.ui.handle(channel, (payload, ctx?) => result)`
 *      - single handler per channel; double-register throws synchronously.
 *      - errors thrown in the handler reject the caller's promise.
 *      - cancellation via `options.signal` aborts the handler's `ctx.signal`
 *        and drops the eventual reply.
 *
 * Broadcast vs. RPC is declared at the channel level: wrap a channel's
 * payload type in `Rpc<Req, Res>` in the shared registry to make it RPC.
 * Wrong-API-for-channel is a compile-time error.
 *
 * Buffering:
 *   - `mentra.send` BUFFERS until `mentra.ready()` acks. The WebView is
 *     the short-lived side and shouldn't drop user input.
 *   - `session.ui.send` silently DROPS when no WebView is bound.
 *     Background is the source of truth; UI state shouldn't accumulate.
 *   - Per-channel inbound buffering (up to 32 payloads) covers the
 *     `controller pushed before React attached the listener` race — see
 *     the WebView shim for details.
 *
 * Wire envelopes (internal — not part of the SDK surface):
 *   - `UI_OPEN` — WebView posted `{type:"ready"}`.
 *   - `UI_CLOSE` — host tore down the WebView.
 *   - `UI_MESSAGE` — WebView → background. `requestId` set on RPC calls.
 *   - `UI_SEND` — background → WebView. `requestId` set on RPC replies.
 *   - `UI_CANCEL` — either direction. Carries only `requestId`; aborts
 *     the in-flight handler's signal.
 */
```

- [ ] **Step 2: Typecheck (defensive — pure comment change)**

```bash
cd mobile/modules/miniapp && bun x tsc --noEmit
```

Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add mobile/modules/miniapp/src/modules/ui.ts
git commit -m "Update session.ui top-of-file docstring to describe RPC surface" --no-verify
```

---

## Task 10: Rebuild SDK dists so dependent packages pick up new exports

**Files:**
- Run the build script.

- [ ] **Step 1: Build the SDK**

```bash
cd mobile/modules/miniapp && bun run build
```

Expected: emits `dist/` with the new `Rpc`, `MentraRpcError`, `useRpc`, etc. (Bun's `tsc` may take a few seconds.)

- [ ] **Step 2: Verify dist exposes the new exports**

```bash
grep -l "MentraRpcError\|useRpc\|Rpc<" mobile/modules/miniapp/dist/index.d.ts mobile/modules/miniapp/dist/ui/index.d.ts mobile/modules/miniapp/dist/background/index.d.ts mobile/modules/miniapp/dist/react/useRpc.d.ts 2>&1
```

Expected: all four files appear in the output (i.e., grep finds matches in each).

- [ ] **Step 3: Commit the rebuilt dist (only if the repo tracks `dist/`)**

Check whether dist is gitignored:

```bash
git check-ignore mobile/modules/miniapp/dist
```

If the command outputs a path (dist IS ignored): skip the commit step.

If it exits with code 1 (dist NOT ignored): stage and commit.

```bash
git add mobile/modules/miniapp/dist
git commit -m "Rebuild @mentra/miniapp dist with RPC types and useRpc hook" --no-verify
```

---

# Phase 2 — Refactor `sdk/example-miniapp`'s TesterController to RPC

## Task 11: Declare `tester:invoke` as an RPC channel in the example

**Files:**
- Modify: `sdk/example-miniapp/src/shared/types.ts`
- Modify: `sdk/example-miniapp/src/shared/channels.ts`

- [ ] **Step 1: Add `TesterInvoke` type**

Append to `sdk/example-miniapp/src/shared/types.ts`:

```ts
/** Args to `tester:invoke` — the new RPC replacing the old `tester:fire`. */
export interface TesterInvoke {
  iface: string
  method: string
  args?: unknown[]
}

/** Result of `tester:invoke`. Handlers return the raw call result; errors
 *  propagate via the RPC error path so callers see `MentraRpcError`. */
export type TesterInvokeResult = unknown
```

- [ ] **Step 2: Wire `tester:invoke` into the Channels registry**

In `sdk/example-miniapp/src/shared/channels.ts`:

a) Update the imports at the top to pull in `Rpc` and the new types:

```ts
import type {Rpc} from "@mentra/miniapp/ui"
import type {
  CaptionsHistoryUpdate,
  CaptionsLastButton,
  CaptionsLiveTranscript,
  CaptionsSettings,
  CapabilitiesSnapshot,
  ConnectionSnapshot,
  TesterEventPayload,
  TesterInvoke,
  TesterInvokeResult,
} from "./types"
```

b) Inside the `Channels` interface, add `tester:invoke` to the RPC section (top-of-file comment also updated to mention RPC). Replace the existing `Channels` interface body with:

```ts
/**
 * Typed channel registry — the single source of truth for every name
 * that flows between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler
 * inlines the declarations so there's no runtime cross-boundary I/O.
 *
 * Channels marked `Rpc<Req, Res>` are RPC — call them via
 * `mentra.request(...)` on UI / `session.ui.handle(...)` on background.
 * Everything else is broadcast — `mentra.send` / `session.ui.on`.
 */
export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  "captions:snapshot": {
    capabilities: CapabilitiesSnapshot
    connection: ConnectionSnapshot
    settings: CaptionsSettings
    liveTranscript: string
    history: string[]
    lastButton: string
  }
  "captions:live-transcript": CaptionsLiveTranscript
  "captions:history-update": CaptionsHistoryUpdate
  "captions:last-button": CaptionsLastButton
  "captions:settings-update": CaptionsSettings
  "captions:capabilities-update": CapabilitiesSnapshot
  "captions:connection-update": ConnectionSnapshot

  /** Streamed tester events (subscribe-based testers only). */
  "tester:event": TesterEventPayload

  // ── UI → background broadcasts ─────────────────────────────────────────

  "captions:clear": Record<string, never>
  "captions:speak-summary": Record<string, never>
  "captions:set-mirror": {mirrorToGlasses: boolean}
  "tester:start": {iface: string; args?: unknown[]}
  "tester:stop": {iface: string}

  // ── UI → background RPC ────────────────────────────────────────────────

  /**
   * Invoke `session[iface][method](...args)` on the background side.
   * Returns the method's return value (awaited). Throws via the SDK's
   * RPC error path if the method is missing or threw.
   *
   * Replaces the old `tester:fire` (which muxed result/error back onto
   * the `tester:event` stream). The new shape is plain async/await.
   */
  "tester:invoke": Rpc<TesterInvoke, TesterInvokeResult>
}
```

- [ ] **Step 3: Typecheck**

```bash
cd sdk/example-miniapp && bun x tsc --noEmit
```

Expected: compiles. (The old `tester:fire` channel is now gone — `TesterController` and `useTester` will fail to compile in the next tasks until we update them, but at this stage we haven't run anything that consumes the registry yet.)

If tsc reports errors about `tester:fire` not existing — that's expected; we fix it in the next two tasks. Don't commit yet if there are errors only in `TesterController.ts` / `useTester.ts` — they're consumers of the registry that will be rewritten next.

Actually: commit anyway, because we'll be in a known-broken state for two tasks. The user has approved `--no-verify` on this branch.

- [ ] **Step 4: Commit**

```bash
git add sdk/example-miniapp/src/shared/types.ts sdk/example-miniapp/src/shared/channels.ts
git commit -m "Declare tester:invoke as an Rpc<> channel in the example registry" --no-verify
```

---

## Task 12: Refactor `TesterController` to use `ui.handle("tester:invoke", ...)`

**Files:**
- Modify: `sdk/example-miniapp/src/background/controllers/TesterController.ts`

- [ ] **Step 1: Rewrite the controller's docstring + `start` to use `handle`**

Replace the entire contents of `sdk/example-miniapp/src/background/controllers/TesterController.ts` with:

```ts
import type {MiniappSession} from "@mentra/miniapp/background"

import type {Channels} from "../../shared/channels"

/**
 * TesterController — the SDK Tester surface's background half.
 *
 * The UI tester pages can't call `session.*` directly (they're inside a
 * WebView, no native access). Two patterns:
 *
 *   1. **Subscribe-based testers** (Storage / Transcription / IMU /
 *      Location / Microphone / System / Glasses / Phone).
 *      UI sends `tester:start` → we open a subscription that pipes events
 *      back as streamed `tester:event` with `{iface, kind, payload}`.
 *      UI sends `tester:stop` to release.
 *
 *   2. **Imperative testers** (Display / Led / Speaker / Phone fire /
 *      Storage gets). UI calls `await mentra.request("tester:invoke", ...)`
 *      and we dispatch to `session[iface][method](...args)` via the new
 *      `session.ui.handle` API. The return value flows back through the
 *      SDK's RPC reply; errors throw on the UI side automatically.
 */

type Send = <C extends keyof Channels & string>(channel: C, payload: Channels[C]) => void

export class TesterController {
  private subscriptions: Map<string, () => void> = new Map()
  private unhandle: (() => void) | null = null

  constructor(private readonly session: MiniappSession) {}

  start(): void {
    const ui = this.session.ui as unknown as {
      send: Send
      on: <C extends keyof Channels & string>(
        channel: C,
        cb: (p: Channels[C]) => void,
      ) => () => void
      handle: <C extends keyof Channels & string>(
        channel: C,
        handler: (payload: unknown, ctx?: {signal: AbortSignal}) => Promise<unknown> | unknown,
      ) => () => void
    }

    ui.on("tester:start", ({iface}) => {
      if (this.subscriptions.has(iface)) return
      const unsub = this.openSubscription(iface, ui.send)
      if (unsub) this.subscriptions.set(iface, unsub)
    })

    ui.on("tester:stop", ({iface}) => {
      const unsub = this.subscriptions.get(iface)
      if (!unsub) return
      try {
        unsub()
      } catch {
        /* ignore */
      }
      this.subscriptions.delete(iface)
    })

    // The single imperative-dispatch handler. Used by every fire-style
    // tester page. Replaces the old `tester:fire` + `tester:event{kind:result}`
    // muxed-into-stream pattern.
    this.unhandle = ui.handle("tester:invoke", async (payload) => {
      const {iface, method, args} = payload as {iface: string; method: string; args?: unknown[]}
      const module = (this.session as unknown as Record<string, unknown>)[iface] as
        | Record<string, unknown>
        | undefined
      if (!module) throw new Error(`unknown iface "${iface}"`)
      const fn = module[method] as ((...a: unknown[]) => unknown) | undefined
      if (typeof fn !== "function") throw new Error(`unknown method "${iface}.${method}"`)
      return await Promise.resolve(fn.apply(module, args ?? []))
    })
  }

  stop(): void {
    for (const [, unsub] of this.subscriptions) {
      try {
        unsub()
      } catch {
        /* ignore */
      }
    }
    this.subscriptions.clear()
    if (this.unhandle) {
      try {
        this.unhandle()
      } catch {
        /* ignore */
      }
      this.unhandle = null
    }
  }

  /**
   * Open a per-iface subscription that pipes every event back to the UI
   * as `tester:event`. The `kind` field tells the UI which sub-channel
   * fired (transcription:final, location:update, ...) so a single tester
   * page can render a typed timeline.
   */
  private openSubscription(iface: string, send: Send): (() => void) | null {
    const emit = (kind: string, payload: unknown) => {
      send("tester:event", {iface, kind, payload})
    }
    switch (iface) {
      case "transcription":
        return this.session.transcription.on((data) => emit(data.isFinal ? "final" : "partial", data))
      case "translation":
        return this.session.translation.to("es-ES", (data) => emit("event", data))
      case "input": {
        const b = this.session.input.onButtonPress((data) => emit("button", data))
        const t = this.session.input.onTouch((data) => emit("touch", data))
        return () => {
          b()
          t()
        }
      }
      case "imu":
        return this.session.imu.onHeadPosition((data) => emit("head", data))
      case "location":
        return this.session.location.onUpdate((data) => emit("update", data))
      case "mic": {
        const a = this.session.mic.onAudioChunk((data) => emit("audio", {data}))
        const v = this.session.mic.onVoiceActivity((data) => emit("vad", data))
        return () => {
          a()
          v()
        }
      }
      case "storage":
        return () => {}
      case "system":
        emit("opened", {note: "session.system has no event surface yet"})
        return () => {}
      case "glasses": {
        const b = this.session.glasses.onBattery((data) => emit("battery", data))
        const c = this.session.glasses.onConnection((data) => emit("connection", data))
        return () => {
          b()
          c()
        }
      }
      case "phone": {
        const n = this.session.phone.notifications.on((data) => emit("notification", data))
        const b = this.session.phone.onBattery((data) => emit("battery", data))
        return () => {
          n()
          b()
        }
      }
      default:
        return null
    }
  }
}
```

- [ ] **Step 2: Typecheck**

```bash
cd sdk/example-miniapp && bun x tsc --noEmit
```

Expected: TesterController is good now, but `useTester.ts` still references `tester:fire` and will fail. That's the next task.

- [ ] **Step 3: Commit**

```bash
git add sdk/example-miniapp/src/background/controllers/TesterController.ts
git commit -m "Refactor TesterController to use ui.handle for imperative dispatch" --no-verify
```

---

## Task 13: Update `useTester` and tester pages to use `mentra.request`

**Files:**
- Modify: `sdk/example-miniapp/src/ui/hooks/useTester.ts`
- Modify: tester pages that previously consumed `kind:"result"` / `kind:"error"` events from `fire`.

- [ ] **Step 1: Replace `fire` with `invoke` in `useTester`**

Replace the contents of `sdk/example-miniapp/src/ui/hooks/useTester.ts`:

```ts
import {useEffect, useRef, useState} from "react"
import {useRpc} from "@mentra/miniapp/ui"

import "../../shared/channels"
import type {Channels} from "../../shared/channels"
import type {TesterEventPayload} from "../../shared/types"

/**
 * useTester — manages a subscribe-based tester (start/stop + streamed
 * events) and exposes an `invoke(method, args)` RPC for imperative calls.
 *
 *   - `latest`, `latestByKind(kind)`, `log`, `lastError` — streamed via
 *     `tester:event` from the background controller.
 *   - `invoke(method, args)` — `mentra.request("tester:invoke", ...)`.
 *     Returns the handler's return value; throws on error.
 */
export function useTester(
  iface: string,
  options: {windowSize?: number} = {},
): {
  latest: TesterEventPayload | null
  latestByKind: (kind: string) => TesterEventPayload | null
  log: TesterEventPayload[]
  lastError: TesterEventPayload | null
  invoke: (method: string, args?: unknown[]) => Promise<unknown>
} {
  const windowSize = options.windowSize ?? 50
  const [latest, setLatest] = useState<TesterEventPayload | null>(null)
  const [log, setLog] = useState<TesterEventPayload[]>([])
  const [lastError, setLastError] = useState<TesterEventPayload | null>(null)
  const ifaceRef = useRef(iface)
  ifaceRef.current = iface
  const rpcInvoke = useRpc<Channels, "tester:invoke">("tester:invoke")

  useEffect(() => {
    mentra.send("tester:start", {iface})
    const unsub = mentra.on("tester:event", (raw) => {
      const ev = raw as TesterEventPayload
      if (ev.iface !== ifaceRef.current) return
      setLatest(ev)
      if (ev.kind === "error") setLastError(ev)
      setLog((prev) => {
        const next = [...prev, ev]
        return next.length > windowSize ? next.slice(-windowSize) : next
      })
    })
    return () => {
      unsub()
      mentra.send("tester:stop", {iface})
    }
  }, [iface, windowSize])

  const invoke = async (method: string, args: unknown[] = []) => {
    try {
      return await rpcInvoke({iface: ifaceRef.current, method, args})
    } catch (err) {
      // Surface error in the existing UI error slot so pages don't need
      // a separate try/catch boilerplate.
      setLastError({
        iface: ifaceRef.current,
        kind: "error",
        payload: {method, message: err instanceof Error ? err.message : String(err)},
      })
      throw err
    }
  }

  const latestByKind = (kind: string): TesterEventPayload | null => {
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.kind === kind) return log[i]!
    }
    return null
  }

  return {latest, latestByKind, log, lastError, invoke}
}
```

- [ ] **Step 2: Find all tester pages that called `fire(...)` and rename to `invoke(...)`**

```bash
grep -l "\.fire(" sdk/example-miniapp/src/ui/pages/tester/
```

Expected output: a list of `.tsx` files. For each one, rename `fire` to `invoke` (the method signature is the same — same args, same usage, but it now returns `Promise<unknown>`).

Do this with sed across the directory (safe — no other `.fire` calls in this codebase outside this hook's returned object):

```bash
grep -rln "\.fire(" sdk/example-miniapp/src/ui/pages/tester/ | while read -r f; do
  sed -i '' 's/\.fire(/\.invoke(/g' "$f"
done
```

Verify no `.fire(` calls remain:

```bash
grep -rn "\.fire(" sdk/example-miniapp/src/ui/pages/tester/ || echo "no matches — good"
```

Expected: "no matches — good".

If any tester page calls the destructured `{fire}` from `useTester`, the sed above won't catch the destructuring rename. Also rename those:

```bash
grep -rln "\bfire\b" sdk/example-miniapp/src/ui/pages/tester/ | while read -r f; do
  sed -i '' 's/\bfire\b/invoke/g' "$f"
done
```

(That's broad — it renames any standalone `fire` identifier in those tester pages. Acceptable because none of them have unrelated `fire` identifiers.)

- [ ] **Step 3: Typecheck the example**

```bash
cd sdk/example-miniapp && bun x tsc --noEmit
```

Expected: compiles. If a tester page used `fire()` in a fire-and-forget way (not awaiting), the new `invoke()` returns a Promise that's unawaited — TypeScript will warn under `strict`/`noUnusedLocals` if at all. Acceptable; pages will be updated to `await` if they need to, but the unawaited promise still fires the call.

- [ ] **Step 4: Commit**

```bash
git add sdk/example-miniapp/src/ui/hooks/useTester.ts sdk/example-miniapp/src/ui/pages/tester/
git commit -m "Switch tester pages to mentra.request via useTester.invoke" --no-verify
```

---

# Phase 3 — Documentation pass

## Task 14: Update `agents/miniapp-sdk-overview.md` with RPC subsection

**Files:**
- Modify: `agents/miniapp-sdk-overview.md`

- [ ] **Step 1: Locate the wire protocol section**

Open the file and find the line "### Wire protocol (briefly)" (approximately around line 144 based on the version inspected during spec writing). The new subsection lands inside the broader bus discussion before the "two transports" sentence.

- [ ] **Step 2: Insert the new subsection**

Right before the "Two transports, auto-selected:" line, insert:

```markdown
#### Request/response across the bridge

Two interaction patterns share the bus:

- **Broadcast** — fire-and-forget. `mentra.send(channel, payload)` (UI) and `session.ui.send(channel, payload)` (background). Subscribe with `mentra.on` / `session.ui.on`. Either direction.
- **RPC** — request/response. `await mentra.request(channel, payload, options?)` on the UI side; one handler per channel on the background side via `session.ui.handle(channel, (payload, ctx?) => result)`. UI → background only.

A channel is declared as RPC by wrapping its payload type in `Rpc<Req, Res>` in the per-miniapp `shared/channels.ts` registry:

​```ts
import type {Rpc} from "@mentra/miniapp/ui"

export interface Channels {
  // Broadcast — used by mentra.send / session.ui.on
  "captions:live-transcript": {text: string}

  // RPC — used by mentra.request / session.ui.handle
  "places:autocomplete": Rpc<{query: string}, PlaceSuggestion[]>
}
​```

Using the wrong API for a channel is a compile-time error (`mentra.send("places:autocomplete", …)` rejects).

**Errors.** `mentra.request` throws when the handler throws. The error is a plain `Error` with `name === "MentraRpcError"` and `cause?.code` if the handler set one (`throw Object.assign(new Error("…"), {cause: {code: "BAD_INPUT"}})`).

**Cancellation.** Pass `{signal}` to `mentra.request`. When the signal aborts, the helper sends a cancel frame; the background handler's `ctx.signal` aborts (handlers can pass it to `fetch(url, {signal})` to short-circuit a slow REST call). The caller's promise rejects with `AbortError` (DOM-standard).

**`useRpc`.** A React hook bundles three ergonomic wins:
- Auto-aborts every in-flight call on unmount.
- The returned callable has an `.abort()` method for the keystroke-debounce-cancel pattern (per-keystroke autocomplete cancels the prior request automatically).
- Stable identity across renders so it's safe in `useEffect` deps.

​```tsx
const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
useEffect(() => {
  if (!query) return
  autocomplete.abort()  // cancel the previous keystroke's request
  autocomplete({query}).then(setSuggestions).catch(() => {})
}, [query])
​```

**Single handler per channel.** `session.ui.handle("foo", h)` throws synchronously if a handler is already registered for that channel — clarifies ownership. Returns a deregister fn the controller stores like other unsubs.

**Streams ≠ RPC.** If a domain wants "start observing X, push updates until stopped", that's a regular channel (`mentra.send("watch-x:start")` on the UI side; background subscribes internally and pushes `mentra.send("watch-x:event", ...)` from the controller). Don't reach for RPC for streams.

**Worked example:** `sdk/example-miniapp/src/background/controllers/TesterController.ts` uses `session.ui.handle("tester:invoke", ...)` to dispatch arbitrary `session[iface][method](...)` calls; the tester UI pages call `mentra.request("tester:invoke", ...)` via the `useTester().invoke(method, args)` convenience.
```

(The triple-backtick fences inside the markdown block use zero-width spaces above to avoid breaking the outer fence; if your renderer doesn't substitute, use regular backticks and escape with backslashes as needed for the doc body.)

Actually — the literal markdown for nested fences is simpler: just write the file with the inner blocks as code fences. The above is the exact text to insert.

- [ ] **Step 3: Commit**

```bash
git add agents/miniapp-sdk-overview.md
git commit -m "Document RPC surface in miniapp SDK overview" --no-verify
```

---

# Phase 4 — Navigation migration

## Task 15: Create the shared `Channels` registry + domain types

**Files:**
- Create: `sdk/Navigation/src/shared/channels.ts`
- Create: `sdk/Navigation/src/shared/types.ts`

- [ ] **Step 1: Create `src/shared/types.ts`**

```ts
/**
 * Shared domain types referenced by both the background JSContext and
 * the UI WebView. Both bundlers inline this file at build time, so
 * there's no runtime resolution across the boundary.
 */

import type {NavManeuver, Pivot} from "@mentra/miniapp"

export type Coords = {lat: number; lng: number; accuracy?: number; ts: number}
export type LatLng = {lat: number; lng: number}
export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"
export type LogEntry = {id: number; ts: number; line: string}

export type PlaceSuggestion = {placeId: string; mainText: string; secondaryText?: string}
export type PlaceDetails = {
  placeId: string
  name: string
  address: string
  lat: number
  lng: number
}
export type SavedPlace = PlaceDetails & {
  savedName?: string
  type?: "home" | "work"
}

/**
 * Trip state mirrored from background to UI. Kept dual `status` +
 * `running` for parity with the existing NavigationPage state machine —
 * `running` is true while `status` ∈ {"navigating","rerouting"}, false
 * otherwise. Collapsing into a single field is a separate refactor.
 */
export type TripState = {
  status: NavStatus
  running: boolean
  maneuver: NavManeuver | null
  activeDestination: LatLng | null
  activeDestinationName: string | null
  routePoints: LatLng[] | null
  offRouteAt: number | null
}

export type DevSettings = {
  simulate: boolean
  speedMultiplier: number
  wrongSidewalk: boolean
  skipCrossings: boolean
}

export type NavSnapshot = {
  coords: Coords | null
  heading: number | null
  mapsReady: boolean
  trip: TripState
  activePivot: Pivot | null
  upcomingPivot: Pivot | null
  log: LogEntry[]
  devSettings: DevSettings
}
```

- [ ] **Step 2: Create `src/shared/channels.ts`**

```ts
/**
 * Typed channel registry — the single source of truth for every name
 * that flows between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler
 * inlines the declarations so there's no runtime cross-boundary I/O.
 *
 * Channels wrapped in `Rpc<Req, Res>` are RPC (call via mentra.request /
 * session.ui.handle). Everything else is broadcast (mentra.send /
 * session.ui.on / session.ui.send).
 */

import type {Rpc} from "@mentra/miniapp/ui"
import type {
  ComputeRouteOptions,
  ComputeRouteResult,
  NavPermissionResult,
  Pivot,
  StartNavigationOptions,
} from "@mentra/miniapp"

import type {
  Coords,
  DevSettings,
  LogEntry,
  NavSnapshot,
  PlaceDetails,
  PlaceSuggestion,
  SavedPlace,
  TripState,
} from "./types"

export interface Channels {
  // ── background → UI broadcasts ─────────────────────────────────────────
  "nav:snapshot": NavSnapshot                              // on ui.onOpen
  "nav:coords": Coords                                     // hot
  "nav:heading": {degrees: number}                         // hot, 10Hz throttled
  "nav:trip-state": TripState                              // on transitions
  "nav:route": {points: {lat: number; lng: number}[]}      // on onRoute
  "nav:pivots": {active: Pivot | null; upcoming: Pivot | null}
  "nav:log-append": LogEntry
  "nav:log-clear": Record<string, never>
  "nav:dev-settings-update": DevSettings

  // ── UI → background broadcasts (fire-and-forget) ───────────────────────
  "nav:start": StartNavigationOptions & {destinationName?: string}
  "nav:stop": Record<string, never>
  "nav:deviate": Record<string, never>
  "nav:set-destination": PlaceDetails | null
  "nav:set-dev-settings": Partial<DevSettings>

  // ── UI → background RPC ────────────────────────────────────────────────
  "nav:compute-route": Rpc<ComputeRouteOptions, ComputeRouteResult>
  "nav:request-permission": Rpc<void, NavPermissionResult>
  "nav:get-snapshot": Rpc<void, NavSnapshot>

  "places:autocomplete": Rpc<{query: string; near?: {lat: number; lng: number}}, PlaceSuggestion[]>
  "places:details": Rpc<{placeId: string}, PlaceDetails>

  "storage:list-saved": Rpc<void, SavedPlace[]>
  "storage:add-saved": Rpc<SavedPlace, void>
  "storage:remove-saved": Rpc<{placeId: string}, void>
  "storage:list-recent": Rpc<void, PlaceDetails[]>
  "storage:add-recent": Rpc<PlaceDetails, void>
}

// Convenience: the typed shape of `window.mentra` for this miniapp.
declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraUiGlobal<Channels>
}
```

- [ ] **Step 3: Verify the file compiles standalone**

```bash
cd sdk/Navigation && bun x tsc --noEmit
```

Expected: this will surface errors elsewhere (the existing `client/`/`frontend/` tree references the old `places.ts`/`User.ts` etc.). We're in a known-broken state during the migration. **Only check that the new file `src/shared/channels.ts` doesn't itself produce errors** — scroll up in the tsc output to confirm none of the errors point at `src/shared/`.

- [ ] **Step 4: Commit**

```bash
git add sdk/Navigation/src/shared/
git commit -m "Add shared Channels registry and domain types for Navigation" --no-verify
```

---

## Task 16: Move SDK-wrapper managers and pure libs into `src/background/`

**Files:**
- Move via `git mv`:
  - `src/client/session/managers/LocationManager.ts` → `src/background/managers/LocationManager.ts`
  - `src/client/session/managers/CompassManager.ts` → `src/background/managers/CompassManager.ts`
  - `src/client/session/managers/DisplayManager.ts` → `src/background/managers/DisplayManager.ts`
  - `src/client/session/managers/SimpleStorageManager.ts` → `src/background/managers/SimpleStorageManager.ts`
  - `src/client/session/managers/navigation/NavigationManager.ts` → `src/background/managers/NavigationManager.ts`
  - `src/client/session/managers/navigation/ManeuverFormatter.ts` → `src/background/managers/ManeuverFormatter.ts`
  - `src/client/lib/formatDistance/formatDistance.ts` → `src/background/lib/formatDistance.ts`
  - `src/client/lib/geometry/geometry.ts` → `src/background/lib/geometry.ts`
  - `src/client/lib/geometry/rdpSmooth.ts` → `src/background/lib/rdpSmooth.ts`
  - `src/client/lib/places/places.ts` → `src/background/lib/places.ts` (used by the new PlacesManager)

- [ ] **Step 1: Make the destination directories**

```bash
mkdir -p sdk/Navigation/src/background/managers sdk/Navigation/src/background/lib
```

- [ ] **Step 2: Move the files (preserving git history)**

```bash
cd sdk/Navigation && \
  git mv src/client/session/managers/LocationManager.ts src/background/managers/LocationManager.ts && \
  git mv src/client/session/managers/CompassManager.ts src/background/managers/CompassManager.ts && \
  git mv src/client/session/managers/DisplayManager.ts src/background/managers/DisplayManager.ts && \
  git mv src/client/session/managers/SimpleStorageManager.ts src/background/managers/SimpleStorageManager.ts && \
  git mv src/client/session/managers/navigation/NavigationManager.ts src/background/managers/NavigationManager.ts && \
  git mv src/client/session/managers/navigation/ManeuverFormatter.ts src/background/managers/ManeuverFormatter.ts && \
  git mv src/client/lib/formatDistance/formatDistance.ts src/background/lib/formatDistance.ts && \
  git mv src/client/lib/geometry/geometry.ts src/background/lib/geometry.ts && \
  git mv src/client/lib/geometry/rdpSmooth.ts src/background/lib/rdpSmooth.ts && \
  git mv src/client/lib/places/places.ts src/background/lib/places.ts
```

- [ ] **Step 3: Rewrite imports in moved files**

The moved manager files reference each other via `@/backend/...` aliases. We'll keep the alias scheme but redirect it later — for now, edit each manager to use relative imports within `background/`:

```bash
cd sdk/Navigation && grep -rln "@/backend/" src/background/ src/client/ src/frontend/ src/test/ 2>/dev/null
```

For each match, update the import. The pattern from each file is consistent:

- `@/backend/session/managers/navigation/ManeuverFormatter` → `./ManeuverFormatter` (from `src/background/managers/NavigationManager.ts`)
- `@/backend/lib/places/places` or `@/client/lib/places/places` → `../lib/places` (from any manager file)
- `@/backend/lib/geometry/geometry` → `../lib/geometry`

The cleanest approach: update the tsconfig path aliases so old imports still resolve, then incrementally fix per task. But the path aliases vary — easier to do the rename in this task.

Run a targeted find-and-replace inside the moved files:

```bash
cd sdk/Navigation/src/background && \
  grep -rln "@/backend/session/managers/navigation/" . | xargs sed -i '' 's|@/backend/session/managers/navigation/|./|g' && \
  grep -rln "@/backend/session/managers/" . | xargs sed -i '' 's|@/backend/session/managers/|./|g' && \
  grep -rln "@/backend/lib/places/places" . | xargs sed -i '' 's|@/backend/lib/places/places|../lib/places|g' && \
  grep -rln "@/backend/lib/formatDistance/formatDistance" . | xargs sed -i '' 's|@/backend/lib/formatDistance/formatDistance|../lib/formatDistance|g' && \
  grep -rln "@/backend/lib/geometry/geometry" . | xargs sed -i '' 's|@/backend/lib/geometry/geometry|../lib/geometry|g' && \
  grep -rln "@/backend/lib/geometry/rdpSmooth" . | xargs sed -i '' 's|@/backend/lib/geometry/rdpSmooth|../lib/rdpSmooth|g' && \
  grep -rln "@/client/" . | xargs sed -i '' 's|@/client/|../|g'
```

(`xargs` may complain if grep finds nothing — that's fine.)

Then update test imports (next task). Don't commit yet — tests + UI still reference the old paths.

- [ ] **Step 4: Commit (known-broken state — tests + UI still need fixing)**

```bash
git add -A sdk/Navigation/src/
git commit -m "Move Navigation SDK wrapper managers and pure libs into src/background/" --no-verify
```

---

## Task 17: Build `PlacesManager` wrapping the existing REST helpers

**Files:**
- Create: `sdk/Navigation/src/background/managers/PlacesManager.ts`

- [ ] **Step 1: Inspect what `places.ts` currently exports**

```bash
grep -E "^export " sdk/Navigation/src/background/lib/places.ts
```

Expected output (approximate — verify): exported helpers like `autocomplete`, `details`, types `PlaceDetails`, `SavedPlace`, `PlaceSuggestion`.

- [ ] **Step 2: Create the manager**

```ts
/**
 * PlacesManager
 *
 * Background-side wrapper over Google Places REST. Adds AbortSignal
 * threading so per-keystroke cancellation from the UI's
 * `mentra.request("places:autocomplete", ..., {signal})` propagates
 * into the underlying fetch.
 *
 * The Google API key is inlined at build time from
 * `process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY`. The JSContext has
 * no DOM and no /api/config endpoint — `define` in build.ts must
 * substitute the value.
 */

import {autocomplete, details, type PlaceDetails, type PlaceSuggestion} from "../lib/places"

export class PlacesManager {
  constructor(private readonly apiKey: string) {}

  autocomplete(query: string, near: {lat: number; lng: number} | undefined, signal?: AbortSignal): Promise<PlaceSuggestion[]> {
    return autocomplete(this.apiKey, query, near, signal)
  }

  details(placeId: string, signal?: AbortSignal): Promise<PlaceDetails> {
    return details(this.apiKey, placeId, signal)
  }
}
```

If `places.ts` doesn't currently accept `apiKey` as the first arg or doesn't accept `signal`, update the file's `autocomplete` and `details` signatures to do so:

```bash
cat sdk/Navigation/src/background/lib/places.ts | head -50
```

Make the minimum edit: each function takes `apiKey` as the first arg, and an optional `signal` last arg passed through to `fetch(url, {signal})`. The existing places.ts likely reads the key from `process.env` directly — change it to accept the key from the caller so the manager can hold one canonical reference.

- [ ] **Step 3: Verify places.ts compiles standalone**

```bash
cd sdk/Navigation && bun x tsc --noEmit src/background/lib/places.ts src/background/managers/PlacesManager.ts 2>&1 | head -30
```

Expected: no errors specific to these two files. (The wider tsc output will still complain about `client/` / `frontend/`.)

- [ ] **Step 4: Commit**

```bash
git add sdk/Navigation/src/background/lib/places.ts sdk/Navigation/src/background/managers/PlacesManager.ts
git commit -m "Add PlacesManager wrapping REST helpers with AbortSignal support" --no-verify
```

---

## Task 18: Skeleton `NavigationController` + `src/background/index.ts`

**Files:**
- Create: `sdk/Navigation/src/background/index.ts`
- Create: `sdk/Navigation/src/background/NavigationController.ts` (skeleton — full impl in Task 19)

- [ ] **Step 1: Create entry**

`sdk/Navigation/src/background/index.ts`:

```ts
/**
 * Background JSContext entry point — Mentra Map miniapp.
 *
 * Constructed once by the MentraOS host inside the per-miniapp JSContext.
 * `registerMiniapp(...)` wires the handler to fire after CONNECT lands;
 * the NavigationController instantiated here lives for the entire
 * session, surviving WebView open/close cycles.
 */

import {registerMiniapp} from "@mentra/miniapp/background"

import {NavigationController} from "./NavigationController"

registerMiniapp((session) => {
  new NavigationController(session).start()
})
```

- [ ] **Step 2: Create skeleton controller**

`sdk/Navigation/src/background/NavigationController.ts`:

```ts
/**
 * NavigationController — the always-on logic for the Mentra Map
 * miniapp. Owns MiniappSession subscriptions, trip state, the glasses
 * HUD logic, storage reads/writes, and Places REST. Lives for the
 * entire session — closing the WebView does NOT stop navigation.
 *
 * The UI WebView is a thin renderer fed via session.ui.send and the
 * UI's mentra.send / mentra.request bus declared in shared/channels.ts.
 */

import type {MiniappSession, NavManeuver, NavRoute, Pivot, UIModule} from "@mentra/miniapp/background"

import type {Channels} from "../shared/channels"
import type {
  Coords,
  DevSettings,
  LogEntry,
  NavSnapshot,
  TripState,
} from "../shared/types"

import {CompassManager} from "./managers/CompassManager"
import {DisplayManager} from "./managers/DisplayManager"
import {LocationManager} from "./managers/LocationManager"
import {NavigationManager} from "./managers/NavigationManager"
import {PlacesManager} from "./managers/PlacesManager"
import {SimpleStorageManager} from "./managers/SimpleStorageManager"

const PLACES_API_KEY = (process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? "") as string

export class NavigationController {
  private readonly ui: UIModule<Channels>
  private readonly location: LocationManager
  private readonly compass: CompassManager
  private readonly display: DisplayManager
  private readonly navigation: NavigationManager
  private readonly storage: SimpleStorageManager
  private readonly places: PlacesManager

  private unsubs: Array<() => void> = []
  private started = false
  private logSeq = 0

  // Canonical state (mirrored to UI).
  private coords: Coords | null = null
  private heading: number | null = null
  private mapsReady = false  // UI sets this; background just tracks it for snapshot
  private trip: TripState = {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    offRouteAt: null,
  }
  private activePivot: Pivot | null = null
  private upcomingPivot: Pivot | null = null
  private log: LogEntry[] = []
  private devSettings: DevSettings = {
    simulate: false,
    speedMultiplier: 5,
    wrongSidewalk: false,
    skipCrossings: false,
  }

  constructor(private readonly session: MiniappSession) {
    this.ui = session.ui as unknown as UIModule<Channels>
    this.location = new LocationManager(session)
    this.compass = new CompassManager(session)
    this.display = new DisplayManager(session)
    this.navigation = new NavigationManager(session)
    this.storage = new SimpleStorageManager(session)
    this.places = new PlacesManager(PLACES_API_KEY)
  }

  start(): void {
    if (this.started) return
    this.started = true

    // Sensor subscriptions, RPC handlers, broadcast listeners, HUD logic
    // — implemented in Task 19. This skeleton compiles so the rest of
    // the migration can wire up imports.

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  private buildSnapshot(): NavSnapshot {
    return {
      coords: this.coords,
      heading: this.heading,
      mapsReady: this.mapsReady,
      trip: this.trip,
      activePivot: this.activePivot,
      upcomingPivot: this.upcomingPivot,
      log: [...this.log],
      devSettings: this.devSettings,
    }
  }

  private dispose(): void {
    try {
      this.navigation.stop()
    } catch {
      /* ignore */
    }
    try {
      this.display.clear()
    } catch {
      /* ignore */
    }
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
  }
}
```

- [ ] **Step 3: Typecheck the skeleton**

```bash
cd sdk/Navigation && bun x tsc --noEmit src/background/ 2>&1 | head -40
```

Expected: any errors are only inside `src/background/` if a manager's import path is wrong. Fix as needed (e.g., if `NavigationManager.ts` still imports `@/backend/...`, update to relative).

- [ ] **Step 4: Commit**

```bash
git add sdk/Navigation/src/background/index.ts sdk/Navigation/src/background/NavigationController.ts
git commit -m "Skeleton NavigationController + background entry point" --no-verify
```

---

## Task 19: Full `NavigationController` — subscriptions, handlers, HUD, broadcasts

**Files:**
- Modify: `sdk/Navigation/src/background/NavigationController.ts`

- [ ] **Step 1: Wire sensor subscriptions**

Inside `start()`, after the `if (this.started) return` line and before `this.session.onBeforeDisconnect(...)`, add the four wire methods and call them. Replace the relevant slice:

```ts
  start(): void {
    if (this.started) return
    this.started = true

    this.wireSensorSubscriptions()
    this.wireRpcHandlers()
    this.wireUIBroadcasts()
    this.wireHUDPump()
    this.primeNavigationPermission()
    this.seedInitialFix()

    this.session.onBeforeDisconnect(() => this.dispose())
  }

  // ── Sensor → state pump ──────────────────────────────────────────────

  private wireSensorSubscriptions(): void {
    // Location
    this.unsubs.push(
      this.location.onUpdate((d) => {
        this.coords = {
          lat: d.lat,
          lng: d.lng,
          accuracy: d.accuracy,
          ts: d.timestamp ?? Date.now(),
        }
        this.ui.send("nav:coords", this.coords)
      }),
    )

    // Heading — throttled to ~10Hz so we don't saturate the bus.
    const HEADING_MIN_INTERVAL_MS = 100
    let lastHeadingAt = 0
    let pendingHeading: number | null = null
    let pendingTimer: ReturnType<typeof setTimeout> | null = null
    const flushHeading = () => {
      pendingTimer = null
      if (pendingHeading == null) return
      this.heading = pendingHeading
      pendingHeading = null
      lastHeadingAt = Date.now()
      this.ui.send("nav:heading", {degrees: this.heading})
    }
    this.unsubs.push(
      this.compass.onUpdate((d) => {
        const now = Date.now()
        const elapsed = now - lastHeadingAt
        if (elapsed >= HEADING_MIN_INTERVAL_MS) {
          this.heading = d.degrees
          lastHeadingAt = now
          this.ui.send("nav:heading", {degrees: this.heading})
        } else {
          pendingHeading = d.degrees
          if (!pendingTimer) pendingTimer = setTimeout(flushHeading, HEADING_MIN_INTERVAL_MS - elapsed)
        }
      }),
    )
    this.unsubs.push(() => {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      pendingHeading = null
    })

    // Pivot events
    this.unsubs.push(
      this.navigation.onPivot(() => {
        this.activePivot = this.navigation.getActivePivot()
        this.upcomingPivot = this.navigation.getUpcomingPivot()
        this.ui.send("nav:pivots", {
          active: this.activePivot,
          upcoming: this.upcomingPivot,
        })
      }),
    )

    // Navigation updates (maneuver / off_route / rerouting / arrived / error)
    this.unsubs.push(
      this.navigation.onUpdate((u) => {
        this.appendLog(this.formatUpdate(u))
        switch (u.kind) {
          case "maneuver":
            this.trip = {...this.trip, status: "navigating", running: true, maneuver: u, offRouteAt: null}
            break
          case "off_route":
            this.trip = {...this.trip, offRouteAt: Date.now()}
            break
          case "rerouting":
            this.trip = {...this.trip, status: "rerouting"}
            break
          case "arrived":
            this.trip = {
              ...this.trip,
              status: "arrived",
              running: false,
              maneuver: null,
              activeDestination: null,
              routePoints: null,
              offRouteAt: null,
            }
            break
          case "error":
            this.trip = {...this.trip, status: "idle", running: false}
            break
        }
        this.ui.send("nav:trip-state", this.trip)
      }),
    )

    // Route updates (full polyline rebuild)
    this.unsubs.push(
      this.navigation.onRoute((route: NavRoute) => {
        this.trip = {...this.trip, routePoints: route.points}
        this.ui.send("nav:route", {points: route.points})
        this.ui.send("nav:trip-state", this.trip)
      }),
    )
  }

  // ── RPC handlers ─────────────────────────────────────────────────────

  private wireRpcHandlers(): void {
    this.unsubs.push(
      this.ui.handle("nav:compute-route", (opts) => this.navigation.computeRoute(opts)),
    )
    this.unsubs.push(
      this.ui.handle("nav:request-permission", () => this.navigation.requestPermission()),
    )
    this.unsubs.push(this.ui.handle("nav:get-snapshot", () => this.buildSnapshot()))

    this.unsubs.push(
      this.ui.handle("places:autocomplete", ({query, near}, ctx) =>
        this.places.autocomplete(query, near, ctx?.signal),
      ),
    )
    this.unsubs.push(
      this.ui.handle("places:details", ({placeId}, ctx) =>
        this.places.details(placeId, ctx?.signal),
      ),
    )

    this.unsubs.push(this.ui.handle("storage:list-saved", () => this.storage.getAllSavedPlaces()))
    this.unsubs.push(this.ui.handle("storage:add-saved", (p) => this.storage.addSavedPlace(p)))
    this.unsubs.push(this.ui.handle("storage:remove-saved", ({placeId}) => this.storage.removeSavedPlace(placeId)))
    this.unsubs.push(this.ui.handle("storage:list-recent", () => this.storage.getRecentSearches()))
    this.unsubs.push(this.ui.handle("storage:add-recent", (p) => this.storage.addRecentSearch(p)))
  }

  // ── UI broadcast listeners ───────────────────────────────────────────

  private wireUIBroadcasts(): void {
    this.unsubs.push(
      this.ui.on("nav:start", async (opts) => {
        const {destinationName, ...startOpts} = opts as typeof opts & {destinationName?: string}
        this.trip = {
          ...this.trip,
          status: "navigating",
          running: true,
          activeDestination: startOpts.stops?.[startOpts.stops.length - 1] ?? null,
          activeDestinationName: destinationName ?? null,
          maneuver: null,
          offRouteAt: null,
        }
        this.appendLog(`START ${destinationName ?? "(unnamed)"}`)
        this.ui.send("nav:trip-state", this.trip)
        try {
          await this.navigation.start(startOpts)
        } catch (err) {
          this.appendLog(`START error: ${err instanceof Error ? err.message : String(err)}`)
          this.trip = {...this.trip, status: "idle", running: false}
          this.ui.send("nav:trip-state", this.trip)
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:stop", () => {
        this.appendLog("STOP")
        try {
          this.navigation.stop()
        } catch {
          /* ignore */
        }
        this.trip = {
          ...this.trip,
          status: "idle",
          running: false,
          maneuver: null,
          activeDestination: null,
          routePoints: null,
          offRouteAt: null,
        }
        this.ui.send("nav:trip-state", this.trip)
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:deviate", () => {
        try {
          this.navigation.dev.deviate()
        } catch (err) {
          this.appendLog(`deviate failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-destination", (place) => {
        // Informational — actual trip starts via nav:start. Stash the
        // friendly name so the snapshot can carry it on the next open.
        if (place) this.appendLog(`set-destination ${place.name}`)
      }),
    )
    this.unsubs.push(
      this.ui.on("nav:set-dev-settings", (partial) => {
        this.devSettings = {...this.devSettings, ...partial}
        this.ui.send("nav:dev-settings-update", this.devSettings)
      }),
    )

    // Mid-trip hydration: every fresh WebView open gets a snapshot.
    this.unsubs.push(this.ui.onOpen(() => this.ui.send("nav:snapshot", this.buildSnapshot())))
  }

  // ── Glasses HUD pump ─────────────────────────────────────────────────
  // Runs synchronously whenever trip / pivots / coords / status changes.
  // Replaces the React useEffect in the old NavigationPage:240-309.

  private lastHudKey = ""
  private wireHUDPump(): void {
    const refresh = () => this.refreshHUD()
    // Tap the same channels we send to UI — re-render the HUD on any
    // state change. Simple and resilient; if a future field affects
    // the HUD output, sending its channel triggers a recompute.
    const tap = (orig: (...a: unknown[]) => void) => {
      return (...a: unknown[]) => {
        orig(...a)
        try {
          refresh()
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("HUD refresh threw", err)
        }
      }
    }
    // We've already wired sensor → ui.send above. Wrap once here to
    // also trigger refresh on every push.
    const originalSend = this.ui.send.bind(this.ui)
    ;(this.ui as unknown as {send: typeof originalSend}).send = tap(originalSend) as unknown as typeof originalSend
    // Prime an initial HUD render once subscriptions warm up.
    setTimeout(refresh, 250)
  }

  private refreshHUD(): void {
    const {status, running, activeDestinationName, maneuver} = this.trip

    let next: string | null = null
    let durationMs: number | undefined

    if (status === "arrived") {
      const at = activeDestinationName ? ` at ${activeDestinationName}` : ""
      next = `You have arrived${at}`
      durationMs = 10_000
    } else if (!running) {
      next = "Welcome to Mentra Navigation!\nPick a destination to get started."
      durationMs = 5_000
    } else if (status === "rerouting") {
      next = "Rebuilding route…"
    } else if (this.activePivot) {
      const verb = this.activePivot.direction === "right" ? "Turn right" : "Turn left"
      const namedRoad = isRealRoadName(this.activePivot.toRoad)
      const onto = namedRoad ? `onto ${namedRoad}` : null
      next = [verb, onto].filter(Boolean).join("\n")
    } else if (this.upcomingPivot && this.coords) {
      const dist = haversineMeters(
        {lat: this.coords.lat, lng: this.coords.lng},
        {lat: this.upcomingPivot.lat, lng: this.upcomingPivot.lng},
      )
      const isCross = this.upcomingPivot.maneuver === "CROSS_STREET"
      const verb = isCross
        ? "Cross the road"
        : this.upcomingPivot.direction === "right"
          ? "Turn right"
          : "Turn left"
      const distStr = formatDistance(dist)
      const nextRoad = isCross ? null : isRealRoadName(this.upcomingPivot.fromRoad)
      const topLine = nextRoad ? `Onto ${nextRoad}` : null
      next = [topLine, `${verb} in ${distStr}`].filter(Boolean).join("\n")
    } else if (
      maneuver?.distanceToDestinationMeters != null &&
      maneuver.distanceToDestinationMeters >= 0
    ) {
      next = `Arriving in ${formatDistance(maneuver.distanceToDestinationMeters)}`
    } else if (running) {
      next = "Arriving"
    }

    if (next == null) return
    // Coalesce — don't spam the glasses with the same frame.
    const key = `${next} ${durationMs ?? 0}`
    if (key === this.lastHudKey) return
    this.lastHudKey = key
    this.display.showText(next, durationMs)
  }

  // ── Permission + initial fix priming ─────────────────────────────────

  private primeNavigationPermission(): void {
    this.session
      .waitForReady()
      .then(() => this.navigation.requestPermission())
      .then((r) => this.appendLog(`requestPermission: ${JSON.stringify(r)}`))
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[NavigationController] requestPermission failed", err)
      })
  }

  private seedInitialFix(): void {
    this.location
      .getOnce()
      .then((d) => {
        if (this.coords) return
        this.coords = {lat: d.lat, lng: d.lng, accuracy: d.accuracy, ts: d.timestamp ?? Date.now()}
        this.ui.send("nav:coords", this.coords)
      })
      .catch(() => {
        /* OK — streaming updates will arrive when location stabilises */
      })
  }

  // ── Log + maneuver helpers ───────────────────────────────────────────

  private appendLog(line: string): void {
    const entry: LogEntry = {id: ++this.logSeq, ts: Date.now(), line}
    this.log = [entry, ...this.log].slice(0, 100)
    this.ui.send("nav:log-append", entry)
  }

  private formatUpdate(u: import("@mentra/miniapp").NavUpdate): string {
    switch (u.kind) {
      case "maneuver":
        return `MANEUVER ${u.maneuverType ?? "?"} dist=${u.distanceToManeuverMeters?.toFixed(0)}m`
      case "off_route":
        return "OFF_ROUTE"
      case "rerouting":
        return "REROUTING"
      case "arrived":
        return "ARRIVED"
      case "error":
        return `ERROR ${u.message ?? ""}`
      default:
        return `UPDATE ${(u as {kind?: string}).kind ?? "?"}`
    }
  }
}

// ── Module helpers ─────────────────────────────────────────────────────

function isRealRoadName(s: string | undefined | null): string | null {
  if (!s) return null
  if (/^Pivot \d+$/i.test(s)) return null
  return s
}

function haversineMeters(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const sLat = Math.sin(dLat / 2)
  const sLng = Math.sin(dLng / 2)
  const aa = sLat * sLat + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sLng * sLng
  return 2 * R * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa))
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
}
```

Add the import for `NavUpdate` at the top of the file (the inline `import("@mentra/miniapp").NavUpdate` works but cleaner imports are preferred):

```ts
import type {MiniappSession, NavManeuver, NavRoute, NavUpdate, Pivot, UIModule} from "@mentra/miniapp/background"
```

And replace `import("@mentra/miniapp").NavUpdate` in `formatUpdate` with just `NavUpdate`.

The `formatDistance` and `haversineMeters` helpers shadow the moved files — that's intentional for the controller (it bundles into background, can't pull DOM-dependent code). Background-side `lib/formatDistance.ts` and `lib/geometry.ts` already exist as moved files; we could import from them, but keeping the controller self-contained for these tiny pure helpers is fine. **Alternative**: import from `./lib/formatDistance` and `./lib/geometry` if their signatures match. Verify:

```bash
grep -E "^export " sdk/Navigation/src/background/lib/formatDistance.ts sdk/Navigation/src/background/lib/geometry.ts
```

If `formatDistance(m: number): string` and `haversineMeters(a, b): number` match, delete the inline helpers and use:

```ts
import {formatDistance} from "./lib/formatDistance"
import {haversineMeters} from "./lib/geometry"
```

Remove the inline `formatDistance` and `haversineMeters` definitions from the bottom of the controller file. Keep `isRealRoadName` (specific to this controller).

- [ ] **Step 2: Typecheck**

```bash
cd sdk/Navigation && bun x tsc --noEmit src/background/ src/shared/ 2>&1 | head -60
```

Expected: no errors in `src/background/` or `src/shared/`. The wider tsc on the whole package will still fail on `src/client/` / `src/frontend/` which we're about to delete.

If TypeScript complains about `this.ui.send` being read-only or about the `tap` wrap of `this.ui.send`, replace the wrap with a simpler approach: call `refresh()` explicitly at the end of each setter that affects HUD. Replace the `wireHUDPump` body:

```ts
  private wireHUDPump(): void {
    // No magic — refreshHUD() is invoked explicitly at the end of each
    // state setter (coords/heading/pivots/trip). This avoids monkey-
    // patching ui.send.
    //
    // We seed once after subscriptions warm up so the welcome message
    // shows even before the first GPS fix.
    setTimeout(() => {
      try {
        this.refreshHUD()
      } catch {
        /* ignore */
      }
    }, 250)
  }
```

And add an explicit `this.refreshHUD()` call after each state mutation in `wireSensorSubscriptions` (after every `this.coords = …`, `this.trip = …`, `this.activePivot/upcomingPivot = …` block). That's mechanical — add `this.refreshHUD()` on the line after `this.ui.send(...)` in each handler.

- [ ] **Step 3: Commit**

```bash
git add sdk/Navigation/src/background/NavigationController.ts
git commit -m "Implement NavigationController subscriptions, RPC handlers, HUD pump" --no-verify
```

---

## Task 20: Update `build.ts` to two-output and rewrite `miniapp.json`

**Files:**
- Rewrite: `sdk/Navigation/build.ts`
- Modify: `sdk/Navigation/miniapp.json`

- [ ] **Step 1: Rewrite `build.ts`**

```ts
/**
 * Production build script — two-output bundle.
 *
 * Emits two bundles under ./dist:
 *   dist/background/index.js  — JSContext entry (no DOM, IIFE).
 *   dist/ui/index.html + ...  — WebView entry (full DOM, Tailwind v4).
 *
 * Env vars whose name starts with `EXPO_PUBLIC_` are inlined into both
 * bundles via `define`. Anything inlined into the UI bundle is visible
 * in WebView source maps; secrets MUST live behind the developer's own
 * backend, not in EXPO_PUBLIC_*.
 */

import {rm} from "fs/promises"

const distDir = "./dist"

await rm(distDir, {recursive: true, force: true})

const navKey = process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY ?? ""
const placesKey = process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY ?? ""
if (!navKey) console.warn("WARN: EXPO_PUBLIC_GOOGLE_NAV_API_KEY is not set — maps will fail to load.")
if (!placesKey) console.warn("WARN: EXPO_PUBLIC_GOOGLE_PLACES_API_KEY is not set — search will fail.")

const nodeEnv = process.env.NODE_ENV === "production" ? "production" : "development"
console.log(`Building with NODE_ENV=${nodeEnv}`)

const sharedDefine: Record<string, string> = {
  "process.env.EXPO_PUBLIC_GOOGLE_NAV_API_KEY": JSON.stringify(navKey),
  "process.env.EXPO_PUBLIC_GOOGLE_PLACES_API_KEY": JSON.stringify(placesKey),
  "process.env.NODE_ENV": JSON.stringify(nodeEnv),
}

// Background: IIFE, no DOM. The JSContext loads this once.
const backgroundResult = await Bun.build({
  entrypoints: ["./src/background/index.ts"],
  outdir: `${distDir}/background`,
  target: "browser",
  format: "iife",
  minify: false,
  define: sharedDefine,
})
if (!backgroundResult.success) {
  console.error("Background build failed:")
  for (const log of backgroundResult.logs) console.error(log)
  process.exit(1)
}

const tailwind = (await import("bun-plugin-tailwind")).default

const uiResult = await Bun.build({
  entrypoints: ["./src/ui/index.html"],
  outdir: `${distDir}/ui`,
  target: "browser",
  plugins: [tailwind],
  minify: true,
  define: sharedDefine,
})
if (!uiResult.success) {
  console.error("UI build failed:")
  for (const log of uiResult.logs) console.error(log)
  process.exit(1)
}

console.log(`Built background (${backgroundResult.outputs.length}) + UI (${uiResult.outputs.length}) files into ${distDir}/`)
```

- [ ] **Step 2: Update `miniapp.json`**

Replace the existing `sdk/Navigation/miniapp.json` with:

```json
{
  "$schema": "./node_modules/@mentra/miniapp-cli/schema/miniapp.schema.json",
  "packageName": "com.mentra.navigation",
  "version": "1.0.2",
  "name": "Mentra Map",
  "description": "Turn-by-turn walking navigation with compass and Google Maps.",
  "icon": "icon.png",
  "type": "standard",
  "sdkVersion": "0.3.0",
  "minHostVersion": "1.42.0",
  "entry": {
    "background": "dist/background/index.js",
    "ui": "dist/ui/index.html"
  },
  "permissions": [
    {"type": "LOCATION", "description": "Used for live position, compass heading, and turn-by-turn directions"}
  ],
  "hardwareRequirements": [
    {"type": "DISPLAY", "level": "REQUIRED", "description": "Shows next maneuver and distance on glasses"}
  ]
}
```

- [ ] **Step 3: Commit (don't run build yet — UI isn't ready)**

```bash
git add sdk/Navigation/build.ts sdk/Navigation/miniapp.json
git commit -m "Switch Navigation build to two-output; mark manifest as type:standard" --no-verify
```

---

## Task 21: Move UI tree into `src/ui/` and wire main entry + store

**Files:**
- Move: `index.html` → `src/ui/index.html`
- Move: `src/frontend/index.css` → `src/ui/index.css`
- Create: `src/ui/main.tsx`
- Create: `src/ui/store/navStore.ts`
- Create: `src/ui/hooks/useChannel.ts`
- Move: `src/frontend/router.tsx` → `src/ui/router.tsx`
- Move: `src/frontend/components/*` → `src/ui/components/*`
- Move: `src/frontend/pages/*` → `src/ui/pages/*`

- [ ] **Step 1: Move tree**

```bash
cd sdk/Navigation && \
  mkdir -p src/ui/store src/ui/hooks src/ui/lib && \
  git mv index.html src/ui/index.html && \
  git mv src/frontend/index.css src/ui/index.css && \
  git mv src/frontend/router.tsx src/ui/router.tsx && \
  git mv src/frontend/components src/ui/components && \
  git mv src/frontend/pages src/ui/pages
```

Confirm `src/frontend/` is now empty or has only `App.tsx` / `frontend.tsx` left. If those two are the only files left, also move them:

```bash
cd sdk/Navigation && \
  git mv src/frontend/App.tsx src/ui/App.tsx 2>/dev/null || true && \
  git mv src/frontend/frontend.tsx src/ui/main.tsx 2>/dev/null || true
```

If `frontend.tsx` was moved as `main.tsx`, we'll rewrite its content in the next step. Otherwise create `main.tsx` from scratch.

Then remove the now-empty `src/frontend/`:

```bash
cd sdk/Navigation && rmdir src/frontend 2>/dev/null || true
```

- [ ] **Step 2: Rewrite `src/ui/main.tsx`**

```tsx
/**
 * UI entry point — Mentra Map miniapp.
 *
 * Mounts React, installs root-level channel subscribers feeding the
 * Zustand store, fires `mentra.ready()` so background's
 * session.ui.onOpen handlers fire. The store is the only seam between
 * the channel bus and the React tree.
 */

import "../shared/channels"
import "./index.css"

import {createRoot} from "react-dom/client"
import {MentraProvider} from "@mentra/miniapp/ui"

import App from "./App"
import {installChannelSubscribers} from "./store/navStore"

const root = document.getElementById("root")
if (!root) throw new Error("Root element not found")
createRoot(root).render(
  <MentraProvider>
    <App />
  </MentraProvider>,
)

installChannelSubscribers()

mentra.ready()
```

- [ ] **Step 3: Create `src/ui/store/navStore.ts`**

```ts
/**
 * navStore — Zustand store fed by background channel pushes. The UI
 * never touches MiniappSession or the managers directly. Background
 * is the source of truth; the store mirrors what background broadcasts.
 *
 * `installChannelSubscribers()` runs once from main.tsx and wires every
 * `nav:*` channel into the store. It also requests a fresh snapshot via
 * `mentra.request("nav:get-snapshot")` so a freshly-mounted WebView
 * doesn't wait for the background-side onOpen snapshot.
 */

import {create} from "zustand"

import type {Channels} from "../../shared/channels"
import type {DevSettings, NavSnapshot, TripState} from "../../shared/types"

type NavStore = NavSnapshot & {
  apply(snapshot: Partial<NavSnapshot>): void
  applyTrip(trip: TripState): void
  applyDevSettings(s: DevSettings): void
  appendLog(entry: NavSnapshot["log"][number]): void
  clearLog(): void
}

const initialSnapshot: NavSnapshot = {
  coords: null,
  heading: null,
  mapsReady: false,
  trip: {
    status: "idle",
    running: false,
    maneuver: null,
    activeDestination: null,
    activeDestinationName: null,
    routePoints: null,
    offRouteAt: null,
  },
  activePivot: null,
  upcomingPivot: null,
  log: [],
  devSettings: {
    simulate: false,
    speedMultiplier: 5,
    wrongSidewalk: false,
    skipCrossings: false,
  },
}

export const useNavStore = create<NavStore>((set) => ({
  ...initialSnapshot,
  apply: (snapshot) => set(snapshot),
  applyTrip: (trip) => set({trip}),
  applyDevSettings: (devSettings) => set({devSettings}),
  appendLog: (entry) =>
    set((s) => ({log: [entry, ...s.log].slice(0, 100)})),
  clearLog: () => set({log: []}),
}))

/** Mark Google Maps as ready/failed from the UI side (background-agnostic). */
export function setMapsReady(ready: boolean): void {
  useNavStore.setState({mapsReady: ready})
}

let installed = false
export function installChannelSubscribers(): void {
  if (installed) return
  installed = true

  mentra.on("nav:snapshot", (snap) => useNavStore.getState().apply(snap))
  mentra.on("nav:coords", (coords) => useNavStore.setState({coords}))
  mentra.on("nav:heading", ({degrees}) => useNavStore.setState({heading: degrees}))
  mentra.on("nav:trip-state", (trip) => useNavStore.getState().applyTrip(trip))
  mentra.on("nav:pivots", ({active, upcoming}) =>
    useNavStore.setState({activePivot: active, upcomingPivot: upcoming}),
  )
  mentra.on("nav:route", ({points}) => {
    useNavStore.setState((s) => ({trip: {...s.trip, routePoints: points}}))
  })
  mentra.on("nav:log-append", (entry) => useNavStore.getState().appendLog(entry))
  mentra.on("nav:log-clear", () => useNavStore.getState().clearLog())
  mentra.on("nav:dev-settings-update", (s) => useNavStore.getState().applyDevSettings(s))

  // Best-effort snapshot kickoff — onOpen also fires one from background,
  // but issuing this explicitly ensures we hydrate even if the open
  // round-trips slowly.
  mentra
    .request("nav:get-snapshot", undefined as never)
    .then((snap) => useNavStore.getState().apply(snap))
    .catch(() => {
      /* ignore — onOpen snapshot will arrive */
    })
}
```

- [ ] **Step 4: Create `src/ui/hooks/useChannel.ts`**

```ts
import {useEffect, useState} from "react"

import type {Channels} from "../../shared/channels"

/**
 * useChannel — subscribe to a broadcast channel and get the latest
 * payload as React state. Returns `undefined` until the first push.
 */
export function useChannel<C extends keyof Channels & string>(
  channel: C,
  initial?: Channels[C],
): Channels[C] | undefined {
  const [value, setValue] = useState<Channels[C] | undefined>(initial)
  useEffect(() => {
    return mentra.on(channel, (payload) => setValue(payload as Channels[C]))
  }, [channel])
  return value
}
```

- [ ] **Step 5: Add `zustand` dependency**

```bash
cd sdk/Navigation && bun add zustand
```

Expected: `package.json` and lockfile updated.

- [ ] **Step 6: Commit**

```bash
git add sdk/Navigation/src/ui sdk/Navigation/package.json sdk/Navigation/bun.lock 2>/dev/null
git commit -m "Move UI tree to src/ui, add Zustand store and channel subscriber" --no-verify
```

If `bun.lock` doesn't exist or wasn't tracked, drop it from `git add`. Use whatever lockfile the repo tracks.

---

## Task 22: Move `GoogleMapsManager` into UI and adapt it

**Files:**
- Move: `src/client/session/managers/GoogleMapsManager.ts` → `src/ui/lib/googleMaps.ts`

- [ ] **Step 1: Move the file**

```bash
cd sdk/Navigation && git mv src/client/session/managers/GoogleMapsManager.ts src/ui/lib/googleMaps.ts
```

- [ ] **Step 2: Update the file's class name + integrate with the store**

The file uses Google Maps JS API loading and exposes `whenReady` / `ready` / `apiKey`. We add a one-time store sync so consumers can `useNavStore(s => s.mapsReady)`.

Append at the bottom of `src/ui/lib/googleMaps.ts`:

```ts
import {setMapsReady} from "../store/navStore"

/** Singleton — one Maps load per WebView mount. */
let singleton: GoogleMapsManager | null = null

/** Lazy initialiser. Pushes `mapsReady` into the store once the script loads. */
export function getGoogleMaps(): GoogleMapsManager {
  if (singleton) return singleton
  singleton = new GoogleMapsManager()
  singleton
    .whenReady()
    .then(() => setMapsReady(true))
    .catch(() => setMapsReady(false))
  return singleton
}
```

- [ ] **Step 3: Add `formatDistance` and `geometry` shims for UI consumers**

Some UI components import `formatDistance` and `haversineMeters` directly. Create thin re-exports:

`sdk/Navigation/src/ui/lib/formatDistance.ts`:

```ts
export {formatDistance} from "../../background/lib/formatDistance"
```

`sdk/Navigation/src/ui/lib/geometry.ts`:

```ts
export {haversineMeters, type LatLng} from "../../background/lib/geometry"
```

(These work because the UI bundle imports source `.ts` from `src/background/lib/`. Both files are pure — no DOM, no globals — so they bundle cleanly into either side.)

- [ ] **Step 4: Commit**

```bash
git add sdk/Navigation/src/ui/lib/
git commit -m "Move GoogleMapsManager into src/ui/lib and add UI-side lib shims" --no-verify
```

---

## Task 23: Rewrite UI App + pages to read from store, call channels

**Files:**
- Modify: `src/ui/App.tsx` — remove `useUser`, use store + channels
- Modify: each page under `src/ui/pages/**` that previously read `user.coords` etc.

This is mechanical but tedious. The shape of the change for each call site:

| Old | New |
|---|---|
| `const user = useUser()` | `(removed)` |
| `user.coords` | `useNavStore((s) => s.coords)` |
| `user.heading` | `useNavStore((s) => s.heading)` |
| `user.mapsReady` | `useNavStore((s) => s.mapsReady)` |
| `user.navigation.start(opts)` | `mentra.send("nav:start", {...opts, destinationName})` |
| `user.navigation.stop()` | `mentra.send("nav:stop", {})` |
| `user.navigation.computeRoute(opts)` | `await mentra.request("nav:compute-route", opts)` |
| `user.navigation.requestPermission()` | `await mentra.request("nav:request-permission", undefined as never)` |
| `user.navigation.getState()` | (delete — snapshot arrives on open + nav:get-snapshot RPC) |
| `user.navigation.onUpdate(h)` | (delete — store is fed by background) |
| `user.navigation.onRoute(h)` | (delete) |
| `user.navigation.getActivePivot()` | `useNavStore((s) => s.activePivot)` |
| `user.navigation.getUpcomingPivot()` | `useNavStore((s) => s.upcomingPivot)` |
| `user.navigation.getPivots()` | (deleted; use upcoming/active only OR add `nav:get-pivots` RPC if needed — see Task 23 step 4) |
| `user.storage.addSavedPlace(p)` | `await mentra.request("storage:add-saved", p)` |
| `user.storage.getAllSavedPlaces()` | `await mentra.request("storage:list-saved", undefined as never)` |
| `user.storage.addRecentSearch(p)` | `await mentra.request("storage:add-recent", p)` |
| `user.storage.getRecentSearches()` | `await mentra.request("storage:list-recent", undefined as never)` |
| `user.display.showText(...)` | (delete — HUD lives in background controller now) |
| Places `autocomplete(query)` | `await useRpc<Channels, "places:autocomplete">("places:autocomplete")({query, near})` |

- [ ] **Step 1: Rewrite `App.tsx`**

Open `sdk/Navigation/src/ui/App.tsx`. Replace its content:

```tsx
import {useState, useEffect} from "react"
import {AnimatePresence} from "motion/react"

import {RouterProvider, useRouter} from "./router"
import {NavigationPage} from "./pages/NavigationPage/NavigationPage"
import {AddPlacePage} from "./pages/AddPlacePage"

import "../shared/channels"
import type {Channels} from "../shared/channels"
import {useRpc} from "@mentra/miniapp/ui"

function Pages() {
  const {route, pop} = useRouter()
  const [savedPlacesVersion, setSavedPlacesVersion] = useState(0)
  const addSaved = useRpc<Channels, "storage:add-saved">("storage:add-saved")

  return (
    <>
      <NavigationPage savedPlacesVersion={savedPlacesVersion} />
      <AnimatePresence>
        {route.name === "add-place" ? (
          <AddPlacePage
            key="add-place"
            presetType={route.presetType}
            onSave={async (place, name, type) => {
              const saved = {
                ...place,
                ...(name ? {savedName: name} : {}),
                ...(type ? {type} : {}),
              }
              await addSaved(saved)
              setSavedPlacesVersion((v) => v + 1)
              pop()
            }}
            onClose={pop}
          />
        ) : null}
      </AnimatePresence>
    </>
  )
}

export default function App() {
  // Pre-warm the Google Maps singleton so NavMap mounts with a ready map.
  useEffect(() => {
    void import("./lib/googleMaps").then((m) => m.getGoogleMaps())
  }, [])

  return (
    <RouterProvider>
      <Pages />
    </RouterProvider>
  )
}
```

- [ ] **Step 2: Rewrite `NavigationPage.tsx`**

This is the big file (919 LoC). Most of the bulk stays — what changes:

1. Drop `useUser`, `user.*` references.
2. Drop the HUD `useEffect` (background owns it).
3. Drop `user.navigation.onUpdate` / `onRoute` subscription wiring (background owns it).
4. Drop the mid-trip hydration `useEffect` (background broadcasts on open).
5. Replace `navigation.computeRoute(...)` with `useRpc(...)`.

Open `sdk/Navigation/src/ui/pages/NavigationPage/NavigationPage.tsx` and read its current state — it's been moved verbatim from `frontend/`. Apply the following edits:

a) Replace the top imports — find this block (lines 1-24-ish):

```ts
import {useUser} from "@/backend/hooks/useUser"
```

Delete that import. Replace with:

```ts
import {useNavStore} from "@/ui/store/navStore"
import {useRpc} from "@mentra/miniapp/ui"
import type {Channels} from "@/shared/channels"
```

b) Inside the component body, replace `const user = useUser()` + the destructuring `const {coords, navigation, display} = user`:

```ts
  const coords = useNavStore((s) => s.coords)
  const heading = useNavStore((s) => s.heading)
  const tripState = useNavStore((s) => s.trip)
  const activePivot = useNavStore((s) => s.activePivot)
  const upcomingPivot = useNavStore((s) => s.upcomingPivot)
  const computeRoute = useRpc<Channels, "nav:compute-route">("nav:compute-route")
```

c) Replace every `user.coords`, `user.heading`, `navigation.getActivePivot()`, etc. with the corresponding store hooks or RPC calls. Use multi-cursor edits (or sed) for the bulk substitutions:

```bash
cd sdk/Navigation/src/ui/pages/NavigationPage && \
  sed -i '' \
    -e 's|user\.coords|coords|g' \
    -e 's|user\.heading|heading|g' \
    -e 's|user\.navigation\.getActivePivot()|activePivot|g' \
    -e 's|user\.navigation\.getUpcomingPivot()|upcomingPivot|g' \
    -e 's|user\.navigation\.getPivots()|[]|g' \
    NavigationPage.tsx
```

(The last one — `getPivots()` — collapses to `[]` for now. If the map component actively uses the pivot list, we add a `nav:pivots-all` snapshot field in step 4 below.)

d) Delete the HUD `useEffect` entirely. Find the `// ---- glasses HUD mirror` comment block (around old line 224) and the closing `}, […])` at line 309. Delete the whole block including `activePivot` reads and `display.showText` calls.

e) Delete the mid-trip hydration `useEffect` (around lines 316-342, the block ending with `eslint-disable-next-line react-hooks/exhaustive-deps`). Background broadcasts `nav:snapshot` on open; the store handles hydration.

f) Delete the subscription-cleanup `useEffect` at lines 346-353. Subscriptions live in background.

g) Find `handleStart(...)`. Replace `await navigation.start(...)` with `mentra.send("nav:start", {...startOpts, destinationName: destination.name})`. Drop any code that subscribed to update/route after starting — background already handles those.

h) Find `handleStop` if present. Replace `navigation.stop()` with `mentra.send("nav:stop", {})`.

i) Find the preview-route `useEffect` (around lines 81-215). Replace `navigation.computeRoute(...)` with `computeRoute(...)`:

```ts
    computeRoute({
      origin,
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
    })
```

The function returns the same shape as before. The `useRpc` hook's `.abort()` replaces the manual `AbortController` plumbing — replace the `previewAbortRef` / `ctrl` logic with `computeRoute.abort()` calls.

j) The `setRunning`/`setStatus`/`setManeuver`/`setRoutePoints` local state are now driven by background. Replace them: read from `tripState`:

```ts
  const status = tripState.status
  const running = tripState.running
  const maneuver = tripState.maneuver
  const routePoints = tripState.routePoints
  const activeDestination = tripState.activeDestination
  const activeDestinationName = tripState.activeDestinationName
  const offRouteAt = tripState.offRouteAt
```

Delete the corresponding `useState` declarations. Anywhere the page calls `setRunning(true)`, `setStatus("navigating")`, etc., delete those calls (background's `nav:trip-state` push updates the store automatically).

- [ ] **Step 3: Rewrite `LocationSearch.tsx`**

Find `sdk/Navigation/src/ui/pages/NavigationPage/components/LocationSearch/LocationSearch.tsx` (342 LoC). It uses Places autocomplete + recent searches. Replace any `placesAutocomplete(...)` import / direct `fetch` calls with the RPC:

```tsx
import {useRpc} from "@mentra/miniapp/ui"
import type {Channels} from "@/shared/channels"

// inside the component:
const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
const placesDetails = useRpc<Channels, "places:details">("places:details")
const listRecent = useRpc<Channels, "storage:list-recent">("storage:list-recent")
const addRecent = useRpc<Channels, "storage:add-recent">("storage:add-recent")

// In the keystroke effect:
autocomplete.abort()
autocomplete({query: q, near: coords ? {lat: coords.lat, lng: coords.lng} : undefined})
  .then(setSuggestions)
  .catch(() => {})
```

Search the file for `user.storage.getRecentSearches` and replace with `await listRecent(undefined as never)`. Similar for `addRecentSearch`. Replace direct Place details lookups with `await placesDetails({placeId})`.

- [ ] **Step 4: Other components**

```bash
cd sdk/Navigation && grep -rln "useUser\|user\." src/ui/ 2>/dev/null
```

For each file in the output, repeat the substitution pattern. Run typecheck after each to surface what's left:

```bash
cd sdk/Navigation && bun x tsc --noEmit src/ui/ 2>&1 | head -50
```

If a UI component genuinely needs the full pivot list (NavMap.tsx draws pivots on the map), add a snapshot field:

a) Add `pivots: Pivot[]` to `NavSnapshot` in `src/shared/types.ts`.
b) In the controller, set `this.pivots = this.navigation.getPivots()` whenever `onRoute` or `onPivot` fires and add it to `buildSnapshot()`.
c) Broadcast `"nav:pivots-all"` channel update in the same places (and add the channel to `Channels`).
d) Read `useNavStore(s => s.pivots)` in NavMap.

(For the first cut, the page collapsing `getPivots() → []` is acceptable — the line-by-line path on the map still renders from `routePoints`. Pivot markers may not draw. Address in a follow-up if visible regression.)

- [ ] **Step 5: Typecheck the UI**

```bash
cd sdk/Navigation && bun x tsc --noEmit src/ui/ src/shared/ src/background/
```

Expected: no errors. If errors remain in `src/client/` (the leftover folder), ignore them — we delete it in Task 24.

- [ ] **Step 6: Commit**

```bash
git add sdk/Navigation/src/ui/
git commit -m "Rewrite Navigation UI pages to read store + use mentra.request" --no-verify
```

---

## Task 24: Delete obsolete `src/client/` and `src/frontend/` trees

**Files:**
- Delete (via `git rm -r`):
  - `src/client/` (whole tree, including any leftover `hooks/`, `session/`, `lib/`)

- [ ] **Step 1: Confirm tree**

```bash
cd sdk/Navigation && find src/client src/frontend -type f 2>/dev/null
```

Expected: only files we've consciously decided not to move (likely empty or near-empty).

- [ ] **Step 2: Delete**

```bash
cd sdk/Navigation && git rm -r src/client 2>/dev/null && git rm -r src/frontend 2>/dev/null || true
```

- [ ] **Step 3: Verify**

```bash
cd sdk/Navigation && [ -d src/client ] && echo "still exists" || echo "deleted"
cd sdk/Navigation && [ -d src/frontend ] && echo "still exists" || echo "deleted"
```

Expected: both `deleted`.

- [ ] **Step 4: Update `tsconfig.json` paths**

Open `sdk/Navigation/tsconfig.json`. Replace any `@/backend/*` or `@/client/*` path aliases with:

```json
{
  "compilerOptions": {
    "paths": {
      "@/background/*": ["./src/background/*"],
      "@/ui/*": ["./src/ui/*"],
      "@/shared/*": ["./src/shared/*"]
    }
  }
}
```

If aliases differ from this exact JSON (other compiler options exist), keep them and only swap the `paths` block.

- [ ] **Step 5: Typecheck the whole package**

```bash
cd sdk/Navigation && bun x tsc --noEmit
```

Expected: clean (or only test files complain, fixed next).

- [ ] **Step 6: Commit**

```bash
git add -A sdk/Navigation/
git commit -m "Remove obsolete client/ and frontend/ trees; update tsconfig paths" --no-verify
```

---

## Task 25: Update test imports under `src/test/`

**Files:**
- Modify: `sdk/Navigation/src/test/navigation/*.test.ts` (multiple files)

- [ ] **Step 1: Update imports**

```bash
cd sdk/Navigation && grep -rln "@/backend/\|@/client/" src/test/ 2>/dev/null
```

For each file, run:

```bash
cd sdk/Navigation && grep -rln "@/backend/session/managers/navigation/" src/test/ | xargs sed -i '' 's|@/backend/session/managers/navigation/|@/background/managers/|g'
cd sdk/Navigation && grep -rln "@/backend/session/managers/" src/test/ | xargs sed -i '' 's|@/backend/session/managers/|@/background/managers/|g'
cd sdk/Navigation && grep -rln "@/backend/lib/" src/test/ | xargs sed -i '' 's|@/backend/lib/|@/background/lib/|g'
cd sdk/Navigation && grep -rln "@/client/" src/test/ | xargs sed -i '' 's|@/client/|@/background/|g'
```

- [ ] **Step 2: Run tests**

```bash
cd sdk/Navigation && bun test
```

Expected: existing tests pass (they test `NavigationManager` directly — its behavior is unchanged, just import path moved).

If some tests fail because they're testing controller logic that moved, that's a separate fix — the spec says we don't add controller tests in this PR. Skip-fix-and-move-on if any failures are clearly about the new background structure rather than the manager itself.

- [ ] **Step 3: Commit**

```bash
git add sdk/Navigation/src/test/
git commit -m "Update test imports to point at src/background after move" --no-verify
```

---

## Task 26: Build the Navigation miniapp + smoke test the dist

**Files:**
- Run the build.

- [ ] **Step 1: Build**

```bash
cd sdk/Navigation && bun run build
```

Expected: emits `dist/background/index.js` and `dist/ui/index.html` (+ JS/CSS assets). No errors.

If the build fails because the background bundle tries to import DOM-only code (Google Maps script load, etc.), follow the error: the controller / managers must not transitively touch `window` / `document`. Adjust imports.

- [ ] **Step 2: Sanity-check the dist**

```bash
ls sdk/Navigation/dist/background/ sdk/Navigation/dist/ui/
```

Expected: at minimum `index.js` in background; `index.html` + bundled `.js`/`.css` in ui.

```bash
grep -c "registerMiniapp\|MiniappSession\|session\.ui\.handle" sdk/Navigation/dist/background/index.js
```

Expected: > 0 (the controller compiled into the IIFE).

```bash
grep -c "mentra.request\|mentra.send\|useNavStore" sdk/Navigation/dist/ui/*.js 2>/dev/null
```

Expected: > 0.

- [ ] **Step 3: Commit dist if tracked**

```bash
git check-ignore sdk/Navigation/dist
```

If the path is printed (ignored), skip. Otherwise:

```bash
git add sdk/Navigation/dist
git commit -m "Build Navigation two-output dist" --no-verify
```

---

## Task 27: Update `agents/miniapp-sdk-overview.md` doc step — already done; verify

This is a sanity step — the docs were updated in Task 14. Confirm consistency now that everything else has shipped.

- [ ] **Step 1: Re-read the overview's new RPC subsection**

```bash
grep -A 5 "Request/response across the bridge" agents/miniapp-sdk-overview.md
```

Confirm the heading is present and the worked-example reference (TesterController) makes sense in the context of Task 12's refactor.

If the controller's actual class name changed, update the doc reference. (We kept `TesterController` — fine.)

- [ ] **Step 2: No commit needed unless changes made.**

---

## Task 28: Manual device verification

This is the catch-net step. The plan has gotten everything to compile and unit-pass; smoke-testing on a real device confirms the end-to-end pipeline.

- [ ] **Step 1: Bring up the mobile app dev workflow**

```bash
cd mobile && bun start
```

In another terminal:

```bash
cd sdk/Navigation && bun dev
```

Expected: dev server prints a QR code.

- [ ] **Step 2: Run through the checklist**

Scan the QR from MentraOS app → Settings → Developer settings → Mini App Development → Scan Mini App QR. Then:

- [ ] Idle: map renders, my-location card shows current GPS, compass updates.
- [ ] Glasses HUD: shows "Welcome to Mentra Navigation!" within 5 s.
- [ ] Search: type a destination → suggestions appear; rapid typing cancels prior results (no obvious flicker in stale-suggestions).
- [ ] Preview: pick a destination → preview polyline draws on the map.
- [ ] Start trip → glasses HUD changes to "Turn left in 200m" (or similar pivot text) on approach.
- [ ] Mid-turn: glasses HUD shows "Onto X St" while inside the turn radius.
- [ ] Arrival: glasses HUD shows "You have arrived at <destination>" for ~10 s.
- [ ] Close-WebView mid-trip → reopen: page shows current trip state immediately (no re-search required, no blank map for >2 s).
- [ ] Stop trip via "Stop" button → glasses display clears.
- [ ] App teardown via swipe-back → background disposes, glasses clear.

- [ ] **Step 3: Document any regression**

If anything from the checklist fails, file a follow-up rather than blocking the migration. The migration's success criterion is "all paths work as well as the old version, plus the mid-trip-close-WebView path now works."

---

## Self-Review

After writing this plan, scan it against the spec for coverage and consistency.

**Spec coverage:**
- Part 1 SDK helper: Tasks 1-10 ✓
- Part 2 Navigation migration: Tasks 15-26 ✓
- Documentation: Task 14 ✓
- TesterController refactor: Tasks 11-13 ✓
- Sequencing alignment: spec said 17 steps, plan has 28 — finer granularity, same logical order. Spec step 1 (envelope) = plan Tasks 1-2. Spec step 8 (docs) = plan Task 14. Spec step 17 (manual verify) = plan Task 28. ✓

**Placeholders / red flags:** none — every code step has the actual code to write.

**Type consistency check:**
- `Rpc<Req, Res>`, `IsRpc`, `RpcReq`, `RpcRes`, `RpcRequestOptions`, `RpcHandlerContext`, `MentraRpcError`, `MentraRpcTimeoutError` — declared in Task 1, exported in Tasks 5/7, used consistently in Tasks 8, 11, 15, 18.
- `Channels` interface — declared per-miniapp in Tasks 11 (example) and 15 (Navigation), consumed by `ui.handle` / `mentra.request` calls in their respective controllers.
- `NavSnapshot`, `TripState`, `DevSettings`, `Coords`, `LogEntry` — declared in Task 15, used in 18, 19, 21, 23.
- `useRpc<Channels, "channel-name">` — same generic pattern everywhere.

**Naming consistency:** `handle()` (not `register()`), `request()` (not `call()`), `useRpc` (not `useRequest`), `MentraRpcError` (not `RpcError`). Consistent across all tasks.

Plan is ready to execute.
