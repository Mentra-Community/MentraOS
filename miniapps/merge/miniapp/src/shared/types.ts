export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatus {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

export type FrequencyMode = "low" | "medium" | "high"

export type MergeBackendStatus = "idle" | "processing" | "ok" | "unconfigured" | "error"
export type MergeAnalysisTrigger = "final" | "sentence" | "interval"
export type MergeDecisionAction = "silent" | "show" | "replace" | "queue" | "drop" | "error"

export interface MergeTranscript {
  id: string
  utteranceId: string | null
  text: string
  language: string | null
  speakerId: string | null
  isFinal: boolean
  receivedAt: number
}

export interface MergeInsight {
  id: string
  text: string
  timestamp: number
  agentType: string
  reasoning?: string
  transcriptId?: string
  displayAction?: Exclude<MergeDecisionAction, "silent" | "error">
  urgency?: "low" | "medium" | "high"
  confidence?: number
}

export interface MergeSettings {
  frequency: FrequencyMode
}

export interface MergeDecision {
  id: string
  timestamp: number
  action: MergeDecisionAction
  trigger: MergeAnalysisTrigger
  chunkText: string
  reasoning?: string
  insightText?: string
  confidence?: number
  urgency?: "low" | "medium" | "high"
}

export interface MergeSnapshot {
  transcripts: MergeTranscript[]
  insights: MergeInsight[]
  decisions: MergeDecision[]
  finalCount: number
  interimCount: number
  cloudStatus: CloudClientStatus
  settings: MergeSettings
  backendUrl: string
  backendStatus: MergeBackendStatus
  processing: boolean
  lastError: string | null
}
