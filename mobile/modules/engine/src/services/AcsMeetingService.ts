/**
 * Host-side ACS meeting controller. One active meeting. Native module owns
 * WHEP + ACS; this service maps that into miniapp envelopes and pipes
 * incoming PCM into AudioPlaybackService (A2DP / PcmStreamPlayer).
 */

import {Platform} from "react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk/internal"

import audioPlaybackService from "./AudioPlaybackService"
import micStateCoordinator from "./MicStateCoordinator"
import {SETTINGS, useSettingsStore} from "../stores/settings"
import {Pcm16LevelMeter} from "../utils/pcm16"
import {softapTraceId} from "../utils/softapTrace"
import {ACS_CALL_MIC, type AcsAudioSource, type ResolvedAudioSource, type SourceReason} from "./acsAudioSource"
import type {SoftapProgress} from "./SoftapCallTransport"

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

/**
 * How the wearer's voice is reaching ACS.
 *
 * `ble-lc3` is the glasses microphone over Bluetooth, decoded on the phone and pushed into the ACS
 * raw outgoing stream. `whip` is the glasses microphone on the WebRTC track they publish (SoftAP or
 * Cloudflare). `phone` is the phone's own microphone. `none` means the source we committed to went
 * away mid-call, which is a reportable failure rather than a reason to open a different microphone.
 */
export type MicTransport = "ble-lc3" | "whip" | "phone" | "none"

/** Error surfaced when the pinned glasses microphone stops producing audio during a call. */
export const GLASSES_MIC_UNAVAILABLE = "GLASSES_MIC_UNAVAILABLE"

export type MeetingParticipantState = "idle" | "connecting" | "connected" | "lobby" | "hold" | "disconnected"

export interface MeetingParticipant {
  id: string
  displayName: string | null
  state: MeetingParticipantState
  isMuted: boolean
  isSpeaking: boolean
}

/**
 * One runtime participant capability.
 *
 * `allowed` is nullable because "denied" and "not known yet" are different facts. ACS delivers
 * capabilities asynchronously, so every call is briefly unknown, and collapsing that into `false`
 * would hide controls on calls that do in fact permit them.
 */
export interface MeetingCapability {
  allowed: boolean | null
  reason: string | null
}

export interface MeetingCapabilities {
  /** Whether this participant may end the Teams group call for everyone. Presenters only. */
  hangUpForEveryone: MeetingCapability
}

export function parseMeetingCapabilities(raw: unknown): MeetingCapabilities | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = (raw as Record<string, unknown>).hangUpForEveryone
  if (!value || typeof value !== "object") return undefined
  const capability = value as Record<string, unknown>
  return {
    hangUpForEveryone: {
      allowed: typeof capability.allowed === "boolean" ? capability.allowed : null,
      reason: typeof capability.reason === "string" && capability.reason ? capability.reason : null,
    },
  }
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
  /** Runtime capabilities. Omitted by natives that predate them; read that as unknown. */
  capabilities?: MeetingCapabilities
  /** Which microphone path is carrying the wearer's voice, decided at join time. */
  micTransport?: MicTransport
  /**
   * SoftAP join checklist, attached only to the state events the SoftAP orchestrator emits while
   * it walks hotspot → scoped join → ACS join → publish → live. Native ACS events never carry it,
   * so a consumer keeps the last one it saw rather than treating its absence as a reset.
   */
  softap?: SoftapProgress
}

/**
 * The call microphone is [ACS_CALL_MIC], and `preferred_mic` governs MentraOS STT capture rather
 * than this call.
 *
 * `"glasses"` selects the wearer's own microphone. Which *transport* carries it is a separate
 * decision made per call by [glassesLc3UplinkSupported]: BLE LC3 into the ACS raw outgoing stream
 * where the host and native both support it, otherwise the glasses' published WebRTC audio track.
 * `"phone"` selects the phone's microphone via `PhoneMicCapturer`; do not route it through ACS
 * `LocalOutgoingAudioStream`, because that hands ACS the audio route
 * (MODE_IN_COMMUNICATION + forced speaker) and opens an echo loop.
 */
export function resolveAcsAudioSource(): ResolvedAudioSource {
  return {source: ACS_CALL_MIC, reason: "explicit"}
}

