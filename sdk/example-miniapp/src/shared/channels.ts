/**
 * Typed channel registry — the single source of truth for every name
 * that flows between this miniapp's background JSContext and its UI
 * WebView. Both halves import this file at build time; the bundler
 * inlines the declarations so there's no runtime cross-boundary I/O.
 */

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
