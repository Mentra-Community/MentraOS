/// <reference types="bun-types" />
import {describe, expect, test} from "bun:test"

import {MiniappErrorCode, MiniappRequestType} from "../protocol"
import type {MiniappSession} from "../session"
import {MEETING_HOST_UPDATE_MESSAGE, MeetingModule} from "./meeting"

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
})
