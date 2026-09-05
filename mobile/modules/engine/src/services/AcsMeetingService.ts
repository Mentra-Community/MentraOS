/**
 * Host-side ACS meeting controller. One active meeting. Native module owns
 * WHEP + ACS; this service maps that into miniapp envelopes and pipes
 * incoming PCM into AudioPlaybackService (A2DP / PcmStreamPlayer).
 */

import audioPlaybackService from "./AudioPlaybackService"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {ACS_CALL_MIC, type ResolvedAudioSource, type SourceReason} from "./acsAudioSource"

export {ACS_CALL_MIC}
export type {ResolvedAudioSource, SourceReason}

type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

export type AudioSafety = "safe" | "degraded" | "unsafe"
export type ActiveStream = "none" | "virtual" | "local"
/**
 * Health of the glasses WHEP subscription that feeds the call. `failed` means ICE
 * dropped or the WHEP endpoint went away (glasses stopped publishing, phone changed
 * networks); the ACS call itself may still be `connected` with a frozen last frame.
 */
export type MediaSourceState = "idle" | "connecting" | "live" | "failed"

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
  mediaSource?: MediaSourceState
  participants?: MeetingParticipant[]
}

/**
 * The call microphone is [ACS_CALL_MIC]. Flip that constant to `"glasses"`
 * to restore glasses WHIP → Cloudflare → WHEP PCM. Do not use ACS
 * LocalOutgoingAudioStream for phone: that path makes ACS own the route
 * (MODE_IN_COMMUNICATION + forced speaker) and opens an echo loop.
 * preferred_mic governs MentraOS STT capture, not this call.
 */
