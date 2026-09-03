export type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

export type AcsAudioSource = "glasses" | "phone"
export type AcsActiveStream = "none" | "virtual" | "local"
export type AcsAudioSafety = "safe" | "degraded" | "unsafe"
/**
 * Health of the glasses WHEP subscription feeding the call. `failed` = ICE dropped or
 * the WHEP endpoint went away while the ACS call may still be `connected`. Native
 * rebuilds it on its own with backoff; the host can force one via `restartVideoSource`.
 */
export type AcsMediaSourceState = "idle" | "connecting" | "live" | "failed"

export type AcsMeetingParticipantState = "idle" | "connecting" | "connected" | "lobby" | "hold" | "disconnected"

export type AcsMeetingParticipant = {
  id: string
  displayName: string | null
  state: AcsMeetingParticipantState
  isMuted: boolean
  isSpeaking: boolean
}

export type AcsMeetingState = {
  state: MeetingPhase
  muted: boolean
  error?: string
  meetingUrl?: string
  provider?: "acs-teams"
  audioSource?: AcsAudioSource
  activeStream?: AcsActiveStream
  audioSafety?: AcsAudioSafety
  mediaSource?: AcsMediaSourceState
  /** Remote roster (Android emits this; iOS does not yet). */
  participants?: AcsMeetingParticipant[]
}

export type AcsOutgoingVideo = {
  width: number
  height: number
  fps: number
  maxBitrateBps: number
}

export type AcsMeetingJoinOptions = {
  meetingUrl: string
  token: string
  whepUrl: string
  displayName?: string
  /** "glasses" sends WHEP PCM. "phone" uses the ACS local mic (handset or BT). */
  audioSource?: AcsAudioSource
  /** Dump WHEP PCM to a WAV in cache for P4 verification. */
  dumpPcmWav?: boolean
  /** When omitted, native keeps 1280×720@15 / 2.5 Mbps. */
  video?: AcsOutgoingVideo
}

export type AcsIncomingPcmEvent = {
  base64: string
  sampleRate: number
  channels: number
}

export type AcsMeetingModuleEvents = {
  onState: (state: AcsMeetingState) => void
  onIncomingPcm: (pcm: AcsIncomingPcmEvent) => void
}
