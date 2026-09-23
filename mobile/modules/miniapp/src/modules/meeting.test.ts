/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {
  MEETING_HOST_UPDATE_MESSAGE,
  MeetingModule,
  parseMeetingEndReason,
  parseMeetingCapabilities,
  parseMeetingMediaSource,
  parseMeetingRecovery,
  parseMeetingSoftApProgress,
  validateMeetingVideoSource,
} from "./meeting"

function mockSession(sendRequest: MiniappSession["sendRequest"]) {
  const handlers = new Set<(state: unknown) => void>()
  const session = {
    sendRequest,
    on: (_event: string, handler: (state: unknown) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  } as unknown as MiniappSession
  return {session, handlers}
}

const joinArgs = {
  provider: "acs-teams" as const,
  meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
  videoSource: {type: "whep" as const, url: "https://customer.cloudflarestream.com/example/webRTC/play"},
  token: "guest-token",
  displayName: "Mentra",
}

describe("MeetingModule", () => {
  test("creates and retires through the host without sending caller credentials", async () => {
    const requests: unknown[] = []
    const result = {
      provider: "acs-teams",
      joinUrl: "https://teams.microsoft.com/meet/123456",
      meetingRef: "ownership",
      identityMode: "guest",
      guestReason: "no-entra-identity",
    }
    const {session} = mockSession(async (payload) => {
      requests.push(payload)
      return result
    })
    const meeting = new MeetingModule(session)
    expect(await meeting.create({provider: "acs-teams", subject: "Standup", durationMinutes: 30})).toEqual(result)
    await meeting.retire(result.meetingRef)
    expect(requests).toEqual([
      {type: MiniappRequestType.MEETING_CREATE, provider: "acs-teams", subject: "Standup", durationMinutes: 30},
      {type: MiniappRequestType.MEETING_RETIRE, meetingRef: "ownership"},
    ])
  })
  test("creation on an older host reports that the app must be updated", async () => {
    const {session} = mockSession(async () => {
      throw {code: MiniappErrorCode.NOT_IMPLEMENTED}
    })
    await expect(new MeetingModule(session).create({provider: "acs-teams"})).rejects.toMatchObject({
      message: MEETING_HOST_UPDATE_MESSAGE,
    })
  })
  test("admission preserves guest identity and propagates host rejection", async () => {
    const requests: unknown[] = []
    const {session} = mockSession(async (payload) => {
      requests.push(payload)
      throw new Error("This meeting does not allow you to admit guests")
    })
    const meeting = new MeetingModule(session)
    await expect(meeting.admit("guest-1")).rejects.toThrow("does not allow")
    expect(requests).toEqual([{type: MiniappRequestType.MEETING_ADMIT, participantId: "guest-1"}])
    await expect(meeting.admit(" ")).rejects.toThrow("participant ID")
    expect(requests).toHaveLength(1)
  })

  test("setVideoEnabled sends the toggle and applies the host's answer", async () => {
    const requests: unknown[] = []
    const {session} = mockSession(async (payload) => {
      requests.push(payload)
      return {state: "connected", muted: false, videoEnabled: false}
    })
    const meeting = new MeetingModule(session)
    await meeting.setVideoEnabled(false)
    expect(requests).toEqual([{type: MiniappRequestType.MEETING_SET_VIDEO_ENABLED, enabled: false}])
    expect(meeting.state.videoEnabled).toBe(false)
  })

  test("videoEnabled reads as unknown when the host omits or garbles it", () => {
    const {session} = mockSession(async () => null)
    const meeting = new MeetingModule(session)
    meeting._applyState({state: "connected", muted: false})
    expect(meeting.state.videoEnabled).toBeUndefined()
    meeting._applyState({state: "connected", muted: false, videoEnabled: "false" as never})
    expect(meeting.state.videoEnabled).toBeUndefined()
  })

  test("setVideoEnabled on an older host reports that the app must be updated", async () => {
    const {session} = mockSession(async () => {
      throw {code: MiniappErrorCode.NOT_IMPLEMENTED}
    })
    await expect(new MeetingModule(session).setVideoEnabled(false)).rejects.toMatchObject({
      message: MEETING_HOST_UPDATE_MESSAGE,
    })
  })

  test("lobby permission distinguishes granted, denied and unreported", () => {
    expect(parseMeetingCapabilities({hangUpForEveryone: {}})?.manageLobby).toBeUndefined()
    for (const allowed of [true, false, null]) {
      expect(parseMeetingCapabilities({hangUpForEveryone: {}, manageLobby: {allowed}})?.manageLobby?.allowed).toBe(
        allowed,
      )
    }
    expect(
      parseMeetingCapabilities({hangUpForEveryone: {}, manageLobby: {allowed: "true"}})?.manageLobby?.allowed,
    ).toBeNull()
  })

  test("getState preserves provider termination details", async () => {
    const endReason = {code: 404, subcode: 8543}
    const {session} = mockSession(async () => ({state: "error", muted: false, endReason}))
    const meeting = new MeetingModule(session)
    expect((await meeting.getState()).endReason).toEqual(endReason)
    expect(meeting.state.endReason).toEqual(endReason)
  })

  test("end reason parsing retains valid fields without coercing malformed codes", () => {
    expect(parseMeetingEndReason({code: 0, subcode: 8543, message: "ended", extra: true})).toEqual({
      code: 0,
      subcode: 8543,
      message: "ended",
    })
    expect(parseMeetingEndReason({code: NaN, subcode: Infinity, message: "ended"})).toEqual({message: "ended"})
    for (const raw of [undefined, null, "404", {}, {code: "404", subcode: false, message: ""}]) {
      expect(parseMeetingEndReason(raw)).toBeUndefined()
    }
  })

  test("join sends MEETING_JOIN and maps NOT_IMPLEMENTED to an update-app error", async () => {
    const {session} = mockSession(async () => {
      throw {code: MiniappErrorCode.NOT_IMPLEMENTED, message: "Unknown or unimplemented request type"}
    })
    const meeting = new MeetingModule(session)
    await expect(meeting.join(joinArgs)).rejects.toEqual({
      code: MiniappErrorCode.NOT_IMPLEMENTED,
      message: MEETING_HOST_UPDATE_MESSAGE,
    })
  })

  test("join forwards provider, WHEP source, and token", async () => {
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return {state: "connecting", muted: false, provider: "acs-teams"}
    })
    const meeting = new MeetingModule(session)
    await expect(meeting.join(joinArgs)).resolves.toMatchObject({state: "connecting", muted: false})
    expect(calls).toEqual([
      {
        type: MiniappRequestType.MEETING_JOIN,
        provider: "acs-teams",
        meetingUrl: joinArgs.meetingUrl,
        videoSource: joinArgs.videoSource,
        token: "guest-token",
        displayName: "Mentra",
      },
    ])
  })

  test("join forwards optional ACS outgoing video", async () => {
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return {state: "connecting", muted: false, provider: "acs-teams"}
    })
    const meeting = new MeetingModule(session)
    const video = {width: 960, height: 540, fps: 30, maxBitrateBps: 1_500_000}
    await meeting.join({...joinArgs, video})
    expect(calls[0]).toMatchObject({video})
  })

  test("join forwards a bare SoftAP source without inventing a URL", async () => {
    // The host produces the URL by binding a listener, so the miniapp must not be required to
    // supply one — and must not have one filled in on its behalf.
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return {state: "connecting", muted: false, provider: "acs-teams"}
    })
    const meeting = new MeetingModule(session)

    await meeting.join({...joinArgs, videoSource: {type: "softap"}})

    expect(calls[0]).toMatchObject({videoSource: {type: "softap"}})
    expect(calls[0]).not.toHaveProperty("videoSource.url")
  })

  test("join forwards SoftAP credentials when the miniapp already started the hotspot", async () => {
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return {state: "connecting", muted: false, provider: "acs-teams"}
    })
    const meeting = new MeetingModule(session)

    await meeting.join({
      ...joinArgs,
      videoSource: {type: "softap", ssid: "MentraLive-1234", passphrase: "hunter2!"},
    })

    expect(calls[0]).toMatchObject({
      videoSource: {type: "softap", ssid: "MentraLive-1234", passphrase: "hunter2!"},
    })
  })

  test("join rejects an unknown transport instead of falling back to WHEP", async () => {
    // Silently downgrading a requested transport is how a call ends up with unexplained latency.
    const {session} = mockSession(async () => ({state: "connecting", muted: false}))
    const meeting = new MeetingModule(session)

    await expect(meeting.join({...joinArgs, videoSource: {type: "quic"} as never})).rejects.toMatchObject({
      code: MiniappErrorCode.INVALID_ARGUMENT,
    })
  })

  test("join rejects a WHEP source with no URL", async () => {
    const {session} = mockSession(async () => ({state: "connecting", muted: false}))
    const meeting = new MeetingModule(session)

    await expect(meeting.join({...joinArgs, videoSource: {type: "whep", url: "  "}})).rejects.toMatchObject({
      code: MiniappErrorCode.INVALID_ARGUMENT,
    })
  })

  test("updateVideoSource refuses a SoftAP source rather than doing nothing", async () => {
    // There is no URL for the caller to change, so accepting this would be a silent no-op while
    // the miniapp believes it repaired the feed.
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return null
    })
    const meeting = new MeetingModule(session)

    await expect(meeting.updateVideoSource({type: "softap"} as never)).rejects.toMatchObject({
      code: MiniappErrorCode.INVALID_ARGUMENT,
    })
    expect(calls).toEqual([])
  })

  test("updateVideoSource and getState hit the host APIs", async () => {
    const calls: unknown[] = []
    const {session} = mockSession(async (payload) => {
      calls.push(payload)
      return {state: "connected", muted: true}
    })
    const meeting = new MeetingModule(session)
    await meeting.updateVideoSource({type: "whep", url: "https://example.test/whep-2"})
    await expect(meeting.getState()).resolves.toMatchObject({state: "connected", muted: true})
    expect(calls[0]).toEqual({
      type: MiniappRequestType.MEETING_UPDATE_VIDEO_SOURCE,
      videoSource: {type: "whep", url: "https://example.test/whep-2"},
    })
    expect(calls[1]).toEqual({type: MiniappRequestType.MEETING_GET_STATE})
  })

  test("applies audioSource, activeStream, and audioSafety from host state", async () => {
    const {session} = mockSession(async () => ({
      state: "connected",
      muted: false,
      provider: "acs-teams",
      audioSource: "phone",
      audioSourceReason: "explicit",
      activeStream: "local",
      audioSafety: "safe",
    }))
    const meeting = new MeetingModule(session)
    await meeting.getState()
    expect(meeting.state).toMatchObject({
      audioSource: "phone",
      audioSourceReason: "explicit",
      activeStream: "local",
      audioSafety: "safe",
    })
  })

  test("applies mediaSource from host state", async () => {
    const {session} = mockSession(async () => ({
      state: "connected",
      muted: false,
      provider: "acs-teams",
      mediaSource: "connecting",
    }))
    const meeting = new MeetingModule(session)
    await meeting.getState()
    expect(meeting.state.mediaSource).toBe("connecting")
  })

  test("mediaSource an older host omits, or reports unknown, reads as undefined", () => {
    expect(parseMeetingMediaSource("live")).toBe("live")
    expect(parseMeetingMediaSource("failed")).toBe("failed")
    // A host that never reports it must not be read as "not live".
    expect(parseMeetingMediaSource(undefined)).toBeUndefined()
    expect(parseMeetingMediaSource("subscribing")).toBeUndefined()
    expect(parseMeetingMediaSource(null)).toBeUndefined()
    expect(parseMeetingMediaSource(3)).toBeUndefined()
  })

  test("applies the SoftAP checklist from host state", async () => {
    const {session} = mockSession(async () => ({
      state: "connecting",
      muted: false,
      provider: "acs-teams",
      softap: {
        traceId: "t-1",
        phase: "starting",
        elapsedMs: 4200,
        steps: [
          {step: "hotspot", status: "done", detail: "Hotspot MentraLive_38f108", durationMs: 3500},
          {step: "scopedJoin", status: "running", detail: "Phone joining MentraLive_38f108"},
          {step: "acsJoin", status: "pending"},
          {step: "publish", status: "pending"},
          {step: "live", status: "pending"},
        ],
      },
    }))
    const meeting = new MeetingModule(session)
    await meeting.getState()
    expect(meeting.state.softap).toEqual({
      traceId: "t-1",
      phase: "starting",
      elapsedMs: 4200,
      steps: [
        {step: "hotspot", status: "done", detail: "Hotspot MentraLive_38f108", error: undefined, durationMs: 3500},
        {
          step: "scopedJoin",
          status: "running",
          detail: "Phone joining MentraLive_38f108",
          error: undefined,
          durationMs: undefined,
        },
        {step: "acsJoin", status: "pending", detail: undefined, error: undefined, durationMs: undefined},
        {step: "publish", status: "pending", detail: undefined, error: undefined, durationMs: undefined},
        {step: "live", status: "pending", detail: undefined, error: undefined, durationMs: undefined},
      ],
    })
  })

  test("applies SoftAP recovery from host state and keeps it when a later event omits it", async () => {
    const recovery = {active: true, generation: 2, deadlineAt: 1_700_000_000_000, phase: "waiting-ble"}
    const {session} = mockSession(async () => ({state: "connected", muted: false, recovery}))
    const meeting = new MeetingModule(session)
    expect((await meeting.getState()).recovery).toEqual(recovery)
    const {session: omitted} = mockSession(async () => ({state: "connected", muted: false}))
    const kept = new MeetingModule(omitted)
    kept._applyState({state: "connected", muted: false, recovery})
    kept._applyState({state: "connected", muted: false})
    expect(kept.state.recovery).toEqual(recovery)
  })

  test("recovery parse is tolerant: malformed payloads read as absent", () => {
    expect(parseMeetingRecovery(undefined)).toBeUndefined()
    expect(parseMeetingRecovery(null)).toBeUndefined()
    expect(parseMeetingRecovery({generation: 1})).toBeUndefined()
    expect(parseMeetingRecovery({active: true, generation: 1})).toEqual({active: true, generation: 1})
    expect(parseMeetingRecovery({active: false})).toEqual({active: false})
  })

  test("SoftAP checklist parse is tolerant: unknown steps drop, malformed payloads read as absent", () => {
    expect(parseMeetingSoftApProgress(undefined)).toBeUndefined()
    expect(parseMeetingSoftApProgress(null)).toBeUndefined()
    expect(parseMeetingSoftApProgress("starting")).toBeUndefined()
    expect(parseMeetingSoftApProgress({phase: "warp", steps: []})).toBeUndefined()
    expect(parseMeetingSoftApProgress({phase: "failed", steps: "nope"})).toBeUndefined()
    expect(
      parseMeetingSoftApProgress({
        phase: "recovering",
        elapsedMs: 1200,
        traceId: "gen-2",
        steps: [{step: "hotspot", status: "running"}],
      })?.phase,
    ).toBe("recovering")
    expect(
      parseMeetingSoftApProgress({
        phase: "failed",
        elapsedMs: "soon",
        steps: [
          {step: "hotspot", status: "done"},
          {step: "teleport", status: "done"},
          {step: "publish", status: "failed", error: "WHIP request failed: connect timeout"},
          null,
          {step: "live", status: "later"},
        ],
      }),
    ).toEqual({
      traceId: undefined,
      phase: "failed",
      elapsedMs: 0,
      steps: [
        {step: "hotspot", status: "done", detail: undefined, error: undefined, durationMs: undefined},
        {
          step: "publish",
          status: "failed",
          detail: undefined,
          error: "WHIP request failed: connect timeout",
          durationMs: undefined,
        },
      ],
    })
  })
})