export function resolveAcsAudioSource(): ResolvedAudioSource {
  return {source: ACS_CALL_MIC, reason: "explicit"}
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

/**
 * Where the glasses video comes from.
 *
 * A union rather than a nullable URL because the two transports need different inputs: WHEP is
 * given a URL, while SoftAP produces one only after the host binds a local listener. Collapsing
 * them into `whepUrl?: string` is what lets an empty string reach the subscriber and fail seconds
 * later as an opaque HTTP error.
 */
export type AcsVideoSource =
  | {type: "whep"; url: string}
  | {type: "softap"; ssid?: string; passphrase?: string; bindAddress?: string}

/**
 * Validates a `videoSource` from a miniapp.
 *
 * Throws rather than defaulting to WHEP. A miniapp that asks for SoftAP and silently gets a
 * Cloudflare call — or vice versa — is a bug that shows up as unexplained latency or a black tile,
 * not as an error anyone can act on.
 */
export function parseAcsVideoSource(raw: unknown): AcsVideoSource {
  if (raw == null || typeof raw !== "object") {
    throw new Error(`videoSource must be {type: "whep", url} or {type: "softap"}`)
  }
  const value = raw as Record<string, unknown>

  if (value.type === "whep") {
    const url = typeof value.url === "string" ? value.url.trim() : ""
    if (!url) throw new Error("videoSource.url is required for a WHEP source")
    return {type: "whep", url}
  }

  if (value.type === "softap") {
    const ssid = typeof value.ssid === "string" ? value.ssid.trim() : ""
    const passphrase = typeof value.passphrase === "string" ? value.passphrase : ""
    // Half a credential pair would otherwise present as a failed hotspot join much later.
    if (Boolean(ssid) !== Boolean(passphrase)) {
      throw new Error("videoSource.ssid and videoSource.passphrase must be provided together")
    }
    return ssid ? {type: "softap", ssid, passphrase} : {type: "softap"}
  }

  throw new Error(`unsupported videoSource.type: ${String(value.type)}`)
}

type NativeModule = {
  join(options: {
    meetingUrl: string
    token: string
    /** Legacy field, still sent for whep so an older native keeps working. */
    whepUrl: string
    videoSource: AcsVideoSource
    displayName?: string
    dumpPcmWav?: boolean
    audioSource?: "glasses" | "phone"
    video?: AcsOutgoingVideo
  }): Promise<MeetingState & {ingestUrl?: string}>
  leave(): Promise<void>
  setMuted(muted: boolean): Promise<MeetingState>
  setAudioSource(source: "glasses" | "phone"): Promise<MeetingState>
  updateVideoSource(whepUrl: string): Promise<void>
  /** Force a WHEP rebuild on the current URL. Absent on natives that predate it. */
  restartVideoSource?(): Promise<void>
  /**
   * Join the glasses hotspot as a scoped, internet-less network; resolves with this phone's
   * address on it. Absent on natives that predate SoftAP, and rejects on iOS.
   */
  joinScopedNetwork?(ssid: string, passphrase: string): Promise<string>
  leaveScopedNetwork?(): Promise<void>
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

/**
 * Phone connectivity feed. Only the subset of `@react-native-community/netinfo`
 * this service needs, so tests can inject a fake and hosts without the package
 * (or a bare test runtime) degrade to "no phone-network awareness" instead of
 * failing to load the meeting service.
 */
export type PhoneNetworkInfo = {type: string; isConnected: boolean | null}
type PhoneNetworkSource = {
  addEventListener(listener: (state: PhoneNetworkInfo) => void): () => void
}

let phoneNetwork: PhoneNetworkSource | null | undefined

function getPhoneNetwork(): PhoneNetworkSource | null {
  if (phoneNetwork !== undefined) return phoneNetwork
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const netInfo = require("@react-native-community/netinfo") as {default?: PhoneNetworkSource} & PhoneNetworkSource
    phoneNetwork = netInfo.default ?? netInfo
  } catch {
    phoneNetwork = null
  }
  return phoneNetwork
}

/** Test seam: inject a fake phone-network feed (or `null` to disable it). */
export function setAcsMeetingPhoneNetworkForTests(source: PhoneNetworkSource | null | undefined): void {
  phoneNetwork = source
}

function parseActiveStream(value: unknown): ActiveStream | undefined {
  if (value === "none" || value === "virtual" || value === "local") return value
  return undefined
}

function parseAudioSafety(value: unknown): AudioSafety | undefined {
  if (value === "safe" || value === "degraded" || value === "unsafe") return value
  return undefined
}

function parseMediaSource(value: unknown): MediaSourceState | undefined {
  if (value === "idle" || value === "connecting" || value === "live" || value === "failed") return value
  return undefined
}

/** Meeting phases during which the WHEP feed should be alive and is worth restarting. */
const MEDIA_ACTIVE_PHASES = new Set<MeetingPhase>(["connecting", "lobby", "connected"])
/** Floor between WHEP restarts we trigger from the host, so a flapping network cannot thrash native. */
const MEDIA_RESTART_MIN_INTERVAL_MS = 3000

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
  /** WHEP URL native is (or should be) subscribed to; what a host-triggered restart re-feeds. */
  private whepUrl: string | null = null
  /** Transport for the active call, so recovery picks the right repair. */
  private videoSource: AcsVideoSource | null = null
  /**
   * SoftAP only: the URL the glasses must publish to. An output of the join rather than an input,
   * because it is not known until native has bound a listener and been given a port.
   */
  private ingestUrl: string | null = null
  private phoneNetworkUnsub: (() => void) | null = null
  private lastPhoneNetworkKey: string | null = null
  private lastMediaRestartAt = 0
  /** Callers parked in [waitForFirstFrame], woken by the next `mediaSource` verdict. */
  private readonly firstFrameWaiters = new Set<(error?: Error) => void>()

  setStateHandler(handler: (packageName: string, state: MeetingState) => void): void {
    this.onState = handler
  }

  getState(): MeetingState {
    return {...this.lastState}
  }

  ownerPackage(): string | null {
    return this.owner
  }

  /**
   * The WHIP URL the glasses must POST their offer to, for a SoftAP call. Null for every other
   * transport and until the join has bound a listener; the orchestrator reads it between the ACS
   * join and telling the glasses to publish.
   */
  softApIngestUrl(): string | null {
    return this.ingestUrl
  }

  /**
   * Join the glasses hotspot as a scoped, internet-less network, returning this phone's address on
   * it. Called before the ACS join, because the local WHIP listener has to bind to that address.
   *
   * A host without the native function is not a host that silently skips the join — the SoftAP call
   * has no network to run on, so this reports the reason instead.
   */
  async joinScopedNetwork(ssid: string, passphrase: string): Promise<string | undefined> {
    const native = getNative()
    if (!native?.joinScopedNetwork) {
      throw new Error("This host cannot join the glasses hotspot; SoftAP calling is unavailable")
    }
    return await native.joinScopedNetwork(ssid, passphrase)
  }

  /** Safe to call when nothing was joined: teardown runs after failed starts too. */
  async leaveScopedNetwork(): Promise<void> {
    await getNative()?.leaveScopedNetwork?.()
  }

  /**
   * Resolves once the host reports a frame actually reached ACS, which is the only signal that
   * remote participants can see the camera.
   *
   * Rejects if the feed fails first, and on timeout. A SoftAP call that connects but never paints
   * is the failure this exists to catch: without it the orchestrator would report `live` on the
   * strength of an ACS join that says nothing about video.
   *
   * @param timeoutMs how long to wait before treating the silence as a failure
   */
  waitForFirstFrame(timeoutMs: number): Promise<void> {
    if (this.lastState.mediaSource === "live") return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.firstFrameWaiters.delete(settle)
        if (error) reject(error)
        else resolve()
      }
      let done = false
      const timer = setTimeout(
        () => settle(new Error(`No glasses video reached the meeting within ${Math.round(timeoutMs / 1000)}s`)),
        timeoutMs,
      )
      this.firstFrameWaiters.add(settle)
    })
  }

  /** Wake every `waitForFirstFrame` caller with the outcome the host just reported. */
  private settleFirstFrameWaiters(mediaSource: MediaSourceState | undefined): void {
    if (mediaSource !== "live" && mediaSource !== "failed") return
    const error = mediaSource === "failed" ? new Error("The glasses video feed failed") : undefined
    for (const settle of [...this.firstFrameWaiters]) settle(error)
  }

  async join(
    packageName: string,
    args: {
      meetingUrl: string
      token: string
      videoSource: AcsVideoSource
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
    // Validate before claiming ownership so a bad request cannot leave the slot taken.
    const video = args.video ? parseAcsOutgoingVideo(args.video) : undefined
    const resolved = resolveAcsAudioSource()
    this.owner = packageName
    // Only a whep source has a URL to re-feed on recovery; softap rebuilds instead.
    this.whepUrl = args.videoSource.type === "whep" ? args.videoSource.url : null
    this.videoSource = args.videoSource
    this.bindNative(native, packageName)
    console.log("[AcsMeeting] phase=join-native", {
      packageName,
      nativeLoaded: true,
      hasToken: Boolean(args.token),
      transport: args.videoSource.type,
      audioSource: resolved.source,
      audioSourceReason: resolved.reason,
      preferredMic: useSettingsStore.getState().getSetting(SETTINGS.preferred_mic.key),
    })
    try {
      const state = await native.join({
        meetingUrl: args.meetingUrl,
        token: args.token,
        whepUrl: this.whepUrl ?? "",
        videoSource: args.videoSource,
        displayName: args.displayName,
        audioSource: resolved.source,
        ...(video ? {video} : {}),
      })
      this.ingestUrl = typeof state.ingestUrl === "string" ? state.ingestUrl : null
      const {ingestUrl: _ingestUrl, ...meetingState} = state
      this.lastState = {
        ...meetingState,
        audioSource: resolved.source,
        audioSourceReason: resolved.reason,
      }
      console.log("[AcsMeeting] phase=join-native-ok", {state: state.state, muted: state.muted})
    } catch (error) {
      // Native never joined (or is unwinding). Release the slot so the same or another
      // miniapp can retry, and make sure nothing half-joined lingers in Teams.
      console.warn("[AcsMeeting] phase=join-native-failed", {
        packageName,
        error: error instanceof Error ? error.message : String(error),
      })
      await native.leave().catch((leaveError) => {
        console.warn("[AcsMeeting] native leave after failed join also failed", leaveError)
      })
      await this.releaseHostState()
      throw error
    }
    this.watchPhoneNetwork(native)
    // Return audio is additive: the wearer is already in the meeting with camera and
    // mic. A playback failure must not reject the join — that would leave the miniapp
    // believing it never joined while native keeps the wearer in Teams.
    try {
      await this.ensurePcmPlayback(packageName)
      console.log("[AcsMeeting] phase=pcm-playback", {streamId: this.pcmStreamId})
    } catch (error) {
      console.warn("[AcsMeeting] phase=pcm-playback-failed; continuing without return audio", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return this.lastState
  }

  async leave(packageName: string): Promise<void> {
    if (this.owner && this.owner !== packageName) return
    const native = getNative()
    try {
      await native?.leave()
    } finally {
      await this.releaseHostState()
    }
  }

  /**
   * Drop everything the host set up around a session: the network watcher, return
   * audio, native listeners, ownership. Runs after native has been told to leave
   * (or after a join that never produced a native call).
   */
  private async releaseHostState(): Promise<void> {
    // Before anything else: a caller parked on a frame that will now never arrive has to be
    // rejected, or a leave mid-join leaves the orchestrator waiting out its whole timeout.
    for (const settle of [...this.firstFrameWaiters]) settle(new Error("The meeting ended"))
    this.firstFrameWaiters.clear()
    this.unwatchPhoneNetwork()
    await this.stopPcm()
    this.unbindNative()
    this.owner = null
    this.whepUrl = null
    this.videoSource = null
    this.ingestUrl = null
    this.lastMediaRestartAt = 0
    this.lastState = {state: "idle", muted: false}
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
    if (this.videoSource?.type === "softap") {
      // The host owns the softap endpoint, so there is no URL for a caller to change. Failing is
      // better than accepting it and doing nothing.
      throw new Error("updateVideoSource is not applicable to a SoftAP call")
    }
    this.whepUrl = whepUrl
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
    if (this.owner !== packageName) {
      throw new Error(
        this.owner ? "This miniapp does not own the active meeting" : "No active meeting; call meeting.join first",
      )
    }
  }

  private unbindNative(): void {
    this.subscriptions.forEach((sub) => sub.remove())
    this.subscriptions = []
  }

  private bindNative(native: NativeModule, packageName: string): void {
    this.unbindNative()
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
        const mediaSource = parseMediaSource(event.mediaSource)
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
          ...(mediaSource ? {mediaSource} : {}),
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
          mediaSource: state.mediaSource,
          participants: participants?.length,
        })
        this.settleFirstFrameWaiters(mediaSource)
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
   * The WHEP PeerConnection does not survive the phone changing networks
   * (Wi-Fi↔cellular, or a different Wi-Fi): ICE fails and native parks the source
   * as `failed` while the ACS call itself reconnects on its own. Nudge native to
   * rebuild the subscription whenever the phone's network identity changes during
   * a live meeting. Native ignores the request when the source is healthy on the
   * same URL, so a spurious event costs nothing.
   */
  private watchPhoneNetwork(native: NativeModule): void {
    this.unwatchPhoneNetwork()
    const source = getPhoneNetwork()
    if (!source) return
    this.lastPhoneNetworkKey = null
    try {
      this.phoneNetworkUnsub = source.addEventListener((info) => {
        const key = `${info.type}:${info.isConnected === false ? "offline" : "online"}`
        const previous = this.lastPhoneNetworkKey
        this.lastPhoneNetworkKey = key
        // First callback is NetInfo replaying the current state, not a change.
        if (previous === null || previous === key) return
        if (info.isConnected === false) return
        void this.restartMediaSource(native, `phone network ${previous} → ${key}`)
      })
    } catch (error) {
      console.warn("[AcsMeeting] phone network watch unavailable", error)
      this.phoneNetworkUnsub = null
    }
  }

  private unwatchPhoneNetwork(): void {
    this.phoneNetworkUnsub?.()
    this.phoneNetworkUnsub = null
    this.lastPhoneNetworkKey = null
  }

  private async restartMediaSource(native: NativeModule, reason: string): Promise<void> {
    const whepUrl = this.whepUrl
    const softap = this.videoSource?.type === "softap"
    // A softap call has no URL to re-feed, but it is still worth rebuilding: the phone changing
    // networks is exactly when it may have dropped off the hotspot.
    if (!this.owner || !MEDIA_ACTIVE_PHASES.has(this.lastState.state)) return
    if (!whepUrl && !softap) return
    const now = Date.now()
    if (now - this.lastMediaRestartAt < MEDIA_RESTART_MIN_INTERVAL_MS) return
    this.lastMediaRestartAt = now
    console.log("[AcsMeeting] phase=media-restart", {reason, mediaSource: this.lastState.mediaSource})
    try {
      // A same-URL updateVideoSource is a no-op while native still believes the
      // peer is healthy; after a network switch that belief is exactly what is wrong.
      if (native.restartVideoSource) await native.restartVideoSource()
      else if (whepUrl) await native.updateVideoSource(whepUrl)
      else console.warn("[AcsMeeting] softap restart needs a native restartVideoSource", {reason})
    } catch (error) {
      console.warn("[AcsMeeting] media restart failed", {reason, error})
    }
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
