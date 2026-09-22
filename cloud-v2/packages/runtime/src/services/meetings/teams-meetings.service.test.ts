import {afterEach, beforeEach, describe, expect, test} from "bun:test"
import {resetAcsTeamsAuthCache, setAcsIdentityClientForTests} from "./acs-teams.service"
import {createTeamsMeeting, resetTeamsMeetingStateForTests, retireTeamsMeeting} from "./teams-meetings.service"

const fetchBefore = globalThis.fetch
const saved = new Map<string, string | undefined>()
let exchangeError: unknown
let graphStatus: number
let requests: Array<{url: string; method?: string; body?: unknown}>
const subject = {tenantId: "tenant", objectId: "employee", token: "verified-teams-token"}
const create = (employee = false, actor = "caller") =>
  createTeamsMeeting({
    actor,
    title: "Daily standup",
    durationMinutes: 30,
    ...(employee ? {subject} : {}),
  })

beforeEach(() => {
  for (const [key, value] of Object.entries({
    ACS_CONNECTION_STRING: "endpoint=https://test.communication.azure.com/;accesskey=test",
    ENTRA_TENANT_ID: "tenant",
    ENTRA_CLIENT_ID: "mobile-client",
    TEAMS_GRAPH_TENANT_ID: "tenant",
    TEAMS_GRAPH_CLIENT_ID: "graph-app",
    TEAMS_GRAPH_CLIENT_SECRET: "graph-secret",
    TEAMS_GRAPH_ORGANIZER_ID: "fallback-organizer",
  })) {
    saved.set(key, process.env[key])
    process.env[key] = value
  }
  exchangeError = undefined
  graphStatus = 200
  requests = []
  resetTeamsMeetingStateForTests()
  setAcsIdentityClientForTests({
    async getTokenForTeamsUser() {
      if (exchangeError) throw exchangeError
      return {token: "employee-acs-token", expiresOn: new Date("2030-01-01")}
    },
    async createUserAndToken() {
      throw new Error("Creation must not mint a guest ACS user")
    },
  })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    requests.push({url, method: init?.method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined})
    if (url.startsWith("https://login.microsoftonline.com/")) {
      expect(init?.body).toBeInstanceOf(URLSearchParams)
      expect((init?.body as URLSearchParams).get("scope")).toBe("https://graph.microsoft.com/.default")
      return Response.json({access_token: "graph-token", expires_in: 3600})
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer graph-token")
    if (graphStatus !== 200) return Response.json({error: {code: "provider-error"}}, {status: graphStatus})
    if (init?.method === "DELETE") return new Response(null, {status: 204})
    return Response.json({id: "meeting/id", joinWebUrl: "https://teams.microsoft.com/meet/123456?p=secret"})
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = fetchBefore
  resetTeamsMeetingStateForTests()
  resetAcsTeamsAuthCache()
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
})

describe("Runtime Teams meeting creation", () => {
  test("uses the configured organizer without Entra and returns only public meeting data", async () => {
    const result = await create()
    expect(result).toMatchObject({provider: "acs-teams", identityMode: "guest", guestReason: "no-entra-identity"})
    expect(Object.keys(result).sort()).toEqual(["guestReason", "identityMode", "joinUrl", "meetingRef", "provider"])
    expect(requests.at(-1)?.url).toEndWith("/users/fallback-organizer/onlineMeetings")
    expect(requests.at(-1)?.body).toMatchObject({subject: "Daily standup", lobbyBypassSettings: {scope: "everyone"}})
    expect(JSON.stringify(result)).not.toContain("graph-secret")
  })
  test("uses the verified licensed employee as organizer", async () => {
    expect(await create(true)).toMatchObject({identityMode: "teams-user"})
    expect(requests.at(-1)?.url).toEndWith("/users/employee/onlineMeetings")
  })
  test("falls back only for the explicit missing Teams license response", async () => {
    exchangeError = {code: "UserLicenseNotPresentForbidden"}
    expect(await create(true)).toMatchObject({identityMode: "guest", guestReason: "teams-license-unavailable"})
    expect(requests.at(-1)?.url).toEndWith("/users/fallback-organizer/onlineMeetings")
  })
  for (const error of [{code: "Forbidden"}, {code: "Unauthorized"}, {code: "TooManyRequests"}, new Error("network")]) {
    test(`does not create with the fallback organizer after ${JSON.stringify(error)}`, async () => {
      exchangeError = error
      await expect(create(true)).rejects.toBe(error)
      expect(requests).toEqual([])
    })
  }
  test("rejects an employee from a different Graph tenant before any provider call", async () => {
    process.env.TEAMS_GRAPH_TENANT_ID = "different-tenant"
    await expect(create(true)).rejects.toMatchObject({status: 403})
    expect(requests).toEqual([])
  })
  test("does not fall back when Graph denies the employee access policy", async () => {
    graphStatus = 403
    await expect(create(true)).rejects.toMatchObject({status: 403})
    expect(requests.filter((r) => r.url.includes("graph.microsoft.com"))).toHaveLength(1)
    expect(requests.at(-1)?.url).toEndWith("/users/employee/onlineMeetings")
  })
  test("requires a configured fallback organizer only for guest creation", async () => {
    delete process.env.TEAMS_GRAPH_ORGANIZER_ID
    await expect(create()).rejects.toMatchObject({status: 503})
    expect(requests).toEqual([])
    expect(await create(true)).toMatchObject({identityMode: "teams-user"})
  })
  test("rate limits creation per caller", async () => {
    for (let i = 0; i < 12; i++) await create()
    await expect(create()).rejects.toMatchObject({status: 429})
    expect(await create(false, "other-caller")).toMatchObject({identityMode: "guest"})
  })
})

describe("Runtime Teams retirement ownership", () => {
  test("retires only the meeting encoded in the authenticated caller's receipt", async () => {
    const created = await create(true)
    await retireTeamsMeeting("caller", created.meetingRef)
    expect(requests.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://graph.microsoft.com/v1.0/users/employee/onlineMeetings/meeting%2Fid",
    })
  })
  test("rejects another caller, tampering, and changed Graph tenant", async () => {
    const created = await create()
    const before = requests.length
    await expect(retireTeamsMeeting("other-caller", created.meetingRef)).rejects.toMatchObject({status: 403})
    await expect(retireTeamsMeeting("caller", `x${created.meetingRef}`)).rejects.toMatchObject({status: 403})
    await expect(
      retireTeamsMeeting("caller", `${created.meetingRef.split(".")[0]}.${"é".repeat(43)}`),
    ).rejects.toMatchObject({status: 403})
    process.env.TEAMS_GRAPH_TENANT_ID = "other-tenant"
    await expect(retireTeamsMeeting("caller", created.meetingRef)).rejects.toMatchObject({status: 403})
    expect(requests).toHaveLength(before)
  })
  test("treats an already deleted meeting as retired", async () => {
    const created = await create()
    graphStatus = 404
    await expect(retireTeamsMeeting("caller", created.meetingRef)).resolves.toBeUndefined()
  })
})
