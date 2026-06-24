/**
 * Typed channel registry — the contract between the background JSContext and
 * the UI WebView. Both bundles import this for type-safety; the bundler
 * inlines it (no runtime cross-bundle import).
 *
 * Broadcasts (background → UI) replace the cloud app's SSE stream.
 * RPC channels (UI → background, request/response) replace its REST endpoints.
 */

import type {Rpc} from "@mentra/miniapp/ui"
import type {ChatEvent, ChatMessage, DebugSpeakResult, DebugTranscript, Settings, Theme} from "./types"

export interface Channels {
  // ── background → UI broadcasts ───────────────────────────────
  /** Every chat event (message / processing / idle / wake_word / status). */
  "chat:event": ChatEvent
  /** Pushed when settings change server-side (e.g. theme set elsewhere). */
  "settings:update": Settings
  /** Raw transcription events for the debug overlay's transcription feed. */
  "debug:transcript": DebugTranscript

  // ── UI → background RPC (request/response) ───────────────────
  /** Full message history snapshot for hydrating a freshly-opened webview. */
  "chat:get-history": Rpc<void, ChatMessage[]>
  /** Clear the in-memory conversation + on-screen history. */
  "chat:clear": Rpc<void, void>
  /**
   * Dev-only: ask a question by text (no wake word / voice). Routes through the
   * same QueryProcessor pipeline as a spoken query; the answer comes back over
   * the regular chat:event broadcast. Used by the debug text input.
   */
  "chat:ask": Rpc<{query: string}, void>
  /** Read current settings. */
  "settings:get": Rpc<void, Settings>
  /** Patch settings (theme and/or chatHistoryEnabled); returns the merged result. */
  "settings:set": Rpc<Partial<Settings>, Settings>
  /** Convenience: set just the theme. */
  "settings:set-theme": Rpc<Theme, void>
  /** Open a URL in the phone's system browser (e.g. an agent OAuth connect link). */
  "system:open-url": Rpc<{url: string}, void>
  /** Debug: speak a fixed phrase through the glasses; returns the device outcome. */
  "debug:speak": Rpc<{text: string}, DebugSpeakResult>
  /**
   * Debug: start/stop a 30×30 spinner animation pinned to the bottom-right of
   * the glasses HUD. `running` reflects the resulting state; `error` is set when
   * the glasses have no display.
   */
  "debug:spinner": Rpc<{action: "start" | "stop"}, {running: boolean; error?: string}>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
