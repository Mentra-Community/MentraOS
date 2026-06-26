export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

export interface CloudClientStatus {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

export type EverythingBackendStatus = "idle" | "processing" | "ok" | "unconfigured" | "error"

export type ChatRole = "user" | "assistant"

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  /** Base64-encoded PNG (no data: prefix) when the assistant rendered an image. */
  imageBase64?: string | null
  createdAt: number
}

export interface EverythingSnapshot {
  messages: ChatMessage[]
  /** True while the mic is capturing speech into the recording buffer. */
  recording: boolean
  /** True while a backend request is in flight. */
  processing: boolean
  backendUrl: string
  backendStatus: EverythingBackendStatus
  cloudStatus: CloudClientStatus
  lastError: string | null
}
