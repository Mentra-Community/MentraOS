/**
 * @mentra/js — Runtime for developer code
 *
 *   import { session, state, defineConfig } from "@mentra/js";
 *
 * `session.*` is a thin proxy over a `MentraRuntime` adapter installed
 * by the dev server. Every call reads `globalThis.__mentraRuntime` at
 * dispatch time, so:
 *
 *   - Adapter hot-swap works (we read "current" on every call).
 *   - If developer code calls `session.foo()` before a runtime is
 *     installed, we throw a clear "no runtime active" error.
 *
 * The runtime contract covers: display, transcription, mic, speaker,
 * camera, device, location, plus session identity + lifecycle. See
 * `./contract.ts`.
 *
 * What's NOT in the proxy (yet): led, storage, dashboard, phone,
 * translation, permissions. Apps that need these can reach them via
 * `@mentra/js/runtime` (full internal surface) — they'll work in cloud
 * mode but not in sim mode until we migrate them onto the contract.
 */

import type { StateManager } from "./state-manager";
import type {
  CameraRuntime,
  DeviceRuntime,
  DisplayRuntime,
  LocationRuntime,
  MentraRuntime,
  MentraSessionInfo,
  MicRuntime,
  SpeakerRuntime,
  TranscriptionRuntime,
} from "./contract";

declare global {
  /**
   * The active `MentraRuntime` adapter. `dev.ts` picks cloud-adapter,
   * sim-adapter, or (future) island-adapter based on what's available.
   */
  var __mentraRuntime: MentraRuntime | undefined;

  /** Shared state manager. See `./state-manager.ts`. */
  var __mentraState: StateManager | undefined;

  /**
   * Raw SDK session (cloud adapter only). Available for legacy code
   * paths that haven't been migrated onto the contract yet.
   */
  var __mentraSession: import("./internals").MentraSession | undefined;
}

// ─── State ───────────────────────────────────────────────────────────────────

export const state = {
  init<T extends Record<string, any>>(defaults: T): void {
    globalThis.__mentraState?.init(defaults);
  },

  get<T = any>(key: string): T {
    return globalThis.__mentraState?.get(key) as T;
  },

  set(key: string, value: any): void {
    globalThis.__mentraState?.set(key, value);
  },

  getAll(): Record<string, any> {
    return globalThis.__mentraState?.getAll() ?? {};
  },

  onChange(key: string, handler: (value: any) => void): () => void {
    return globalThis.__mentraState?.on(`change:${key}`, handler) ?? (() => {});
  },
};

// ─── Session (contract-routed) ───────────────────────────────────────────────

function getRuntime(): MentraRuntime {
  const r = globalThis.__mentraRuntime;
  if (!r) {
    throw new Error("[mentra/js] No runtime is active. Is `mentra dev` running?");
  }
  return r;
}

// Manager proxies. Each one reads the *current* runtime on every call
// so hot-swap / session-rebind work transparently.

const displayProxy: DisplayRuntime = new Proxy({} as DisplayRuntime, {
  get: (_t, prop) => (getRuntime().display as any)[prop],
});
const transcriptionProxy: TranscriptionRuntime = new Proxy({} as TranscriptionRuntime, {
  get: (_t, prop) => (getRuntime().transcription as any)[prop],
});
const micProxy: MicRuntime = new Proxy({} as MicRuntime, {
  get: (_t, prop) => (getRuntime().mic as any)[prop],
});
const speakerProxy: SpeakerRuntime = new Proxy({} as SpeakerRuntime, {
  get: (_t, prop) => (getRuntime().speaker as any)[prop],
});
const cameraProxy: CameraRuntime = new Proxy({} as CameraRuntime, {
  get: (_t, prop) => (getRuntime().camera as any)[prop],
});
const deviceProxy: DeviceRuntime = new Proxy({} as DeviceRuntime, {
  get: (_t, prop) => (getRuntime().device as any)[prop],
});
const locationProxy: LocationRuntime = new Proxy({} as LocationRuntime, {
  get: (_t, prop) => (getRuntime().location as any)[prop],
});

// ─── Lazy handler queue ──────────────────────────────────────────────────────
// If developer code calls session.onReady() before dev.ts has installed
// the runtime, we queue the handler and replay when the runtime appears.

