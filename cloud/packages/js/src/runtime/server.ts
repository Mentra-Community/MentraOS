/**
 * @mentra/js/server — primitives for `server/` code (cloud-hosted)
 *
 *   import { onSession, onStop, type MentraSession } from "@mentra/js/server";
 *
 * ⚠️ **This module is for `server/` code only.**
 * `server/` runs on the developer's cloud-hosted backend — multi-tenant,
 * one `MentraSession` per connecting user, handlers fire per user.
 *
 * For `client/` code (runs on the phone, one user, singleton session),
 * import from `@mentra/js` instead:
 *
 *   import { session } from "@mentra/js";
 *   session.onReady(...);
 *
 * These are the primitives for `server/` code — Hono apps that run on
 * the developer's cloud-hosted backend to subscribe to audio + (where
 * possible) non-audio session events per connecting user.
 *
 * Philosophy
 * ──────────
 * Different lifecycle from `client/` code:
 *
 *   - `client/` runs on the phone. One user. One session. Long-lived.
 *     Uses `session.onReady()` — fires once when the app boots.
 *
 *   - `server/` runs on the developer's cloud. Many users. Many
 *     sessions. Each fires its own lifecycle. Uses `onSession(cb)` —
 *     fires once per connecting user.
 *
 * This file is the `server/` side. The phone-side `session` object
 * (exported from `@mentra/js` directly) is the `client/` side.
 *
 * Under the hood
 * ──────────────
 * `mentra dev` (and eventually `mentra start` in production) boots a
 * MiniAppServer and registers the handlers here. When a user connects,
 * every handler registered via `onSession()` fires with the fresh
 * MentraSession for that user.
 *
 * Handlers registered before the dev server boots are queued and
 * replayed once the runtime is live (same lazy pattern the client-side
 * `session.onReady()` uses).
 */

import type { MentraSession } from "./internals";

type SessionHandler = (session: MentraSession) => void | Promise<void>;
type StopHandler = (session: MentraSession | null, reason: string) => void | Promise<void>;
type ToolCallHandler = (toolCall: any) => Promise<any>;

/**
 * Queue for handlers registered before dev.ts has installed the
 * server runtime. See `__flushServerHandlers()` — called by dev.ts
 * once the MiniAppServer is ready.
 */
const lazyOnSession: SessionHandler[] = [];
const lazyOnStop: StopHandler[] = [];
const lazyOnToolCall: ToolCallHandler[] = [];

declare global {
  /**
   * Registration target for server/ handlers. `dev.ts` installs this
   * when it boots MiniAppServer; it's a thin interface rather than
   * MiniAppServer itself so we can swap implementations later
   * (production, on-device multi-tenant, tests, etc.).
   */
  var __mentraServerRuntime:
    | {
        onSession: (cb: SessionHandler) => void;
        onStop: (cb: StopHandler) => void;
        onToolCall?: (cb: ToolCallHandler) => void;
      }
    | undefined;
}

/**
 * Register a per-session handler. Use inside `server/` code.
 *
 * ⚠️ **Do not use from `client/` code.** `client/` runs on the phone
 * where there's only one user and one session — use `session.onReady()`
 * from `@mentra/js` instead.
 *
 * Fires every time a user connects to this server. Your handler
 * receives a fresh `MentraSession` scoped to that user. This is the
 * multi-tenant equivalent of the client-side `session.onReady()`.
 *
 * Typical usage:
 *
 *   onSession((session) => {
 *     const userId = session.userId;
 *     const userState = getOrCreateUserState(userId);
 *     userState.attachSession(session);
 *
 *     session.transcription.on((data) => userState.handleTranscript(data));
 *     session.onStopped(() => userState.detachSession());
 *   });
 */
export function onSession(handler: SessionHandler): void {
  const rt = globalThis.__mentraServerRuntime;
  if (rt) rt.onSession(handler);
  else lazyOnSession.push(handler);
}

/**
 * Register a per-session stop handler.
 *
 * Fires when a user's session ends (graceful stop, disconnect, crash).
 * Use this for cleanup that needs to happen even if the session handler
 * didn't have a chance to register its own cleanup (rare, but possible
 * during server shutdown or abnormal termination).
 *
 * For most apps, `session.onStopped()` inside your `onSession` handler
 * is the right place for cleanup — that's session-scoped.
 */
export function onStop(handler: StopHandler): void {
  const rt = globalThis.__mentraServerRuntime;
  if (rt) rt.onStop(handler);
  else lazyOnStop.push(handler);
}

/**
 * Register a tool-call handler. For MentraAI apps that expose tools.
 *
 * Not used by every app — silent no-op if the server doesn't support
 * it or the app doesn't declare tools.
 */
export function onToolCall(handler: ToolCallHandler): void {
  const rt = globalThis.__mentraServerRuntime;
  if (rt?.onToolCall) rt.onToolCall(handler);
  else lazyOnToolCall.push(handler);
}

/**
 * Called by `dev.ts` once it has installed
 * `globalThis.__mentraServerRuntime`. Drains anything the developer
 * registered at module load (before dev.ts got a chance to wire up
 * the runtime) and forwards it.
 */
export function __flushServerHandlers(): void {
  const rt = globalThis.__mentraServerRuntime;
  if (!rt) return;
  for (const h of lazyOnSession.splice(0)) rt.onSession(h);
  for (const h of lazyOnStop.splice(0)) rt.onStop(h);
  if (rt.onToolCall) for (const h of lazyOnToolCall.splice(0)) rt.onToolCall(h);
}

// Re-export the MentraSession type so server/ code can type handlers
// without a separate import from `@mentra/js/runtime`.
export type { MentraSession } from "./internals";
