/**
 * @fileoverview MeetingModule — phone-native meeting (ACS Teams).
 *
 * Workspace credentials belong to the host. Consumer token pass-through remains
 * available for older hosts and Call backends. Never persist credentials.
 */

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import type {MiniappRequestError} from "../session"
import {MiniappSession} from "../session"
import type {UnsubscribeFn} from "./events"

export const MEETING_HOST_UPDATE_MESSAGE = "Update the Mentra App to use Teams calling"

export type MeetingProvider = "acs-teams"

export type MeetingPhase = "idle" | "connecting" | "lobby" | "connected" | "disconnected" | "error"

/** Glasses video reaches the phone through a Cloudflare WHEP endpoint. */
export interface MeetingWhepVideoSource {
  type: "whep"
  url: string
}

/**
 * Glasses video reaches the phone directly over the glasses' own hotspot, with no Cloudflare hop.
 *
 * There is no URL here because the host produces one rather than consuming one: it joins the
 * hotspot, binds a local WHIP endpoint, and tells the glasses where to publish. The miniapp only
 * chooses the transport.
 *
 * Supported by current Android and iOS hosts.
 */
export interface MeetingSoftApVideoSource {
  type: "softap"
  /**
   * Reuse a hotspot the miniapp has already started, instead of letting the host start one. Both
   * are required together; omit both for the normal path.
   */
  ssid?: string
  passphrase?: string
}

export type MeetingVideoSource = MeetingWhepVideoSource | MeetingSoftApVideoSource

/**
 * Validates a video source, returning the narrowed value.
 *
 * Exported because both `join` and `updateVideoSource` need it and because the invalid cases are
 * worth pinning: an unknown `type` and a WHEP source with no URL must fail here, at the call the
 * miniapp author can see, rather than as a meeting that connects and shows nothing.
 */
export function validateMeetingVideoSource(source: unknown): MeetingVideoSource {
  const value = (source ?? {}) as Record<string, unknown>

  if (value.type === "whep") {
    const url = typeof value.url === "string" ? value.url.trim() : ""
    if (!url) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "videoSource.url is required for a WHEP source"}
    }
    return {type: "whep", url}
  }

  if (value.type === "softap") {
    const ssid = typeof value.ssid === "string" ? value.ssid.trim() : ""
    const passphrase = typeof value.passphrase === "string" ? value.passphrase : ""
    // Half a credential pair is a misconfiguration that would otherwise present as a failed
    // hotspot join several seconds later.
    if (Boolean(ssid) !== Boolean(passphrase)) {
      throw {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "videoSource.ssid and videoSource.passphrase must be provided together",
      }
    }
    return ssid ? {type: "softap", ssid, passphrase} : {type: "softap"}
  }

  throw {
    code: MiniappErrorCode.INVALID_ARGUMENT,
    message: `videoSource must be {type: "whep", url} or {type: "softap"}`,
  }
}

/** Advertised ACS outgoing format. Omitted hosts keep 1280×720@15. */
export interface MeetingOutgoingVideo {
  width: number
  height: number
  fps: number
  maxBitrateBps: number
}

/**
 * Which path the wearer took into the call: a meeting this app created, or a link they joined.
 *
 * Diagnostic only — the host behaves identically either way — but it is stamped on the host and
 * native traces, so a quality comparison between the two paths can be made from one capture.
 */
export type MeetingOrigin = "created" | "joined"

export interface MeetingJoinOptions {
  provider: MeetingProvider
  meetingUrl: string
  videoSource: MeetingVideoSource
  /** Legacy consumer credential. Omit when getConfiguration().credentialSource is runtime. */
  token?: string
  displayName?: string
  video?: MeetingOutgoingVideo
  origin?: MeetingOrigin
}

export interface MeetingCreateOptions {
  provider: MeetingProvider
  subject?: string
  durationMinutes?: number
}

export interface CreatedMeeting {
  provider: MeetingProvider
  joinUrl: string
  /** Opaque ownership receipt. Keep it to retire this meeting later. */
  meetingRef: string
  identityMode: MeetingIdentityMode
  guestReason?: "no-entra-identity" | "teams-license-unavailable"
}

export type MeetingParticipantState = "idle" | "connecting" | "connected" | "lobby" | "hold" | "disconnected"

