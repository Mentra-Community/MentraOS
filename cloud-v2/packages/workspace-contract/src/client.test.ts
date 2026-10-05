import {describe, expect, test} from "bun:test"
import {CoreWorkspaceClientError, createCoreWorkspaceClient} from "./client"
import {SERVICE_HEADERS, verifyServiceRequest} from "./service-signature"
import type {AuthorizeResponse, PrincipalResponse, WorkspaceChangeEvent, WorkspaceSummary} from "./types"

const ORG = "org_1"
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

function clientFor(
  handler: Handler,
  overrides: {expectedOrganizationId?: string; timeoutMs?: number; baseUrl?: string} = {},
) {
  const mock = mockFetch(handler)
  const client = createCoreWorkspaceClient({
    baseUrl: overrides.baseUrl ?? BASE,
    service: "store",
    secret: SECRET,
    expectedOrganizationId: overrides.expectedOrganizationId ?? ORG,
    fetch: mock.fetch,
    timeoutMs: overrides.timeoutMs,
  })
  return {client, calls: mock.calls}
}

const workspace = (organizationId = ORG): WorkspaceSummary => ({
  organizationId,
  workspaceId: "ws_1",
  name: "Acme",
  status: "active",
  authorizationRevision: 3,
})

const userPrincipal = (organizationId = ORG) =>
  ({
    kind: "user",
    organizationId,
    mentraUserId: "user_1",
    email: "a@example.com",
    emailVerified: true,
    workosUserId: null,
    isOrganizationAdmin: false,
  } as const)

const allowed = (organizationId = ORG): AuthorizeResponse => ({
  allowed: true,
  organizationId,
  principal: userPrincipal(organizationId),
  workspace: workspace(organizationId),
  membership: {membershipId: "mem_1", role: "developer"},
  capabilities: ["workspace.read", "miniapps.access", "miniapps.publish"],
})

const changeEvent = (organizationId = ORG): WorkspaceChangeEvent => ({
  eventId: "evt_1",
  organizationId,
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

  test("authorize returns a denial with its reason", async () => {
    const denied: AuthorizeResponse = {
      allowed: false,
      reason: "not_a_member",
      organizationId: ORG,
      principal: userPrincipal(),
      capabilities: [],
    }
    const {client} = clientFor(() => json(denied))
    const response = await client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}})
    expect(response.allowed).toBe(false)
    expect(response.reason).toBe("not_a_member")
  })

  test("resolvePrincipal posts the token and maps 401 to null", async () => {
    const principal: PrincipalResponse = {
      principal: userPrincipal(),
      workspaces: [
        {...workspace(), membership: {membershipId: "mem_1", role: "owner"}, capabilities: ["workspace.read"]},
      ],
    }
    const {client, calls} = clientFor((request) =>
      JSON.parse(request.body).token === "good" ? json(principal) : json({error: "unauthenticated"}, 401),
    )
    expect(await client.resolvePrincipal("good")).toEqual(principal)
    expect(await client.resolvePrincipal("bad")).toBeNull()
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/principal`)
    expect(calls[0].method).toBe("POST")
    expect(JSON.parse(calls[0].body)).toEqual({token: "good"})
  })

  test("checkMemberships posts the user and workspaces and returns the map", async () => {
    const map = {ws_1: {role: "admin", capabilities: ["workspace.read"]}, ws_2: null}
    const {client, calls} = clientFor(() => json(map))
    expect(await client.checkMemberships("user_1", ["ws_1", "ws_2"])).toEqual(map as never)
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

  test("getWorkspace escapes the workspace id in the path", async () => {
    const {client, calls} = clientFor(() => json(workspace()))
    await client.getWorkspace("a/b?c")
    expect(calls[0].url).toBe(`${BASE}/api/internal/workspaces/workspaces/a%2Fb%3Fc`)
  })

  test("listChanges sends the cursor and limit only when given", async () => {
    const page = {events: [changeEvent()], next: "cursor_2"}
    const {client, calls} = clientFor(() => json(page))
    expect(await client.listChanges(null)).toEqual(page)
    await client.listChanges("cursor_1")
    await client.listChanges(null, 50)
    await client.listChanges("a b&c", 10)
    expect(calls.map((call) => call.url.slice(BASE.length))).toEqual([
      "/api/internal/workspaces/changes",
      "/api/internal/workspaces/changes?after=cursor_1",
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

describe("organization binding", () => {
  test("rejects an authorize response from another organization", async () => {
    const {client} = clientFor(() => json(allowed("org_other")))
    await expectClientError(
      client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
      "organization_mismatch",
    )
  })

  test("rejects an authorize response whose nested principal or workspace is from another organization", async () => {
    const nestedPrincipal: AuthorizeResponse = {...allowed(), principal: userPrincipal("org_other")}
    const nestedWorkspace: AuthorizeResponse = {...allowed(), workspace: workspace("org_other")}
    for (const body of [nestedPrincipal, nestedWorkspace]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(
        client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
        "organization_mismatch",
      )
    }
  })

  test("rejects a principal response from another organization, including its workspaces", async () => {
    const membership = {membershipId: "mem_1", role: "member"} as const
    const wrongPrincipal: PrincipalResponse = {principal: userPrincipal("org_other"), workspaces: []}
    const wrongWorkspace: PrincipalResponse = {
      principal: userPrincipal(),
      workspaces: [{...workspace("org_other"), membership, capabilities: []}],
    }
    for (const body of [wrongPrincipal, wrongWorkspace]) {
      const {client} = clientFor(() => json(body))
      await expectClientError(client.resolvePrincipal("t"), "organization_mismatch")
    }
  })

  test("rejects a workspace summary from another organization", async () => {
    const {client} = clientFor(() => json(workspace("org_other")))
    await expectClientError(client.getWorkspace("ws_1"), "organization_mismatch")
  })

  test("rejects a change feed containing an event from another organization", async () => {
    const {client} = clientFor(() => json({events: [changeEvent(), changeEvent("org_other")], next: null}))
    await expectClientError(client.listChanges(null), "organization_mismatch")
  })

  test("treats a client configured for a different organization as a mismatch", async () => {
    const {client} = clientFor(() => json(allowed()), {expectedOrganizationId: "org_2"})
    await expectClientError(
      client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
      "organization_mismatch",
    )
  })

  test("fails closed when a response that must carry an organization does not", async () => {
    const {organizationId: _omitted, ...withoutOrganization} = allowed()
    const {client} = clientFor(() => json(withoutOrganization))
    await expectClientError(
      client.authorize({credential: {type: "mentra_user", mentraUserId: "user_1"}}),
      "bad_response",
    )
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

  test("maps 401 to unauthorized and 403 to forbidden outside principal lookup", async () => {
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
