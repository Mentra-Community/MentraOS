/**
 * Shared domain types referenced by BOTH the background JSContext and
 * the UI WebView. Both bundlers inline this file at build time, so
 * there's no runtime resolution across the boundary.
 *
 * Rule: anything that crosses the `mentra.send` / `session.ui.send`
 * channel boundary needs its payload shape declared here so each side
 * sees the same TypeScript type.
 */

/** Per-tester event payload. The tester subscribes to a specific iface
 * via `mentra.send("tester:start", {iface})` and gets back a stream of
 * `{iface, kind, payload}` events from background. `kind` distinguishes
 * the event sub-type (e.g. "transcript", "button", "location"). */
export interface TesterEventPayload {
  iface: string
  kind: string
  payload: unknown
}

/** Glasses capabilities snapshot, broadcast on session.ui.onOpen. */
export interface CapabilitiesSnapshot {
  hasCamera?: boolean
  hasMicrophone?: boolean
  hasDisplay?: boolean
  hasSpeaker?: boolean
  hasWifi?: boolean
  modelName?: string
}

/** Connection state snapshot, broadcast on session.ui.onOpen and on change. */
export interface ConnectionSnapshot {
  connected: boolean
}

/** Captions live transcript update — pushed to UI on every transcription event. */
export interface CaptionsLiveTranscript {
  text: string
}

/** Captions history update — pushed when a final transcription is appended. */
export interface CaptionsHistoryUpdate {
  history: string[]
}

/** Last-button-press footer update. */
export interface CaptionsLastButton {
  label: string
}

/** Caller-controlled settings the UI can flip on background. */
export interface CaptionsSettings {
  mirrorToGlasses: boolean
}
