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
  CalendarSnapshotResult,
  ConnectionSnapshot,
  ElevenLabsSnapshot,
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

  /** ElevenLabs ConvAI tester snapshot (full state). */
  "elevenlabs:update": ElevenLabsSnapshot

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

  /** Demonstrates the nested session.phone.calendar.listEvents request API. */
  "tester:calendar-list": Rpc<{startsAt: string; endsAt: string; limit?: number}, CalendarSnapshotResult>

  /**
   * speaker.createStream E2E: the background generates a sine tone and pumps
   * it through a live PCM stream (write → backpressure → close). Can't go
   * through tester:invoke — the SpeakerStreamWriter can't cross the bridge,
   * so the whole pump loop runs background-side and only a summary returns.
   */
  "tester:speaker-stream-tone": Rpc<
    {seconds?: number; freqHz?: number; sampleRate?: 16000 | 24000 | 48000},
    {streamId: string; durationMs?: number; chunks: number; lastBufferedMs: number}
  >

  /** Start ElevenLabs ConvAI session (signed URL → WS → mic PCM). */
  "elevenlabs:start": Rpc<Record<string, never>, {ok: true}>

  /** Stop ElevenLabs ConvAI session and release mic. */
  "elevenlabs:stop": Rpc<Record<string, never>, {ok: true}>

  /** Play the last saved mic recording from phone storage. */
  "elevenlabs:play-recording": Rpc<Record<string, never>, {ok: true}>

  /** Stop playback of the saved mic recording. */
  "elevenlabs:stop-playback": Rpc<Record<string, never>, {ok: true}>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
