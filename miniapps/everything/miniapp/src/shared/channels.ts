import type {
  ChatMessage,
  CloudClientStatus,
  EverythingBackendStatus,
  EverythingSnapshot,
} from "./types"

export interface Channels {
  // background -> ui
  "everything:snapshot": EverythingSnapshot
  "everything:message": ChatMessage
  "everything:recording": {recording: boolean}
  "everything:processing": {processing: boolean}
  "everything:backend-status": {status: EverythingBackendStatus; lastError: string | null}
  "everything:cloud-status": CloudClientStatus
  "everything:interim": {text: string}

  // ui -> background
  "everything:request-snapshot": Record<string, never>
  "everything:start-recording": Record<string, never>
  "everything:stop-recording": Record<string, never>
  "everything:send": {text: string}
  "everything:clear": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
