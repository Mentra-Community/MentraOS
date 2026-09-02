/**
 * Host-side ACS meeting controller. One active meeting. Native module owns
 * WHEP + ACS; this service maps that into miniapp envelopes and pipes
 * incoming PCM into AudioPlaybackService (A2DP / PcmStreamPlayer).
 */

import audioPlaybackService from "./AudioPlaybackService"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {type ResolvedAudioSource, type SourceReason} from "./acsAudioSource"

export type {ResolvedAudioSource, SourceReason}

type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

export type AudioSafety = "safe" | "degraded" | "unsafe"
export type ActiveStream = "none" | "virtual" | "local"

export type MeetingParticipantState = "idle" | "connecting" | "connected" | "lobby" | "hold" | "disconnected"

export interface MeetingParticipant {
  id: string
  displayName: string | null
  state: MeetingParticipantState
  isMuted: boolean
  isSpeaking: boolean
}

export interface MeetingState {
  state: MeetingPhase
  muted: boolean
  error?: string
  meetingUrl?: string
  provider?: "acs-teams"
  audioSource?: "glasses" | "phone"
  audioSourceReason?: SourceReason
  activeStream?: ActiveStream
  audioSafety?: AudioSafety
  participants?: MeetingParticipant[]
}

/**
 * The call microphone is the glasses microphone. The wearer's voice only
 * exists in the glasses WHIP/WHEP stream, and the phone path makes the ACS
 * SDK own the phone audio route (MODE_IN_COMMUNICATION + forced phone
 * speaker), which pulls A2DP playback off the glasses and opens an echo loop.
 * preferred_mic governs MentraOS STT capture, not this call.
 */
export function resolveAcsAudioSource(): ResolvedAudioSource {
  return {source: "glasses", reason: "explicit"}
}

const PARTICIPANT_STATES = new Set<MeetingParticipantState>([
  "idle",
  "connecting",
  "connected",
  "lobby",
  "hold",
  "disconnected",
])

export function parseMeetingParticipants(raw: unknown): MeetingParticipant[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: MeetingParticipant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const value = entry as Record<string, unknown>
    if (typeof value.id !== "string" || !value.id) continue
    const state = PARTICIPANT_STATES.has(value.state as MeetingParticipantState)
      ? (value.state as MeetingParticipantState)
      : "idle"
    result.push({
      id: value.id,
      displayName: typeof value.displayName === "string" && value.displayName ? value.displayName : null,
      state,
      isMuted: Boolean(value.isMuted),
      isSpeaking: Boolean(value.isSpeaking),
    })
  }
  return result
}

export type AcsOutgoingVideo = {
  width: number
  height: number
  fps: number
  maxBitrateBps: number
}

/** ACS VirtualOutgoingVideoStream documented 16:9 sizes. P540 is 960×540, not 540×960. */
const ACS_VIRTUAL_CAMERA_SIZES = new Set(["1280x720", "960x540"])

export function parseAcsOutgoingVideo(raw: unknown): AcsOutgoingVideo | undefined {
  if (raw == null) return undefined
  if (typeof raw !== "object") throw new Error("video must be an object")
  const value = raw as Record<string, unknown>
  const width = Number(value.width)
  const height = Number(value.height)
  const fps = Number(value.fps)
  const maxBitrateBps = Number(value.maxBitrateBps)
  if (![width, height, fps, maxBitrateBps].every(Number.isFinite)) {
    throw new Error("video requires width, height, fps, and maxBitrateBps")
  }
  if (!ACS_VIRTUAL_CAMERA_SIZES.has(`${width}x${height}`) || fps < 1 || fps > 30 || maxBitrateBps <= 0) {
    throw new Error(`unsupported ACS video ${width}x${height}@${fps}`)
  }
  return {width, height, fps, maxBitrateBps}
}

type NativeModule = {
  join(options: {
    meetingUrl: string
    token: string
    whepUrl: string
    displayName?: string
    dumpPcmWav?: boolean
    audioSource?: "glasses" | "phone"
    video?: AcsOutgoingVideo
  }): Promise<MeetingState>
  leave(): Promise<void>
  setMuted(muted: boolean): Promise<MeetingState>
  setAudioSource(source: "glasses" | "phone"): Promise<MeetingState>
  updateVideoSource(whepUrl: string): Promise<void>
  getState(): Promise<MeetingState>
  addListener(event: string, listener: (event: Record<string, unknown>) => void): {remove: () => void}
}

let nativeModule: NativeModule | null | undefined

function getNative(): NativeModule | null {
  if (nativeModule !== undefined) return nativeModule
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nativeModule = require("@mentra/acs-meeting").default as NativeModule
  } catch {
    nativeModule = null
  }
  return nativeModule
}

