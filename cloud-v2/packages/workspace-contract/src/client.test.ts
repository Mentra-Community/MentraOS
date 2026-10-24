import {describe, expect, test} from "bun:test"
import {CoreWorkspaceClientError, createCoreWorkspaceClient} from "./client"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import {INVALID_TOKEN_ERROR, SERVICE_UNAUTHORIZED_ERROR} from "./types"
import type {WorkspaceRole} from "./capabilities"
import type {LicenseView, LicenseWrite} from "./licenses"
import type {
  AuthorizeResponse,
  DeletionHoldsResponse,
  PrincipalResponse,
  RegistryCheckResult,
  RegistryEntryDetail,
  WorkspaceChangeEvent,
  WorkspaceDeletionHold,
  WorkspaceSummary,
} from "./types"

const SECRET = "client-secret"
const BASE = "https://core.test"

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string
}

type Handler = (request: Recorded, init: RequestInit) => Response | Promise<Response>

function mockFetch(handler: Handler) {
  const calls: Recorded[] = []
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const recorded: Recorded = {
      url: String(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : "",
    }
    calls.push(recorded)
    return handler(recorded, init)
  }
  return {calls, fetch: fetchImpl as unknown as typeof fetch}
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json"}})
}

function clientFor(handler: Handler, overrides: {timeoutMs?: number; baseUrl?: string} = {}) {
  const mock = mockFetch(handler)
  const client = createCoreWorkspaceClient({
    baseUrl: overrides.baseUrl ?? BASE,
    service: "store",
    secret: SECRET,
    fetch: mock.fetch,
    timeoutMs: overrides.timeoutMs,
  })
  return {client, calls: mock.calls}
}

const workspace = (): WorkspaceSummary => ({
  workspaceId: "ws_1",
  name: "Acme",
  status: "active",
  authorizationRevision: 3,
})

const changeEvent = (seq: number, overrides: Partial<WorkspaceChangeEvent> = {}): WorkspaceChangeEvent => ({
  eventId: `01HZ00000000000000000000${seq}`,
  seq,
  workspaceId: "ws_1",
  action: "membership.added",
  occurredAt: "2026-10-13T12:00:00.000Z",
  target: {membershipId: "wm_1", mentraUserId: "mu_1"},
  before: {role: null},
  after: {role: "member"},
  ...overrides,
})

const userPrincipal = () =>
  ({
    kind: "user",
    mentraUserId: "user_1",
    email: "a@example.com",
    emailVerified: true,
    isOrganizationAdmin: false,
  } as const)

const allowed = (): AuthorizeResponse => ({
  allowed: true,
  principal: userPrincipal(),
  workspace: workspace(),
  membership: {membershipId: "mem_1", role: "developer"},
  capabilities: ["workspace.read", "miniapps.access", "miniapps.publish"],
})

async function expectClientError(promise: Promise<unknown>, code: CoreWorkspaceClientError["code"]) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  expect(error).toBeInstanceOf(CoreWorkspaceClientError)
  expect((error as CoreWorkspaceClientError).code).toBe(code)
  return error as CoreWorkspaceClientError
}

describe("request signing", () => {
  test("signs every request with the service headers over the exact path, query and body", async () => {
    const {client, calls} = clientFor((request) => {
      if (request.url.includes("/workspaces/ws%201")) return json(workspace())
      if (request.url.endsWith("/authorize")) return json(allowed())
      return json({})
    })

    const before = Date.now()
    await client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}, workspaceId: "ws_1"})
    await client.getWorkspace("ws 1")
    const after = Date.now()

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/internal/workspaces/authorize`,
      `${BASE}/api/internal/workspaces/workspaces/ws%201`,
    ])
    for (const call of calls) {
      const url = new URL(call.url)
      expect(call.headers.get(SERVICE_HEADERS.service)).toBe("store")
      const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
      expect(timestampMs).toBeGreaterThanOrEqual(before)
      expect(timestampMs).toBeLessThanOrEqual(after)
      expect(
        verifyServiceRequest({
          secrets: [SECRET],
          method: call.method,
          pathWithQuery: `${url.pathname}${url.search}`,
          body: call.body,
          timestampMs,
          signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
          nowMs: timestampMs,
        }),
      ).toBe(true)
    }
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(calls[0].body)).toEqual({
      credential: {type: "mentra_user", mentraUserId: "user_1"},
      workspaceId: "ws_1",
    })
    expect(calls[1].method).toBe("GET")
    expect(calls[1].body).toBe("")
  })

  test("does not verify under another secret", async () => {
    const {client, calls} = clientFor(() => json(workspace()))
    await client.getWorkspace("ws_1")
    const call = calls[0]
    const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
    expect(
      verifyServiceRequest({
        secrets: ["other"],
        method: "GET",
        pathWithQuery: "/api/internal/workspaces/workspaces/ws_1",
        body: "",
        timestampMs,
        signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
        nowMs: timestampMs,
      }),
    ).toBe(false)
  })

  test("tolerates a trailing slash on the base URL", async () => {
    const {client, calls} = clientFor(() => json(workspace()), {baseUrl: `${BASE}/`})
    await client.getWorkspace("ws_1")
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/ws_1`)
  })
})