const lazyReadyQueue: Array<(info: MentraSessionInfo) => void> = [];
const lazyStoppedQueue: Array<(reason: string) => void> = [];
const lazyReconnectedQueue: Array<() => void> = [];

/**
 * Called by `dev.ts` the moment it sets `globalThis.__mentraRuntime`.
 * Drains handlers registered before the runtime existed and forwards
 * them onto the adapter.
 */
export function __flushLazyHandlers(): void {
  const r = globalThis.__mentraRuntime;
  if (!r) return;
  for (const h of lazyReadyQueue.splice(0)) r.onReady(h);
  for (const h of lazyStoppedQueue.splice(0)) r.onStopped(h);
  for (const h of lazyReconnectedQueue.splice(0)) r.onReconnected(h);
}

// ─── The `session` object ────────────────────────────────────────────────────

interface Session {
  onReady(handler: (info?: MentraSessionInfo) => void): void;
  onStopped(handler: (reason: string) => void): void;
  onReconnected(handler: () => void): void;
  readonly info: MentraSessionInfo;
  readonly userId: string;
  readonly runtime: string;
  readonly display: DisplayRuntime;
  readonly transcription: TranscriptionRuntime;
  readonly mic: MicRuntime;
  readonly speaker: SpeakerRuntime;
  readonly camera: CameraRuntime;
  readonly device: DeviceRuntime;
  readonly location: LocationRuntime;
}

export const session: Session = {
  onReady(handler: (info?: MentraSessionInfo) => void): void {
    const r = globalThis.__mentraRuntime;
    if (r) {
      r.onReady(handler as (info: MentraSessionInfo) => void);
    } else {
      lazyReadyQueue.push(handler as (info: MentraSessionInfo) => void);
    }
  },

  onStopped(handler: (reason: string) => void): void {
    const r = globalThis.__mentraRuntime;
    if (r) r.onStopped(handler);
    else lazyStoppedQueue.push(handler);
  },

  onReconnected(handler: () => void): void {
    const r = globalThis.__mentraRuntime;
    if (r) r.onReconnected(handler);
    else lazyReconnectedQueue.push(handler);
  },

  /** Session identity (userId, email, sessionId). */
  get info(): MentraSessionInfo {
    return getRuntime().info;
  },

  /** Convenience accessor for `info.userId`. */
  get userId(): string {
    return getRuntime().info.userId;
  },

  /** Name of the active runtime adapter. "cloud" | "sim" | "island" | ... */
  get runtime(): string {
    return globalThis.__mentraRuntime?.name ?? "none";
  },

  // ── Contract-covered managers ─────────────────────────────────────────

  get display(): DisplayRuntime {
    return displayProxy;
  },
  get transcription(): TranscriptionRuntime {
    return transcriptionProxy;
  },
  get mic(): MicRuntime {
    return micProxy;
  },
  get speaker(): SpeakerRuntime {
    return speakerProxy;
  },
  get camera(): CameraRuntime {
    return cameraProxy;
  },
  get device(): DeviceRuntime {
    return deviceProxy;
  },
  get location(): LocationRuntime {
    return locationProxy;
  },
};

// ─── Config helper ───────────────────────────────────────────────────────────

export function defineConfig(config: {
  packageName: string;
  name: string;
  version?: string;
  permissions?: string[];
  server?: { env?: string[] };
  runtime?: "auto" | "cloud" | "sim";
}) {
  return config;
}

// ─── Re-exports ──────────────────────────────────────────────────────────────
// Contract types — apps that want to type-annotate handlers.

export type {
  MentraRuntime,
  MentraSessionInfo,
  DisplayRuntime,
  TranscriptionRuntime,
  TranscriptionData,
  MicRuntime,
  MicChunk,
  VadEvent,
  SpeakerRuntime,
  SpeakerStream,
  SpeakerStreamOptions,
  CameraRuntime,
  PhotoOptions,
  PhotoResult,
  CameraStreamOptions,
  CameraStreamResult,
  DeviceRuntime,
  DeviceStateRuntime,
  LocationRuntime,
  LocationData,
} from "./contract";

export { MentraRuntimeCapabilityError, Observable } from "./contract";

// For apps that need the full forked SDK surface (led, storage, dashboard,
// phone, translation, permissions, or direct MentraSession access):
//
//   import { MentraSession, MiniAppServer, getMentraAuth } from "@mentra/js/runtime";
//
// See `./internals/index.ts` for everything available.
