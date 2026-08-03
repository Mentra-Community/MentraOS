# Miniapp Interop: System Lifecycle Control + Actions — Implementation Plan

Status: draft for review
Scope: `@mentra/miniapp` SDK, island module (host), miniapp-cli (manifest), example miniapp
Primary consumer: Mentra AI (`com.mentra.ai`) rewritten as a local miniapp

## Goal

Let **system miniapps** (Mentra AI first) do four things, all host-mediated:

1. `list()` installed miniapps (compatibility-filtered, with their declared actions)
2. `start(packageName)` / `stop(packageName)` other miniapps
3. `invoke(packageName, actionId, params)` — call a typed, manifest-declared **action** in another miniapp
4. Targets **wake automatically**: invoking an action on a stopped miniapp spawns its background JSContext, delivers the call, and returns the result. The woken app stays running until explicitly stopped (no idle reclaim in v1).

The action format must be mechanically translatable to MCP tools (not a literal MCP server — just a schema that maps 1:1).

## Non-goals (v1)

- No events/pub-sub plane between miniapps (deferred until a concrete need exists)
- No non-system callers: every interop API is SYSTEM-only. No `visibility` field in the manifest, no consent UI, no per-action ACLs. When third-party callers happen someday, a `visibility` field gets added with default `"system"` so v1 manifests stay valid.
- No cloud involvement. The legacy cloud system-app API (`cloud/.../system-app.api.ts`) is untouched and dies with the cloud SDK.
- No binary payloads through actions (pass URIs / storage keys instead)

## Mental model (the Android mapping)

| Ours | Android equivalent |
|---|---|
| RN host (LocalMiniappRuntime + JSCRuntime) | system_server + Binder |
| Host-bound packageName per JSContext | kernel-assigned UID |
| `session.miniapps.start()` | launching an app (user-visible) |
| `invoke()` on a stopped app → headless wake | delivering an explicit Intent to a manifest-declared component (system spawns the process, no UI) |
| `actions` in miniapp.json | `<receiver>`/`<service>` + intent-filter in AndroidManifest — but typed and described |
| Privilege table (request type → SYSTEM/ALL) | signature/privileged permission on framework APIs |
| Explicit addressing only (packageName + actionId) | explicit Intents. No implicit resolution — the LLM reads action descriptions instead of the system matching intent filters |

## 1. SDK surface (`mobile/modules/miniapp`)

Two namespaces, split by **layer** (not by caller/target):