describe("operations", () => {
  test("authorize returns the decision from Core", async () => {
    const {client} = clientFor(() => json(allowed()))
    const response = await client.authorize({credential: {type: "bearer", token: "t"}, capability: "miniapps.publish"})
    expect(response.allowed).toBe(true)
    expect(response.capabilities).toContain("miniapps.publish")
  })

  test("authorize accepts null workspace and membership when Core has none to report", async () => {
    const {client} = clientFor(() =>
      json({
        allowed: false,
        reason: "workspace_not_found",
        principal: null,
        workspace: null,
        membership: null,
        capabilities: [],
      }),
    )
    const response = await client.authorize({credential: {type: "bearer", token: "t"}, workspaceId: "ws_missing"})
    expect(response.allowed).toBe(false)
    expect(response.workspace).toBeNull()
    expect(response.membership).toBeNull()
    expect(response.principal).toBeNull()
  })

  test("authorize returns a denial with its reason", async () => {
    const denied: AuthorizeResponse = {
      allowed: false,
      reason: "not_a_member",
      principal: userPrincipal(),
      capabilities: [],
    }
    const {client} = clientFor(() => json(denied))
    const response = await client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}})
    expect(response.allowed).toBe(false)
    expect(response.reason).toBe("not_a_member")
  })

  test("resolvePrincipal posts the token and maps an invalid_token 401 to null", async () => {
    const principal: PrincipalResponse = {
      principal: userPrincipal(),
      workspaces: [
        {...workspace(), membership: {membershipId: "mem_1", role: "owner"}, capabilities: ["workspace.read"]},
      ],
    }
    const {client, calls} = clientFor((request) =>
      JSON.parse(request.body).token === "good" ? json(principal) : json({error: "invalid_token"}, 401),
    )
    expect(await client.resolvePrincipal("good")).toEqual(principal)
    expect(await client.resolvePrincipal("bad")).toBeNull()
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/principal`)
    expect(calls[0].method).toBe("POST")
    expect(JSON.parse(calls[0].body)).toEqual({token: "good"})
  })

  test("checkMemberships posts the user and workspaces and returns the map", async () => {
    const memberships = {ws_1: {role: "admin", capabilities: ["workspace.read"]}, ws_2: null}
    const {client, calls} = clientFor(() => json({memberships}))
    expect(await client.checkMemberships("user_1", ["ws_1", "ws_2"])).toEqual(memberships as never)
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/memberships/check`)
    expect(JSON.parse(calls[0].body)).toEqual({mentraUserId: "user_1", workspaceIds: ["ws_1", "ws_2"]})
  })

  test("getWorkspace returns the summary and maps 404 to null", async () => {
    const {client, calls} = clientFor((request) =>
      request.url.endsWith("/ws_1") ? json(workspace()) : json({error: "workspace_not_found"}, 404),
    )
    expect(await client.getWorkspace("ws_1")).toEqual(workspace())
    expect(await client.getWorkspace("missing")).toBeNull()
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/ws_1`)
    expect(calls[0].method).toBe("GET")
  })

  test("getWorkspace reads only a workspace_not_found 404 as absent: any other 404 is an error, not an answer", async () => {
    // A proxy, a wrong base URL or a Core without this API answers 404 too; none of them knows the workspace is gone.
    for (const response of [
      () => json({error: "not_found"}, 404),
      () => json({}, 404),
      () => new Response("Not Found", {status: 404}),
    ]) {
      const {client} = clientFor(response)
      const error = await expectClientError(client.getWorkspace("ws_1"), "bad_request")
      expect(error.status).toBe(404)
    }
  })

  test("getWorkspace escapes the workspace id in the path", async () => {
    const {client, calls} = clientFor(() => json(workspace()))
    await client.getWorkspace("a/b?c")
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/a%2Fb%3Fc`)
  })

  test("mintServiceCredential posts the request and returns the credential once", async () => {
    const {client, calls} = clientFor(() => json({credentialId: "cred_1", token: "msk_dev_x.y"}))
    const input = {
      workspaceId: "ws_1",
      name: "CI",
      packageNames: ["com.example.app"],
      issuedBy: {service: "store", actorEmail: "a@example.com"},
    }
    expect(await client.mintServiceCredential(input)).toEqual({credentialId: "cred_1", token: "msk_dev_x.y"})
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/credentials`)
    expect(JSON.parse(calls[0].body)).toEqual(input)
  })

  test("resolveEmail posts the email, signed like every other call, and maps user_not_found to null", async () => {
    const {client, calls} = clientFor((request) =>
      JSON.parse(request.body).email === "a@example.com"
        ? json({mentraUserId: "user_1"})
        : json({error: "user_not_found"}, 404),
    )
    expect(await client.resolveEmail("a@example.com")).toBe("user_1")
    expect(await client.resolveEmail("nobody@example.com")).toBeNull()
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/users/resolve-email`)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].headers.get(SERVICE_HEADERS.service)).toBe("store")
    expect(
      verifyServiceRequest({
        secrets: [SECRET],
        method: "POST",
        pathWithQuery: "/api/internal/workspaces/users/resolve-email",
        body: calls[0].body,
        timestampMs: Number(calls[0].headers.get(SERVICE_HEADERS.timestamp)),
        signature: calls[0].headers.get(SERVICE_HEADERS.signature)!,
        nowMs: Date.now(),
      }),
    ).toBe(true)
  })

  test("resolveEmail reads only a user_not_found 404 as nobody, and refuses an answer without a user id", async () => {
    for (const response of [() => json({error: "not_found"}, 404), () => new Response("Not Found", {status: 404})]) {
      const {client} = clientFor(response)
      expect((await expectClientError(client.resolveEmail("a@example.com"), "bad_request")).status).toBe(404)
    }
    for (const body of [{}, {mentraUserId: ""}, {mentraUserId: 7}, ["user_1"]]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.resolveEmail("a@example.com"), "bad_response")
    }
  })

  test("listChanges asks for the page after a cursor, signed over the exact query", async () => {
    const page = {events: [changeEvent(8), changeEvent(9)], next: "9"}
    const {client, calls} = clientFor(() => json(page))

    expect(await client.listChanges({after: "7", limit: 2})).toEqual(page)

    expect(calls).toHaveLength(1)
    expect(calls[0]!.method).toBe("GET")
    expect(calls[0]!.url).toBe(`${BASE}/api/internal/workspaces/changes?after=7&limit=2`)
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

  test("listChanges sends only what it is given: no cursor starts from the beginning", async () => {
    const empty = {events: [], next: null}
    const {client, calls} = clientFor(() => json(empty))

    expect(await client.listChanges({})).toEqual(empty)
    expect(await client.listChanges({after: null})).toEqual(empty)
    expect(await client.listChanges({after: "0"})).toEqual(empty)
    expect(await client.listChanges({limit: 500})).toEqual(empty)

    expect(calls.map(call => call.url.slice(BASE.length))).toEqual([
      "/api/internal/workspaces/changes",
      "/api/internal/workspaces/changes",
      "/api/internal/workspaces/changes?after=0",
      "/api/internal/workspaces/changes?limit=500",
    ])
  })

  test("listChanges returns an event as Core sent it, tombstones with no workspace and null snapshots included", async () => {
    const tombstone = changeEvent(10, {
      workspaceId: null,
      action: "user.deleted",
      target: {mentraUserId: "mu_gone"},
      before: null,
      after: null,
    })
    const unknownAction = changeEvent(11, {action: "something.new", target: null})
    const {client} = clientFor(() => json({events: [tombstone, unknownAction], next: null}))

    expect(await client.listChanges({after: "9"})).toEqual({events: [tombstone, unknownAction], next: null})
  })
})

