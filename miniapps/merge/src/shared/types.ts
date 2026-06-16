export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatus {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
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

export interface MergeSnapshot {
  transcripts: MergeTranscript[]
  finalCount: number
  interimCount: number
  cloudStatus: CloudClientStatus
}
