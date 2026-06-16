import type {CloudClientStatus, MergeSnapshot, MergeTranscript} from "./types"

export interface Channels {
  "merge:snapshot": MergeSnapshot
  "merge:transcript": MergeTranscript
  "merge:cloud-status": CloudClientStatus
  "merge:clear": Record<string, never>
  "merge:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
