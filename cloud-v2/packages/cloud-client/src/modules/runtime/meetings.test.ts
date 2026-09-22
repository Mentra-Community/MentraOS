import {describe, expect, test} from "bun:test"
import {createHttpClient} from "../../http"
import {noopLogger} from "../../logger"
import {Meetings} from "./meetings"

const guest = {token: "acs", identityMode: "guest" as const, acsUserId: "user", expiresOn: "2030-01-01"}
function fixture(response: object) {
  const calls: {url: string; init?: RequestInit}[] = []
  const meetings = new Meetings(
    createHttpClient({
      baseUrl: "https://private.example/runtime",
      getToken: async () => "core-brokered-runtime-token",
      logger: noopLogger,
      fetch: async (url, init) => {
        calls.push({url: String(url), init})
        return Response.json(response)
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