describe("validateMeetingVideoSource", () => {
  test("narrows a WHEP source and trims its URL", () => {
    expect(validateMeetingVideoSource({type: "whep", url: " https://example.test/whep "})).toEqual({
      type: "whep",
      url: "https://example.test/whep",
    })
  })

  test("accepts a bare SoftAP source", () => {
    expect(validateMeetingVideoSource({type: "softap"})).toEqual({type: "softap"})
  })

  test("drops unrelated fields from a SoftAP source", () => {
    // Anything extra would be forwarded to the host and read as configuration it does not have.
    expect(validateMeetingVideoSource({type: "softap", url: "https://nope.test"})).toEqual({
      type: "softap",
    })
  })

  test("rejects half a credential pair", () => {
    // Only one of the two would present as a failed hotspot join seconds later, far from the cause.
    expect(() => validateMeetingVideoSource({type: "softap", ssid: "MentraLive-1"})).toThrow()
    expect(() => validateMeetingVideoSource({type: "softap", passphrase: "hunter2!"})).toThrow()
  })

  test("rejects missing, empty and unknown sources", () => {
    for (const input of [undefined, null, {}, {type: ""}, {type: "direct"}, "whep", 7]) {
      expect(() => validateMeetingVideoSource(input)).toThrow()
    }
  })

  test("rejects a WHEP source whose URL is absent or blank", () => {
    expect(() => validateMeetingVideoSource({type: "whep"})).toThrow()
    expect(() => validateMeetingVideoSource({type: "whep", url: ""})).toThrow()
    expect(() => validateMeetingVideoSource({type: "whep", url: "   "})).toThrow()
  })

  test("rejects a non-string URL rather than coercing it", () => {
    expect(() => validateMeetingVideoSource({type: "whep", url: 42})).toThrow()
  })
})