/** A remote participant as reported by the phone-native meeting client. */
export interface MeetingParticipant {
  /** Stable provider identifier (ACS raw id). */
  id: string
  displayName: string | null
  state: MeetingParticipantState
  isMuted: boolean
  isSpeaking: boolean
}

export type MeetingIdentityMode = "guest" | "teams-user"
export type MeetingGuestReason = "no-entra-identity" | "teams-license-unavailable" | "legacy-credential"

/**
 * Identity resolved before joining. `teams-user` means Microsoft accepted the
 * Teams calling license, not that the account owns a particular M365 SKU or
 * has permission to organize every meeting. Credentials never cross this API.
 * Acquisition/consent/provider errors reject instead of reporting guest mode.
 */
export interface MeetingIdentity {
  identityMode: MeetingIdentityMode
  guestReason?: MeetingGuestReason
  /** Present when the host has a signed-in Entra account, including unlicensed accounts. */
  account?: {displayName?: string; email?: string}
}

/** Host policy; this contains no credentials or deployment endpoints. */
export interface MeetingConfiguration {
  enabled: boolean
  credentialSource: "runtime" | "miniapp"
  externalBackendAllowed: boolean
  managedStreams: boolean
  /** Omitted by older hosts. Runtime creation requires Graph organizer configuration. */
  creationSource?: "runtime" | "miniapp"
}

export interface MeetingState {
  /** Omitted by older hosts. Tokens never cross this boundary. */
  identityMode?: MeetingIdentityMode
  guestReason?: MeetingGuestReason
  state: MeetingPhase
  muted: boolean
  /**
   * Whether remote participants receive the glasses camera. False after `setVideoEnabled(false)`;
   * every new join starts true. Omitted by hosts that cannot toggle outgoing video.
   */
  videoEnabled?: boolean
  error?: string
  /** Provider termination details, including Teams' invalid meeting-link codes. */
  endReason?: MeetingEndReason
  meetingUrl?: string
  provider?: MeetingProvider
  audioSource?: "glasses" | "phone"
  audioSourceReason?: "explicit" | "current-mic" | "ranking" | "fallback-glasses-connected" | "fallback-no-glasses"
  activeStream?: "none" | "virtual" | "local"
  audioSafety?: "safe" | "degraded" | "unsafe"
  /**
   * Health of the glasses video the phone is forwarding into the meeting.
   * `live` means a frame reached the meeting client, so it is the only honest
   * "remote participants can see the camera" signal — the WHEP subscription
   * answers seconds earlier. Omitted by hosts that predate the field, which
   * must be read as "unknown", never as "not live".
   */
  mediaSource?: MeetingMediaSource
  /** Remote roster. Omitted by hosts that predate participant reporting. */
  participants?: MeetingParticipant[]
  /**
   * What this participant is allowed to do in the meeting, as the provider reports it at runtime.
   * Omitted by hosts that predate capability reporting.
   */
  capabilities?: MeetingCapabilities
  /**
   * SoftAP join checklist. Present only on the state events the host emits while it walks the
   * SoftAP sequence (and on the final one when it fails); absent on every other event, including
   * the native meeting client's own. Keep the last one you saw — absence is not a reset.
   */
  softap?: MeetingSoftApProgress
  /**
   * SoftAP mid-call recovery. Omitted by hosts that predate the field, and omitted on events
   * that have no news. `active` means keep the ACS call — a lost hotspot is a media outage.
   */
  recovery?: MeetingSoftApRecovery
}

export type MeetingMediaSource = "idle" | "connecting" | "live" | "failed"

export interface MeetingEndReason {
  code?: number
  subcode?: number
  message?: string
}

/** Older hosts omit this field; malformed values must not become provider error codes. */
export function parseMeetingEndReason(raw: unknown): MeetingEndReason | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  const number = (field: unknown): number | undefined =>
    typeof field === "number" && Number.isFinite(field) ? field : undefined
  const code = number(value.code)
  const subcode = number(value.subcode)
  const message = typeof value.message === "string" && value.message ? value.message : undefined
  if (code === undefined && subcode === undefined && message === undefined) return undefined
  return {
    ...(code !== undefined ? {code} : {}),
    ...(subcode !== undefined ? {subcode} : {}),
    ...(message !== undefined ? {message} : {}),
  }
}

