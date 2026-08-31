/**
 * Host-side ACS meeting controller. One active meeting. Native module owns
 * WHEP + ACS; this service maps that into miniapp envelopes and pipes
 * incoming PCM into AudioPlaybackService (A2DP / PcmStreamPlayer).
 */

import audioPlaybackService from "./AudioPlaybackService"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {useCoreStore} from "../stores/core"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {resolveAudioSource, type ResolvedAudioSource, type SourceReason} from "./acsAudioSource"

export type {ResolvedAudioSource, SourceReason}

type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

export type AudioSafety = "safe" | "degraded" | "unsafe"
export type ActiveStream = "none" | "virtual" | "local"

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
}

/** MentraOS preferred_mic → ACS capture. bluetooth uses the OS local capture path. */
export function resolveAcsAudioSource(): ResolvedAudioSource {
  return resolveAudioSource({
    preferred: String(useSettingsStore.getState().getSetting(SETTINGS.preferred_mic.key) ?? "auto"),
    currentMic: useCoreStore.getState().currentMic,
    micRanking: useCoreStore.getState().micRanking,
    glassesConnected: isGlassesConnected(useGlassesStore.getState().connection),
  })
}

type NativeModule = {
  join(options: {
    meetingUrl: string
    token: string
    whepUrl: string
    displayName?: string
    dumpPcmWav?: boolean
    audioSource?: "glasses" | "phone"
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

class AcsMeetingService {
  private owner: string | null = null
  private pcmStreamId: string | null = null
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
    args: {meetingUrl: string; token: string; whepUrl: string; displayName?: string},
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
        }
        this.lastState = state
        console.log("[AcsMeeting] phase=native-state", {
          state: state.state,
          muted: state.muted,
          error: state.error,
          audioSource: state.audioSource,
          activeStream: state.activeStream,
          audioSafety: state.audioSafety,
        })
        this.onState?.(packageName, state)
      }),
      native.addListener("onIncomingPcm", (event) => {
        const base64 = event.base64 as string | undefined
        if (!base64 || !this.pcmStreamId) return
        void audioPlaybackService.writeStreamChunk(this.pcmStreamId, base64).catch((error) => {
          console.warn("[AcsMeeting] incoming PCM write failed", error)
        })
      }),
    ]
  }

  private async ensurePcmPlayback(packageName: string): Promise<void> {
    if (this.pcmStreamId) return
    const streamId = `acs-in-${packageName}-${Date.now()}`
    await audioPlaybackService.openStream({
      streamId,
      appId: packageName,
      sampleRate: 16000,
      channels: 1,
      stopOtherAudio: true,
      onEnded: () => {
        if (this.pcmStreamId === streamId) this.pcmStreamId = null
      },
    })
    this.pcmStreamId = streamId
  }

  private async stopPcm(): Promise<void> {
    const streamId = this.pcmStreamId
    this.pcmStreamId = null
    if (!streamId) return
    await audioPlaybackService.abortStream(streamId).catch(() => undefined)
  }
}

const acsMeetingService = new AcsMeetingService()
export default acsMeetingService