/**
 * Whether this call can take the wearer's voice off the glasses over BLE LC3.
 *
 * Every term is a hard requirement, and the answer has to be known *before* the glasses are told
 * what to publish — deciding afterwards is how a call ends up with either two copies of the wearer
 * or none. A host whose native module has no `pushOutgoingPcm` keeps the WHIP audio track it has
 * always used rather than silently joining a meeting nobody can be heard in.
 *
 * SoftAP takes BLE LC3 and publishes WHIP video only (`captureAudio=false`), so the glasses SoC
 * microphone is never opened for a call.
 *
 * This was switched off once on a misread: a soak logged `P4 pcm meanAbs` 8–39 and called it
 * digital silence. It was the room. The same LC3 path measured on the bench sits at `meanAbs`
 * ≈30–60 / `peak` ≈80–100 in a quiet room with nobody talking, and that soak had already
 * published with `captureAudio=false`, so the SoC mic was not the thief either. The uplink now
 * logs its own `meanAbs`/`peak` every window ([logMicUplink]) so the next soak reads the level,
 * not the frame rate. Disable only with a level log showing the floor *while the wearer talks*.
 */
const SOFTAP_BLE_LC3_UPLINK = true
/**
 * How long native may take to finish a leave before it reports the cleanup as stuck.
 *
 * Generous on purpose: this is a diagnostic ceiling on a hang-up plus an agent disposal, not a
 * readiness deadline. The caller treats a timeout as "cleanup failed", never as "safe to restart".
 */
const ACS_LEAVE_WAIT_MS = 20_000
/**
 * SoftAP video (camera → H.264 → WHIP → WHEP → ACS) is slower than BLE LC3.
 * Hold glasses PCM this long so the talk track does not lead the picture.
 * Set from SoftAP+LC3 clap correlator (2026-09-10): leads 70/201/173/300/142 ms,
 * median 173, rounded to 170. `AVSYNC clap audioLeadMs` is still the re-cal.
 */
export const SOFTAP_LC3_AUDIO_DELAY_MS = 170
let softapBleLc3UplinkForTests: boolean | null = null

