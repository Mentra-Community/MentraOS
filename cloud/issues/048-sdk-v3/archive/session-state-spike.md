# Spike: Session ↔ Webview Shared State — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [reconnection spike](./reconnection-architecture-spike.md), [client SDK spike](./client-sdk-spike.md)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The typed shared state system (`session.state`) for SDK v3 — how mini apps share state between the session runtime (Hermes on phone, or Hono on a server) and the webview (phone screen, or browser). Covers the problem, proposed API with full TypeScript generics, transport mechanism, webview connection lifecycle, and MentraJS framework integration.

**What this doc does NOT cover:** The broader SDK v3 migration plan (see [spike.md](./spike.md)), persistent storage (`session.storage` — that's a separate, already-existing system), display/layout rendering on the glasses (see `session.display`), or the webview auth system itself (existing infrastructure, reused here).

**Key distinction:** `session.state` is **ephemeral, in-memory shared state** between session and webview. It does NOT persist across session restarts. If developers want persistence, they use `session.storage`. These are two separate systems with different guarantees.

---

## The Problem

Mini apps frequently need a phone-side companion UI — settings panels, detailed views, maps, debug overlays. Today there are two execution contexts:

| Context     | Runtime                                                        | Where it runs                    | What it does                                                    |
| ----------- | -------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------- |
| **Session** | Hermes (local apps) or Node/Bun (cloud apps via Hono)          | Phone JS engine or remote server | Always-on glasses logic — transcription, display, camera, audio |
| **Webview** | Browser engine (WKWebView / Android WebView / desktop browser) | Phone screen or browser tab      | Companion UI — settings, maps, detailed views, onboarding       |

The session code and webview code run in **completely separate JS runtimes**. They share no memory, no global state, no module scope. Today there is no clean way to synchronize state between them.

### What developers do today

Developers build their own state management. The captions app, for example, has a `UserSession` wrapper class that manually shuttles settings between the session process and the webview over custom WebSocket messages. Every app reinvents this — custom message types, custom serialization, custom event listeners, no type safety across the boundary.

This is the same class of problem that React solved for component state, except across process boundaries. The SDK should own it.

---

## Proposed API

### Developer-defined state interface

The developer defines their app's shared state as a TypeScript interface. This is the single source of truth for what keys exist and what types they hold:

```typescript
// shared/state.ts
interface AppState {
  lastTranscript: string;
  settings: {
    fontSize: number;
    language: string;
    showTimestamps: boolean;
  };
  connectionCount: number;
}
```

### `MentraSession<T>` — generic session

The state interface is passed as a generic parameter to `MentraSession`. This threads type information through the entire session, so every `.state` call is fully type-checked:

```typescript
import type { AppState } from "../shared/state";

type Session = MentraSession<AppState>;
```

### Full type definitions

```typescript
/**
 * Shared state manager — ephemeral, in-memory state synchronized
 * between session and webview over the state transport.
 *
 * State does NOT persist across session restarts.
 * For persistence, use session.storage.
 */
interface StateManager<T extends Record<string, unknown>> {
  /**
   * Set a value in shared state. Immediately available locally
   * and synchronized to all connected webviews.
   */
  set<K extends keyof T>(key: K, value: T[K]): void;

  /**
   * Get the current value of a state key.
   * Returns undefined if the key has never been set.
   */
  get<K extends keyof T>(key: K): T[K] | undefined;

  /**
   * Subscribe to changes on a specific key.
   * Fires whenever set() is called for that key (from either side).
   * Returns an unsubscribe function.
   */
  on<K extends keyof T>(key: K, handler: (value: T[K]) => void): () => void;

  /**
   * Get a snapshot of all current state.
   */
  getAll(): Partial<T>;

  /**
   * Subscribe to any state change.
   * Fires on every set() call with the key and new value.
   * Returns an unsubscribe function.
   */
  onAny(handler: <K extends keyof T>(key: K, value: T[K]) => void): () => void;
}

/**
 * MentraSession with typed shared state.
 * T defaults to Record<string, unknown> for untyped usage.
 */
class MentraSession<T extends Record<string, unknown> = Record<string, unknown>> {
  readonly transcription: TranscriptionManager;
  readonly translation: TranslationManager;
  readonly display: DisplayManager;
  readonly camera: CameraModule;
  readonly speaker: SpeakerManager;
  readonly mic: MicManager;
  readonly device: DeviceManager;
  readonly phone: PhoneManager;
  readonly location: LocationManager;
  readonly led: LedModule;
  readonly storage: StorageManager;
  readonly permissions: PermissionsManager;
  readonly dashboard: DashboardManager;
  readonly time: TimeUtils;
  readonly state: StateManager<T>; // ← NEW

  // ... v2 compat getters, etc.
}
```

### Session-side usage

```typescript
// session/index.ts
import type { AppState } from "../shared/state";

export default function onSession(session: MentraSession<AppState>) {
  // ✅ Type-checked — "lastTranscript" exists and is string
  session.state.set("lastTranscript", "hello world");

  // ❌ TS error — value must be string, not number
  session.state.set("lastTranscript", 42);

  // ❌ TS error — "nonExistent" is not a key in AppState
  session.state.set("nonExistent", "foo");

  // ✅ Type-checked — returns string | undefined
  const transcript = session.state.get("lastTranscript");

  // ✅ Typed callback — settings is AppState["settings"]
  session.state.on("settings", (settings) => {
    console.log(settings.fontSize); // ✅ number
    console.log(settings.language); // ✅ string
  });

  // Subscribe to transcription and push to shared state
  session.transcription.on((event) => {
    session.state.set("lastTranscript", event.text);
  });

  // Snapshot of all state
  const snapshot = session.state.getAll();
  // ^? Partial<AppState>
}
```

### Webview-side usage (React hooks)

The webview side exposes React hooks that subscribe to shared state. These hooks are provided by `@mentra/react` (or the webview SDK package):

```typescript
/**
 * React hook — subscribes to a single key in shared state.
 * Re-renders the component when the value changes.
 * Returns the current value (or undefined if not yet set).
 */
function useMentraState<T extends Record<string, unknown>, K extends keyof T>(key: K): T[K] | undefined;

/**
 * React hook — returns the current connection status
 * between the webview and the session runtime.
 */
function useMentraConnection(): ConnectionStatus;

type ConnectionStatus =
  | "connected" // WebSocket open, state syncing
  | "connecting" // WebSocket handshake in progress
  | "disconnected" // WebSocket closed, will retry
  | "no-session"; // No active session exists (app not running)

/**
 * React hook — returns the auth context for the current webview.
 * Already exists in the current SDK — reused here for state transport auth.
 */
function useMentraAuth(): {
  frontendToken: string | null;
  sessionId: string | null;
  userId: string | null;
};
```

Webview component example:

```tsx
// webview/App.tsx
import type { AppState } from "../shared/state";

function CaptionsView() {
  // ✅ Type-checked — "lastTranscript" exists in AppState, typed as string
  const lastTranscript = useMentraState<AppState, "lastTranscript">("lastTranscript");

  // ❌ TS error — "doesNotExist" is not a key in AppState
  const oops = useMentraState<AppState, "doesNotExist">("doesNotExist");

  const status = useMentraConnection();

  if (status === "no-session") {
    return <div>App is not running</div>;
  }

  if (status !== "connected") {
    return <div>Connecting...</div>;
  }

  return (
    <div>
      <p>{lastTranscript ?? "Waiting for speech..."}</p>
    </div>
  );
}

function SettingsPanel() {
  const settings = useMentraState<AppState, "settings">("settings");
  const { setMentraState } = useMentraActions<AppState>();

  // Webview can write state too — syncs back to session
  const updateFontSize = (size: number) => {
    setMentraState("settings", {
      ...settings,
      fontSize: size,
    });
  };

  return (
    <div>
      <label>Font Size: {settings?.fontSize ?? 16}</label>
      <input
        type="range"
        min={12}
        max={32}
        value={settings?.fontSize ?? 16}
        onChange={(e) => updateFontSize(Number(e.target.value))}
      />
    </div>
  );
}
```

Webview write hook:

```typescript
/**
 * React hook — returns functions to write to shared state from the webview.
 * Writes are sent to the session and broadcast to all subscribers.
 */
function useMentraActions<T extends Record<string, unknown>>(): {
  setMentraState: <K extends keyof T>(key: K, value: T[K]) => void;
};
```

---

## Transport

### How state sync happens

State synchronization uses a WebSocket between the session runtime and the webview. The transport differs between local and cloud apps, but the protocol is identical.

#### Local apps (session runs on phone in Hermes)

```
┌─────────────────────┐       native bridge       ┌─────────────────────┐
│   Hermes runtime    │ ◄──────────────────────► │     WKWebView /      │
│   (session code)    │    (same process,          │   Android WebView    │
│                     │     synchronous)           │   (webview code)     │
└─────────────────────┘                            └─────────────────────┘
```

For local apps, the session and webview are on the same device. Communication uses the native bridge between the Hermes JS engine and the webview — same mechanism already used for other session↔phone communication. No network involved. State updates are effectively synchronous.

#### Cloud apps (session runs on server via Hono)

```
┌─────────────────────┐      WebSocket (wss://)    ┌─────────────────────┐
│   Hono server       │ ◄────────────────────────► │   Browser /          │
│   (session code)    │    (authenticated,          │   Phone WebView      │
│                     │     state channel)          │   (webview code)     │
└─────────────────────┘                            └─────────────────────┘
```

For cloud apps, the webview (in the browser or phone) connects to the Hono server over a WebSocket. This is a dedicated state channel, separate from the glasses↔cloud WebSocket.

### Authentication

The state WebSocket reuses the existing webview auth system. The webview already obtains a `frontendToken` via `useMentraAuth()` — this token is sent during the WebSocket handshake to authenticate and associate the connection with the correct session.

No new auth infrastructure needed.

### Wire protocol

State messages are JSON over the WebSocket. Minimal protocol — three message types:

```typescript
// Session → Webview: state update
{
  type: "state:set",
  key: string,
  value: unknown   // JSON-serializable
}

// Webview → Session: state update (webview can write too)
{
  type: "state:set",
  key: string,
  value: unknown
}

// Session → Webview: full state snapshot (sent on initial connection)
{
  type: "state:snapshot",
  state: Record<string, unknown>
}
```

On initial WebSocket connection, the session sends a `state:snapshot` with the full current state. After that, incremental `state:set` messages flow in both directions. This ensures the webview always has the latest state, even if it connects after the session has been running for a while.

### Serialization constraint

State values must be JSON-serializable. No functions, no class instances, no circular references. TypeScript can't enforce this at the type level (without heavy mapped types), but the runtime should `JSON.parse(JSON.stringify(value))` on set and throw a clear error if serialization fails.

---

## Webview Connection States

The webview needs to know the status of its connection to the session. This is exposed via the `useMentraConnection()` hook:

```
                    ┌──────────────┐
        page load → │  connecting  │
                    └──────┬───────┘
                           │
                    WS open + snapshot received
                           │
                    ┌──────▼───────┐
              ┌───► │  connected   │ ◄───┐
              │     └──────┬───────┘     │
              │            │             │
              │     WS closed /          │  WS reconnected
              │     network error        │
              │            │             │
              │     ┌──────▼───────┐     │
              │     │ disconnected │ ────┘
              │     └──────┬───────┘
              │            │
              │     reconnect attempts exhausted /
              │     server reports no session
              │            │
              │     ┌──────▼───────┐
              │     │  no-session  │
              │     └──────────────┘
              │            │
              │     session starts (or user retries)
              └────────────┘
```

| Status         | Meaning                         | Typical UI                                       |
| -------------- | ------------------------------- | ------------------------------------------------ |
| `connecting`   | WebSocket handshake in progress | Loading spinner                                  |
| `connected`    | Authenticated, state syncing    | Normal app UI                                    |
| `disconnected` | Connection lost, auto-retrying  | "Reconnecting..." banner, stale data still shown |
| `no-session`   | No active session on the server | "App not running" screen, or read-only fallback  |

The `disconnected` → `connected` transition is automatic. The SDK handles reconnection with exponential backoff (same pattern as the glasses↔cloud reconnection — see [reconnection spike](./reconnection-architecture-spike.md)).

The `disconnected` state preserves the last-known state in the webview. Components continue to render with stale data. This is intentional — a brief network blip shouldn't blank the screen.

---

## MentraJS Framework Integration

The shared state system aligns with the MentraJS framework convention structure. The framework uses convention-based directories to separate session code, webview code, and shared types:

```
my-app/
├── session/
│   └── index.ts          ← session.state.set("key", value)
├── webview/
│   └── App.tsx           ← useMentraState<AppState>("key")
└── shared/
    └── state.ts          ← interface AppState { ... }
```

### How the framework wires it up

The `shared/state.ts` file exports the state interface. Both `session/index.ts` and `webview/App.tsx` import from it. TypeScript ensures the same interface is used on both sides — a rename or type change in `shared/state.ts` produces compile errors in both session and webview code if they fall out of sync.

The framework handles the bridge setup automatically:

1. **Session side:** The framework creates `MentraSession<AppState>` with the developer's state type. `session.state` is ready to use — the developer never manually creates a WebSocket server or serializes messages.
2. **Webview side:** The framework wraps the React app in a `<MentraProvider>` that establishes the state WebSocket connection. Hooks like `useMentraState` read from this context. The developer never manually connects or parses messages.
3. **Shared types:** TypeScript's project references (or the framework's build step) ensure `shared/` is compiled once and used by both sides. No code duplication, no copy-paste type definitions.

