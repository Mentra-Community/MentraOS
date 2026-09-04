/**
 * @fileoverview MeetingModule — phone-native meeting (ACS Teams).
 *
 * V1 token pass-through is deliberate technical debt (identity ticket):
 * later, join(meetingUrl, whepUrl) and the host fetches the credential from
 * Porter. Miniapps must not persist the token.
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
 * Android only for now. iOS hosts reject this with `NOT_IMPLEMENTED`.
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

export interface MeetingJoinOptions {
  provider: MeetingProvider
  meetingUrl: string
  videoSource: MeetingVideoSource
  /** V1-only: Porter-minted ACS guest token. Do not persist. */
  token: string
  displayName?: string
  video?: MeetingOutgoingVideo
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

export interface MeetingState {
  state: MeetingPhase
  muted: boolean
  error?: string
  meetingUrl?: string
  provider?: MeetingProvider
  audioSource?: "glasses" | "phone"
  audioSourceReason?:
    | "explicit"
    | "current-mic"
    | "ranking"
    | "fallback-glasses-connected"
    | "fallback-no-glasses"
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
}

export type MeetingMediaSource = "idle" | "connecting" | "live" | "failed"

const PARTICIPANT_STATES: ReadonlySet<string> = new Set(["idle", "connecting", "connected", "lobby", "hold", "disconnected"])

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
    if (!options.token?.trim()) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "token is required"}
    }
    try {
      const result = await this.session.sendRequest<MeetingState | null>(
        {
          type: MiniappRequestType.MEETING_JOIN,
          provider: options.provider,
          meetingUrl: options.meetingUrl,
          videoSource,
          token: options.token,
          displayName: options.displayName,
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

  async leave(): Promise<void> {
    try {
      await this.session.sendRequest<void>({type: MiniappRequestType.MEETING_LEAVE})
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

  /** @internal — applied by MiniappSession on inbound MEETING_STATE. */
  _applyState(event: MeetingState): void {
    this._state = {
      state: event.state,
      muted: Boolean(event.muted),
      error: event.error,
      meetingUrl: event.meetingUrl,
      provider: event.provider,
      audioSource: event.audioSource,
      audioSourceReason: event.audioSourceReason,
      activeStream: event.activeStream,
      audioSafety: event.audioSafety,
      mediaSource: parseMeetingMediaSource(event.mediaSource),
      participants: parseMeetingParticipants(event.participants),
    }
  }
}