/** Test seam: skip the native require and inject a fake ACS module. */
export function setAcsMeetingNativeForTests(mod: NativeModule | null | undefined): void {
  nativeModule = mod
}

function parseActiveStream(value: unknown): ActiveStream | undefined {
  if (value === "none" || value === "virtual" || value === "local") return value
  return undefined
}

function parseAudioSafety(value: unknown): AudioSafety | undefined {
  if (value === "safe" || value === "degraded" || value === "unsafe") return value
  return undefined
}

/** Formats the native PcmStreamPlayer accepts (mono only). */
const PCM_SAMPLE_RATES = new Set([16000, 24000, 48000])
const PCM_BACKLOG_WARN_MS = 600

class AcsMeetingService {
  private owner: string | null = null
  private pcmStreamId: string | null = null
  private pcmFormat: {sampleRate: number; channels: number} | null = null
  private pcmReopen: Promise<void> | null = null
  private pcmWriteChain: Promise<void> = Promise.resolve()
  private lastBacklogWarnAt = 0
  private subscriptions: Array<{remove: () => void}> = []
  private lastState: MeetingState = {state: "idle", muted: false}
  private onState: ((packageName: string, state: MeetingState) => void) | null = null

  setStateHandler(handler: (packageName: string, state: MeetingState) => void): void {
    this.onState = handler
  }

  getState(): MeetingState {
    return {...this.lastState}
  }

  ownerPackage(): string | null {
    return this.owner
  }

  async join(
    packageName: string,
    args: {
      meetingUrl: string
      token: string
      whepUrl: string
      displayName?: string
      video?: AcsOutgoingVideo
    },
  ): Promise<MeetingState> {
    const native = getNative()
    if (!native) {
      console.warn("[AcsMeeting] phase=join-native nativeLoaded=false")
      throw new Error("ACS meeting module is not available on this host")
    }
    if (this.owner && this.owner !== packageName) {
      throw new Error("Another miniapp already has an active meeting")
    }
    this.owner = packageName
    this.bindNative(native, packageName)
    const resolved = resolveAcsAudioSource()
    const video = args.video ? parseAcsOutgoingVideo(args.video) : undefined
    console.log("[AcsMeeting] phase=join-native", {
      packageName,
      nativeLoaded: true,
      hasToken: Boolean(args.token),
      hasWhep: Boolean(args.whepUrl),
      audioSource: resolved.source,
      audioSourceReason: resolved.reason,
      preferredMic: useSettingsStore.getState().getSetting(SETTINGS.preferred_mic.key),
    })
    const state = await native.join({
      meetingUrl: args.meetingUrl,
      token: args.token,
      whepUrl: args.whepUrl,
      displayName: args.displayName,
      audioSource: resolved.source,
      ...(video ? {video} : {}),
    })
    this.lastState = {
      ...state,
      audioSource: resolved.source,
      audioSourceReason: resolved.reason,
    }
    console.log("[AcsMeeting] phase=join-native-ok", {state: state.state, muted: state.muted})
    await this.ensurePcmPlayback(packageName)
    console.log("[AcsMeeting] phase=pcm-playback", {streamId: this.pcmStreamId})
    return this.lastState
  }

  async leave(packageName: string): Promise<void> {
    if (this.owner && this.owner !== packageName) return
    const native = getNative()
    try {
      await native?.leave()
    } finally {
      await this.stopPcm()
      this.owner = null
      this.lastState = {state: "idle", muted: false}
    }
  }

  async setMuted(packageName: string, muted: boolean): Promise<MeetingState> {
    this.assertOwner(packageName)
    const native = getNative()
    if (!native) throw new Error("ACS meeting module is not available on this host")
    const state = await native.setMuted(muted)
    this.lastState = {
      ...this.lastState,
      ...state,
      audioSourceReason: this.lastState.audioSourceReason,
    }
    return this.lastState
  }

  async updateVideoSource(packageName: string, whepUrl: string): Promise<void> {
    this.assertOwner(packageName)
    const native = getNative()
    if (!native) throw new Error("ACS meeting module is not available on this host")
    await native.updateVideoSource(whepUrl)
  }

  async readState(packageName: string): Promise<MeetingState> {
    if (this.owner && this.owner !== packageName) {
      return {state: "idle", muted: false}
    }
    const native = getNative()
    if (!native) return {state: "idle", muted: false}
    const state = await native.getState()
    this.lastState = state
    return state
  }

  async leaveIfOwner(packageName: string): Promise<void> {
    if (this.owner === packageName) await this.leave(packageName)
  }

  private assertOwner(packageName: string): void {
    if (this.owner && this.owner !== packageName) {
      throw new Error("This miniapp does not own the active meeting")
    }
  }

