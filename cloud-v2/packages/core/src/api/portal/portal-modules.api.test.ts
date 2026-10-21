/**
 * @fileoverview The portal module forwarder against a stub module, without a database.
 *
 * The stub is a real `Bun.serve` on loopback, so the request Core sends (headers, signatures, path) and the
 * way it treats a slow, failing or redirecting module are the real thing. People reach the module as the
 * principal a test places on the context (as `principalAuth` accepts an already resolved one), and the
 * workspace authorization Core's `authorize` gives is replaced by a membership table. `createApp` is used only
 * to pin that the routes are mounted behind the portal's sign-in gate. `tests/portal-modules.integration.test.ts`
 * runs the same seam against real sign-ins and Mongo.
 */

import type {Logger} from "@mentra/cloud-shared"
import type {AuthorizeResponse} from "@mentra/workspace-contract"
import {verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import * as authorization from "../../services/workspaces/authorization.service"
import type {CorePrincipal, UserPrincipal} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import {createApp} from "../app"
import {portalModuleApi} from "./portal-modules.api"

const SECRET = "billing-secret-for-tests"

const ENV_KEYS = [
  "CLOUD_CORE_BILLING_URL",
  "CLOUD_CORE_BILLING_SECRET",
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

interface Captured {
  method: string
  pathWithQuery: string
  headers: Headers
  body: string
}

let calls: Captured[] = []
let respond: (request: Request) => Response | Promise<Response> = () => Response.json({ok: true})

const module_ = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const origin = new URL(request.url).origin
    calls.push({
      method: request.method,
      pathWithQuery: request.url.slice(origin.length),
      headers: request.headers,
      body: await request.text(),
    })
    return respond(request)
  },
})
afterAll(() => module_.stop(true))

/** Points Core at the stub as a Core whose environment is `environment` (null: unset); `prod` shows billing to everyone. */
function configure(environment: string | null = "prod", extra: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.CLOUD_CORE_BILLING_URL = `http://127.0.0.1:${module_.port}`
  process.env.CLOUD_CORE_BILLING_SECRET = SECRET
  if (environment === null) delete process.env.CLOUD_CORE_ENVIRONMENT
  else process.env.CLOUD_CORE_ENVIRONMENT = environment
  for (const [key, value] of Object.entries(extra)) process.env[key] = value
}

interface LogLine {
  level: string
  fields: Record<string, unknown>
  message: string
}
let logs: LogLine[] = []