/**
 * One runtime capability.
 *
 * `allowed` is nullable because "you may not" and "we do not know yet" are different answers and
 * need different UI. Providers deliver capabilities asynchronously — Teams can grant a presenter
 * role mid-call — so a control gated on this should read `null` as "not yet", not as "no".
 */
export interface MeetingCapability {
  allowed: boolean | null
  /** Provider reason, e.g. `role_restricted`, `meeting_restricted`. Null when not reported. */
  reason: string | null
}

export interface MeetingCapabilities {
  /** Whether `meeting.end()` will be honoured: presenters only, on Teams. */
  hangUpForEveryone: MeetingCapability
  manageLobby?: MeetingCapability
}

/** Tolerant parse of a host `capabilities` payload. A malformed payload reads as absent. */
export function parseMeetingCapabilities(raw: unknown): MeetingCapabilities | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = (raw as Record<string, unknown>).hangUpForEveryone
  if (!value || typeof value !== "object") return undefined
  const capability = value as Record<string, unknown>
  const rawLobby = (raw as Record<string, unknown>).manageLobby
  const lobby = rawLobby && typeof rawLobby === "object" ? (rawLobby as Record<string, unknown>) : undefined
  return {
    ...(lobby
      ? {
          manageLobby: {
            allowed: typeof lobby.allowed === "boolean" ? lobby.allowed : null,
            reason: typeof lobby.reason === "string" && lobby.reason ? lobby.reason : null,
          },
        }
      : {}),
    hangUpForEveryone: {
      allowed: typeof capability.allowed === "boolean" ? capability.allowed : null,
      reason: typeof capability.reason === "string" && capability.reason ? capability.reason : null,
    },
  }
}

/**
 * The five SoftAP steps, in order. `hotspot`: glasses turn on their AP. `scopedJoin`: the phone
 * joins it without giving up cellular. `acsJoin`: the phone binds its video receiver and joins
 * Teams. `publish`: the glasses start the camera and publish to the phone. `live`: a frame reached
 * the meeting.
 */
export type MeetingSoftApStep = "hotspot" | "scopedJoin" | "acsJoin" | "publish" | "live"

export type MeetingSoftApStepStatus = "pending" | "running" | "done" | "failed"

export interface MeetingSoftApStepState {
  step: MeetingSoftApStep
  status: MeetingSoftApStepStatus
  /** What the step produced or is doing: SSID, phone address, receiver URL, glasses status. */
  detail?: string
  /** Only on `failed`. */
  error?: string
  durationMs?: number
}

export interface MeetingSoftApProgress {
  /** Correlates phone and glasses logs for this attempt. */
  traceId?: string
  phase: "idle" | "starting" | "recovering" | "live" | "stopping" | "failed"
  steps: MeetingSoftApStepState[]
  /** ms since the host started the sequence. */
  elapsedMs: number
}

/** Host SoftAP mid-call recovery. Missing `recovery` is "no news", not "ended". */
export interface MeetingSoftApRecovery {
  active: boolean
  generation?: number
  deadlineAt?: number
  phase?: string
}

const SOFTAP_STEPS: ReadonlySet<string> = new Set(["hotspot", "scopedJoin", "acsJoin", "publish", "live"])
const SOFTAP_STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "done", "failed"])
const SOFTAP_PHASES: ReadonlySet<string> = new Set(["idle", "starting", "recovering", "live", "stopping", "failed"])

/** Tolerant parse of a host `softap` payload. Unknown steps are dropped; a malformed payload reads as absent. */
export function parseMeetingSoftApProgress(raw: unknown): MeetingSoftApProgress | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (!SOFTAP_PHASES.has(String(value.phase)) || !Array.isArray(value.steps)) return undefined
  const steps: MeetingSoftApStepState[] = []
  for (const entry of value.steps) {
    if (!entry || typeof entry !== "object") continue
    const step = entry as Record<string, unknown>
    if (!SOFTAP_STEPS.has(String(step.step)) || !SOFTAP_STEP_STATUSES.has(String(step.status))) continue
    steps.push({
      step: step.step as MeetingSoftApStep,
      status: step.status as MeetingSoftApStepStatus,
      detail: typeof step.detail === "string" && step.detail ? step.detail : undefined,
      error: typeof step.error === "string" && step.error ? step.error : undefined,
      durationMs: typeof step.durationMs === "number" && Number.isFinite(step.durationMs) ? step.durationMs : undefined,
    })
  }
  return {
    traceId: typeof value.traceId === "string" && value.traceId ? value.traceId : undefined,
    phase: value.phase as MeetingSoftApProgress["phase"],
    steps,
    elapsedMs: typeof value.elapsedMs === "number" && Number.isFinite(value.elapsedMs) ? value.elapsedMs : 0,
  }
}

