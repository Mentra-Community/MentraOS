export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatus {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

export type FrequencyMode = "low" | "medium" | "high"
export type AnswerLanguage = "English" | "Spanish" | "French" | "German" | "Italian" | "Portuguese" | "Japanese" | "Korean" | "Chinese" | "Auto"

export type MergeBackendStatus = "idle" | "processing" | "ok" | "unconfigured" | "error"
export type MergeAnalysisTrigger = "final" | "sentence" | "interval" | "expand"
export type MergeDisplayAction = "show" | "replace" | "queue" | "drop"
export type MergeDecisionAction = "silent" | "defer" | MergeDisplayAction | "error"

export interface MergeInsightSource {
  title: string
  uri: string
  domain?: string
}

export interface MergeInsightProfiling {
  totalMs: number
  clientRoundTripMs?: number
  geminiMs?: number
  parseMs?: number
  model: string
  webSearchEnabled: boolean
  grounded: boolean
  sourceCount: number
}

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
  displayAction?: MergeDisplayAction
  urgency?: "low" | "medium" | "high"
  confidence?: number
  sources?: MergeInsightSource[]
  searchQueries?: string[]
  profiling?: MergeInsightProfiling
  parentInsightId?: string
}

export interface MergeSettings {
  frequency: FrequencyMode
  answerLanguage: AnswerLanguage
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
  sources?: MergeInsightSource[]
  searchQueries?: string[]
  profiling?: MergeInsightProfiling
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