function recordingLogger(): Logger {
  const record = (level: string) => (fields: unknown, message?: string) => {
    logs.push({level, fields: fields as Record<string, unknown>, message: message ?? ""})
  }
  return {debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error")} as unknown as Logger
}

// --- Workspaces and people --------------------------------------------------

const members = new Map<string, Set<string>>()
const deleted = new Set<string>()

let authorizeSpy: ReturnType<typeof spyOn<typeof authorization, "authorize">>

beforeEach(() => {
  calls = []
  logs = []
  respond = () => Response.json({ok: true})
  for (const key of ENV_KEYS) delete process.env[key]
  members.clear()
  deleted.clear()
  members.set("ws_1", new Set(["mu_member"]))
  members.set("ws_2", new Set(["mu_other"]))
  deleted.add("ws_gone")
  authorizeSpy = spyOn(authorization, "authorize").mockImplementation(async (p, req) => {
    const deny = (reason: NonNullable<AuthorizeResponse["reason"]>): AuthorizeResponse => ({
      allowed: false,
      reason,
      principal: p,
      capabilities: [],
    })
    if (!p) return deny("unauthenticated")
    const id = req.workspaceId
    if (!id || !(members.has(id) || deleted.has(id))) return deny("workspace_not_found")
    if (deleted.has(id)) return deny("workspace_deleted")
    if (p.kind === "user" && (p.isOrganizationAdmin || members.get(id)?.has(p.mentraUserId))) {
      return {allowed: true, principal: p, capabilities: []}
    }
    return deny("not_a_member")
  })
})

afterEach(() => {
  authorizeSpy.mockRestore()
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

function person(mentraUserId: string, isOrganizationAdmin = false): UserPrincipal {
  return {
    kind: "user",
    mentraUserId,
    tenantId: "mentra",
    email: `${mentraUserId}@example.test`,
    emailVerified: true,
    isOrganizationAdmin,
    via: "session",
  }
}

const member = person("mu_member")
const admin = person("mu_admin", true)
const stranger = person("mu_stranger")

const workspaceKey: CorePrincipal = {
  kind: "credential",
  credentialId: "01HZKEY",
  credentialKind: "workspace",
  workspaceId: "ws_1",
  scopes: ["workspace.read"],
  packageNames: [],
  label: "ci key",
}
const operatorKey: CorePrincipal = {...workspaceKey, credentialKind: "organization", workspaceId: null, scopes: []}

const principals = new Map<string, CorePrincipal>()
const as = (name: string, principal: CorePrincipal) => {
  principals.set(name, principal)
  return name
}

const root = new Hono<AppEnv>()
root.use("*", async (c, next) => {
  const principal = principals.get(c.req.header("x-test-principal") ?? "")
  if (principal) c.set("principal", principal)
  c.set("logger", recordingLogger())
  const rotated = c.req.header("x-test-set-cookie")
  if (rotated) c.header("set-cookie", rotated, {append: true})
  await next()
})
root.route("/api/portal/billing", portalModuleApi("billing"))

type Init = Omit<RequestInit, "headers"> & {headers?: Record<string, string>}

function billing(principal: string | null, rest: string, init: Init = {}) {
  return root.request(`http://localhost/api/portal/billing${rest}`, {
    ...init,
    headers: {...(principal ? {"x-test-principal": principal} : {}), ...init.headers},
  })
}

/** The principal the stub verified for its latest call, or null when its signatures did not verify. */
function verified(call: Captured = calls.at(-1)!) {
  return verifyForwardedPrincipal(
    {method: call.method, pathWithQuery: call.pathWithQuery, body: call.body, headers: call.headers},
    [SECRET],
  )
}

/** The `error` (and `reason`) of one of Core's refusals. */
const errorBody = (reply: Response) => reply.json() as Promise<{error?: string; reason?: string}>

/** A request whose URL is exactly `rawUrl`: the `Request` constructor would collapse `..` segments. */
function rawUrlRequest(rawUrl: string, headers: Record<string, string>): Request {
  const request = new Request("http://localhost/", {headers})
  Object.defineProperty(request, "url", {value: rawUrl})
  return request
}

describe("who may call, and in what order Core answers", () => {
  test("nobody is 401, whether or not the module is installed, and nothing is forwarded", async () => {
    for (const environment of [null, "prod"] as const) {
      if (environment) configure(environment)
      for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js", "/nothing"]) {
        const reply = await billing(null, rest)
        expect([rest, reply.status, await reply.json()]).toEqual([rest, 401, {error: "unauthorized"}])
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a workspace key or an operator key is 403, even for its own workspace", async () => {
    configure("prod")
    for (const name of [as("ws-key", workspaceKey), as("op-key", operatorKey)]) {
      for (const rest of ["/workspaces/ws_1/licenses", "/account/licenses", "/ui/entry.js"]) {
        const reply = await billing(name, rest)
        expect([name, rest, reply.status, (await errorBody(reply)).error]).toEqual([name, rest, 403, "forbidden"])
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a module that is not installed is a 404 after authentication, for every path and method", async () => {
    for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js", "/nothing"]) {
      for (const method of ["GET", "POST"]) {
        const reply = await billing(as("member", member), rest, {method})
        expect([rest, method, reply.status, await reply.json()]).toEqual([rest, method, 404, {error: "module_not_installed"}])
      }
    }
    // Not installed comes before the scope check: a stranger learns nothing about the workspace.
    const reply = await billing(as("stranger", stranger), "/workspaces/ws_1/licenses")
    expect([reply.status, (await errorBody(reply)).error]).toEqual([404, "module_not_installed"])
    expect(authorizeSpy).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  test("an installed module whose settings are unusable is a 503 for a person who may see it", async () => {
    configure("prod", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
    const reply = await billing(as("member", member), "/account/licenses")
    expect([reply.status, await reply.json()]).toEqual([503, {error: "module_unavailable"}])
    delete process.env.CLOUD_CORE_BILLING_SECRET
    process.env.CLOUD_CORE_BILLING_URL = `http://127.0.0.1:${module_.port}`
    const noSecret = await billing(as("member", member), "/ui/entry.js")
    expect([noSecret.status, await noSecret.json()]).toEqual([503, {error: "module_unavailable"}])
    expect(calls).toHaveLength(0)
  })

  test("a person the module is hidden from gets the 404 of an absent module, not the 503 of a broken one", async () => {
    configure("staging", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
    const reply = await billing(as("member", member), "/account/licenses")
    expect([reply.status, await reply.json()]).toEqual([404, {error: "module_not_installed"}])
  })

  test("Core's own answers are labelled as data", async () => {
    for (const reply of [await billing(null, "/account/x"), await billing(as("member", member), "/account/x")]) {
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
      expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    }
  })
})

describe("staff-only billing outside prod", () => {
  test("on dev and staging a person who is not an Organization Admin gets a 404 and no call; an Organization Admin is forwarded", async () => {
    for (const environment of ["dev", "staging"]) {
      configure(environment)
      calls = []
      for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js"]) {
        const hidden = await billing(as("member", member), rest)
        expect([environment, rest, hidden.status, await hidden.json()]).toEqual([
          environment,
          rest,
          404,
          {error: "module_not_installed"},
        ])
      }
      expect(calls).toHaveLength(0)
      for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js"]) {
        const reply = await billing(as("admin", admin), rest)
        expect([environment, rest, reply.status]).toEqual([environment, rest, 200])
      }
      expect(calls).toHaveLength(3)
    }
  })

  test("a person it is hidden from cannot probe for it with a body over the limit: a 404, not a 413, and no call", async () => {
    const tooBig = "x".repeat(1024 * 1024 + 1)
    for (const environment of ["dev", "staging"]) {
      configure(environment)
      for (const rest of ["/account/checkout", "/workspaces/ws_1/licenses"]) {
        const reply = await billing(as("member", member), rest, {method: "POST", body: tooBig})
        expect([environment, rest, reply.status, await reply.json()]).toEqual([
          environment,
          rest,
          404,
          {error: "module_not_installed"},
        ])
      }
      // The limit is for a request that will be forwarded: the same body from staff is refused as too large.
      const staff = await billing(as("admin", admin), "/account/checkout", {method: "POST", body: tooBig})
      expect([environment, staff.status, await staff.json()]).toEqual([environment, 413, {error: "payload_too_large"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("nor can a body over the limit tell a person the module is broken: it is the 503, unread", async () => {
    configure("prod", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
    const reply = await billing(as("member", member), "/account/checkout", {method: "POST", body: "x".repeat(1024 * 1024 + 1)})
    expect([reply.status, await reply.json()]).toEqual([503, {error: "module_unavailable"}])
    expect(calls).toHaveLength(0)
  })

  test("on prod both are forwarded", async () => {
    configure("prod")
    expect((await billing(as("member", member), "/account/licenses")).status).toBe(200)
    expect((await billing(as("admin", admin), "/account/licenses")).status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test("an unset or unrecognized environment is staff-only, the safe side", async () => {
    for (const environment of [null, "production", "local", ""]) {
      configure(environment)
      calls = []
      const hidden = await billing(as("member", member), "/account/licenses")
      expect([environment, hidden.status]).toEqual([environment, 404])
      expect([environment, (await billing(as("admin", admin), "/account/licenses")).status]).toEqual([environment, 200])
    }
  })
})

describe("workspace routes", () => {
  test("a member is forwarded with their workspace as the scope, at the module's /v1/portal path", async () => {
    configure()
    const reply = await billing(as("member", member), "/workspaces/ws_1/licenses/abc?x=1&y=%20z", {
      method: "POST",
      body: '{"seats":3}',
      headers: {"content-type": "application/json", accept: "application/json"},
    })

    expect(reply.status).toBe(200)
    expect(calls).toHaveLength(1)
    expect(calls[0].pathWithQuery).toBe("/v1/portal/workspaces/ws_1/licenses/abc?x=1&y=%20z")
    expect(calls[0].method).toBe("POST")
    expect(calls[0].body).toBe('{"seats":3}')
    expect(verified()).toEqual({
      kind: "user",
      mentraUserId: "mu_member",
      email: "mu_member@example.test",
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "workspace", workspaceId: "ws_1"},
    })
    // Core asks whether the person is in the workspace, and nothing more: the module decides capabilities.
    expect(authorizeSpy).toHaveBeenCalledWith(member, {workspaceId: "ws_1"})
  })

  test("the workspace itself, without a path after it, is a workspace route", async () => {
    configure()
    expect((await billing(as("member", member), "/workspaces/ws_1")).status).toBe(200)
    expect(calls[0].pathWithQuery).toBe("/v1/portal/workspaces/ws_1")
    expect(verified()).toMatchObject({scope: {kind: "workspace", workspaceId: "ws_1"}})
  })

  test("an Organization Admin gets a workspace scope for any workspace, and the principal says they are one", async () => {
    configure()
    for (const workspaceId of ["ws_1", "ws_2"]) {
      expect((await billing(as("admin", admin), `/workspaces/${workspaceId}/licenses`)).status).toBe(200)
      expect(verified()).toMatchObject({
        isOrganizationAdmin: true,
        scope: {kind: "workspace", workspaceId},
      })
    }
  })

  test("a non-member who is no Organization Admin is 403 and the module is never called", async () => {
    configure()
    for (const [name, rest] of [
      ["stranger", "/workspaces/ws_1/licenses"],
      ["stranger", "/workspaces/ws_2/licenses"],
      ["member", "/workspaces/ws_2/licenses"],
    ] as const) {
      const reply = await billing(as(name, name === "member" ? member : stranger), rest, {method: "POST", body: "{}"})
      const body = await errorBody(reply)
      expect([name, rest, reply.status, body.error, body.reason]).toEqual([name, rest, 403, "forbidden", "not_a_member"])
    }
    expect(calls).toHaveLength(0)
  })

  test("an unknown or deleted workspace is a 404 workspace_not_found, with no call", async () => {
    configure()
    for (const workspaceId of ["ws_unknown", "ws_gone"]) {
      const reply = await billing(as("admin", admin), `/workspaces/${workspaceId}/licenses`)
      expect([workspaceId, reply.status, (await errorBody(reply)).error]).toEqual([workspaceId, 404, "workspace_not_found"])
    }
    expect(calls).toHaveLength(0)
  })

  test("the workspace Core authorizes is the one the module is told, however its id is spelled", async () => {
    configure()
    // `%5F` is an underscore: one decoding names ws_1, which the module decodes the same way.
    expect((await billing(as("member", member), "/workspaces/ws%5F1/licenses")).status).toBe(200)
    expect(authorizeSpy).toHaveBeenCalledWith(member, {workspaceId: "ws_1"})
    expect(calls[0].pathWithQuery).toBe("/v1/portal/workspaces/ws%5F1/licenses")
    expect(verified()).toMatchObject({scope: {kind: "workspace", workspaceId: "ws_1"}})
  })

  test("nothing the request says can name another workspace", async () => {
    configure()
    const reply = await billing(as("member", member), "/workspaces/ws_1/licenses?workspaceId=ws_2&scope=organization", {
      method: "POST",
      body: JSON.stringify({scope: {kind: "organization"}, workspaceId: "ws_2"}),
      headers: {
        "content-type": "application/json",
        "x-mentra-principal": Buffer.from(JSON.stringify({kind: "user", scope: {kind: "organization"}})).toString("base64url"),
        "x-mentra-workspace-id": "ws_2",
      },
    })
    expect(reply.status).toBe(200)
    expect(verified()).toMatchObject({scope: {kind: "workspace", workspaceId: "ws_1"}})
    expect(calls[0].headers.get("x-mentra-workspace-id")).toBeNull()
  })

  test("a workspace route without a workspace is not a route", async () => {
    configure()
    for (const rest of ["/workspaces", "/workspaces/", "/workspaces//licenses"]) {
      const reply = await billing(as("admin", admin), rest)
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 404, {error: "not_found"}])
    }
    expect(calls).toHaveLength(0)
  })
})

describe("account routes", () => {
  test("carry the person's own scope and nothing else, at the module's /v1/portal/account path", async () => {
    configure()
    const reply = await billing(as("member", member), "/account/licenses?x=1", {method: "GET"})
    expect(reply.status).toBe(200)
    expect(calls[0].pathWithQuery).toBe("/v1/portal/account/licenses?x=1")
    expect(verified()).toEqual({
      kind: "user",
      mentraUserId: "mu_member",
      email: "mu_member@example.test",
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "person"},
    })
    // No workspace is involved, so none is looked up.
    expect(authorizeSpy).not.toHaveBeenCalled()
  })

  test("stay a person's scope whatever the query, the body or the headers ask", async () => {
    configure()
    const forged = Buffer.from(JSON.stringify({kind: "user", scope: {kind: "workspace", workspaceId: "ws_2"}})).toString("base64url")
    for (const [rest, init] of [
      ["/account/checkout?scope=workspace&workspaceId=ws_2", {}],
      ["/account/checkout?scope=organization", {}],
      [
        "/account/checkout",
        {
          method: "POST",
          body: JSON.stringify({scope: "workspace", workspaceId: "ws_2", principal: {scope: {kind: "organization"}}}),
          headers: {"content-type": "application/json", "x-mentra-principal": forged, "x-mentra-scope": "workspace"},
        },
      ],
    ] as const) {
      calls = []
      const reply = await billing(as("admin", admin), rest, init)
      expect([rest, reply.status]).toEqual([rest, 200])
      expect([rest, verified()]).toMatchObject([rest, {isOrganizationAdmin: true, scope: {kind: "person"}}])
    }
  })

  test("the account itself, without a path after it, is an account route", async () => {
    configure()
    expect((await billing(as("member", member), "/account")).status).toBe(200)
    expect(calls[0].pathWithQuery).toBe("/v1/portal/account")
  })
})

describe("what the module receives", () => {
  test("only content-type and accept of the caller's headers; nothing under x-mentra-*, cookie or authorization", async () => {
    configure()
    await billing(as("member", member), "/account/x", {
      method: "POST",
      body: "{}",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        cookie: "__Host-mentra_portal_session=secret",
        authorization: "Bearer secret",
        origin: "https://portal.test",
        "x-mentra-service": "forged",
        "x-mentra-service-signature": "forged",
        "x-mentra-principal-signature": "forged",
        "x-forwarded-for": "6.6.6.6",
      },
    })

    const got = calls[0].headers
    expect(got.get("content-type")).toBe("application/json")
    expect(got.get("accept")).toBe("application/json")
    for (const name of ["cookie", "authorization", "origin", "x-forwarded-for"]) expect([name, got.get(name)]).toEqual([name, null])
    expect(got.get("x-mentra-service")).toBe("core")
    expect(got.get("x-mentra-service-signature")).not.toBe("forged")
    expect(got.get("x-mentra-principal-signature")).not.toBe("forged")
    expect(verified()).not.toBeNull()
  })

  test("a request changed after Core signed it does not verify", async () => {
    configure()
    await billing(as("member", member), "/account/x", {method: "POST", body: '{"a":1}'})
    const call = calls[0]
    expect(verified(call)).not.toBeNull()
    expect(verified({...call, body: '{"a":2}'})).toBeNull()
    expect(verified({...call, pathWithQuery: "/v1/portal/account/y"})).toBeNull()
    expect(verified({...call, method: "PUT"})).toBeNull()
  })

  test("correlates: Core's request id goes out, the module's comes back, and one line is logged without a body or query", async () => {
    configure()
    respond = request => Response.json({ok: true}, {headers: {"x-request-id": `module-${request.headers.get("x-request-id")}`}})
    const reply = await billing(as("member", member), "/account/x?token=hunter2", {headers: {"x-request-id": "rid-1"}})
    expect(calls[0].headers.get("x-request-id")).not.toBeNull()
    expect(reply.headers.get("x-request-id")).toBe(`module-${calls[0].headers.get("x-request-id")}`)
    const lines = logs.filter(line => line.message.includes("billing"))
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toBe("Portal module billing request forwarded")
    expect(lines[0].fields).toMatchObject({audience: "portal", status: 200, upstreamStatus: 200})
    expect(JSON.stringify(logs)).not.toContain("hunter2")
  })
})

describe("what the person receives", () => {
  test("an upstream 401 is a 403 with the module's body: a module's answer never means sign in again", async () => {
    configure()
    respond = () => Response.json({error: "billing_staff_only"}, {status: 401})
    const reply = await billing(as("member", member), "/account/x")
    expect([reply.status, await reply.json()]).toEqual([403, {error: "billing_staff_only"}])
  })

  test("other statuses and bodies pass through, with content-type, cache-control and retry-after only", async () => {
    configure()
    respond = () =>
      Response.json({error: "slow_down"}, {status: 429, headers: {"retry-after": "9", "x-secret": "1", "set-cookie": "a=b"}})
    const reply = await billing(as("member", member), "/account/x")
    expect([reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([429, {error: "slow_down"}, "9"])
    expect(reply.headers.get("x-secret")).toBeNull()
    expect(reply.headers.get("set-cookie")).toBeNull()
  })

  test("a 5xx, a redirect, an oversized body or a success that is not JSON is a 503 module_unavailable", async () => {
    configure()
    const failures: Array<[string, () => Response]> = [
      ["a 5xx", () => new Response("down", {status: 500})],
      ["a redirect", () => new Response(null, {status: 302, headers: {location: "https://elsewhere.example"}})],
      ["an oversized body", () => Response.json({pad: "x".repeat(11 * 1024 * 1024)})],
      ["html", () => new Response("<html></html>", {headers: {"content-type": "text/html"}})],
    ]
    for (const [name, answer] of failures) {
      respond = answer
      const reply = await billing(as("member", member), "/account/x")
      expect([name, reply.status, await reply.json()]).toEqual([name, 503, {error: "module_unavailable"}])
    }
  })

  test("a module that is down is a 503 module_unavailable", async () => {
    configure("prod", {CLOUD_CORE_BILLING_URL: "http://127.0.0.1:9"})
    const reply = await billing(as("member", member), "/account/x")
    expect([reply.status, await reply.json()]).toEqual([503, {error: "module_unavailable"}])
  })

  test("a body over the limit is a 413, and one that is not UTF-8 a 400, both without a call", async () => {
    configure()
    const big = await billing(as("member", member), "/account/x", {method: "POST", body: "x".repeat(1024 * 1024 + 1)})
    expect([big.status, await big.json()]).toEqual([413, {error: "payload_too_large"}])
    const bad = await billing(as("member", member), "/account/x", {method: "POST", body: new Uint8Array([0xff, 0xfe, 0x41])})
    expect([bad.status, await bad.json()]).toEqual([400, {error: "invalid_body"}])
    expect(calls).toHaveLength(0)
  })

  test("keeps the session cookie Core rotated", async () => {
    configure()
    const reply = await billing(as("member", member), "/account/x", {headers: {"x-test-set-cookie": "rotated=1; Path=/"}})
    expect(reply.headers.get("set-cookie")).toBe("rotated=1; Path=/")
  })
})

describe("paths", () => {
  test("a dot segment, an encoded separator, a control character or a double encoding is a 400 invalid_path, with no call", async () => {
    configure()
    const base = "http://localhost/api/portal/billing"
    for (const rest of [
      "/account/../workspaces/ws_2/x",
      "/account/./x",
      "/account/%2e%2e/x",
      "/account/a%2fb",
      "/account/a%5cb",
      "/account/a%00b",
      "/account/%252e",
      "/account/%zz",
      "/workspaces/ws_1/../../account/x",
      "/workspaces/ws_1%2f..%2fws_2/x",
      "/workspaces/%252e%252e/x",
    ]) {
      const reply = await root.fetch(rawUrlRequest(`${base}${rest}`, {"x-test-principal": as("member", member)}))
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 400, {error: "invalid_path"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("anything but exactly workspaces/<id>, account or ui is a 404, however the first segment is spelled", async () => {
    configure()
    for (const rest of ["", "/", "/nothing", "/Account/x", "/ACCOUNT", "/Workspaces/ws_1/x", "/UI/entry.js", "/%75i/entry.js", "//account/x", "/accounts/x", "/workspace/ws_1/x"]) {
      const reply = await root.fetch(
        rawUrlRequest(`http://localhost/api/portal/billing${rest}`, {"x-test-principal": as("admin", admin)}),
      )
      expect([rest, reply.status, (await errorBody(reply)).error]).toEqual([rest, 404, "not_found"])
    }
    expect(calls).toHaveLength(0)
  })
})

describe("UI assets", () => {
  test("GET /ui/<rest> is relayed from the module's /v1/portal/ui/<rest>, to anyone who may see the module, in no workspace", async () => {
    configure()
    respond = () =>
      new Response("export default {}", {headers: {"content-type": "text/javascript", etag: '"e1"', "cache-control": "no-cache"}})

    const reply = await billing(as("stranger", stranger), "/ui/entry.js?v=3")

    expect(reply.status).toBe(200)
    expect(await reply.text()).toBe("export default {}")
    expect(reply.headers.get("content-type")).toBe("text/javascript")
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
    expect(reply.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(reply.headers.get("etag")).toBe('"e1"')
    expect(reply.headers.get("content-security-policy")).toBeNull()
    expect(calls[0].pathWithQuery).toBe("/v1/portal/ui/entry.js?v=3")
    expect(verified()).toMatchObject({scope: {kind: "person"}})
    expect(authorizeSpy).not.toHaveBeenCalled()
  })

  test("a conditional request is passed through and a 304 relayed", async () => {
    configure()
    respond = request =>
      request.headers.get("if-none-match") === '"e1"' ? new Response(null, {status: 304, headers: {etag: '"e1"'}}) : new Response("x")
    const reply = await billing(as("member", member), "/ui/entry.js", {headers: {"if-none-match": '"e1"'}})
    expect(reply.status).toBe(304)
    expect(reply.headers.get("etag")).toBe('"e1"')
  })

  test("text/html is a 503 module_unavailable, never relayed", async () => {
    configure()
    respond = () => new Response("<script>alert(1)</script>", {headers: {"content-type": "text/html"}})
    const reply = await billing(as("member", member), "/ui/entry.js")
    expect([reply.status, await reply.json()]).toEqual([503, {error: "module_unavailable"}])
  })

  test("SVG is relayed only under Core's own policy", async () => {
    configure()
    respond = () => new Response("<svg/>", {headers: {"content-type": "image/svg+xml"}})
    const reply = await billing(as("member", member), "/ui/logo.svg")
    expect(reply.status).toBe(200)
    expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'")
  })

  test("only GET and HEAD: any other method is a 405 with no call", async () => {
    configure()
    expect((await billing(as("member", member), "/ui/entry.js", {method: "HEAD"})).status).toBe(200)
    calls = []
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const reply = await billing(as("member", member), "/ui/entry.js", {method, body: "{}"})
      expect([method, reply.status, reply.headers.get("allow")]).toEqual([method, 405, "GET, HEAD"])
    }
    expect(calls).toHaveLength(0)
  })

  test("is gated like the rest: a stranger to the module cannot probe it with a method it refuses", async () => {
    configure("staging")
    const reply = await billing(as("member", member), "/ui/entry.js", {method: "POST", body: "{}"})
    expect([reply.status, (await errorBody(reply)).error]).toEqual([404, "module_not_installed"])
  })
})

/**
 * `request` with another method but its body kept: what a server delivers for a `GET` or `HEAD` that carries one.
 * The `Request` constructor refuses to build that, so it is set on the instance.
 */
function withMethod(request: Request, method: string): Request {
  Object.defineProperty(request, "method", {value: method})
  return request
}

describe("billing's open reads outside prod", () => {
  const ENVIRONMENTS = ["dev", "staging", null, "production", ""] as const
  const png = () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {headers: {"content-type": "image/png", etag: '"i1"'}})
  const answerIcons = () => {
    respond = request => (new URL(request.url).pathname.includes("/ui/icons/") ? png() : Response.json({ok: true}))
  }

  /** Every way to ask for something that is not an open read, each with the method that does not make it one. */
  const CLOSED: Array<[method: string, rest: string]> = [
    // The rest of billing, whatever the family.
    ["GET", "/workspaces/ws_1/status"],
    ["GET", "/workspaces/ws_1/status?purchase=pur_1"],
    ["POST", "/workspaces/ws_1/purchase"],
    ["POST", "/workspaces/ws_1/session"],
    ["GET", "/workspaces/ws_1/summary"],
    ["POST", "/workspaces/ws_1/checkout"],
    ["GET", "/workspaces/ws_1"],
    ["GET", "/workspaces/ws_1/"],
    ["GET", "/account/status"],
    ["POST", "/account/purchase"],
    ["POST", "/account/session"],
    ["GET", "/account/summary"],
    ["GET", "/account"],
    ["GET", "/account/"],
    ["GET", "/ui/entry.js"],
    ["HEAD", "/ui/entry.js"],
    ["GET", "/ui/entry.js?v=1"],
    ["GET", "/ui/chunk-abc.js"],
    ["GET", "/ui/logo.svg"],
    ["GET", "/ui/catalog"],
    // A catalog is read with GET, and only GET.
    ["POST", "/workspaces/ws_1/catalog"],
    ["HEAD", "/workspaces/ws_1/catalog"],
    ["PUT", "/workspaces/ws_1/catalog"],
    ["PATCH", "/workspaces/ws_1/catalog"],
    ["DELETE", "/workspaces/ws_1/catalog"],
    ["OPTIONS", "/workspaces/ws_1/catalog"],
    ["POST", "/account/catalog"],
    ["HEAD", "/account/catalog"],
    ["PUT", "/account/catalog"],
    ["DELETE", "/account/catalog"],
    // The path is exact: a trailing slash, another case, an encoding, a deeper or a doubled path.
    ["GET", "/workspaces/ws_1/catalog/"],
    ["GET", "/workspaces/ws_1/Catalog"],
    ["GET", "/workspaces/ws_1/CATALOG"],
    ["GET", "/workspaces/ws_1/catalog/x"],
    ["GET", "/workspaces/ws_1/catalog/x/y"],
    ["GET", "/workspaces/ws_1/%63atalog"],
    ["GET", "/workspaces/ws_1/%43atalog"],
    ["GET", "/workspaces/ws_1/catalog%20"],
    ["GET", "/workspaces/ws_1/catalog;x"],
    ["GET", "/workspaces/ws_1/x/catalog"],
    ["GET", "/workspaces/ws_1//catalog"],
    ["GET", "/account/catalog/"],
    ["GET", "/account/Catalog"],
    ["GET", "/account/catalog/x"],
    ["GET", "/account/%63atalog"],
    ["GET", "/account//catalog"],
    // The family is part of the path: catalog is not an asset, an icon is not a scope's path.
    ["GET", "/workspaces/catalog"],
    ["GET", "/workspaces/ws_1/ui/icons/a.png"],
    ["GET", "/workspaces/ws_1/icons/a.png"],
    ["GET", "/account/icons/a.png"],
    ["GET", "/account/ui/icons/a.png"],
    // Nothing in the query or the case of the first segment makes a request another.
    ["GET", "/workspaces/ws_1/status?path=catalog"],
    ["GET", "/workspaces/ws_1/status?/catalog"],
    ["GET", "/account/status?x=/account/catalog"],
    ["GET", "/ui/entry.js?/icons/a.png"],
    ["GET", "/Account/catalog"],
    ["GET", "/UI/icons/a.png"],
    ["GET", "/%75i/icons/a.png"],
    ["GET", "/Workspaces/ws_1/catalog"],
    // Icons: one file under icons/, GET and HEAD only, exactly spelled.
    ["GET", "/ui/icons"],
    ["GET", "/ui/icons/"],
    ["GET", "/ui/iconsx/a.png"],
    ["GET", "/ui/Icons/a.png"],
    ["GET", "/ui/ICONS/a.png"],
    ["GET", "/ui/%69cons/a.png"],
    ["GET", "/ui/icons%2fa.png"],
    ["GET", "/ui/icons/a/b.png"],
    ["GET", "/ui/icons//a.png"],
    ["GET", "/ui/icons/a.png/"],
    ["GET", "/ui/icons/%61.png"],
    ["GET", "/ui/icons/a%20b.png"],
    ["GET", "/ui/x/icons/a.png"],
    ["POST", "/ui/icons/a.png"],
    ["PUT", "/ui/icons/a.png"],
    ["PATCH", "/ui/icons/a.png"],
    ["DELETE", "/ui/icons/a.png"],
    ["OPTIONS", "/ui/icons/a.png"],
  ]

  test("a member who is not staff reads a workspace's catalog, the person's, and the icons: forwarded, each with its scope", async () => {
    for (const environment of ENVIRONMENTS) {
      configure(environment)
      calls = []
      answerIcons()
      const workspaceCatalog = await billing(as("member", member), "/workspaces/ws_1/catalog?locale=en-US")
      expect([environment, workspaceCatalog.status]).toEqual([environment, 200])
      expect(calls[0].method).toBe("GET")
      expect(calls[0].pathWithQuery).toBe("/v1/portal/workspaces/ws_1/catalog?locale=en-US")
      expect(verified()).toEqual({
        kind: "user",
        mentraUserId: "mu_member",
        email: "mu_member@example.test",
        emailVerified: true,
        isOrganizationAdmin: false,
        organizationCapabilities: [],
        scope: {kind: "workspace", workspaceId: "ws_1"},
      })
      expect(authorizeSpy).toHaveBeenCalledWith(member, {workspaceId: "ws_1"})

      const accountCatalog = await billing(as("member", member), "/account/catalog?locale=en-US")
      expect([environment, accountCatalog.status]).toEqual([environment, 200])
      expect(calls[1].pathWithQuery).toBe("/v1/portal/account/catalog?locale=en-US")
      expect(verified()).toMatchObject({isOrganizationAdmin: false, scope: {kind: "person"}})

      const icon = await billing(as("member", member), "/ui/icons/mentra.call.unlimited.png")
      expect([environment, icon.status]).toEqual([environment, 200])
      expect(icon.headers.get("content-type")).toBe("image/png")
      expect(icon.headers.get("x-content-type-options")).toBe("nosniff")
      expect(icon.headers.get("cross-origin-resource-policy")).toBe("same-origin")
      expect(new Uint8Array(await icon.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
      expect(calls[2].method).toBe("GET")
      expect(calls[2].pathWithQuery).toBe("/v1/portal/ui/icons/mentra.call.unlimited.png")
      expect(verified()).toMatchObject({isOrganizationAdmin: false, scope: {kind: "person"}})

      const head = await billing(as("member", member), "/ui/icons/x.svg", {method: "HEAD"})
      expect([environment, head.status]).toEqual([environment, 200])
      expect(calls[3].pathWithQuery).toBe("/v1/portal/ui/icons/x.svg")
      expect(calls).toHaveLength(4)
    }
  })

  test("a person with no workspace reads the person's catalog and the icons too", async () => {
    configure("staging")
    answerIcons()
    expect((await billing(as("stranger", stranger), "/account/catalog")).status).toBe(200)
    expect((await billing(as("stranger", stranger), "/ui/icons/a.png")).status).toBe(200)
    expect(calls).toHaveLength(2)
  })

  test("everything else stays a 404 module_not_installed, with no call and no workspace lookup", async () => {
    for (const environment of ENVIRONMENTS) {
      configure(environment)
      for (const [method, rest] of CLOSED) {
        const reply = await billing(as("member", member), rest, {method, body: method === "POST" || method === "PUT" || method === "PATCH" ? "{}" : undefined})
        // A HEAD answer has no body.
        const answer = method === "HEAD" ? null : await reply.json()
        expect([environment, method, rest, reply.status, answer]).toEqual([
          environment,
          method,
          rest,
          404,
          method === "HEAD" ? null : {error: "module_not_installed"},
        ])
      }
    }
    expect(calls).toHaveLength(0)
    expect(authorizeSpy).not.toHaveBeenCalled()
  })

  test("a path Core refuses to forward is the same 404 to someone who is not staff, and a 400 to staff: no probing around the open reads", async () => {
    // Bun resolves a literal or encoded dot segment before Core sees the URL, so those arrive here only as a server
    // that does not would deliver them; the separators, controls and escapes below arrive raw either way.
    configure("staging")
    const base = "http://localhost/api/portal/billing"
    for (const rest of [
      "/workspaces/ws_1/catalog/../status",
      "/workspaces/ws_1/catalog/./",
      "/workspaces/ws_1/catalog%2f..%2fstatus",
      "/workspaces/ws_1/%2e%2e/catalog",
      "/workspaces/ws_1/catalog%00",
      "/workspaces/ws_1/catalog%zz",
      "/account/catalog/../status",
      "/account/%252e%252e/catalog",
      "/ui/icons/../entry.js",
      "/ui/icons/./a.png",
      "/ui/icons/%2e%2e/entry.js",
      "/ui/icons/..%2fentry.js",
      "/ui/icons/%252e%252e/entry.js",
      "/ui/icons/a%5cb",
      "/ui/icons/a%2fb",
    ]) {
      const hidden = await root.fetch(rawUrlRequest(`${base}${rest}`, {"x-test-principal": as("member", member)}))
      expect([rest, hidden.status, await hidden.json()]).toEqual([rest, 404, {error: "module_not_installed"}])
      const staff = await root.fetch(rawUrlRequest(`${base}${rest}`, {"x-test-principal": as("admin", admin)}))
      expect([rest, staff.status, await staff.json()]).toEqual([rest, 400, {error: "invalid_path"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("a catalog is for a member of its workspace: a non-member is a 403, an unknown or deleted workspace a 404, and nothing is called", async () => {
    configure("staging")
    for (const [name, rest, status, error] of [
      ["stranger", "/workspaces/ws_1/catalog", 403, "forbidden"],
      ["stranger", "/workspaces/ws_2/catalog", 403, "forbidden"],
      ["member", "/workspaces/ws_2/catalog", 403, "forbidden"],
      ["member", "/workspaces/ws_unknown/catalog", 404, "workspace_not_found"],
      ["member", "/workspaces/ws_gone/catalog", 404, "workspace_not_found"],
    ] as const) {
      const reply = await billing(as(name, name === "member" ? member : stranger), rest)
      const body = await errorBody(reply)
      expect([name, rest, reply.status, body.error]).toEqual([name, rest, status, error])
      if (status === 403) expect(body.reason).toBe("not_a_member")
    }
    expect(calls).toHaveLength(0)
  })

  test("an Organization Admin reads any workspace's catalog and every other path, as before", async () => {
    configure("staging")
    for (const rest of ["/workspaces/ws_2/catalog", "/workspaces/ws_2/status", "/account/status", "/ui/entry.js", "/ui/icons/a.png"]) {
      expect([rest, (await billing(as("admin", admin), rest)).status]).toEqual([rest, 200])
    }
    expect((await billing(as("admin", admin), "/workspaces/ws_2/purchase", {method: "POST", body: "{}"})).status).toBe(200)
    expect(calls).toHaveLength(6)
  })

  test("a workspace key, an operator key and nobody still get no open read", async () => {
    configure("staging")
    for (const name of [as("ws-key", workspaceKey), as("op-key", operatorKey)]) {
      for (const rest of ["/workspaces/ws_1/catalog", "/account/catalog", "/ui/icons/a.png"]) {
        const reply = await billing(name, rest)
        expect([name, rest, reply.status, (await errorBody(reply)).error]).toEqual([name, rest, 403, "forbidden"])
      }
    }
    for (const rest of ["/workspaces/ws_1/catalog", "/account/catalog", "/ui/icons/a.png"]) {
      const reply = await billing(null, rest)
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 401, {error: "unauthorized"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("on prod everything is forwarded, as before", async () => {
    configure("prod")
    answerIcons()
    const requests: Array<[string, string]> = [
      ["GET", "/workspaces/ws_1/catalog"],
      ["GET", "/workspaces/ws_1/status"],
      ["POST", "/workspaces/ws_1/purchase"],
      ["POST", "/workspaces/ws_1/session"],
      ["GET", "/workspaces/ws_1/summary"],
      ["POST", "/workspaces/ws_1/catalog"],
      ["GET", "/account/status"],
      ["GET", "/ui/entry.js"],
      ["GET", "/ui/icons/a.png"],
    ]
    for (const [method, rest] of requests) {
      const reply = await billing(as("member", member), rest, {method, body: method === "POST" ? "{}" : undefined})
      expect([method, rest, reply.status]).toEqual([method, rest, 200])
    }
    expect(calls).toHaveLength(requests.length)
  })

  test("a module that is not installed has no catalog and no icons: a 404 module_not_installed", async () => {
    // Nothing configured, whatever the environment.
    for (const environment of ["staging", "prod"]) {
      process.env.CLOUD_CORE_ENVIRONMENT = environment
      for (const rest of ["/workspaces/ws_1/catalog", "/account/catalog", "/ui/icons/a.png"]) {
        const reply = await billing(as("member", member), rest)
        expect([environment, rest, reply.status, await reply.json()]).toEqual([environment, rest, 404, {error: "module_not_installed"}])
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a module whose settings are unusable is a 503 for an open read and still a 404 for anything else", async () => {
    configure("staging", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
    for (const rest of ["/workspaces/ws_1/catalog", "/account/catalog", "/ui/icons/a.png"]) {
      const reply = await billing(as("member", member), rest)
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 503, {error: "module_unavailable"}])
    }
    for (const rest of ["/workspaces/ws_1/status", "/account/status", "/ui/entry.js"]) {
      const reply = await billing(as("member", member), rest)
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 404, {error: "module_not_installed"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("the body limit is applied exactly where the request is forwarded", async () => {
    const tooBig = "x".repeat(1024 * 1024 + 1)
    /** A request carrying `tooBig`, with the method it is to be seen under. */
    const carrying = (principal: string, method: string, rest: string) =>
      withMethod(
        new Request(`http://localhost/api/portal/billing${rest}`, {method: "POST", body: tooBig, headers: {"x-test-principal": principal}}),
        method,
      )
    const gated = new Set(["module_not_installed", "module_unavailable"])

    for (const [environment, extra] of [
      ["staging", {}],
      ["dev", {}],
      ["prod", {}],
      ["staging", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"}],
      ["prod", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"}],
    ] as const) {
      configure(environment, extra)
      // A HEAD answer has no body to read an error from; HEAD has a test of its own below.
      const requests: Array<[string, string]> = [
        ...CLOSED.filter(([method]) => method !== "HEAD"),
        ["GET", "/workspaces/ws_1/catalog"],
        ["GET", "/account/catalog"],
        ["GET", "/ui/icons/a.png"],
      ]
      for (const [name, principal] of [["member", member], ["admin", admin]] as const) {
        for (const [method, rest] of requests) {
          const key = as(name, principal)
          // Whether the request would be forwarded or refused: the answer without the large body.
          const bodyless = method === "GET" || method === "OPTIONS"
          const small = await root.fetch(
            new Request(`http://localhost/api/portal/billing${rest}`, {
              method,
              body: bodyless ? undefined : "{}",
              headers: {"x-test-principal": key},
            }),
          )
          const smallError = ((await small.json()) as {error?: string}).error
          const large = await root.fetch(carrying(key, method, rest))
          const largeBody = (await large.json()) as {error?: string}
          const expectation = gated.has(smallError ?? "") ? [small.status, smallError] : [413, "payload_too_large"]
          expect([environment, Object.keys(extra).length, name, method, rest, large.status, largeBody.error]).toEqual([
            environment,
            Object.keys(extra).length,
            name,
            method,
            rest,
            ...expectation,
          ])
        }
      }
    }
    // Nothing that was refused for its size reached the module.
    expect(calls.every(call => call.body.length < 1024)).toBe(true)
  })

  test("an open read carrying a body over the limit is a 413, and a closed one is not told there is a limit", async () => {
    configure("staging")
    const tooBig = "x".repeat(1024 * 1024 + 1)
    const send = async (method: string, rest: string) => {
      const request = new Request(`http://localhost/api/portal/billing${rest}`, {method: "POST", body: tooBig, headers: {"x-test-principal": as("member", member)}})
      return root.fetch(withMethod(request, method))
    }
    expect((await send("GET", "/workspaces/ws_1/catalog")).status).toBe(413)
    expect((await send("GET", "/ui/icons/a.png")).status).toBe(413)
    expect((await send("HEAD", "/ui/icons/a.png")).status).toBe(413)
    expect((await send("HEAD", "/ui/entry.js")).status).toBe(404)
    for (const [method, rest] of [
      ["GET", "/workspaces/ws_1/status"],
      ["POST", "/workspaces/ws_1/catalog"],
      ["GET", "/ui/entry.js"],
      ["GET", "/workspaces/ws_1/catalog/"],
    ] as const) {
      const reply = await send(method, rest)
      expect([method, rest, reply.status, await reply.json()]).toEqual([method, rest, 404, {error: "module_not_installed"}])
    }
    expect(calls).toHaveLength(0)
  })
})

describe("mounted in Core", () => {
  test("the portal's sign-in gate is in front: a request with no session is 401 and the module is not called", async () => {
    configure()
    const app = createApp({readinessChecks: []})
    for (const rest of ["/account/licenses", "/workspaces/ws_1/licenses", "/ui/entry.js"]) {
      const reply = await app.request(`http://localhost/api/portal/billing${rest}`)
      expect([rest, reply.status]).toEqual([rest, 401])
    }
    expect(calls).toHaveLength(0)
  })
})