/** Tolerant parse of a host `recovery` payload. A malformed payload reads as absent. */
export function parseMeetingRecovery(raw: unknown): MeetingSoftApRecovery | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.active !== "boolean") return undefined
  const generation =
    typeof value.generation === "number" && Number.isFinite(value.generation) ? value.generation : undefined
  const deadlineAt =
    typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt) ? value.deadlineAt : undefined
  const phase = typeof value.phase === "string" && value.phase ? value.phase : undefined
  return {
    active: value.active,
    ...(generation !== undefined ? {generation} : {}),
    ...(deadlineAt !== undefined ? {deadlineAt} : {}),
    ...(phase ? {phase} : {}),
  }
}

const PARTICIPANT_STATES: ReadonlySet<string> = new Set([
  "idle",
  "connecting",
  "connected",
  "lobby",
  "hold",
  "disconnected",
])

const MEDIA_SOURCES: ReadonlySet<string> = new Set(["idle", "connecting", "live", "failed"])

/** Tolerant parse of a host `mediaSource`. Unknown values read as unknown. */
export function parseMeetingMediaSource(raw: unknown): MeetingMediaSource | undefined {
  return MEDIA_SOURCES.has(String(raw)) ? (raw as MeetingMediaSource) : undefined
}

/** Tolerant parse of a host `participants` payload. Unknown shapes are skipped. */
export function parseMeetingParticipants(raw: unknown): MeetingParticipant[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: MeetingParticipant[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue
    const value = entry as Record<string, unknown>
    if (typeof value.id !== "string" || !value.id) continue
    result.push({
      id: value.id,
      displayName: typeof value.displayName === "string" && value.displayName ? value.displayName : null,
      state: PARTICIPANT_STATES.has(String(value.state)) ? (value.state as MeetingParticipantState) : "idle",
      isMuted: Boolean(value.isMuted),
      isSpeaking: Boolean(value.isSpeaking),
    })
  }
  return result
}

export type MeetingStateHandler = (state: MeetingState) => void

/** The host resumed a photo pause because it hit the ceiling. */
export interface MeetingVideoPublisherEvent {
  pauseId: string
  status: "expired"
}

/**
 * Why [MeetingModule.captureStill] failed. `unsupported` means this host, build, or transport
 * cannot do it at all (older Mentra App, iOS today, a non-Direct-link call): use the
 * pause-based path instead. Everything else is a failed attempt of a supported one.
 */
export type MeetingStillFailure =
  | "unsupported"
  | "not_live"
  | "busy"
  | "glasses_rejected"
  | "upload_timeout"
  | "hold_failed"
  | "cancelled"

/** Rejection of [MeetingModule.captureStill]. */
export interface MeetingStillError {
  code: string
  message: string
  reason: MeetingStillFailure
}

/** `card` on the tile, glasses `uploading` the capture, still `shown` on the tile. */
export type MeetingStillPhase = "card" | "uploading" | "shown"

/** @internal Push correlated to one [MeetingModule.captureStill] call by `stillId`. */
export interface MeetingStillProgressEvent {
  stillId: string
  phase: MeetingStillPhase
}

let stillSeq = 0

