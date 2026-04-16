/**
 * @mentra/js — Runtime for client/ code
 *
 * Provides `session` and `state` objects that are wired to the real
 * MentraSession and StateManager by the dev server.
 *
 * import { session, state } from "@mentra/js";
 */

import type { MentraSession } from "@mentra/sdk";
import type { StateManager } from "./state-manager";

// These are set by the dev server when a session connects
declare global {
  var __mentraSession: MentraSession | undefined;
  var __mentraState: StateManager | undefined;
}

// ─── State ───────────────────────────────────────────────────────────────────

export const state = {
  init<T extends Record<string, any>>(defaults: T): void {
    const mgr = globalThis.__mentraState;
    if (mgr) {
      mgr.init(defaults);
    }
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

// ─── Session ─────────────────────────────────────────────────────────────────

// Session proxy — waits for the real session to be available, then delegates
const readyHandlers: Array<(s: MentraSession) => void> = [];
const stoppedHandlers: Array<(reason: string) => void> = [];

// Listen for session ready from the dev server
if (globalThis.__mentraState) {
  globalThis.__mentraState.on("session_ready", (s: MentraSession) => {
    for (const handler of readyHandlers) {
      try { handler(s); } catch (e) { console.error("[mentra/js] onReady error:", e); }
    }
  });
  globalThis.__mentraState.on("session_stopped", (reason: string) => {
    for (const handler of stoppedHandlers) {
      try { handler(reason); } catch (e) { console.error("[mentra/js] onStopped error:", e); }
    }
  });
}

function getSession(): MentraSession {
  const s = globalThis.__mentraSession;
  if (!s) throw new Error("[mentra/js] No active session. Is the dev server running?");
  return s;
}

export const session = {
  onReady(handler: (session?: MentraSession) => void): void {
    readyHandlers.push(handler as any);
    // If session already exists, fire immediately
    if (globalThis.__mentraSession) {
      try { handler(globalThis.__mentraSession); } catch (e) { console.error(e); }
    }
  },

  onStopped(handler: (reason: string) => void): void {
    stoppedHandlers.push(handler);
  },

  // ── v3 MentraSession manager accessors ────────────────────────────────

  /** 🖥️ Display management — showText, showTextWall, clear, etc. */
  get display() {
    return getSession().display;
  },

  /** 🎙️ Transcription — on(), configure() */
  get transcription() {
    return getSession().transcription;
  },

  /** 📷 Camera — takePhoto, startStream, etc. */
  get camera() {
    return getSession().camera;
  },

  /** 🔊 Speaker management */
  get speaker() {
    return getSession().speaker;
  },

  /** 🎤 Microphone management */
  get mic() {
    return getSession().mic;
  },

  /** 📱 Device state */
  get device() {
    return getSession().device;
  },

  /** 💡 RGB LED control */
  get led() {
    return getSession().led;
  },

  /** 🔐 Key-value storage */
  get storage() {
    return getSession().storage;
  },

  /** 📍 Location management */
  get location() {
    return getSession().location;
  },

  /** 📞 Phone management */
  get phone() {
    return getSession().phone;
  },

  /** 📊 Dashboard API */
  get dashboard() {
    return getSession().dashboard;
  },

  /** Capabilities of the connected glasses */
  get capabilities() {
    return getSession().capabilities;
  },

  /** Logger instance for this session */
  get logger() {
    return getSession().logger;
  },

  /** The userId associated with this session */
  get userId() {
    return getSession().userId;
  },
};

// ─── Config ──────────────────────────────────────────────────────────────────

export function defineConfig(config: {
  packageName: string;
  name: string;
  version?: string;
  permissions?: string[];
  server?: { env?: string[] };
}) {
  return config;
}

// ─── Re-exports ──────────────────────────────────────────────────────────────

export type { MentraSession } from "@mentra/sdk";
export type { StateManager } from "./state-manager";