export function glassesLc3UplinkSupported(args: {
  videoSource: AcsVideoSource
  audioSource: AcsAudioSource
  hasPushOutgoingPcm: boolean
  platform: string
}): boolean {
  if (!(softapBleLc3UplinkForTests ?? SOFTAP_BLE_LC3_UPLINK)) return false
  // iOS has no `setMicSourcePin` yet, so it cannot promise the phone microphone stays shut.
  if (args.platform !== "android") return false
  // WHEP audio comes back from Cloudflare already mixed into the subscribed track; there is no
  // captureAudio flag on that path to turn off.
  if (args.videoSource.type !== "softap") return false
  if (args.audioSource !== "glasses") return false
  return args.hasPushOutgoingPcm
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
const ACS_VIRTUAL_CAMERA_SIZES = new Set(["1280x720", "960x540", "858x480"])

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

/**
 * The app's default network after a hotspot join.
 *
 * `usable` is the only field to branch on; the rest is for the note the wearer sees and the trace.
 * A held cellular request brings the radio up but does not promise the default route has switched
 * or validated, so this is asked separately rather than inferred from the hold.
 */
export interface DefaultNetworkStatus {
  transport: string
  validated: boolean
  present: boolean
  usable: boolean
  detail: string
}

type NativeModule = {
  prepareAgent?(options: {token: string; displayName?: string}): Promise<MeetingState>
  join(options: {
    meetingUrl: string
    token: string
    /** Legacy field, still sent for whep so an older native keeps working. */
    whepUrl: string
    videoSource: AcsVideoSource
    displayName?: string
    dumpPcmWav?: boolean
    audioSource?: "glasses" | "phone"
    audioDelayMs?: number
    video?: AcsOutgoingVideo
  }): Promise<MeetingState & {ingestUrl?: string}>
  leave(): Promise<void>
  /**
   * Leave, and resolve only once the hang-up, the agent disposal, and the network releases have
   * actually finished.
   *
   * [leave] queues its work on the session executor and returns immediately, so awaiting it proves
   * nothing about cleanup — which is what let a fast Stop/Start start a second call on top of the
   * first one's teardown. Absent on natives that predate the signal.
   */
  leaveAndAwait?(options: {timeoutMs: number}): Promise<{completed: boolean}>
  /**
   * End the group call for everyone, then tear this device down. Rejects when the capability is
   * denied or ACS refuses — and has still left the call. Absent on natives that predate End.
   */
  endForEveryone?(): Promise<MeetingState>
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
  beginTrace?(traceId: string): Promise<void>
  leaveScopedNetwork?(): Promise<void>
  /**
   * TCP-probe the hotspot gateway over the scoped network. Absent on natives that predate it.
   * `detail` is a one-line human summary (address, port, latency or the failure).
   */
  probeScopedGateway?(): Promise<{reachable: boolean; detail: string}>
  /** The joined hotspot: `prefix` is what the media path must stay inside. */
  scopedNetworkInfo?(): Promise<{available: boolean; localIpv4: string | null; prefix: string | null}>
  /**
   * Wait for the app's default network to be validated, after the hotspot join changed it.
   * Absent on natives that predate the cellular transition handling.
   */
  awaitValidatedDefaultNetwork?(): Promise<DefaultNetworkStatus>
  getState(): Promise<MeetingState>
  /**
   * Hand one chunk of already-decoded microphone PCM to the ACS uplink. Synchronous on purpose:
   * this runs ~100×/s and a promise per chunk would cost more than the copy does.
   *
   * Absent on natives that predate the BLE LC3 uplink, which is exactly what
   * [glassesLc3UplinkSupported] tests for.
   */
  pushOutgoingPcm?(base64: string, sampleRate: number, channels: number): void
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

/** Test seam: exercise the BLE LC3 path without flipping the production kill switch. */
export function setSoftapBleLc3UplinkForTests(enabled: boolean | null): void {
  softapBleLc3UplinkForTests = enabled
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

/**
 * Playout headroom for the far end's voice.
 *
 * The native player defaults to half a second, which is right for a miniapp clip and wrong here:
 * a streaming track sits at its buffer size, so that default is 500ms of delay before the wearer
 * hears anyone, enough that both sides talk over each other. This trades cushion for immediacy —
 * still several BLE playout beats, but a conversation instead of a broadcast.
 */
const PCM_JITTER_MS = 120
/**
 * Above this the backlog is real congestion rather than the configured cushion.
 *
 * Has to stay clear of [PCM_JITTER_MS], because the reported backlog *includes* the track's own
 * buffer and so never falls below it. A threshold at or under the cushion logs once per interval
 * for the whole call and says nothing.
 */
const PCM_BACKLOG_WARN_MS = PCM_JITTER_MS + 400

/** The Bluetooth SDK mic identifier the call pins itself to. */
const GLASSES_MIC_SOURCE = "glasses"
/**
 * How long the glasses may produce no PCM before the call reports its microphone gone.
 *
 * The pin makes a phone-mic fallback impossible, so the only honest response to a source that
 * stopped is to say so. One second is several BLE mic-beats: long enough that a reconnect blip
 * does not raise an error, short enough that the wearer is not talking into nothing for long.
 */
const GLASSES_MIC_GRACE_MS = 1000
/** Cadence of the uplink health line, matching the native P8 ladder. */
const MIC_UPLINK_LOG_INTERVAL_MS = 5000
/** A 50 ms LC3 frame arriving more than this late is a missed beat, not jitter. */
const MIC_GAP_WARN_MS = 90

/**
 * Encode one microphone buffer for `pushOutgoingPcm`.
 *
 * Hermes has no Node `Buffer`. Using it here is how a live SoftAP call selected `ble-lc3`,
 * pinned the glasses, and still sent Teams a minute of silence: every `mic_pcm` event threw
 * `Property 'Buffer' doesn't exist` before native saw a byte. `btoa` is what React Native
 * actually has.
 */
export function pcmToBase64(pcm: ArrayBuffer): string {
  const bytes = new Uint8Array(pcm)
  let binary = ""
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

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
  private scopedLostSub: {remove: () => void} | null = null
  private readonly scopedLostListeners = new Set<(error: {code: string; message: string}) => void>()
  /**
   * Set before the scoped network is released, so the loss we are about to cause is not reported as
   * one that happened to us. Android emits `onLost` for a deliberate release, and a naive wiring
   * turns every successful Leave and End into a mid-call network error.
   */
  private scopedTerminating = false
  /**
   * Bumped by every join and every release, and captured by everything that can outlive a call:
   * the `mic_pcm` listener and the in-flight `native.join`.
   *
   * A leave during a slow join is the case this exists for. Without it the join resolves into a
   * torn-down host, subscribes a microphone listener nobody will ever unsubscribe, and pushes the
   * wearer's voice at a native session that has already left the meeting.
   */
  private callGeneration = 0
  private micTransport: MicTransport = "whip"
  private micSub: {remove: () => void} | null = null
  /** True between the pin/requirement being taken and released, so release is exactly once. */
  private micUplinkActive = false
  private micFramesForwarded = 0
  /** Frames since the last health line, so the rate and the call total stay separate facts. */
  private micFramesWindow = 0
  private micDropsStale = 0
  private micDropsNonGlasses = 0
  private micGaps = 0
  private micGapMsMax = 0
  private lastGlassesFrameAt = 0
  private lastMicUplinkLogAt = 0
  private lastMicDropLogAt = 0
  /** PCM level over the current health window; read and reset by [logMicUplink]. */
  private micLevel = new Pcm16LevelMeter()
  private lastMicLevel: {meanAbs: number; peak: number} | null = null
  /** Guards [releaseHostState] so a remote hang-up followed by an explicit leave releases once. */
  private hostStateReleased = true

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
   * Whether this call is taking the wearer's voice over BLE LC3, which means the glasses must
   * publish video only. Read by the SoftAP orchestrator between the meeting join and the publish.
   */
  glassesLc3UplinkActive(): boolean {
    return this.micTransport === "ble-lc3"
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
    this.scopedTerminating = false
    this.bindScopedNetworkLost(native)
    await native.beginTrace?.(softapTraceId())
    return await native.joinScopedNetwork(ssid, passphrase)
  }

  /**
   * Subscribe to "the glasses hotspot went away while we still wanted it".
   *
   * Only unexpected losses arrive here. Native drops the framework callback for a network it
   * released itself, and [leaveScopedNetwork] raises the terminal intent before releasing, so a
   * normal Leave or End cannot manufacture a mid-call failure.
   */
  onScopedNetworkLost(listener: (error: {code: string; message: string}) => void): () => void {
    this.scopedLostListeners.add(listener)
    return () => this.scopedLostListeners.delete(listener)
  }

  private bindScopedNetworkLost(native: NativeModule): void {
    if (this.scopedLostSub) return
    try {
      this.scopedLostSub = native.addListener("onScopedNetworkLost", (event) => {
        if (this.scopedTerminating) {
          console.log("[AcsMeeting] phase=scoped-lost-expected", {code: event.code})
          return
        }
        const error = {
          code: typeof event.code === "string" ? event.code : "SOFTAP_NETWORK_LOST",
          message: typeof event.message === "string" ? event.message : "The glasses hotspot went away",
        }
        console.warn("[AcsMeeting] phase=scoped-lost", error)
        for (const listener of [...this.scopedLostListeners]) {
          try {
            listener(error)
          } catch (listenerError) {
            console.warn("[AcsMeeting] scoped-lost listener threw", listenerError)
          }
        }
      })
    } catch (error) {
      // A native that predates the event simply never reports mid-call loss; that is a smaller
      // problem than failing the join over a missing listener.
      console.warn("[AcsMeeting] scoped network loss events unavailable", error)
      this.scopedLostSub = null
    }
  }

  /** Raise the terminal intent so the release we are about to do is not read as a failure. */
  beginScopedTeardown(): void {
    this.scopedTerminating = true
  }

  /**
   * Wait until the phone's default network is validated again after the hotspot join.
   *
   * Joining the glasses hotspot takes the phone off Wi-Fi, and ACS needs the internet for the very
   * next step. Waiting is what turns a 40-second join timeout with device-wide DNS failures into a
   * short, named wait — or an honest failure. Null when the host cannot tell.
   */
  async awaitValidatedDefaultNetwork(): Promise<DefaultNetworkStatus | null> {
    const native = getNative()
    if (!native?.awaitValidatedDefaultNetwork) return null
    return await native.awaitValidatedDefaultNetwork()
  }

  /**
   * Can this phone reach the glasses over the hotspot it just joined? Null when the host cannot
   * tell (no native support), so the orchestrator narrates nothing rather than a guess.
   */
  async probeScopedGateway(): Promise<{reachable: boolean; detail: string} | null> {
    const native = getNative()
    if (!native?.probeScopedGateway) return null
    return await native.probeScopedGateway()
  }

  /** Safe to call when nothing was joined: teardown runs after failed starts too. */
  async leaveScopedNetwork(): Promise<void> {
    // Intent first, release second. The other order is the false-positive bug: Android reports the
    // loss we asked for, and the call reports a network failure as it is successfully ending.
    this.scopedTerminating = true
    try {
      await getNative()?.leaveScopedNetwork?.()
    } finally {
      this.scopedLostSub?.remove()
      this.scopedLostSub = null
    }
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

  /**
   * Sign in to ACS before the glasses hotspot exists.
   *
   * SoftAP DNS cannot resolve Teams hosts. Doing this on the phone's existing internet is what
   * stops `createCallAgent` from hanging until the hotspot is torn down.
   */
  async prepareAgent(args: {token: string; displayName?: string}): Promise<void> {
    const native = getNative()
    if (!native?.prepareAgent) return
    console.log("[AcsMeeting] phase=prepare-agent")
    await native.prepareAgent({token: args.token, displayName: args.displayName})
    console.log("[AcsMeeting] phase=prepare-agent-ok")
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
    const generation = ++this.callGeneration
    this.hostStateReleased = false
    this.owner = packageName
    // Only a whep source has a URL to re-feed on recovery; softap rebuilds instead.
    this.whepUrl = args.videoSource.type === "whep" ? args.videoSource.url : null
    this.videoSource = args.videoSource
    // Decided here, before the join, so the SoftAP orchestrator can read it between the join and
    // telling the glasses what to capture.
    const lc3Uplink = glassesLc3UplinkSupported({
      videoSource: args.videoSource,
      audioSource: resolved.source,
      hasPushOutgoingPcm: typeof native.pushOutgoingPcm === "function",
      platform: Platform.OS,
    })
    this.micTransport = lc3Uplink ? "ble-lc3" : resolved.source === "phone" ? "phone" : "whip"
    this.bindNative(native, packageName)
    console.log("[AcsMeeting] phase=join-native", {
      packageName,
      nativeLoaded: true,
      hasToken: Boolean(args.token),
      transport: args.videoSource.type,
      audioSource: resolved.source,
      audioSourceReason: resolved.reason,
      micTransport: this.micTransport,
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
        ...(lc3Uplink ? {audioDelayMs: SOFTAP_LC3_AUDIO_DELAY_MS} : {}),
        ...(video ? {video} : {}),
      })
      if (generation !== this.callGeneration) {
        // The wearer left while ACS was still joining. Nothing above knows about this call, so
        // hanging it up here is the only thing that takes the device out of the Teams roster.
        console.warn("[AcsMeeting] phase=join-cancelled", {packageName, generation})
        await native.leave().catch((leaveError) => {
          console.warn("[AcsMeeting] native leave after a cancelled join failed", leaveError)
        })
        throw new Error("The meeting was cancelled before it finished joining")
      }
      this.ingestUrl = typeof state.ingestUrl === "string" ? state.ingestUrl : null
      const {ingestUrl: _ingestUrl, ...meetingState} = state
      this.lastState = {
        ...meetingState,
        audioSource: resolved.source,
        audioSourceReason: resolved.reason,
        micTransport: this.micTransport,
      }
      console.log("[AcsMeeting] phase=join-native-ok", {state: state.state, muted: state.muted})
      this.startGlassesMicUplink(generation)
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
   * Leave, and do not resolve until native reports its cleanup is finished.
   *
   * The difference from [leave] is the whole point: native's `leave()` queues the hang-up, the
   * agent disposal, and the network releases on its session executor and returns straight away, so
   * a caller that awaits it and then starts the next call is racing the previous one's teardown.
   *
   * Falls back to [leave] on builds that predate the signal and says so, rather than pretending to
   * a guarantee it cannot give.
   *
   * @param timeoutMs how long native may take before it reports the cleanup as stuck
   */
  async leaveAndAwait(packageName: string, timeoutMs = ACS_LEAVE_WAIT_MS): Promise<{completed: boolean; reason?: string}> {
    if (this.owner && this.owner !== packageName) return {completed: true}
    const native = getNative()
    if (!native?.leaveAndAwait) {
      await this.leave(packageName)
      return {completed: false, reason: "unsupported"}
    }
    try {
      const outcome = await native.leaveAndAwait({timeoutMs})
      return {completed: outcome?.completed !== false}
    } finally {
      await this.releaseHostState()
    }
  }

  /**
   * End the Teams group call for everyone.
   *
   * Host state is released either way: native tears this device down whatever the hang-up did, so
   * holding the meeting slot open after a rejection would leave the miniapp unable to start another
   * call. The rejection still propagates — the caller has to be able to say "you left, but the
   * meeting may still be active" instead of claiming a clean end.
   */
  async endForEveryone(packageName: string): Promise<MeetingState> {
    if (this.owner && this.owner !== packageName) {
      throw new Error("This miniapp does not own the active meeting")
    }
    const native = getNative()
    if (!native?.endForEveryone) {
      throw new Error("Update the Mentra App to end a meeting for everyone")
    }
    try {
      const state = await native.endForEveryone()
      console.log("[AcsMeeting] phase=end-for-everyone-ok", {state: state.state})
      return state
    } finally {
      await this.releaseHostState()
    }
  }

  /** Whether the wearer may end this meeting for everyone, as ACS last reported it. */
  hangUpForEveryoneCapability(): MeetingCapability {
    return this.lastState.capabilities?.hangUpForEveryone ?? {allowed: null, reason: null}
  }

  /**
   * Drop everything the host set up around a session: the microphone uplink, the network watcher,
   * return audio, native listeners, ownership.
   *
   * Idempotent, because there are now several terminal paths into it and they overlap. A remote
   * hang-up arrives as a native `disconnected`, and the miniapp usually calls `leave` right after
   * seeing it; releasing the microphone pin twice would clear a pin the *next* call had already
   * taken. Every release also bumps the call generation, which is what stops a `mic_pcm` event
   * already queued on the JS thread from reaching a native session that is gone.
   */
  private async releaseHostState(): Promise<void> {
    if (this.hostStateReleased) return
    this.hostStateReleased = true
    this.callGeneration++
    // Before anything else: a caller parked on a frame that will now never arrive has to be
    // rejected, or a leave mid-join leaves the orchestrator waiting out its whole timeout.
    for (const settle of [...this.firstFrameWaiters]) settle(new Error("The meeting ended"))
    this.firstFrameWaiters.clear()
    this.stopGlassesMicUplink()
    this.unwatchPhoneNetwork()
    await this.stopPcm()
    this.unbindNative()
    this.scopedLostSub?.remove()
    this.scopedLostSub = null
    this.owner = null
    this.whepUrl = null
    this.videoSource = null
    this.ingestUrl = null
    this.lastMediaRestartAt = 0
    this.lastState = {state: "idle", muted: false}
  }

  /**
   * Start forwarding the glasses microphone into ACS for this call.
   *
   * Order matters and is the whole point: pin the Bluetooth SDK to the glasses *before* asking it
   * for PCM, so the first frame the mic requirement produces is already from the right source and
   * the phone microphone is never opened even for one buffer. `generation` is captured by the
   * listener so a frame that lands after this call ended is dropped rather than pushed at a native
   * session that has left the meeting.
   */
  private startGlassesMicUplink(generation: number): void {
    if (this.micTransport !== "ble-lc3") return
    const native = getNative()
    const push = native?.pushOutgoingPcm
    if (!native || !push) return
    this.micFramesForwarded = 0
    this.micFramesWindow = 0
    this.micDropsStale = 0
    this.micDropsNonGlasses = 0
    this.micGaps = 0
    this.micGapMsMax = 0
    this.lastGlassesFrameAt = Date.now()
    this.lastMicDropLogAt = 0
    this.lastMicUplinkLogAt = Date.now()
    this.micLevel.take()
    this.lastMicLevel = null
    try {
      void Promise.resolve(BluetoothSdk.setMicSourcePin?.(GLASSES_MIC_SOURCE)).catch((error) => {
        console.warn("[AcsMeeting] pinning the glasses microphone failed", error)
      })
      this.micUplinkActive = true
      micStateCoordinator.setCallRequirement(true)
      this.micSub = BluetoothSdk.addListener("mic_pcm", (event: {pcm?: ArrayBuffer; sampleRate?: number; source?: string}) => {
        if (generation !== this.callGeneration) {
          this.micDropsStale += 1
          this.logMicDrop("stale", {generation, active: this.callGeneration})
          return
        }
        // The pin makes this unreachable in normal operation, which is exactly why it is checked:
        // a mic the SDK moved under us would otherwise put the phone's room into a Teams call
        // that reports the glasses.
        if (event.source !== GLASSES_MIC_SOURCE) {
          this.micDropsNonGlasses += 1
          this.logMicDrop("non-glasses", {source: event.source})
          this.reportGlassesMicUnavailable(event.source)
          return
        }
        const pcm = event.pcm
        if (!pcm) return
        const now = Date.now()
        if (this.micFramesForwarded > 0) {
          const gapMs = now - this.lastGlassesFrameAt
          if (gapMs > MIC_GAP_WARN_MS) {
            this.micGaps += 1
            this.micGapMsMax = Math.max(this.micGapMsMax, gapMs)
            this.logMicDrop("gap", {gapMs})
          }
        }
        this.lastGlassesFrameAt = now
        this.micFramesForwarded += 1
        this.micFramesWindow += 1
        this.micLevel.add(pcm)
        try {
          push.call(native, pcmToBase64(pcm), event.sampleRate ?? 16000, 1)
        } catch (error) {
          console.warn("[AcsMeeting] pushing glasses PCM to ACS failed", error)
        }
        this.logMicUplink()
      })
      console.log("[AcsMeeting] phase=glasses-mic-uplink-start", {generation, micTransport: this.micTransport})
    } catch (error) {
      // A host that cannot subscribe has no wearer audio at all, and that is worth saying loudly,
      // but it is not worth failing a call the wearer can still see and hear.
      console.error("[AcsMeeting] phase=glasses-mic-uplink-unavailable", error)
      this.stopGlassesMicUplink()
      this.markMicTransportNone()
    }
  }

  /** Release the microphone claims this call took. Safe to call when it never took them. */
  private stopGlassesMicUplink(): void {
    this.micSub?.remove()
    this.micSub = null
    if (this.micUplinkActive) {
      this.micUplinkActive = false
      micStateCoordinator.setCallRequirement(false)
      // Last, and unconditionally: while the pin is set no other consumer can pick a microphone,
      // so leaving it behind would leave captions and the cloud uplink stuck on the glasses.
      void Promise.resolve(BluetoothSdk.setMicSourcePin?.(null)).catch((error) => {
        console.warn("[AcsMeeting] releasing the glasses microphone pin failed", error)
      })
      console.log("[AcsMeeting] phase=glasses-mic-uplink-stop", {
        frames: this.micFramesForwarded,
        dropsStale: this.micDropsStale,
        dropsNonGlasses: this.micDropsNonGlasses,
        gaps: this.micGaps,
        gapMsMax: this.micGapMsMax,
      })
    }
    this.micTransport = "whip"
  }

  /**
   * Report a call whose pinned microphone stopped delivering. There is deliberately no fallback:
   * the wearer agreed to be heard from the glasses, and quietly switching to the phone in the
   * middle of a meeting puts the room they are standing in on the call.
   */
  private reportGlassesMicUnavailable(source: string | undefined): void {
    if (Date.now() - this.lastGlassesFrameAt < GLASSES_MIC_GRACE_MS) return
    if (this.micTransport === "none") return
    console.error("[AcsMeeting] phase=glasses-mic-unavailable", {source, dropsNonGlasses: this.micDropsNonGlasses})
    this.markMicTransportNone()
  }

  /**
   * Record that this call has no wearer audio path.
   *
   * The state has to carry it, not just the field: a call that reported `ble-lc3` and then failed
   * to start the uplink looks identical from the miniapp's side to one that is working, and the
   * wearer finds out by being asked to repeat themselves.
   */
  private markMicTransportNone(): void {
    this.micTransport = "none"
    this.lastState = {...this.lastState, micTransport: "none", error: GLASSES_MIC_UNAVAILABLE}
    if (this.owner) this.onState?.(this.owner, this.lastState)
  }

  private logMicUplink(): void {
    const now = Date.now()
    const elapsed = now - this.lastMicUplinkLogAt
    if (elapsed < MIC_UPLINK_LOG_INTERVAL_MS) return
    this.lastMicUplinkLogAt = now
    // Level, not just cadence: a 20 Hz stream of the noise floor and a 20 Hz stream of speech
    // have the same framesPerSecond. Quiet room on Mentra Live LC3 is meanAbs ≈30–60.
    const level = this.micLevel.take()
    this.lastMicLevel = {meanAbs: level.meanAbs, peak: level.peak}
    console.log("[AcsMeeting] phase=glasses-mic-uplink", {
      framesPerSecond: Math.round((this.micFramesWindow * 1000) / elapsed),
      frames: this.micFramesForwarded,
      meanAbs: level.meanAbs,
      peak: level.peak,
      dropsStale: this.micDropsStale,
      dropsNonGlasses: this.micDropsNonGlasses,
      gaps: this.micGaps,
      gapMsMax: this.micGapMsMax,
    })
    // #region agent log
    fetch("http://127.0.0.1:7905/ingest/5a9713c9-45ff-4d09-9435-2adc5db5e91d", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Debug-Session-Id": "828181"},
      body: JSON.stringify({
        sessionId: "828181",
        runId: "run1",
        hypothesisId: "E",
        location: "AcsMeetingService.ts:logMicUplink",
        message: "phone decoded glasses PCM window",
        data: {
          fps: Math.round((this.micFramesWindow * 1000) / elapsed),
          meanAbs: level.meanAbs,
          peak: level.peak,
          frames: this.micFramesForwarded,
        },
        timestamp: Date.now(),
      }),
    }).catch(() => {})
    // #endregion
    this.micFramesWindow = 0
  }

  /** Level of the last uplink window, for tests and dev screens. `null` until a window closed. */
  lastGlassesMicLevel(): {meanAbs: number; peak: number} | null {
    return this.lastMicLevel
  }

  private logMicDrop(reason: string, extra: Record<string, unknown>): void {
    const now = Date.now()
    if (now - this.lastMicDropLogAt < 1000) return
    this.lastMicDropLogAt = now
    console.warn("[AcsMeeting] phase=glasses-mic-drop", {
      reason,
      dropsStale: this.micDropsStale,
      dropsNonGlasses: this.micDropsNonGlasses,
      gaps: this.micGaps,
      ...extra,
    })
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
      // Mute is an ACS-side gate. It does not change which microphone the call is using, and it
      // deliberately does not turn the glasses microphone off — see the mute chain in native.
      micTransport: this.micTransport,
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
    this.lastState = {...state, micTransport: this.micTransport}
    return this.lastState
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
        const capabilities = parseMeetingCapabilities(event.capabilities)
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
          micTransport: this.micTransport,
          ...(mediaSource ? {mediaSource} : {}),
          ...(participants ? {participants} : {}),
          // Absent means unknown, so keep the last known verdict rather than clearing it.
          ...((capabilities ?? this.lastState.capabilities) ? {capabilities: capabilities ?? this.lastState.capabilities} : {}),
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
          micTransport: state.micTransport,
          participants: participants?.length,
        })
        this.settleFirstFrameWaiters(mediaSource)
        this.onState?.(packageName, state)
        // A remote hang-up, an ACS error or a dropped call never goes through `leave`, so without
        // this the microphone pin, the PCM requirement and the `mic_pcm` listener would outlive the
        // meeting — and the next miniapp to start a call would inherit them.
        if (state.state === "disconnected" || state.state === "error") {
          void this.releaseHostState().catch((error) => {
            console.warn("[AcsMeeting] releasing host state after a terminal native state failed", error)
          })
        }
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
    // SoftAP media is bound to the scoped hotspot, not the phone's default route. Joining that
    // hotspot is what *causes* NetInfo to flap `none:offline → cellular:online` — the default
    // route looks gone for a beat, then cellular comes back. Rebuilding the WHIP listener on
    // that flap changes the ingest port after the glasses already have the old URL, and their
    // POST hits a tombstone (HTTP 410). A real hotspot loss is `onScopedNetworkLost`, not this
    // default-network watch. WHEP still needs the rebuild: that path rides the default route.
    if (softap) return
    if (!this.owner || !MEDIA_ACTIVE_PHASES.has(this.lastState.state)) return
    if (!whepUrl) return
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
          console.warn("[AcsMeeting] incoming PCM backlog high (downlink playback, not glasses mic)", {bufferedMs})
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
      jitterMs: PCM_JITTER_MS,
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
