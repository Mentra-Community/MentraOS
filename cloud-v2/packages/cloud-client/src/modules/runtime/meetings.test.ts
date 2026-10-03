import {describe, expect, test} from "bun:test"
import {createHttpClient} from "../../http"
import {noopLogger} from "../../logger"
import {Meetings} from "./meetings"

const guest = {token: "acs", identityMode: "guest" as const, acsUserId: "user", expiresOn: "2030-01-01"}
function fixture(response: object, status = 200) {
  const calls: {url: string; init?: RequestInit}[] = []
  const meetings = new Meetings(
    createHttpClient({
      baseUrl: "https://private.example/runtime",
      getToken: async () => "core-brokered-runtime-token",
      logger: noopLogger,
      fetch: async (url, init) => {
        calls.push({url: String(url), init})
        return Response.json(response, {status})
      },
    }),
  )
  return {meetings, calls}
}

describe("Runtime meeting credentials", () => {
  test("uses the selected Runtime and its bearer independently of the realtime session", async () => {
    const {meetings, calls} = fixture(guest)
    expect(await meetings.getAcsCredential()).toEqual(guest)
    expect(calls[0].url).toBe("https://private.example/runtime/api/meetings/acs/token")
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer core-brokered-runtime-token")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({})
  })
  test("accepts the employee credential and forwards the host-only subject", async () => {
    const {meetings, calls} = fixture({...guest, identityMode: "teams-user"})
    expect((await meetings.getAcsCredential("entra")).identityMode).toBe("teams-user")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({teamsUserAadToken: "entra"})
  })
  test("requires a specific reason before accepting a guest for an employee request", async () => {
    await expect(fixture(guest).meetings.getAcsCredential("entra")).rejects.toThrow("invalid")
    expect(
      (await fixture({...guest, guestReason: "teams-license-unavailable"}).meetings.getAcsCredential("entra"))
        .guestReason,
    ).toBe("teams-license-unavailable")
  })
  test("rejects expired or malformed credentials", async () => {
    for (const response of [
      {...guest, token: ""},
      {...guest, expiresOn: "2000-01-01"},
      {...guest, identityMode: "unknown"},
      {...guest, acsUserId: ""},
    ]) {
      await expect(fixture(response).meetings.getAcsCredential()).rejects.toThrow("invalid")
    }
  })
})

describe("Runtime meeting creation", () => {
  const created = {
    provider: "acs-teams",
    joinUrl: "https://teams.microsoft.com/meet/123?p=test",
    meetingRef: "opaque-owner-reference",
    identityMode: "guest",
    guestReason: "no-entra-identity",
  } as const
  test.each([
    [403, "Teams token verification failed"],
    [503, "Teams meeting creation is not configured on this Runtime"],
  ])("surfaces Runtime's error detail for HTTP %s", async (status, message) => {
    const {meetings, calls} = fixture({error: "meeting_error", message}, status)
    await expect(meetings.createTeamsMeeting({})).rejects.toThrow(message)
    expect(calls).toHaveLength(1)
  })
  test("uses the selected Runtime, preserves identity metadata, and strips unexpected fields", async () => {
    const {meetings, calls} = fixture({...created, token: "must-stay-host-only"})
    expect(await meetings.createTeamsMeeting({subject: "Standup", durationMinutes: 20})).toEqual(created)
    expect(calls[0].url).toBe("https://private.example/runtime/api/meetings/teams/create")
    expect(new Headers(calls[0].init?.headers).get("Authorization")).toBe("Bearer core-brokered-runtime-token")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({subject: "Standup", durationMinutes: 20})
  })
  test("forwards the host subject and accepts only the specific license fallback", async () => {
    const result = {...created, guestReason: "teams-license-unavailable" as const}
    const {meetings, calls} = fixture(result)
    expect(await meetings.createTeamsMeeting({}, "entra")).toEqual(result)
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({teamsUserAadToken: "entra"})
    await expect(fixture(created).meetings.createTeamsMeeting({}, "entra")).rejects.toThrow("invalid")
    expect(await fixture({...created, identityMode: "teams-user"}).meetings.createTeamsMeeting({}, "entra")).toEqual({
      provider: created.provider,
      joinUrl: created.joinUrl,
      meetingRef: created.meetingRef,
      identityMode: "teams-user",
    })
  })
  test("rejects unexpected URLs, missing ownership, and identity mismatches", async () => {
    for (const response of [
      {...created, joinUrl: "https://teams.microsoft.com.evil.example/meeting"},
      {...created, joinUrl: "https://teams.microsoft.com@evil.example/meeting"},
      {...created, meetingRef: ""},
      {...created, identityMode: "teams-user"},
      {...created, guestReason: "unknown"},
    ])
      await expect(fixture(response).meetings.createTeamsMeeting({})).rejects.toThrow("invalid")
  })
  test("retires using only the opaque ownership reference", async () => {
    const {meetings, calls} = fixture({})
    await meetings.retireTeamsMeeting(created.meetingRef)
    expect(calls[0].url).toBe("https://private.example/runtime/api/meetings/teams/retire")
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({meetingRef: created.meetingRef})
  })
  test("does not retry a creation POST after an ambiguous failure", async () => {
    let calls = 0
    const meetings = new Meetings(
      createHttpClient({
        baseUrl: "https://private.example/runtime",
        getToken: async () => "token",
        logger: noopLogger,
        fetch: async () => {
          calls++
          throw new Error("connection closed after request")
        },
      }),
    )
    await expect(meetings.createTeamsMeeting({})).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