  private bindNative(native: NativeModule, packageName: string): void {
    this.subscriptions.forEach((sub) => sub.remove())
    this.subscriptions = [
      native.addListener("onState", (event) => {
        const audioSafety = parseAudioSafety(event.audioSafety)
        if (audioSafety === "unsafe") {
          console.error("[AcsMeeting] phase=audio-unsafe", {
            activeStream: event.activeStream,
            audioSource: event.audioSource,
          })
        }
        const participants = parseMeetingParticipants(event.participants)
        const state: MeetingState = {
          state: (event.state as MeetingPhase) ?? "idle",
          muted: Boolean(event.muted),
          error: event.error as string | undefined,
          meetingUrl: event.meetingUrl as string | undefined,
          provider: "acs-teams",
          audioSource: event.audioSource === "phone" ? "phone" : "glasses",
          audioSourceReason: this.lastState.audioSourceReason,
          activeStream: parseActiveStream(event.activeStream),
          audioSafety,
          ...(participants ? {participants} : {}),
        }
        this.lastState = state
        console.log("[AcsMeeting] phase=native-state", {
          state: state.state,
          muted: state.muted,
          error: state.error,
          audioSource: state.audioSource,
          activeStream: state.activeStream,
          audioSafety: state.audioSafety,
          participants: participants?.length,
        })
        this.onState?.(packageName, state)
      }),
      native.addListener("onIncomingPcm", (event) => {
        const base64 = event.base64 as string | undefined
        if (!base64 || !this.owner) return
        // Serialize: native async calls may complete out of order, and PCM
        // chunks written out of order are audible as garbling.
        this.pcmWriteChain = this.pcmWriteChain
          .then(() => this.writeIncomingPcm(packageName, base64, event.sampleRate, event.channels))
          .catch(() => undefined)
      }),
    ]
  }

  /**
   * Native normalizes to 16 kHz mono, so this is normally a straight write.
   * If the format ever differs, reopen the player to match rather than play
   * the bytes at the wrong rate (that is what slows and deepens the audio).
   */
  private async writeIncomingPcm(
    packageName: string,
    base64: string,
    rawRate: unknown,
    rawChannels: unknown,
  ): Promise<void> {
    const sampleRate = Number(rawRate) || 16000
    const channels = Number(rawChannels) || 1
    if (!PCM_SAMPLE_RATES.has(sampleRate) || channels !== 1) {
      console.warn("[AcsMeeting] incoming PCM format unsupported; dropping chunk", {sampleRate, channels})
      return
    }
    if (this.pcmFormat && (this.pcmFormat.sampleRate !== sampleRate || this.pcmFormat.channels !== channels)) {
      if (!this.pcmReopen) {
        console.warn("[AcsMeeting] incoming PCM format changed; reopening player", {
          from: this.pcmFormat,
          to: {sampleRate, channels},
        })
        this.pcmReopen = this.stopPcm()
          .then(() => this.ensurePcmPlayback(packageName, sampleRate, channels))
          .finally(() => {
            this.pcmReopen = null
          })
      }
      await this.pcmReopen
    } else if (!this.pcmStreamId) {
      await this.ensurePcmPlayback(packageName, sampleRate, channels)
    }
    const streamId = this.pcmStreamId
    if (!streamId) return
    try {
      const result = await audioPlaybackService.writeStreamChunk(streamId, base64)
      const bufferedMs = result?.bufferedMs
      if (typeof bufferedMs === "number" && bufferedMs > PCM_BACKLOG_WARN_MS) {
        const now = Date.now()
        if (now - this.lastBacklogWarnAt > 5000) {
          this.lastBacklogWarnAt = now
          console.warn("[AcsMeeting] incoming PCM backlog high", {bufferedMs})
        }
      }
    } catch (error) {
      console.warn("[AcsMeeting] incoming PCM write failed", error)
    }
  }

  private async ensurePcmPlayback(packageName: string, sampleRate = 16000, channels = 1): Promise<void> {
    if (this.pcmStreamId) return
    const streamId = `acs-in-${packageName}-${Date.now()}`
    await audioPlaybackService.openStream({
      streamId,
      appId: packageName,
      sampleRate,
      channels,
      stopOtherAudio: true,
      onEnded: () => {
        if (this.pcmStreamId === streamId) {
          this.pcmStreamId = null
          this.pcmFormat = null
        }
      },
    })
    this.pcmStreamId = streamId
    this.pcmFormat = {sampleRate, channels}
  }

  private async stopPcm(): Promise<void> {
    const streamId = this.pcmStreamId
    this.pcmStreamId = null
    this.pcmFormat = null
    if (!streamId) return
    await audioPlaybackService.abortStream(streamId).catch(() => undefined)
  }
}

const acsMeetingService = new AcsMeetingService()
export default acsMeetingService