describe("response shape", () => {
  const mint = {
    workspaceId: "ws_1",
    name: "CI",
    packageNames: [],
    issuedBy: {service: "store", actorEmail: "a@example.com"},
  }

  test("rejects an authorize response without its decision or capabilities", async () => {
    const {allowed: _allowed, ...withoutDecision} = allowed()
    const {capabilities: _capabilities, ...withoutCapabilities} = allowed()
    for (const body of [withoutDecision, withoutCapabilities, [allowed()]]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(
        client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
        "bad_response",
      )
    }
  })

  test("rejects an authorize response whose nested principal or workspace is malformed", async () => {
    const badBodies = [
      {...allowed(), principal: "user_1"},
      {...allowed(), principal: {...userPrincipal(), kind: "robot"}},
      {...allowed(), workspace: ["ws_1"]},
      {...allowed(), workspace: {...workspace(), workspaceId: 1}},
    ]
    for (const body of badBodies) {
      const {client} = clientFor(() => json(body))
      await expectClientError(
        client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
        "bad_response",
      )
    }
  })

  test("rejects a principal response with a malformed principal or workspace", async () => {
    const membership = {membershipId: "mem_1", role: "member"} as const
    const {workspaceId: _workspaceId, ...withoutId} = workspace()
    const badBodies = [
      {workspaces: []},
      {principal: {...userPrincipal(), kind: undefined}, workspaces: []},
      {principal: userPrincipal(), workspaces: [{...withoutId, membership, capabilities: []}]},
      {principal: userPrincipal(), workspaces: ["ws_1"]},
    ]
    for (const body of badBodies) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.resolvePrincipal("t"), "bad_response")
    }
  })

  test("accepts a credential principal", async () => {
    const principal: PrincipalResponse = {
      principal: {
        kind: "credential",
        credentialId: "cred_1",
        credentialKind: "workspace",
        workspaceId: "ws_1",
        scopes: [],
        packageNames: [],
        label: "CI",
      },
      workspaces: [],
    }
    const {client} = clientFor(() => json(principal))
    expect(await client.resolvePrincipal("t")).toEqual(principal)
  })

  test("rejects a workspace summary without a workspace id", async () => {
    const {workspaceId: _workspaceId, ...withoutId} = workspace()
    for (const body of [withoutId, [workspace()], "ws_1"]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.getWorkspace("ws_1"), "bad_response")
    }
  })

  test("fails closed when a membership check or minted credential has the wrong shape", async () => {
    const memberships = clientFor(() => json({memberships: ["ws_1"]}))
    await expectClientError(memberships.client.checkMemberships("user_1", ["ws_1"]), "bad_response")
    const bareMap = clientFor(() => json({ws_1: null}))
    await expectClientError(bareMap.client.checkMemberships("user_1", ["ws_1"]), "bad_response")
    const credential = clientFor(() => json({credentialId: "cred_1"}))
    await expectClientError(credential.client.mintServiceCredential(mint), "bad_response")
    const notAnObject = clientFor(() => json([{credentialId: "cred_1", token: "msk_dev_x.y"}]))
    await expectClientError(notAnObject.client.mintServiceCredential(mint), "bad_response")
  })

  test("fails closed when a change page has the wrong shape", async () => {
    const good = changeEvent(1)
    const bad: unknown[] = [
      [good],
      {next: null},
      {events: good, next: null},
      {events: [good]},
      {events: [good], next: 1},
      {events: [good], next: ""},
      {events: [good], next: "not-a-cursor"},
      {events: ["event"], next: null},
      {events: [{...good, eventId: undefined}], next: null},
      {events: [{...good, seq: "1"}], next: null},
      {events: [{...good, seq: 1.5}], next: null},
      {events: [{...good, seq: -1}], next: null},
      {events: [{...good, action: undefined}], next: null},
      {events: [{...good, workspaceId: 7}], next: null},
      {events: [{...good, occurredAt: undefined}], next: null},
      {events: [{...good, target: "x"}], next: null},
      {events: [{...good, before: []}], next: null},
      {events: [{...good, after: 7}], next: null},
    ]
    for (const body of bad) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.listChanges({}), "bad_response")
    }
  })

  test("fails closed when a change page is out of order or its cursor does not point at its last event", async () => {
    const outOfOrder = clientFor(() => json({events: [changeEvent(5), changeEvent(4)], next: "4"}))
    await expectClientError(outOfOrder.client.listChanges({}), "bad_response")
    const repeated = clientFor(() => json({events: [changeEvent(5), changeEvent(5)], next: "5"}))
    await expectClientError(repeated.client.listChanges({}), "bad_response")
    const wrongCursor = clientFor(() => json({events: [changeEvent(5), changeEvent(6)], next: "9"}))
    await expectClientError(wrongCursor.client.listChanges({}), "bad_response")
    const cursorWithoutEvents = clientFor(() => json({events: [], next: "9"}))
    await expectClientError(cursorWithoutEvents.client.listChanges({}), "bad_response")
  })
})

