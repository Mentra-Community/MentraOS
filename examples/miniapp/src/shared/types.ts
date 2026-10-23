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

/** Args to `tester:invoke` — the new RPC replacing the old `tester:fire`. */
export interface TesterInvoke {
  iface: string
  method: string
  args?: unknown[]
}

/** Result of `tester:invoke`. Handlers return the raw call result; errors
 *  propagate via the RPC error path so callers see `MentraRpcError`. */
export type TesterInvokeResult = unknown

export interface CalendarSnapshotEvent {
  id: string
  calendarId: string
  title: string
  startsAt: string
  endsAt: string
  timezone?: string
  allDay: boolean
  location?: string
  notes?: string
  url?: string
  links: string[]
}

export interface CalendarSnapshotResult {
  events: CalendarSnapshotEvent[]
  truncated: boolean
}

/** ElevenLabs ConvAI tester — mirrors RN example App.tsx types. */
export type ElevenLabsConversationState = "Idle" | "Signing" | "Streaming"

export type ElevenLabsCloseSource = "none" | "remote" | "user_stop" | "cleanup" | "mic_start_failed"

export interface ElevenLabsStreamStats {
  droppedChunks: number
  frames: number
  receivedBytes: number
  sentBytes: number
  sentChunks: number
}

export interface ElevenLabsDiagnostics {
  elevenLabsEventCount: number
  firstPcmDelayMs: number | null
  firstPcmAtMs: number | null
  lastElevenLabsEvent: string
  lastPcmAtMs: number | null
  lastPcmSize: number | null
  lastSendError: string | null
  micRequestedAtMs: number | null
  micStage: string
  signedUrlLatencyMs: number | null
  signedUrlStatus: string
  websocketCloseAfterMs: number | null
  websocketCloseCode: number | null
  websocketCloseReason: string
  websocketCloseSource: ElevenLabsCloseSource
  websocketCloseWasClean: boolean | null
  websocketOpenedAtMs: number | null
  websocketState: string
  websocketTarget: string
}

export interface ElevenLabsLogEntry {
  id: string
  message: string
}

/** Mic PCM capture (post-LC3) saved under a fixed phone blob key. */
export type ElevenLabsRecordingStatus = "none" | "capturing" | "ready" | "error"

export interface ElevenLabsRecording {
  status: ElevenLabsRecordingStatus
  /** Fixed blob key (overwritten each conversation). */
  blobKey: string
  /** `file://` path on the phone once committed, else null. */
  uri: string | null
  bytes: number
  durationMs: number
  sampleRate: number | null
  error: string | null
  isPlaying: boolean
}

/** Full ElevenLabs tester snapshot pushed background → UI. */
export interface ElevenLabsSnapshot {
  agentId: string
  signedUrlEndpoint: string
  conversationState: ElevenLabsConversationState
  lastError: string | null
  lastTranscript: string
  lastAgentResponse: string
  metadata: string
  vadScore: number | null
  stats: ElevenLabsStreamStats
  diagnostics: ElevenLabsDiagnostics
  logs: ElevenLabsLogEntry[]
  recording: ElevenLabsRecording
}
