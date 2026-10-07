import {describe, expect, test} from "bun:test"
import {CoreWorkspaceClientError, createCoreWorkspaceClient} from "./client"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import {INVALID_TOKEN_ERROR, SERVICE_UNAUTHORIZED_ERROR} from "./types"
import type {AuthorizeResponse, PrincipalResponse, WorkspaceChangeEvent, WorkspaceSummary} from "./types"

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

const userPrincipal = () =>
  ({
    kind: "user",
    mentraUserId: "user_1",
    email: "a@example.com",
    emailVerified: true,
    name: null,
    workosUserId: null,
    isOrganizationAdmin: false,
  } as const)

const allowed = (): AuthorizeResponse => ({
  allowed: true,
  principal: userPrincipal(),
  workspace: workspace(),
  membership: {membershipId: "mem_1", role: "developer"},
  capabilities: ["workspace.read", "miniapps.access", "miniapps.publish"],
})

const changeEvent = (): WorkspaceChangeEvent => ({
  eventId: "evt_1",
  seq: 1,
  workspaceId: "ws_1",
  action: "membership.added",
  occurredAt: "2026-01-01T00:00:00.000Z",
  target: {membershipId: "mem_1"},
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
      if (request.url.includes("/changes")) return json({events: [], next: null})
      if (request.url.endsWith("/authorize")) return json(allowed())
      return json({})
    })

    const before = Date.now()
    await client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}, workspaceId: "ws_1"})
    await client.listChanges("abc", 100)
    const after = Date.now()

    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/api/internal/workspaces/authorize`,
      `${BASE}/api/internal/workspaces/changes?after=abc&limit=100`,
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
    const {client, calls} = clientFor(() => json({events: [], next: null}))
    await client.listChanges(null)
    const call = calls[0]
    const timestampMs = Number(call.headers.get(SERVICE_HEADERS.timestamp))
    expect(
      verifyServiceRequest({
        secrets: ["other"],
        method: "GET",
        pathWithQuery: "/api/internal/workspaces/changes",
        body: "",
        timestampMs,
        signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
        nowMs: timestampMs,
      }),
    ).toBe(false)
  })

  test("tolerates a trailing slash on the base URL", async () => {
    const {client, calls} = clientFor(() => json({events: [], next: null}), {baseUrl: `${BASE}/`})
    await client.listChanges(null)
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/changes`)
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

  test("listChanges sends the cursor and limit only when given", async () => {
    const page = {events: [changeEvent()], next: "2"}
    const {client, calls} = clientFor(() => json(page))
    expect(await client.listChanges(null)).toEqual(page)
    await client.listChanges("1")
    await client.listChanges(null, 50)
    await client.listChanges("a b&c", 10)
    expect(calls.map((call) => call.url.slice(BASE.length))).toEqual([
      "/api/internal/workspaces/changes",
      "/api/internal/workspaces/changes?after=1",
      "/api/internal/workspaces/changes?limit=50",
      "/api/internal/workspaces/changes?after=a+b%26c&limit=10",
    ])
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

  test("rejects a change feed containing an event without an id or seq", async () => {
    const {eventId: _eventId, ...withoutId} = changeEvent()
    const badEvents = [withoutId, {...changeEvent(), seq: "2"}, "evt_2"]
    for (const bad of badEvents) {
      const {client} = clientFor(() => json({events: [changeEvent(), bad], next: null}))
      await expectClientError(client.listChanges(null), "bad_response")
    }
  })

  test("rejects a change feed whose next cursor is neither a string nor null", async () => {
    const {client} = clientFor(() => json({events: [], next: 2}))
    await expectClientError(client.listChanges(null), "bad_response")
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
    await expectClientError(client.listChanges(null), "core_unavailable")
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
    const error = await expectClientError(client.listChanges(null), "service_unauthorized")
    expect(error.status).toBe(401)
    await expectClientError(client.getWorkspace("ws_1"), "service_unauthorized")
    await expectClientError(client.checkMemberships("user_1", []), "service_unauthorized")
    await expectClientError(client.authorize({credential: {type: "bearer", token: "t"}}), "service_unauthorized")
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
    await expectClientError(client.listChanges(null), "unauthorized")
  })

  test("maps other 401s to unauthorized and 403 to forbidden", async () => {
    const unauthorized = clientFor(() => json({error: "bad_signature"}, 401))
    const error = await expectClientError(unauthorized.client.listChanges(null), "unauthorized")
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
    await expectClientError(notJson.client.listChanges(null), "bad_response")
    const wrongShape = clientFor(() => json({events: "nope"}))
    await expectClientError(wrongShape.client.listChanges(null), "bad_response")
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