describe("failures", () => {
  test("times out after timeoutMs with core_unavailable", async () => {
    const {client} = clientFor(
      (_request, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")))
        }),
      {timeoutMs: 25},
    )
    const started = Date.now()
    await expectClientError(client.getWorkspace("ws_1"), "core_unavailable")
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test("maps a network failure to core_unavailable", async () => {
    const {client} = clientFor(() => {
      throw new TypeError("fetch failed")
    })
    await expectClientError(client.getWorkspace("ws_1"), "core_unavailable")
  })

  test("maps a 5xx response to core_unavailable", async () => {
    const {client} = clientFor(() => json({error: "boom"}, 503))
    const error = await expectClientError(client.getWorkspace("ws_1"), "core_unavailable")
    expect(error.status).toBe(503)
  })

  test("maps a service_unauthorized 401 to service_unauthorized on every operation", async () => {
    const {client} = clientFor(() => json({error: SERVICE_UNAUTHORIZED_ERROR}, 401))
    const error = await expectClientError(client.getWorkspace("ws_1"), "service_unauthorized")
    expect(error.status).toBe(401)
    await expectClientError(client.getWorkspace("ws_1"), "service_unauthorized")
    await expectClientError(client.checkMemberships("user_1", []), "service_unauthorized")
    await expectClientError(client.authorize({credential: {type: "bearer", token: "t"}}), "service_unauthorized")
    await expectClientError(client.resolveEmail("a@example.com"), "service_unauthorized")
  })

  test("resolvePrincipal throws instead of returning null for a service_unauthorized or unrecognised 401", async () => {
    const service = clientFor(() => json({error: SERVICE_UNAUTHORIZED_ERROR}, 401))
    const serviceError = await expectClientError(service.client.resolvePrincipal("t"), "service_unauthorized")
    expect(serviceError.status).toBe(401)
    const other = clientFor(() => json({error: "something_else"}, 401))
    await expectClientError(other.client.resolvePrincipal("t"), "unauthorized")
    const bare = clientFor(() => new Response("", {status: 401}))
    await expectClientError(bare.client.resolvePrincipal("t"), "unauthorized")
    const invalid = clientFor(() => json({error: INVALID_TOKEN_ERROR}, 401))
    expect(await invalid.client.resolvePrincipal("t")).toBeNull()
  })

  test("an invalid_token 401 on another operation is an unauthorized error, not a null", async () => {
    const {client} = clientFor(() => json({error: INVALID_TOKEN_ERROR}, 401))
    await expectClientError(client.getWorkspace("ws_1"), "unauthorized")
  })

  test("maps other 401s to unauthorized and 403 to forbidden", async () => {
    const unauthorized = clientFor(() => json({error: "bad_signature"}, 401))
    const error = await expectClientError(unauthorized.client.getWorkspace("ws_1"), "unauthorized")
    expect(error.status).toBe(401)
    const forbidden = clientFor(() => json({error: "forbidden"}, 403))
    await expectClientError(
      forbidden.client.mintServiceCredential({
        workspaceId: "ws_1",
        name: "CI",
        packageNames: [],
        issuedBy: {service: "fleet", actorEmail: "a@example.com"},
      }),
      "forbidden",
    )
  })

  test("maps other client errors to bad_request and carries the error text", async () => {
    const {client} = clientFor(() => json({error: "too_many_workspaces"}, 400))
    const error = await expectClientError(client.checkMemberships("user_1", []), "bad_request")
    expect(error.status).toBe(400)
    expect(error.message).toContain("too_many_workspaces")
  })

  test("maps a non-JSON or malformed body to bad_response", async () => {
    const notJson = clientFor(() => new Response("<html>gateway</html>", {status: 200}))
    await expectClientError(notJson.client.getWorkspace("ws_1"), "bad_response")
    const wrongShape = clientFor(() => json({name: "no id"}))
    await expectClientError(wrongShape.client.getWorkspace("ws_1"), "bad_response")
  })
})

describe("deletion holds", () => {
  const AS_OF = new Date("2026-10-14T12:34:56.789Z")
  const holds = (...entries: WorkspaceDeletionHold[]): DeletionHoldsResponse => ({workspaceId: "ws 1", holds: entries, ignored: false})
  const verifies = (call: Recorded) => {
    const url = new URL(call.url)
    const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
    return verifyServiceRequest({
      secrets: [SECRET],
      method: call.method,
      pathWithQuery: `${url.pathname}${url.search}`,
      body: call.body,
      timestampMs,
      signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
      nowMs: timestampMs,
    })
  }

  test("setDeletionHold PUTs the reason, count and asOf to this service's own hold, signed over the exact path and body", async () => {
    const answer = holds({service: "store", reason: "owns_miniapps", count: 3})
    const {client, calls} = clientFor(() => json(answer))

    expect(await client.setDeletionHold("ws 1", {reason: "owns_miniapps", count: 3, asOf: AS_OF})).toEqual(answer)

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("PUT")
    // The service in the path is always the one the client signs as: a service sets only its own hold.
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/ws%201/deletion-holds/store`)
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(calls[0].body)).toEqual({reason: "owns_miniapps", count: 3, asOf: "2026-10-14T12:34:56.789Z"})
    expect(verifies(calls[0])).toBe(true)
  })

  test("setDeletionHold sends no count when it is given none", async () => {
    const {client, calls} = clientFor(() => json(holds({service: "store", reason: "owns_miniapps"})))
    await client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: AS_OF})
    expect(JSON.parse(calls[0].body)).toEqual({reason: "owns_miniapps", asOf: "2026-10-14T12:34:56.789Z"})
  })

  test("clearDeletionHold DELETEs this service's hold with its asOf, and returns the holds left", async () => {
    const answer = holds({service: "fleet", reason: "manages_devices"})
    const {client, calls} = clientFor(() => json(answer))

    expect(await client.clearDeletionHold("ws 1", {asOf: AS_OF})).toEqual(answer)

    expect(calls[0].method).toBe("DELETE")
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/ws%201/deletion-holds/store`)
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(calls[0].body)).toEqual({asOf: "2026-10-14T12:34:56.789Z"})
    expect(verifies(calls[0])).toBe(true)
  })

  test("an update Core ignored as stale resolves with the holds Core keeps and ignored: true", async () => {
    const answer: DeletionHoldsResponse = {workspaceId: "ws 1", holds: [{service: "store", reason: "owns_miniapps", count: 2}], ignored: true}
    const {client} = clientFor(() => json(answer))
    expect(await client.clearDeletionHold("ws 1", {asOf: AS_OF})).toEqual(answer)
    expect(await client.setDeletionHold("ws 1", {reason: "owns_miniapps", count: 5, asOf: AS_OF})).toEqual(answer)
  })

  test("an asOf that is not a valid date is refused before anything is sent", async () => {
    const {client, calls} = clientFor(() => json(holds()))
    const invalid = new Date(Number.NaN)
    await expect(client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: invalid})).rejects.toThrow(RangeError)
    await expect(client.clearDeletionHold("ws_1", {asOf: invalid})).rejects.toThrow(RangeError)
    expect(calls).toHaveLength(0)
  })

  test("a refusal is an error with Core's status: an unknown workspace, a deleted one, another service's hold", async () => {
    const unknown = clientFor(() => json({error: "workspace_not_found"}, 404))
    expect((await expectClientError(unknown.client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: AS_OF}), "bad_request")).status).toBe(404)
    expect((await expectClientError(unknown.client.clearDeletionHold("ws_1", {asOf: AS_OF}), "bad_request")).status).toBe(404)
    const deleted = clientFor(() => json({error: "workspace_deleted"}, 410))
    expect((await expectClientError(deleted.client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: AS_OF}), "bad_request")).status).toBe(410)
    const forbidden = clientFor(() => json({error: "forbidden"}, 403))
    await expectClientError(forbidden.client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: AS_OF}), "forbidden")
  })

  test("fails closed on an answer that does not have the holds shape", async () => {
    for (const body of [
      {},
      {workspaceId: "ws_1"},
      {workspaceId: "ws_1", holds: {}},
      {workspaceId: 5, holds: []},
      {workspaceId: "ws_1", holds: [{service: "store"}]},
      {workspaceId: "ws_1", holds: [{service: "store", reason: "owns_miniapps", count: "3"}]},
      {workspaceId: "ws_1", holds: [{service: "store", reason: "owns_miniapps", count: 0}]},
      // A Core that predates asOf says nothing about it, and would have applied a late call.
      {workspaceId: "ws_1", holds: []},
      {workspaceId: "ws_1", holds: [], ignored: "true"},
      {workspaceId: "ws_1", holds: [], ignored: null},
    ]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.setDeletionHold("ws_1", {reason: "owns_miniapps", asOf: AS_OF}), "bad_response")
      await expectClientError(client.clearDeletionHold("ws_1", {asOf: AS_OF}), "bad_response")
    }
  })
})