function mintStillId(): string {
  stillSeq = (stillSeq + 1) % 0xffff
  return `still-${Date.now().toString(36)}-${stillSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export interface MeetingStillResult {
  ok: true
  requestId: string
  /** Size of the JPEG the glasses delivered. */
  bytes: number
  /** Host clock when the first still frame reached the Teams sender. */
  shownAt: number
  timings: {cardMs: number; stillMs: number; heldMs: number; totalMs: number}
}

const STILL_FAILURES: ReadonlySet<string> = new Set<MeetingStillFailure>([
  "unsupported",
  "not_live",
  "busy",
  "glasses_rejected",
  "upload_timeout",
  "hold_failed",
  "cancelled",
])

function toStillError(error: unknown): MeetingStillError {
  const raw = (error && typeof error === "object" ? error : {}) as {code?: unknown; message?: unknown; reason?: unknown}
  const code = typeof raw.code === "string" ? raw.code : MiniappErrorCode.INTERNAL
  const message = typeof raw.message === "string" ? raw.message : String(error)
  let reason: MeetingStillFailure
  if (typeof raw.reason === "string" && STILL_FAILURES.has(raw.reason)) reason = raw.reason as MeetingStillFailure
  else if (code === MiniappErrorCode.NOT_IMPLEMENTED) reason = "unsupported"
  else if (code === MiniappErrorCode.REQUEST_ABORTED) reason = "cancelled"
  else reason = "glasses_rejected"
  return {code, message, reason}
}

function isMiniappRequestError(error: unknown): error is MiniappRequestError {
  return Boolean(error && typeof error === "object" && "code" in error)
}

function mapHostError(error: unknown): never {
  if (isMiniappRequestError(error) && error.code === MiniappErrorCode.NOT_IMPLEMENTED) {
    throw {code: MiniappErrorCode.NOT_IMPLEMENTED, message: MEETING_HOST_UPDATE_MESSAGE}
  }
  throw error
}

export class MeetingModule {
  private _state: MeetingState = {state: "idle", muted: false}

  constructor(private readonly session: MiniappSession) {}

  get state(): MeetingState {
    return {...this._state}
  }

  /**
   * Join a Teams meeting via the phone ACS client.
   * Resolves once the host has accepted the join (state may still be connecting/lobby).
   */
  async join(options: MeetingJoinOptions): Promise<MeetingState> {
    if (options.provider !== "acs-teams") {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: `Unsupported meeting provider: ${options.provider}`}
    }
    if (!options.meetingUrl?.trim()) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "meetingUrl is required"}
    }
    const videoSource = validateMeetingVideoSource(options.videoSource)

    try {
      const result = await this.session.sendRequest<MeetingState | null>(
        {
          type: MiniappRequestType.MEETING_JOIN,
          provider: options.provider,
          meetingUrl: options.meetingUrl,
          videoSource,
          ...(options.token ? {token: options.token} : {}),
          displayName: options.displayName,
          ...(options.origin ? {origin: options.origin} : {}),
          ...(options.video ? {video: options.video} : {}),
        },
        {timeoutMs: 0},
      )
      if (result) this._applyState(result)
      return this.state
    } catch (error) {
      mapHostError(error)
    }
  }

  /** Query before using a separate Call backend. Older hosts return NOT_IMPLEMENTED. */
  async getConfiguration(): Promise<MeetingConfiguration> {
    return this.session.sendRequest<MeetingConfiguration>({type: MiniappRequestType.MEETING_GET_CONFIGURATION})
  }

  /** Resolve the current calling identity without creating or joining a meeting. */
  async getIdentity(): Promise<MeetingIdentity> {
    try {
      return await this.session.sendRequest<MeetingIdentity>(
        {type: MiniappRequestType.MEETING_GET_IDENTITY},
        {timeoutMs: 30_000},
      )
    } catch (error) {
      mapHostError(error)
    }
  }

  /** Create a Teams meeting in the selected Runtime without exposing provider credentials. */
  async create(options: MeetingCreateOptions): Promise<CreatedMeeting> {
    if (options.provider !== "acs-teams") {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "Unsupported meeting provider"}
    }
    try {
      return await this.session.sendRequest<CreatedMeeting>(
        {
          type: MiniappRequestType.MEETING_CREATE,
          provider: options.provider,
          subject: options.subject,
          durationMinutes: options.durationMinutes,
        },
        {timeoutMs: 0},
      )
    } catch (error) {
      mapHostError(error)
    }
  }

  /** Delete a meeting created by this caller. Does not hang up an active call. */
  async retire(meetingRef: string): Promise<void> {
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_RETIRE, meetingRef}, {timeoutMs: 0})
    } catch (error) {
      mapHostError(error)
    }
  }

  async leave(): Promise<void> {
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_LEAVE})
    } catch (error) {
      mapHostError(error)
    }
  }

  /**
   * Stop the glasses camera publisher without leaving the meeting.
   * On Direct link this stops only `start_stream`. Cloudflare callers pause their own stream.
   */
  async pauseVideoPublisher(options: {reason: "photo"}): Promise<{pauseId: string}> {
    try {
      return await this.session.sendRequest<{pauseId: string}>({
        type: MiniappRequestType.MEETING_PAUSE_VIDEO_PUBLISHER,
        reason: options.reason,
      })
    } catch (error) {
      mapHostError(error)
    }
  }

  /** A stale `pauseId` is a no-op. Leave, End, and a new join cancel the pause themselves. */
  async resumeVideoPublisher(pauseId: string): Promise<void> {
    try {
      await this.session.sendRequest<void>({
        type: MiniappRequestType.MEETING_RESUME_VIDEO_PUBLISHER,
        pauseId,
      })
    } catch (error) {
      mapHostError(error)
    }
  }

  /** Resolves when the first card frame has been handed to the Teams sender. */
  async showCard(options: {kind: "taking-photo"}): Promise<void> {
    try {
      await this.session.sendRequest<void>({
        type: MiniappRequestType.MEETING_SHOW_CARD,
        kind: options.kind,
      })
    } catch (error) {
      mapHostError(error)
    }
  }

  /**
   * Replace the card with a still. Resolves when the first still frame is handed to the sender.
   * `durationMs` is the caller's clock, starting at `shownAt`.
   */
  async showImage(options: {imageUrl: string; durationMs: number}): Promise<{shownAt: number}> {
    try {
      return await this.session.sendRequest<{shownAt: number}>({
        type: MiniappRequestType.MEETING_SHOW_IMAGE,
        imageUrl: options.imageUrl,
        durationMs: options.durationMs,
      })
    } catch (error) {
      mapHostError(error)
    }
  }

  /** The caller's `durationMs` has elapsed. Glasses frames may reach the tile again. */
  async showLive(): Promise<void> {
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_SHOW_LIVE})
    } catch (error) {
      mapHostError(error)
    }
  }

  /**
   * Share one full-size glasses photo on the outgoing video of a Direct link call, without
   * stopping the glasses camera stream. The host shows the "Taking a photo..." card, has the glasses
   * shoot and upload straight to the phone, holds the still for `durationMs`, then returns to live
   * video. Do not combine with [pauseVideoPublisher] or [showCard]/[showImage]; this replaces them.
   *
   * `onProgress` reports each phase as the host reaches it, so a caller can say "taking",
   * "sharing" and "on the call" at the right moments; the promise itself settles after the hold.
   *
   * Rejects with a [MeetingStillError]. `reason: "unsupported"` means use the pause-based path.
   */
  async captureStill(options: {
    durationMs: number
    onProgress?: (phase: MeetingStillPhase) => void
  }): Promise<MeetingStillResult> {
    const stillId = mintStillId()
    const onProgress = options.onProgress
    const unsubscribe = onProgress
      ? this.session.on("meetingStill", (event) => {
          if (event.stillId === stillId) onProgress(event.phase)
        })
      : undefined
    try {
      return await this.session.sendRequest<MeetingStillResult>(
        {type: MiniappRequestType.MEETING_CAPTURE_STILL, durationMs: options.durationMs, stillId},
        // Capture, upload, and the hold itself; the host bounds each step.
        {timeoutMs: options.durationMs + 75_000},
      )
    } catch (error) {
      throw toStillError(error)
    } finally {
      unsubscribe?.()
    }
  }

  /**
   * End the meeting for everyone, then leave.
   *
   * Different from [leave] in what happens to the other participants: leaving takes this device out
   * of a meeting that carries on, ending terminates the group call. Only a presenter may do it, so
   * check `state.capabilities?.hangUpForEveryone.allowed` before offering it.
   *
   * A rejection means the meeting may still be live — it never means the wearer is still in the
   * call. The host always completes local teardown, so the honest thing to tell the user is "you
   * left, but the meeting may still be active".
   */
  async end(): Promise<void> {
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_END}, {timeoutMs: 0})
    } catch (error) {
      mapHostError(error)
    }
  }

  /** Admit one guest; callers must wait for the roster to report connected. */
  async admit(participantId: string): Promise<void> {
    if (!participantId.trim()) throw new Error("A participant ID is required")
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_ADMIT, participantId})
    } catch (error) {
      mapHostError(error)
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    try {
      const result = await this.session.sendRequest<MeetingState | null>({
        type: MiniappRequestType.MEETING_SET_MUTED,
        muted,
      })
      if (result) this._applyState(result)
    } catch (error) {
      mapHostError(error)
    }
  }

  /**
   * Stop or resume the glasses camera the meeting receives. The call and the glasses stream stay
   * up, so a local `<StreamPreview>` keeps drawing while remote participants see the camera off.
   * Check `state.videoEnabled !== undefined` before offering it; older hosts reject.
   */
  async setVideoEnabled(enabled: boolean): Promise<void> {
    try {
      const result = await this.session.sendRequest<MeetingState | null>({
        type: MiniappRequestType.MEETING_SET_VIDEO_ENABLED,
        enabled,
      })
      if (result) this._applyState(result)
    } catch (error) {
      mapHostError(error)
    }
  }

  /**
   * Repoint the host at a new WHEP URL mid-call, the recovery path for a re-published stream.
   *
   * WHEP only. A SoftAP source has no URL to update — the host owns the endpoint — and its
   * recovery is a full rebuild, so accepting one here would be a silent no-op.
   */
  async updateVideoSource(source: MeetingWhepVideoSource): Promise<void> {
    const validated = validateMeetingVideoSource(source)
    if (validated.type !== "whep") {
      throw {
        code: MiniappErrorCode.INVALID_ARGUMENT,
        message: "updateVideoSource accepts a WHEP source; a SoftAP call recovers by rejoining",
      }
    }
    try {
      await this.session.sendRequest<void>({
        type: MiniappRequestType.MEETING_UPDATE_VIDEO_SOURCE,
        videoSource: validated,
      })
    } catch (error) {
      mapHostError(error)
    }
  }

  async getState(): Promise<MeetingState> {
    try {
      const result = await this.session.sendRequest<MeetingState | null>({
        type: MiniappRequestType.MEETING_GET_STATE,
      })
      if (result) this._applyState(result)
      return this.state
    } catch (error) {
      mapHostError(error)
    }
  }

  onState(handler: MeetingStateHandler): UnsubscribeFn {
    return this.session.on("meetingState", handler)
  }

  /** Fired when the host's pause ceiling resumes the publisher. A resume this caller sent is silent. */
  onVideoPublisher(handler: (event: MeetingVideoPublisherEvent) => void): UnsubscribeFn {
    return this.session.on("meetingVideoPublisher", handler)
  }

  /** @internal — applied by MiniappSession on inbound MEETING_STATE. */
  _applyState(event: MeetingState): void {
    this._state = {
      identityMode:
        event.identityMode === "guest" || event.identityMode === "teams-user"
          ? event.identityMode
          : this._state.identityMode,
      guestReason:
        event.identityMode === "guest"
          ? event.guestReason
          : event.identityMode === "teams-user"
            ? undefined
            : this._state.guestReason,
      state: event.state,
      muted: Boolean(event.muted),
      videoEnabled: typeof event.videoEnabled === "boolean" ? event.videoEnabled : undefined,
      error: event.error,
      endReason: parseMeetingEndReason(event.endReason),
      meetingUrl: event.meetingUrl,
      provider: event.provider,
      audioSource: event.audioSource,
      audioSourceReason: event.audioSourceReason,
      activeStream: event.activeStream,
      audioSafety: event.audioSafety,
      mediaSource: parseMeetingMediaSource(event.mediaSource),
      participants: parseMeetingParticipants(event.participants),
      // Absent means unknown, so the last known verdict stands. Clearing it would make End flicker
      // out of the UI on every native state event that does not carry capabilities.
      capabilities: parseMeetingCapabilities(event.capabilities) ?? this._state.capabilities,
      softap: parseMeetingSoftApProgress(event.softap),
      // Absence is "no news", never "recovery ended". The host must send `active: false`.
      recovery: parseMeetingRecovery(event.recovery) ?? this._state.recovery,
    }
  }
}
