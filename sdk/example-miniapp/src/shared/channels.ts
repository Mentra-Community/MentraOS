/**
 * Typed channel registry — the single source of truth for every name
 * that flows between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler
 * inlines the declarations so there's no runtime cross-boundary I/O.
 */

import type {
  CaptionsHistoryUpdate,
  CaptionsLastButton,
  CaptionsLiveTranscript,
  CaptionsSettings,
  CapabilitiesSnapshot,
  ConnectionSnapshot,
  TesterEventPayload,
} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Initial snapshot — fired when session.ui.onOpen lands. */
  "captions:snapshot": {
    capabilities: CapabilitiesSnapshot
    connection: ConnectionSnapshot
    settings: CaptionsSettings
    liveTranscript: string
    history: string[]
    lastButton: string
  }

  /** Hot updates while the WebView is mounted. */
  "captions:live-transcript": CaptionsLiveTranscript
  "captions:history-update": CaptionsHistoryUpdate
  "captions:last-button": CaptionsLastButton
  "captions:settings-update": CaptionsSettings
  "captions:capabilities-update": CapabilitiesSnapshot
  "captions:connection-update": ConnectionSnapshot

  /** Per-tester stream. The tester pages subscribe to this and ignore
   *  events whose `iface` doesn't match the page. */
  "tester:event": TesterEventPayload

  // ── UI → background ────────────────────────────────────────────────────

  /** Captions imperative actions. */
  "captions:clear": Record<string, never>
  "captions:speak-summary": Record<string, never>
  "captions:set-mirror": {mirrorToGlasses: boolean}

  /** Tester "start a subscription" — the read-only testers
   *  (Permissions / Storage / Transcription / IMU / Location / Microphone /
   *  System) call this with the iface they want to observe. Idempotent. */
  "tester:start": {iface: string; args?: unknown[]}

  /** Tester "stop a subscription" — release any background-side listeners. */
  "tester:stop": {iface: string}

  /** Tester "fire-and-forget action" — the imperative testers (Display /
   *  Led / Speaker / Phone) call this with the exact session method to
   *  invoke. Background dispatches to `session[iface][method](...args)`
   *  and silently drops if the iface or method doesn't exist. */
  "tester:fire": {iface: string; method: string; args?: unknown[]}
}
