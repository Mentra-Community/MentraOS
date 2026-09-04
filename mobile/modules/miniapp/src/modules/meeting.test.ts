/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {
  MEETING_HOST_UPDATE_MESSAGE,
  MeetingModule,
  parseMeetingMediaSource,
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

    await expect(
      meeting.join({...joinArgs, videoSource: {type: "quic"} as never}),
    ).rejects.toMatchObject({code: MiniappErrorCode.INVALID_ARGUMENT})
  })

  test("join rejects a WHEP source with no URL", async () => {
    const {session} = mockSession(async () => ({state: "connecting", muted: false}))
    const meeting = new MeetingModule(session)

    await expect(
      meeting.join({...joinArgs, videoSource: {type: "whep", url: "  "}}),
    ).rejects.toMatchObject({code: MiniappErrorCode.INVALID_ARGUMENT})
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

    await expect(
      meeting.updateVideoSource({type: "softap"} as never),
    ).rejects.toMatchObject({code: MiniappErrorCode.INVALID_ARGUMENT})
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
