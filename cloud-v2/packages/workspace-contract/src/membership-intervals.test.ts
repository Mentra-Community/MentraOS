import {describe, expect, test} from "bun:test"
import {CoreWorkspaceClientError, createCoreWorkspaceClient} from "./client"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import {
  CLIENT_WORKSPACE_ERRORS,
  INVITATION_DECLINED_ACTION,
  type MembershipInterval,
  type MembershipIntervalsResponse,
} from "./types"

const SECRET = "client-secret"
const BASE = "https://core.test"

function clientFor(handler: (url: string) => unknown, status = 200) {
  const calls: Array<{url: string; method: string; headers: Headers}> = []
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({url: String(input), method: init.method ?? "GET", headers: new Headers(init.headers)})
    return new Response(JSON.stringify(handler(String(input))), {
      status,
      headers: {"content-type": "application/json"},
    })
  }
  const client = createCoreWorkspaceClient({
    baseUrl: BASE,
    service: "fleet",
    secret: SECRET,
    fetch: fetchImpl as unknown as typeof fetch,
  })
  return {client, calls}
}

const open = (overrides: Partial<MembershipInterval> = {}): MembershipInterval => {
  const interval = {
    membershipId: "wm_1",
    workspaceId: "ws_1",
    mentraUserId: "mu_1",
    role: "member" as const,
    start: "2026-01-02T03:04:05.000Z",
    end: null,
    endReason: null,
    ...overrides,
  }
  return {roles: [{role: interval.role, start: interval.start, end: interval.end}], ...interval}
}

const page = (overrides: Partial<MembershipIntervalsResponse> = {}): MembershipIntervalsResponse => ({
  lookbackDays: 120,
  windowStart: "2026-06-23T00:00:00.000Z",
  feedSeq: 412,
  intervals: [open(), open({membershipId: "wm_2", end: "2026-09-01T10:00:00.000Z", endReason: "left"})],
  next: null,
  ...overrides,
})

async function expectBadResponse(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CoreWorkspaceClientError)
  expect((error as CoreWorkspaceClientError).code).toBe("bad_response")
}

describe("listMembershipIntervals", () => {
  test("reads a page, signed over the exact path and query", async () => {
    const body = page({next: "cursor-2"})
    const {client, calls} = clientFor(() => body)

    expect(await client.listMembershipIntervals({after: "cursor-1", limit: 200})).toEqual(body)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url).toBe(`${BASE}/api/internal/workspaces/membership-intervals?after=cursor-1&limit=200`)
    const url = new URL(calls[0]!.url)
    expect(
      verifyServiceRequest({
        secrets: [SECRET],
        method: "GET",
        pathWithQuery: `${url.pathname}${url.search}`,
        body: "",
        timestampMs: Number(calls[0]!.headers.get(SERVICE_HEADERS.timestamp)),
        signature: calls[0]!.headers.get(SERVICE_HEADERS.signature) ?? "",
        nowMs: Date.now(),
      }),
    ).toBe(true)
  })

  test("no cursor starts from the beginning and sends nothing it was not given", async () => {
    const {client, calls} = clientFor(() => page())
    await client.listMembershipIntervals({})
    await client.listMembershipIntervals({after: null})
    expect(calls.map(call => call.url.slice(BASE.length))).toEqual([
      "/api/internal/workspaces/membership-intervals",
      "/api/internal/workspaces/membership-intervals",
    ])
  })

  test("returns an open interval older than the lookback with its real start and no end", async () => {
    const old = open({start: "2025-01-01T00:00:00.000Z"})
    const {client} = clientFor(() => page({intervals: [old]}))
    const result = await client.listMembershipIntervals({})
    expect(result.intervals).toEqual([old])
    expect(Date.parse(result.intervals[0]!.start)).toBeLessThan(Date.parse(result.windowStart))
    expect(result.intervals[0]!.end).toBeNull()
  })

  test("returns the role intervals inside each membership interval", async () => {
    const promoted = open({
      role: "admin",
      roles: [
        {role: "member", start: "2026-01-02T03:04:05.000Z", end: "2026-02-01T00:00:00.000Z"},
        {role: "admin", start: "2026-02-01T00:00:00.000Z", end: null},
      ],
    })
    const left = open({
      membershipId: "wm_2",
      role: "member",
      end: "2026-09-01T00:00:00.000Z",
      endReason: "left",
      roles: [
        {role: "developer", start: "2026-01-02T03:04:05.000Z", end: "2026-03-01T00:00:00.000Z"},
        {role: "member", start: "2026-03-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z"},
      ],
    })
    const {client} = clientFor(() => page({intervals: [promoted, left]}))
    expect((await client.listMembershipIntervals({})).intervals).toEqual([promoted, left])
  })

  test("accepts every end reason", async () => {
    for (const endReason of ["left", "removed", "workspace_deleted", "account_deleted"] as const) {
      const {client} = clientFor(() => page({intervals: [open({end: "2026-09-01T00:00:00.000Z", endReason})]}))
      expect((await client.listMembershipIntervals({})).intervals[0]!.endReason).toBe(endReason)
    }
  })

  test("refuses a response that is not the documented shape", async () => {
    const bad: unknown[] = [
      {...page(), lookbackDays: 0},
      {...page(), lookbackDays: "90"},
      {...page(), windowStart: "not a time"},
      {...page(), feedSeq: -1},
      {...page(), intervals: "none"},
      {...page(), next: 5},
      {...page(), next: ""},
      page({intervals: [open({mentraUserId: ""})]}),
      page({intervals: [open({start: "nope"})]}),
      page({intervals: [open({endReason: "left"})]}),
      page({intervals: [open({end: "2026-09-01T00:00:00.000Z", endReason: null})]}),
      page({intervals: [open({end: "2026-09-01T00:00:00.000Z", endReason: "evicted" as never})]}),
      page({intervals: [open({start: "2026-09-02T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z", endReason: "left"})]}),
      page({intervals: [open({roles: []})]}),
      page({intervals: [{...open(), roles: undefined as never}]}),
      page({intervals: [open({roles: [{role: "boss" as never, start: "2026-01-02T03:04:05.000Z", end: null}]})]}),
      page({intervals: [open({roles: [{role: "member", start: "2025-12-01T00:00:00.000Z", end: null}]})]}),
      page({intervals: [open({roles: [{role: "member", start: "2026-01-02T03:04:05.000Z", end: "2026-02-01T00:00:00.000Z"}]})]}),
      page({
        intervals: [
          open({
            roles: [
              {role: "member", start: "2026-01-02T03:04:05.000Z", end: null},
              {role: "admin", start: "2026-02-01T00:00:00.000Z", end: null},
            ],
          }),
        ],
      }),
      page({
        intervals: [
          open({
            end: "2026-03-01T00:00:00.000Z",
            endReason: "left",
            roles: [{role: "member", start: "2026-01-02T03:04:05.000Z", end: "2026-04-01T00:00:00.000Z"}],
          }),
        ],
      }),
      [],
    ]
    for (const body of bad) {
      const {client} = clientFor(() => body)
      await expectBadResponse(client.listMembershipIntervals({}))
    }
  })

  test("an interval never ends with the retired reasons", async () => {
    for (const endReason of ["replaced", "user_deleted"]) {
      const {client} = clientFor(() =>
        page({intervals: [open({end: "2026-09-01T00:00:00.000Z", endReason: endReason as never})]}),
      )
      await expectBadResponse(client.listMembershipIntervals({}))
    }
  })

  test("a 403 (a service that may not read history) is forbidden, and a 5xx is core_unavailable", async () => {
    const forbidden = clientFor(() => ({error: "forbidden"}), 403)
    const err = await forbidden.client.listMembershipIntervals({}).catch((e: unknown) => e)
    expect((err as CoreWorkspaceClientError).code).toBe("forbidden")
    const down = clientFor(() => ({error: "boom"}), 503)
    const err2 = await down.client.listMembershipIntervals({}).catch((e: unknown) => e)
    expect((err2 as CoreWorkspaceClientError).code).toBe("core_unavailable")
  })
})

