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

export interface MeetingVideoSource {
  type: "whep"
  url: string
}

export interface MeetingJoinOptions {
  provider: MeetingProvider
  meetingUrl: string
  videoSource: MeetingVideoSource
  /** V1-only: Porter-minted ACS guest token. Do not persist. */
  token: string
  displayName?: string
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
    if (options.videoSource?.type !== "whep" || !options.videoSource.url?.trim()) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "videoSource must be a WHEP URL"}
    }
    if (!options.token?.trim()) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "token is required"}
    }
    try {
      const result = await this.session.sendRequest<MeetingState | null>(
        {
          type: MiniappRequestType.MEETING_JOIN,
          provider: options.provider,
          meetingUrl: options.meetingUrl,
          videoSource: options.videoSource,
          token: options.token,
          displayName: options.displayName,
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

  async updateVideoSource(source: MeetingVideoSource): Promise<void> {
    if (source?.type !== "whep" || !source.url?.trim()) {
      throw {code: MiniappErrorCode.INVALID_ARGUMENT, message: "videoSource must be a WHEP URL"}
    }
    try {
      await this.session.sendRequest<void>({
        type: MiniappRequestType.MEETING_UPDATE_VIDEO_SOURCE,
        videoSource: source,
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
    }
  }
}