### End-to-end type safety example

```typescript
// shared/state.ts
export interface AppState {
  lastTranscript: string;
  settings: {
    fontSize: number;
    language: string;
  };
}
```

```typescript
// session/index.ts
import type { AppState } from "../shared/state";

export default function onSession(session: MentraSession<AppState>) {
  session.state.set("lastTranscript", "hello"); // ✅
  session.state.set("lastTranscript", 42); // ❌ TS2345: number not assignable to string
  session.state.set("bogus", "value"); // ❌ TS2345: "bogus" not assignable to keyof AppState
}
```

```tsx
// webview/App.tsx
import type { AppState } from "../shared/state";

function MyComponent() {
  const transcript = useMentraState<AppState, "lastTranscript">("lastTranscript");
  //    ^? string | undefined

  const nope = useMentraState<AppState, "bogus">("bogus");
  //   ❌ TS2344: "bogus" does not satisfy keyof AppState
}
```

If the developer renames `lastTranscript` to `currentTranscript` in `shared/state.ts`, both the session code and the webview code get compile errors until they update. No runtime surprises.

---

## State Lifecycle

### Ephemeral by design

State lives in memory on the session side. When the session ends (user disconnects, app stops, server restarts), all state is gone. On the next session start, state is empty.

This is intentional:

