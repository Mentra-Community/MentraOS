import type {
  CloudClientStatus,
  AnswerLanguage,
  FrequencyMode,
  MergeBackendStatus,
  MergeDecision,
  MergeInsight,
  MergeSnapshot,
  MergeTranscript,
} from "./types"

export interface Channels {
  "merge:snapshot": MergeSnapshot
  "merge:transcript": MergeTranscript
  "merge:insight": MergeInsight
  "merge:decision": MergeDecision
  "merge:cloud-status": CloudClientStatus
  "merge:backend-status": {status: MergeBackendStatus; lastError: string | null}
  "merge:processing": {processing: boolean}
  "merge:set-frequency": {frequency: FrequencyMode}
  "merge:set-answer-language": {answerLanguage: AnswerLanguage}
  "merge:clear": Record<string, never>
  "merge:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