describe("client workspace contract constants", () => {
  test("the decline action is the change-feed name W1 emits", () => {
    expect(INVITATION_DECLINED_ACTION).toBe("invitation.declined")
  })

  test("the codes the Mentra App maps to words", () => {
    expect(CLIENT_WORKSPACE_ERRORS).toEqual({
      alreadyInWorkspace: "already_in_workspace",
      lastOwner: "last_owner",
      invitationExpired: "invitation_expired",
      invitationNotFound: "invitation_not_found",
      emailUnverified: "email_unverified",
      membershipChanged: "membership_changed",
    })
  })
})

describe("listWorkspaceMembers", () => {
  const member = (overrides: Record<string, unknown> = {}) => ({
    membershipId: "wm_1",
    mentraUserId: "mu_1",
    email: "a@example.test",
    name: "Ada",
    role: "member" as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    pending: false,
    ...overrides,
  })

  test("reads the workspace's members from its own path, signed", async () => {
    const body = {members: [member(), member({membershipId: "wm_2", name: null, pending: true, mentraUserId: null})]}
    const {client, calls} = clientFor(() => body)
    expect(await client.listWorkspaceMembers("ws_1")).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/api/internal/workspaces/workspaces/ws_1/members`)
    expect(calls[0]!.headers.get(SERVICE_HEADERS.signature)).toBeTruthy()
  })

  test("a server that predates names is accepted: name is optional", async () => {
    const {name: _name, ...bare} = member()
    const {client} = clientFor(() => ({members: [bare]}))
    expect((await client.listWorkspaceMembers("ws_1")).members).toHaveLength(1)
  })

  test("refuses a response that is not a member list", async () => {
    for (const body of [{}, {members: "none"}, {members: [member({role: ""})]}, {members: [member({name: 5})]}, {members: [member({email: 7})]}, {members: [{}]}]) {
      const {client} = clientFor(() => body)
      await expectBadResponse(client.listWorkspaceMembers("ws_1"))
    }
  })

  test("an id is encoded into the path", async () => {
    const {client, calls} = clientFor(() => ({members: []}))
    await client.listWorkspaceMembers("a/b")
    expect(calls[0]!.url).toBe(`${BASE}/api/internal/workspaces/workspaces/a%2Fb/members`)
  })
})