- **Shared state is for UI synchronization**, not data persistence. "What is the current transcript?" "What are the user's active settings?" "How many connections are open?" — these are session-scoped questions.
- **Persistence is `session.storage`.** If the developer wants settings to survive restarts, they load from `session.storage` on session start and push to `session.state` for the webview to consume.

Typical pattern:

```typescript
export default function onSession(session: MentraSession<AppState>) {
  // Load persisted settings into ephemeral state on startup
  const savedSettings = await session.storage.get("settings");
  if (savedSettings) {
    session.state.set("settings", savedSettings);
  }

  // When webview changes settings, persist AND update state
  session.state.on("settings", async (settings) => {
    await session.storage.set("settings", settings);
    // State is already updated — webview sees it immediately
    // Storage write is for persistence across restarts
  });
}
```

### Multiple webviews

A session can have multiple webviews connected simultaneously (e.g., phone webview + browser tab for debugging). All connected webviews receive the same state updates. A `state:set` from any source (session or any webview) is broadcast to all other connected clients.

The session runtime is the source of truth. If two webviews set the same key simultaneously, last-write-wins at the session. No conflict resolution, no CRDTs — this is ephemeral UI state, not a distributed database.

---

## Open Questions

These are **not decided** — they need team discussion.

| #   | Question                                                                                | Context                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **What happens when webview is open but no session exists?**                            | User opens the browser URL directly, or the mini app crashed. Does the webview show stale data? A blank "app not running" screen? Read-only access to `session.storage`? The `no-session` connection status exists, but we haven't decided what the _default behavior_ should be. This might be app-specific (developer handles it in their `no-session` UI branch).                                                   |
| 2   | **Should the webview have read access to `session.storage` without an active session?** | If the session is not running, there's no `session.state`. But `session.storage` is persisted server-side. Should the webview SDK expose a `useMentraStorage()` hook that works even in `no-session` state? This would let the webview show saved settings or history even when the app isn't active. Adds complexity — the webview would need a separate REST/WS path to storage that doesn't go through the session. |
| 3   | **Does a `MentraSession` instance exist when only the webview is connected?**           | Today, sessions are created by webhooks (cloud) or app launch (local). If a user opens the webview URL but the mini app isn't running on any glasses, there is no session. Should connecting a webview create a "headless" session? Or is the session strictly tied to an active glasses connection?                                                                                                                   |
| 4   | **Grace period before `no-session` state fires?**                                       | If the mini app stops (crash, user switches apps, glasses disconnect), how quickly should the webview transition to `no-session`? Immediately? After 5 seconds? 30 seconds? A grace period would smooth over brief interruptions (glasses Bluetooth reconnecting, app restart). Too long and the webview shows stale data with no indication the session is gone.                                                      |
| 5   | **Auto-restart: should the webview trigger a mini app restart?**                        | If the webview detects `no-session`, should it be able to request that the OS restart the mini app? This is probably an OS-level concern (the phone OS decides when to start/stop apps), not an SDK concern. But the webview might need a `requestRestart()` API that signals the OS. Needs mobile team input.                                                                                                         |
| 6   | **Should `state.set()` support partial updates for object values?**                     | If `settings` is `{ fontSize: number, language: string }`, should `session.state.set("settings", { fontSize: 20 })` merge with the existing value, or replace it entirely? Replace is simpler and predictable. Merge is more ergonomic for large objects. React's `setState` merges at the top level — do we follow that precedent, or keep it simple with full replacement?                                           |
| 7   | **Rate limiting / batching for high-frequency updates?**                                | If the session does `session.state.set("transcript", ...)` 30 times per second (live transcription), should the transport batch updates? The webview doesn't need 30 re-renders per second. Could debounce on the webview side (hook-level), or batch on the session side (transport-level). Need to decide where throttling lives.                                                                                    |
