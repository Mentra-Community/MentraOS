/**
 * Host-side ACS meeting controller. One active meeting. Native module owns
 * WHEP + ACS; this service maps that into miniapp envelopes and pipes
 * incoming PCM into AudioPlaybackService (A2DP / PcmStreamPlayer).
 */

import audioPlaybackService from "./AudioPlaybackService"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {useCoreStore} from "../stores/core"

type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

export interface MeetingState {
  state: MeetingPhase
  muted: boolean
  error?: string
  meetingUrl?: string
  provider?: "acs-teams"
  audioSource?: "glasses" | "phone"
}

/** MentraOS preferred_mic → ACS capture. bluetooth uses the OS local capture path. */
export function resolveAcsAudioSource(): "glasses" | "phone" {
  const preferred = String(useSettingsStore.getState().getSetting(SETTINGS.preferred_mic.key) ?? "auto")
  if (preferred === "phone" || preferred === "bluetooth") return "phone"
  if (preferred === "glasses") return "glasses"
  const current = useCoreStore.getState().currentMic
  if (current === "phone" || current === "bluetooth" || current === "bluetoothClassic") return "phone"
  if (current === "glasses") return "glasses"
  const rank = useCoreStore.getState().micRanking[0]
  return rank === "glasses" ? "glasses" : "phone"
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

class AcsMeetingService {
  private owner: string | null = null
  private pcmStreamId: string | null = null
  private subscriptions: Array<{remove: () => void}> = []
  private settingUnsub: (() => void) | null = null
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
    const audioSource = resolveAcsAudioSource()
    console.log("[AcsMeeting] phase=join-native", {
      packageName,
      nativeLoaded: true,
      hasToken: Boolean(args.token),
      hasWhep: Boolean(args.whepUrl),
      audioSource,
      preferredMic: useSettingsStore.getState().getSetting(SETTINGS.preferred_mic.key),
    })
    const state = await native.join({
      meetingUrl: args.meetingUrl,
      token: args.token,
      whepUrl: args.whepUrl,
      displayName: args.displayName,
      audioSource,
    })
    this.lastState = state
    this.watchMicSetting(native)
    console.log("[AcsMeeting] phase=join-native-ok", {state: state.state, muted: state.muted})
    await this.ensurePcmPlayback(packageName)
    console.log("[AcsMeeting] phase=pcm-playback", {streamId: this.pcmStreamId})
    return state
  }

  async leave(packageName: string): Promise<void> {
    if (this.owner && this.owner !== packageName) return
    const native = getNative()
    try {
      await native?.leave()
    } finally {
      await this.stopPcm()
      this.stopWatchingMicSetting()
      this.owner = null
      this.lastState = {state: "idle", muted: false}
    }
  }

  async setMuted(packageName: string, muted: boolean): Promise<MeetingState> {
    this.assertOwner(packageName)
    const native = getNative()
    if (!native) throw new Error("ACS meeting module is not available on this host")
    const state = await native.setMuted(muted)
    this.lastState = state
    return state
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
        const state: MeetingState = {
          state: (event.state as MeetingPhase) ?? "idle",
          muted: Boolean(event.muted),
          error: event.error as string | undefined,
          meetingUrl: event.meetingUrl as string | undefined,
          provider: "acs-teams",
          audioSource: event.audioSource === "phone" ? "phone" : "glasses",
        }
        this.lastState = state
        console.log("[AcsMeeting] phase=native-state", {state: state.state, muted: state.muted, error: state.error})
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

  private watchMicSetting(native: NativeModule): void {
    this.stopWatchingMicSetting()
    let last = resolveAcsAudioSource()
    const apply = () => {
      if (!this.owner) return
      const source = resolveAcsAudioSource()
      if (source === last) return
      last = source
      void native.setAudioSource(source).then((state) => {
        this.lastState = {...this.lastState, ...state, audioSource: source}
        console.log("[AcsMeeting] phase=audio-source", {audioSource: source})
      }).catch((error) => {
        console.warn("[AcsMeeting] setAudioSource failed", error)
      })
    }
    const unsubSettings = useSettingsStore.subscribe(apply)
    const unsubCore = useCoreStore.subscribe(apply)
    this.settingUnsub = () => {
      unsubSettings()
      unsubCore()
    }
  }

  private stopWatchingMicSetting(): void {
    this.settingUnsub?.()
    this.settingUnsub = null
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