describe("licenses", () => {
  const LICENSE_ID = "01JZWY3V8N0F2E9GQ4T6KXH5RD"
  const write = (overrides: Partial<LicenseWrite> = {}): LicenseWrite => ({
    licenseId: LICENSE_ID,
    revision: 3,
    owner: {type: "workspace", workspaceId: "ws_1"},
    product: "mentra.call.unlimited",
    features: [{key: "call.unlimited", packages: ["com.mentra.call"]}],
    quantity: 5,
    validFrom: "2026-10-01T00:00:00.000Z",
    paidThrough: "2026-11-04T00:00:00.000Z",
    ...overrides,
  })
  const view = (overrides: Partial<LicenseView> = {}): LicenseView => {
    const {licenseId, ...rest} = write()
    return {licenseId, ...rest, seatsUsed: 2, endedAt: null, ...overrides}
  }
  const verifies = (call: Recorded) => {
    const url = new URL(call.url)
    const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
    return verifyServiceRequest({
      secrets: [SECRET],
      method: call.method,
      pathWithQuery: `${url.pathname}${url.search}`,
      body: call.body,
      timestampMs,
      signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
      nowMs: timestampMs,
    })
  }

  test("putLicense PUTs the whole write to the license's own path, signed, and returns whether Core applied it", async () => {
    const {client, calls} = clientFor(() => json({applied: true, revision: 3}))

    expect(await client.putLicense(write())).toEqual({applied: true, revision: 3})

    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("PUT")
    expect(calls[0].url).toBe(`${BASE}/api/internal/licenses/${LICENSE_ID}`)
    expect(calls[0].headers.get("content-type")).toBe("application/json")
    expect(JSON.parse(calls[0].body)).toEqual(write())
    expect(verifies(calls[0])).toBe(true)
  })

  test("putLicense resolves a repeat Core already has as not applied", async () => {
    const {client} = clientFor(() => json({applied: false, revision: 3}))
    expect(await client.putLicense(write())).toEqual({applied: false, revision: 3})
  })

  test("putLicense throws the client's error with Core's status and code: stale_revision, owner_not_found, unavailable", async () => {
    const stale = clientFor(() => json({error: "stale_revision", error_description: "Core has revision 4", revision: 4}, 409))
    expect((await expectClientError(stale.client.putLicense(write()), "stale_revision")).status).toBe(409)

    const gone = clientFor(() => json({error: "owner_not_found", error_description: "the workspace is deleted"}, 404))
    expect((await expectClientError(gone.client.putLicense(write()), "owner_not_found")).status).toBe(404)

    const down = clientFor(() => json({error: "server_error"}, 503))
    expect((await expectClientError(down.client.putLicense(write()), "core_unavailable")).status).toBe(503)

    // Any other 404 or 409 says nothing about the owner or the revision.
    const proxy = clientFor(() => new Response("not found", {status: 404}))
    expect((await expectClientError(proxy.client.putLicense(write()), "bad_request")).status).toBe(404)
    const conflict = clientFor(() => json({error: "membership_changed"}, 409))
    expect((await expectClientError(conflict.client.putLicense(write()), "bad_request")).status).toBe(409)
    const invalid = clientFor(() => json({error: "invalid_request"}, 400))
    expect((await expectClientError(invalid.client.putLicense(write()), "bad_request")).status).toBe(400)
  })

  test("putLicense fails closed on an answer without applied and a whole revision", async () => {
    for (const body of [{}, {applied: true}, {revision: 3}, {applied: "true", revision: 3}, {applied: true, revision: 1.5}]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.putLicense(write()), "bad_response")
    }
  })

  test("listLicenses asks for one workspace's licenses, signed over the exact query", async () => {
    const {client, calls} = clientFor(() => json({licenses: [view()]}))

    expect(await client.listLicenses("ws 1")).toEqual({licenses: [view()]})
    expect(calls[0].method).toBe("GET")
    expect(calls[0].url).toBe(`${BASE}/api/internal/licenses?ownerType=workspace&ownerId=ws+1`)
    expect(calls[0].body).toBe("")
    expect(verifies(calls[0])).toBe(true)
  })

  test("listLicenses fails closed on an answer that is not a list of licenses", async () => {
    for (const body of [
      {},
      {licenses: {}},
      {licenses: [{}]},
      {licenses: [{...view(), licenseId: 5}]},
      {licenses: [{...view(), seatsUsed: "2"}]},
      {licenses: [{...view(), owner: null}]},
      {licenses: [{...view(), revision: undefined}]},
    ]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.listLicenses("ws_1"), "bad_response")
    }
  })
})