- **`session.miniapps`** — discover and control the lifecycle of *other miniapps as apps*: `list`, `start`, `stop`. SYSTEM-only, and likely permanently so (you don't want arbitrary apps killing each other).
- **`session.actions`** — the *action layer* (the MCP-shaped capability surface), both directions: `invoke` (call another miniapp's action) and `handle` (expose one of your own). This namespace **is** the MCP tool layer: `invoke` = an MCP client calling a tool, `handle` = an MCP server exposing one.

Why `invoke` lives in `actions`, not `miniapps`: `invoke` and `handle` are the two ends of one wire — both keyed by `actionId`, both about a *capability* rather than the app's lifecycle. Keeping them together makes the model self-evident ("an action has a caller side and a handler side"), maps cleanly onto MCP, and matches their permission *trajectory* — `start`/`stop`/`list` stay privileged forever, while `invoke` (like `handle`) is meant to open up to non-system callers later. `list`/`start`/`stop` are operations on the *app*; `invoke`/`handle` are operations on an *action*. (Resolved from review: the earlier `miniapps.invoke` placement grouped by "takes a packageName," which read as an awkward split from `handle`.)

### `session.miniapps` — lifecycle & discovery (SYSTEM-only)

```ts
session.miniapps.list(opts?: {includeIncompatible?: boolean}): Promise<MiniappInfo[]>
session.miniapps.start(packageName: string): Promise<void>      // user-tap semantics
session.miniapps.stop(packageName: string): Promise<void>

interface MiniappInfo {
  packageName: string
  name: string
  description?: string
  version: string
  running: boolean
  compatibility: CompatibilityResult      // the existing island type — see below
  actions: DeclaredAction[]               // straight from the installed manifest
}
```

- `list()` returns **compatible apps only** by default. Each entry carries the project's existing `CompatibilityResult` (`mobile/modules/engine/src/utils/hardware/hardware.ts:13`) — `{isCompatible, missingRequired: HardwareRequirement[], missingOptional, warnings}` — already computed on `ClientApp.compatibility`. So "incompatible reasons" aren't a vague string array; they're structured `missingRequired` hardware requirements (CAMERA, DISPLAY, etc.), and `HardwareCompatibility.getCompatibilityMessage(result)` / `getDetailedMessages(result)` already turn them into human strings Mentra AI can speak ("the camera app needs glasses with a camera"). `includeIncompatible: true` adds the incompatible apps to the list.
- `start()` goes through the exact same path as a home-screen tap (`useAppStatusStore.start`), so hardware gates, the captions STT gate, foreground arbitration, and navigation all apply unchanged.
- `list`/`start`/`stop` from a non-system app reject with `NOT_PERMITTED`.

### `session.actions` — invoke (caller) + handle (target)

```ts
// Caller side — SYSTEM-only for now (room to open to non-system callers later)
session.actions.invoke<TResult = unknown>(
  packageName: string,
  actionId: string,
  params?: Record<string, unknown>,
  opts?: {timeoutMs?: number},                                  // default 30s, max 120s
): Promise<TResult>

// Target side — open to ALL miniapps (any app may expose actions)
session.actions.handle(
  actionId: string,
  handler: (params: Record<string, unknown>, ctx: ActionContext) => unknown | Promise<unknown>,
): () => void                              // unsubscribe, mirrors session.ui.handle

interface ActionContext {
  callerPackageName: string                // injected by host — never self-reported
  callId: string
}
```

- **`invoke`** rejects with `NOT_PERMITTED` from a non-system caller. Exposing actions (`handle`) is open to everyone; only *calling* others' actions is privileged. The 256 KB payload cap (see §3) applies only here — `list`/`start`/`stop` carry no meaningful payload.
- **`handle`** semantics mirror `session.ui.handle` exactly: one handler per actionId, synchronous throw on double-register, thrown errors propagate to the caller as a rejected `invoke()`.
- Handling an actionId not declared in the manifest logs a warning (dev) — the host will never route calls to it.
- **Registration race**: a woken app's handlers register during module init. The SDK buffers inbound action calls for up to 5s waiting for the handler before rejecting with `NO_ACTION_HANDLER` — same per-channel buffering trick the UI bus already uses (`modules/ui.ts`).

## 2. Manifest: declared actions (`miniapp.json`)

New optional top-level field, validated by the CLI (`sdk/miniapp-cli/src/manifest.ts`):

```json
"actions": [
  {
    "id": "add_todo",
    "description": "Add an item to the user's todo list. Use when the user asks to remember, note, or add something.",
    "parameters": {
      "type": "object",
      "properties": {
        "text": {"type": "string", "description": "The todo item text"},
        "due": {"type": "string", "description": "Optional ISO-8601 due date"}
      },
      "required": ["text"]
    }
  }
]
```

Rules:

- `id`: `^[a-z][a-z0-9_]*$`, unique within the app, max 64 chars. Global uniqueness is `packageName + id` (explicit addressing — no namespace collisions possible).
- `description`: required, non-empty. This is the AI-facing contract — CLI lints for length (≥ 20 chars recommended).
- `parameters`: **a JSON Schema object, restricted to the MCP-compatible subset**: top-level `type: "object"`, `properties` with `type` ∈ `string` / `number` / `boolean` / `array` (of primitives), plus `enum`, `description`, `items` (for arrays), and a top-level `required` array. `number` (not `integer`) since the runtime is JavaScript and everything is a JS number anyway. Arrays of primitives are allowed. No nested objects in v1 (keeps host validation trivial; relax later). This maps verbatim to an MCP `inputSchema`.
- **No new version gate.** This is greenfield and additive — the `actions` field is optional and ships in the current `@mentra/miniapp` 0.3.x line (host `supportedSdkRange` is `^0.3.0`, current SDK is `0.3.0`). A miniapp built against an SDK that has `session.actions` simply has it; older manifest parsers ignore an unknown `actions` field. We do **not** bump to 0.4.0 — that would fall outside the host's `^0.3.0` range and break the existing gate for no benefit.

### MCP correspondence (the reason for the schema choice)

| miniapp.json | MCP tool |
|---|---|
| `packageName` + `id` | `name` (adapter mangles, e.g. `com_mentra_todo__add_todo` — MCP names disallow dots) |
| `description` | `description` |
| `parameters` | `inputSchema`, verbatim |
| `invoke()` JSON result | tool result content |

Mentra AI consumes `miniapps.list()` directly (in-process, no MCP server). A future "expose installed miniapps to external agents" feature is a thin adapter over the same registry.

## 3. Wire protocol additions (`mobile/modules/miniapp/src/protocol.ts`)

New `MiniappRequestType` values (background → host):

- `miniapp_apps_list`
- `miniapp_app_start`
- `miniapp_app_stop`
- `miniapp_action_invoke` — `{targetPackageName, actionId, params, timeoutMs}`
- `miniapp_action_result` — target → host: `{callId, ok, result | error}`

New `MiniappResponseType` value (host → target):

- `ACTION_CALL` — `{callId, actionId, params, callerPackageName}` delivered as an event-style envelope to the target's background context

Correlation is double-legged and host-owned: caller's `requestId` ↔ host-generated `callId` ↔ target's `miniapp_action_result`. Both legs reuse the existing `pendingRequests` machinery in `session.ts`.

New `MiniappErrorCode` values: `NOT_PERMITTED`, `APP_NOT_FOUND`, `APP_NOT_COMPATIBLE`, `ACTION_NOT_FOUND`, `NO_ACTION_HANDLER`, `WAKE_FAILED`, `ACTION_TIMEOUT`, `PAYLOAD_TOO_LARGE`.

Payload cap (max serialized size of an action call's `params` and of its `result`): **256 KB each**, host-enforced → `PAYLOAD_TOO_LARGE`. One number for both directions — no reason to make them differ. The point is to stop a huge blob being shoved across the JS-context bridge (it's JSON-serialized); actions carry commands, not media — pass a URI or storage key for anything large. It's a single host-side constant (lives in `LocalMiniappRuntime`, not in the SDK, the wire format, or any miniapp), so changing it is a one-line host edit shipped in an app update — no SDK release.

## 4. Host implementation (island module)

### Prerequisite — extract a headless `MiniappLauncher` (do this first)

Everything below assumes a miniapp's background context can be spawned **without any UI**. Today it can't: the launch sequence — resolve the bundle (dev HTTP vs installed `file://`), read the manifest, then `MentraJSRouter.spawnAndRegister` — lives inside the `LocalMiniappView` React component's mount effect (`mobile/src/components/miniapp/LocalMiniappView.tsx:224-337`), and only runs because the `<Compositor>` mounts that component on **foreground**. `useAppStatusStore.start()` just sets `running: true` optimistically; the actual spawn is a side effect of the UI mounting.

That breaks the headless wake (no foreground → no mount → no spawn) and is incompatible with the codebase direction: `island` is becoming a **native library** OEMs embed via RN brownfield, with **no shared UI components** (the UI-Kit idea is dropped — OEMs write their own native UI). Any logic stuck in our RN components is invisible to an OEM. So the launch logic must live in `island`, and its API is part of island's public, native-facing surface.

**Extract a `MiniappLauncher` service in `island`:**

```ts
launcher.ensureRunning(packageName): Promise<void>   // resolve bundle → read manifest → spawnAndRegister; resolves on the
                                                     //   context's miniapp_connect handshake; idempotent
launcher.stop(packageName): Promise<void>            // unregister/kill the background context
launcher.isRunning(packageName): boolean
```

`ensureRunning` resolves once the context has spawned **and** completed its `miniapp_connect` handshake (or rejects on a spawn/connect timeout). This gives the connect-await a single home instead of each caller polling. It owns the bundle-resolve + manifest-read + spawn recipe currently **duplicated** across `LocalMiniappView`, `mentraJsBootstrap.ts` (dev respawn), `MiniappCatalog`, and `devMiniappLaunch.ts`. No React, no RN-component imports — it must be callable from native across the brownfield bridge.

**Re-wiring (the whole job is moving four things out of one component):**
- `apps.ts` `start()` → calls `launcher.ensureRunning(pkg)` so "start" actually spawns, then runs its existing foreground/arbitration (user-tap semantics). Spawn no longer depends on the UI.
- `apps.ts` `stop()` → calls `launcher.stop(pkg)`.
- `LocalMiniappView` → becomes dumb: bind + render the `<WebView>` only. It no longer resolves bundles or spawns anything.
- The interop `ActionCallBroker` (§4.3) → calls `launcher.ensureRunning(pkg)` for the headless wake.

**The boundary this draws (the point of the exercise):** background-context spawn = `island` (the launcher); WebView *rendering* + foregrounding = the app/OEM. The WebView *host* logic (the `window.MentraOS` injection + `WebviewBridge`) is **already** in island, so the launcher is the one remaining headless piece. After this, `setForeground` cleanly means "render the WebView for an already-running background context" — correctly a UI concern.

### 4.1 Privilege check (PUBLIC vs SYSTEM)

Two protection levels, named after access modifiers (and Android's `normal` vs `privileged` protectionLevels):

- **PUBLIC** — no guard; any miniapp may call. This is the **default for every SDK function**, so it is expressed by *omission* — there is no `"PUBLIC"` token to write. Everything that exists today (display, camera, storage, subscriptions, `session.actions.handle`, …) is PUBLIC simply by not being listed below.
- **SYSTEM** — system apps only.

So the whole mechanism is a set of the SYSTEM-gated request types, checked before dispatch — mirroring the existing `permissionRequirements` gate in `JSCDispatcher`:

```ts
// Only the *restricted* request types are enumerated. Anything not in this set
// is PUBLIC (the default). No "PUBLIC"/"ALL" value exists — open is the absence
// of a restriction, which is why it's the default for every other SDK function.
const SYSTEM_ONLY = new Set<string>([
  "miniapp_apps_list",     // session.miniapps.list
  "miniapp_app_start",     // session.miniapps.start
  "miniapp_app_stop",      // session.miniapps.stop
  "miniapp_action_invoke", // session.actions.invoke
])
// before dispatch: if (SYSTEM_ONLY.has(type) && !isSystemCaller(pkg)) → NOT_PERMITTED
```

`session.actions.handle` is deliberately absent — exposing your own actions is PUBLIC. `invoke` is SYSTEM in v1 and stays SYSTEM for this plan (opening it to non-system callers is out of scope). If a third level beyond PUBLIC/SYSTEM is ever needed (e.g. user-consented), this graduates from a `Set` to an explicit enum then — not now.

`isSystemCaller(packageName)` returns true iff **either**:

- `SYSTEM_APPS.includes(packageName)` (`mobile/src/constants/miniapps.ts`), **or**
- the app is a dev sideload (`isMiniappDev`)

That's it. Sideloads are trusted because sideloading already requires the developer to be driving the phone (same trust model as adb on Android) — and this is exactly how the Mentra AI team iterates on the AI miniapp before it ships as a built-in. Squatting isn't a concern: a sideload is already privileged regardless of the name it claims, and in production the store owns `packageName` uniqueness, so a non-system app can't ship as `com.mentra.ai`.

### 4.2 Lifecycle handlers (`LocalMiniappRuntime`)

- `miniapp_apps_list` → read `AppRegistry.getInstalledMiniapps()` + island apps store state (`running`, `compatibility`) + cached declared actions. No spawning.
- `miniapp_app_start` → `useAppStatusStore.getState().start(app)` — full user-tap path (now spawns via `launcher.ensureRunning` internally, then foregrounds; see prerequisite).
- `miniapp_app_stop` → `useAppStatusStore.getState().stop(packageName)` (calls `launcher.stop` internally).

### 4.3 Action broker (`LocalMiniappRuntime`, new `ActionCallBroker` helper)

`miniapp_action_invoke` flow:

1. Privilege check (caller), existence checks: target installed (`APP_NOT_FOUND`), action declared in its manifest (`ACTION_NOT_FOUND`), target hardware-compatible (`APP_NOT_COMPATIBLE`).
2. If target not running → **headless wake**: `await launcher.ensureRunning(targetPackageName)` (the launcher from the prerequisite). Background context only — no foreground, no arbitration, no WebView; deliberately **not** `useAppStatusStore.start`, so the user's active app is never disturbed. Resolves on the target's `miniapp_connect`; 10s timeout → `WAKE_FAILED`.
3. Deliver `ACTION_CALL` to the target's context; arm handler timeout (caller's `timeoutMs`, default 30s → `ACTION_TIMEOUT`). If the target's `handle()` hasn't registered yet, buffer up to 5s, else `NO_ACTION_HANDLER`.
4. On `miniapp_action_result` (matched by `callId`), forward result/error to the caller's pending request.

### 4.4 Action registry (`AppRegistry`)

- Parse + validate the `actions` field at install (`unpackMiniApp`) and launch (`getMiniappManifest`); cache per installed app for `list()` and broker lookups. Invalid actions → install warning, action omitted from registry (don't brick the install).
- Include `declaredActions` in the `CONNECT_ACK` payload so the SDK can warn on `handle()` for undeclared ids.

### 4.5 No idle reclaim in v1

A miniapp woken by an action **stays running** until something explicitly stops it (the user via the home UI, or a system app via `stop()`). No idle timers, no `startedBy` tracking, no reclaim sweep — all cut for v1. Rationale: it's the simplest correct behavior, it avoids stop-vs-second-invoke races entirely, contexts are cheap (~3–5 MB), and AI calls cluster in conversational bursts where staying warm is what you want anyway. A woken app shows as running in the UI exactly like a user-started one, and the user can stop it like any other app. If memory pressure ever makes reclaim worth it, it's an additive follow-up.

### 4.6 Visibility of system-initiated start/stop (no new UI needed)

`start()`/`stop()` already surface through existing machinery — we don't add a hint:

- **On glasses:** `LocalDisplayManager.onMount` already sends a `"Starting <AppName>…"` boot message to the display when a miniapp mounts (`mobile/modules/engine/src/services/LocalDisplayManager.ts:122`). Because system `start()` goes through the same `useAppStatusStore.start` → mount path as a tile tap, the AI starting an app looks identical to the user starting it.
- **In the app list:** the app flips to `running` in the home UI either way.
- **Headless action wakes intentionally show nothing** on the glasses — a background action shouldn't seize the display. The boot message is tied to *display mount*, not background spawn, so a woken app that never calls `session.display` stays invisible, which is the desired behavior.

## 5. Implementation phases

**Phase 0 — Runtime prerequisite: extract `MiniappLauncher`.**
Move bundle-resolve + manifest-read + `spawnAndRegister` out of `LocalMiniappView` into an island `MiniappLauncher` (`ensureRunning`/`stop`/`isRunning`); re-wire `apps.ts` `start`/`stop` to it; make `LocalMiniappView` render-only. No React in the launcher (it ships across the native bridge). Dedupe the recipe from `mentraJsBootstrap`/`MiniappCatalog`/`devMiniappLaunch`.
Files: `island/src/services/MiniappLauncher.ts` (new), `island/src/stores/apps.ts`, `mobile/src/components/miniapp/LocalMiniappView.tsx`.
Accept: tapping a miniapp still launches it; a background context can be spawned with the UI closed (call `launcher.ensureRunning` from a non-UI path and confirm `miniapp_connect`); dev respawn unaffected.

**Phase 1 — Lifecycle + list (SYSTEM-gated).**
Protocol types; `session.miniapps` module with `list/start/stop`; host handlers + privilege registry + `isSystemCaller`.
Files: `miniapp/src/protocol.ts`, `miniapp/src/modules/miniapps.ts` (new), `miniapp/src/session.ts`, `island/src/services/LocalMiniappRuntime.ts`, `mobile/src/constants/miniapps.ts` (export `isSystemCaller` helper).
Accept: a dev-sideloaded miniapp lists apps (with `CompatibilityResult`), starts and stops Captions; a non-system miniapp gets `NOT_PERMITTED`.

**Phase 2 — Manifest actions + handler registration (`handle`).**
CLI schema + validation (`sdk/miniapp-cli/src/manifest.ts`); `AppRegistry` parse/cache; new `miniapp/src/modules/actions.ts` with `handle` (target side, open to all); `declaredActions` in CONNECT_ACK. No SDK version bump (additive in 0.3.x).
Accept: example miniapp declares `add_todo` and registers a handler; `mentra-miniapp dev` validates good/bad manifests; `miniapps.list()` returns its action schema.

**Phase 3 — Invocation + wake (`invoke`).**
Add `invoke` to `miniapp/src/modules/actions.ts` (caller side, SYSTEM-gated); `ActionCallBroker`, `ACTION_CALL`/`miniapp_action_result` envelopes, double correlation, headless wake via `launcher.ensureRunning` (Phase 0), timeouts, size caps, error codes, handler-registration buffering.
Accept: `invoke()` of `add_todo` on a stopped example miniapp wakes it headlessly (no navigation), returns the result, end-to-end < ~2s warm path; the woken app stays running; all error codes reachable in tests.

**Phase 4 — Audit trail.**
PostHog audit events for every interop call (`caller`, `target`, `actionId`/lifecycle op, outcome — an LLM caller will eventually do something the user wants to trace). PostHog is already wired in the mobile app.
Accept: a `start`/`stop`/`invoke` from a system app emits a structured analytics event.

**Phase 5 — Example, docs, Mentra AI handoff.**
Update `sdk/example-miniapp` with a declared+handled action; docs page (manifest reference + `session.miniapps`/`session.actions`); a short "consuming actions as LLM tools" note for the Mentra AI team showing `miniapps.list()` → MCP-shaped tool defs.

## 6. Testing

- Unit: manifest validation (CLI), privilege checks, broker correlation/timeout paths (island), SDK handler semantics (mirror existing `ui.ts` tests).
- E2E (dev mode): two sideloaded miniapps — one invoking actions on the other; exercise wake, result, and timeout. Browser simulator (`agents/miniapp-browser-testing-simulator-spec.md`) for SDK-side without glasses.

## 7. Settled decisions

No open questions — the scope is fixed:

- **Headless launcher (Phase 0)** — miniapp spawn moves out of `LocalMiniappView` into an island `MiniappLauncher`; `start`/`stop`/wake all go through it. Needed regardless of this feature, since `island` ships as a native lib with no shared UI components (UI-Kit dropped).
- **`invoke` is SYSTEM-only**, full stop. Opening it to non-system callers is out of scope for this plan; not a future concern to design around now.
- **Payload cap** is a single **256 KB** for both `params` and `result`. One-line host edit if a real action ever needs more.
- **PUBLIC is the default** protection level (expressed by omission); **SYSTEM** is the only gated level.
- **No idle reclaim** — woken apps stay running until explicitly stopped.
- **No new UI hint** — the display manager already shows "Starting …" + the running badge.
- **Params** use `number` (not `integer`) and allow primitive arrays.
- **No SDK version bump** — additive in the 0.3.x line, matching the host's `^0.3.0` range.