describe("host-owned meeting identity", () => {
  test("joins without exposing a credential to the miniapp and retains the host identity", async () => {
    const sent: unknown[] = []
    const {session} = mockSession(async (payload) => {
      sent.push(payload)
      return {state: "connected", muted: false, identityMode: "guest", guestReason: "teams-license-unavailable"}
    })
    const {token: _token, ...options} = joinArgs
    const meeting = new MeetingModule(session)
    expect(await meeting.join(options)).toMatchObject({identityMode: "guest", guestReason: "teams-license-unavailable"})
    expect(sent[0]).not.toHaveProperty("token")
    expect(meeting.state).not.toHaveProperty("token")
    expect(await meeting.getState()).toMatchObject({identityMode: "guest", guestReason: "teams-license-unavailable"})
  })
  test("asks the host for policy before choosing backend-dependent features", async () => {
    const sent: unknown[] = []
    const config = {enabled: true, credentialSource: "runtime", externalBackendAllowed: false, managedStreams: false}
    const {session} = mockSession(async (payload) => {
      sent.push(payload)
      return config
    })
    expect(await new MeetingModule(session).getConfiguration()).toEqual(config)
    expect(sent).toEqual([{type: MiniappRequestType.MEETING_GET_CONFIGURATION}])
  })
})