describe("the miniapp registry", () => {
  const NOTES_URL = "https://notes.example.com/"
  const verifies = (call: Recorded) => {
    const url = new URL(call.url)
    const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
    return verifyServiceRequest({
      secrets: [SECRET],
      method: call.method,
      pathWithQuery: `${url.pathname}${url.search}`,
      body: call.body,
      timestampMs,
      signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
      nowMs: timestampMs,
    })
  }
  const result = (overrides: Partial<RegistryCheckResult> = {}): RegistryCheckResult => ({
    url: NOTES_URL,
    status: "accepted",
    packageName: "com.example.notes",
    name: "Notes",
    iconUrl: `${NOTES_URL}icon.png`,
    private: false,
    checkedAt: "2026-10-24T08:00:00.000Z",
    ...overrides,
  })
  const detail = (overrides: Partial<RegistryEntryDetail> = {}): RegistryEntryDetail => ({
    url: NOTES_URL,
    packageName: "com.example.notes",
    registrableDomain: "example.com",
    name: "Notes",
    version: "1.0.0",
    ageRating: "4+",
    iconUrl: `${NOTES_URL}icon.png`,
    verification: "verified",
    private: false,
    status: "active",
    firstRegisteredAt: "2026-10-24T08:00:00.000Z",
    lastVerifiedAt: "2026-10-24T08:00:00.000Z",
    manifest: {
      packageName: "com.example.notes",
      version: "1.0.0",
      name: "Notes",
      entry: {ui: "ui/index.html"},
      bundle: {url: "notes.zip", sha256: "ab".repeat(32)},
    },
    ...overrides,
  })
  const check = {urls: [NOTES_URL, "https://tools.acme.com/"], workspaceId: "ws_1", mentraUserId: "mu_1"}

  test("checkRegistry POSTs the URLs, workspace and person, signed, and returns one result per URL", async () => {
    const results = [result(), result({url: "https://tools.acme.com/", status: "unreachable", packageName: null, name: null, iconUrl: null})]
    const {client, calls} = clientFor(() => json({results}))

    expect(await client.checkRegistry(check)).toEqual(results)
    expect(calls[0].method).toBe("POST")
    expect(calls[0].url).toBe(`${BASE}/api/internal/registry/check`)
    expect(JSON.parse(calls[0].body)).toEqual(check)
    expect(verifies(calls[0])).toBe(true)
  })

  test("checkRegistry fails closed on results that aren't the URLs asked about, in order, each of its shape", async () => {
    for (const results of [
      [result()],
      [result({url: "https://tools.acme.com/"}), result({url: NOTES_URL})],
      [result(), result({url: "https://tools.acme.com/", status: "maybe" as never})],
      [result(), result({url: "https://tools.acme.com/", private: null as never})],
      [result(), result({url: "https://tools.acme.com/", name: 5 as never})],
      [result(), result({url: "https://tools.acme.com/", checkedAt: "soon"})],
    ]) {
      const {client} = clientFor(() => json({results}))
      await expectClientError(client.checkRegistry(check), "bad_response")
    }
    const {client} = clientFor(() => json({}))
    await expectClientError(client.checkRegistry(check), "bad_response")
  })

  test("checkRegistry waits for Core's 10-second check deadline, past the client's usual timeout", async () => {
    const results = [result(), result({url: "https://tools.acme.com/"})]
    const slow = (delayMs: number) => (_request: Recorded, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json({results})), delayMs)
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer)
          reject(init.signal?.reason)
        })
      })
    // A client whose timeout is 50 ms still gets a check that takes longer, while its other calls time out.
    const {client} = clientFor(slow(200), {timeoutMs: 50})
    expect(await client.checkRegistry(check)).toEqual(results)
    await expectClientError(client.lookupRegistry({workspaceId: "ws_1", packageNames: ["com.example.notes"]}), "core_unavailable")
  })

  test("checkRegistry reads not_a_member as forbidden", async () => {
    const {client} = clientFor(() => json({error: "not_a_member"}, 403))
    expect((await expectClientError(client.checkRegistry(check), "forbidden")).message).toContain("not_a_member")
  })

  test("lookupRegistry returns every package asked about, an own entry even for __proto__", async () => {
    const entries = {"com.example.notes": {name: "Notes", iconUrl: null, private: false, archived: false}, ["__proto__"]: null}
    const {client, calls} = clientFor(() => new Response(JSON.stringify({entries}), {status: 200}))

    const answer = await client.lookupRegistry({workspaceId: "ws_1", packageNames: ["com.example.notes", "__proto__"]})
    expect(answer["com.example.notes"]).toEqual(entries["com.example.notes"])
    expect(Object.prototype.hasOwnProperty.call(answer, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(answer)).toBe(Object.prototype)
    expect(calls[0].url).toBe(`${BASE}/api/internal/registry/lookup`)
    expect(JSON.parse(calls[0].body)).toEqual({workspaceId: "ws_1", packageNames: ["com.example.notes", "__proto__"]})
    expect(verifies(calls[0])).toBe(true)
  })

  test("lookupRegistry fails closed on an answer that leaves a package out or has the wrong shape", async () => {
    for (const entries of [
      {},
      {"com.example.notes": {name: "Notes", iconUrl: null, private: false}},
      {"com.example.notes": {name: "Notes", iconUrl: null, private: "no", archived: false}},
      {"com.example.notes": "Notes"},
    ]) {
      const {client} = clientFor(() => json({entries}))
      await expectClientError(client.lookupRegistry({workspaceId: "ws_1", packageNames: ["com.example.notes"]}), "bad_response")
    }
  })

  test("getRegistryEntry asks for one URL, signed over the exact query, and reads only not_found as none", async () => {
    const {client, calls} = clientFor(() => json({entry: detail()}))
    expect(await client.getRegistryEntry(NOTES_URL)).toEqual(detail())
    expect(calls[0].method).toBe("GET")
    expect(calls[0].url).toBe(`${BASE}/api/internal/registry/entries?url=https%3A%2F%2Fnotes.example.com%2F`)
    expect(verifies(calls[0])).toBe(true)

    const none = clientFor(() => json({error: "not_found"}, 404))
    expect(await none.client.getRegistryEntry(NOTES_URL)).toBeNull()
    const proxy = clientFor(() => new Response("not found", {status: 404}))
    await expectClientError(proxy.client.getRegistryEntry(NOTES_URL), "bad_request")
  })

  test("getRegistryEntry accepts an entry with only its URL and package, and fails closed on a malformed one", async () => {
    const hidden = detail({name: null, version: null, ageRating: null, iconUrl: null, private: true, manifest: null})
    expect(await clientFor(() => json({entry: hidden})).client.getRegistryEntry(NOTES_URL)).toEqual(hidden)
    for (const entry of [
      undefined,
      {...detail(), packageName: ""},
      {...detail(), ageRating: "21+"},
      {...detail(), verification: "trusted"},
      {...detail(), status: "deleted"},
      {...detail(), lastVerifiedAt: "never"},
      {...detail(), manifest: {name: "Notes"}},
    ]) {
      const {client} = clientFor(() => json({entry}))
      await expectClientError(client.getRegistryEntry(NOTES_URL), "bad_response")
    }
  })

  test("archiveRegistry POSTs the rule, reason and actor, and returns what Core did", async () => {
    const body = {rule: {kind: "domain" as const, value: "Example.com"}, reason: "spam", actorEmail: "staff@example.com"}
    const {client, calls} = clientFor(() => json({rule: {kind: "domain", value: "example.com"}, created: true, entriesArchived: 3}))
    expect(await client.archiveRegistry(body)).toEqual({rule: {kind: "domain", value: "example.com"}, created: true, entriesArchived: 3})
    expect(calls[0].url).toBe(`${BASE}/api/internal/registry/archive`)
    expect(JSON.parse(calls[0].body)).toEqual(body)
    expect(verifies(calls[0])).toBe(true)

    for (const answer of [{}, {rule: {kind: "everything", value: "x"}, created: true, entriesArchived: 0}, {rule: body.rule, created: true, entriesArchived: -1}]) {
      const {client: bad} = clientFor(() => json(answer))
      await expectClientError(bad.archiveRegistry(body), "bad_response")
    }
  })
})

describe("construction", () => {
  test("throws on an empty or whitespace-only secret instead of signing forgeable requests", () => {
    for (const secret of ["", "   "]) {
      expect(() =>
        createCoreWorkspaceClient({
          baseUrl: BASE,
          service: "store",
          secret,
          fetch: mockFetch(() => json({})).fetch,
        }),
      ).toThrow()
    }
  })
})
