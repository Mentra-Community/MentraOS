/**
 * @mentra/miniapp/framework
 *
 * The framework primitives layered on top of the @mentra/miniapp library.
 * Same package, separate import surface, so the team can compare
 * library-vs-framework shapes without touching the existing library API.
 *
 * Design intent:
 *
 *   - `session` is the same long-lived MiniappSession that `useSession()`
 *     returns. Both surfaces share one process-wide singleton via the
 *     internal/shared-session helper. There is no scenario where a
 *     miniapp ends up with two competing MiniappSession instances by
 *     using both surfaces.
 *
 *   - `state` is a reactive snapshot store. `state.set(...)` produces a
 *     new immutable snapshot, which framework/react's `useMentra()`
 *     subscribes to via useSyncExternalStore.
 *
 *   - `exposeClient({ ... })` registers functions on a global proxy
 *     target. The webview reads them via `mentra.client.X()` (typed by
 *     the developer passing `typeof import("../client")` as a generic).
 *     v1 of the framework will auto-discover exports at build time;
 *     v0 requires the one-line registration.
 *
 *   - `defineConfig(...)` is an identity function with type inference
 *     for `mentra.config.ts`. It exists to give consumers a typed
 *     declaration site without forcing an awkward bare object literal.
 *
 * For the import-rule policy that keeps `state` and `session` out of
 * webview-side code, see `cloud/packages/js/src/dev.ts` (under
 * @mentra/js) and the framework's own forthcoming dev tooling. v0
 * relies on convention; v1 enforces it at build time.
 */

import type {MiniappSession} from "../session"
import {getOrCreateSharedSession} from "../internal/shared-session"

// ─── Session ────────────────────────────────────────────────────────────────

/**
 * The same MiniappSession that `useSession()` returns. Lazily
 * initialized on first access; calls `connect()` once.
 *
 * This is a `Proxy` so the developer can write top-level code like
 * `session.transcription.on(...)` without worrying about whether the
 * singleton has been created yet.
 */
export const session = new Proxy({} as MiniappSession, {
  get(_target, prop, receiver) {
    const s = getOrCreateSharedSession()
    const value = Reflect.get(s, prop, receiver)
    return typeof value === "function" ? value.bind(s) : value
  },
})

/**
 * Register a one-shot callback for when the session is ready (CONNECT_ACK
 * received). If already ready, fires on the next microtask.
 */
export function onReady(callback: () => void): void {
  const s = getOrCreateSharedSession()
  if (s.ready) {
    queueMicrotask(callback)
    return
  }
  s.waitForReady()
    .then(() => callback())
    .catch((err) => console.error("[@mentra/miniapp/framework] onReady error:", err))
}

// Convenience: attach onReady to the session proxy as well, so apps
// can write `session.onReady(...)` in addition to `import { onReady }`.
;(session as unknown as {onReady: typeof onReady}).onReady = onReady

// ─── State ──────────────────────────────────────────────────────────────────

type Listener = () => void

class StateStore {
  /** Live data; mutable. */
  private data: Record<string, unknown> = {}
  /**
   * Immutable snapshot, replaced on every `set()`. useSyncExternalStore
   * relies on referential stability between calls when nothing has
   * changed; we provide that by keeping the same snapshot object
   * until a write produces a new one.
   */
  private snapshot: Record<string, unknown> = {}
  private listeners = new Set<Listener>()
  private initialized = false

  init<T extends object>(defaults: T): void {
    if (this.initialized) {
      // Idempotent re-init: merge defaults but keep already-set values.
      // Avoids clobbering state if the developer re-imports client/
      // during HMR.
      for (const [k, v] of Object.entries(defaults)) {
        if (!(k in this.data)) this.data[k] = v
      }
    } else {
      this.data = {...defaults} as Record<string, unknown>
      this.initialized = true
    }
    this.snapshot = {...this.data}
  }

  get<T = unknown>(key: string): T {
    return this.data[key] as T
  }

  set(key: string, value: unknown): void {
    if (Object.is(this.data[key], value)) return
    this.data[key] = value
    this.snapshot = {...this.data}
    for (const l of this.listeners) l()
  }

  /** Returns the current immutable snapshot. Stable reference between writes. */
  getSnapshot(): Record<string, unknown> {
    return this.snapshot
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const state = new StateStore()

// ─── Client RPC registry ────────────────────────────────────────────────────

const clientFns: Record<string, (...args: unknown[]) => unknown> = {}

/**
 * Register functions exposed to the webview as `mentra.client.X(...)`.
 * Call once from `client/index.ts` with all the functions you want
 * available to the React side.
 *
 *   exposeClient({ setDisplayLines, refresh })
 *
 * v0 of the framework requires this explicit registration. v1 will
 * auto-discover exports of `client/index.ts` at build time and remove
 * the boilerplate.
 */
export function exposeClient<T extends Record<string, (...args: never[]) => unknown>>(fns: T): T {
  for (const [name, fn] of Object.entries(fns)) {
    clientFns[name] = fn as (...args: unknown[]) => unknown
  }
  return fns
}

/** @internal — consumed by framework/react. */
export function __getClientFns(): Record<string, (...args: unknown[]) => unknown> {
  return clientFns
}

// ─── defineConfig ───────────────────────────────────────────────────────────

export interface MiniappConfig {
  packageName: string
  name: string
  version?: string
  description?: string
  permissions?: string[]
  hardwareRequirements?: Array<{type: string; level?: "REQUIRED" | "OPTIONAL"; description?: string}>
}

/** Identity function with type inference for `mentra.config.ts`. */
export function defineConfig(config: MiniappConfig): MiniappConfig {
  return config
}
