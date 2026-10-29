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
import type {AuthorizeResponse, ForwardedPrincipal} from "@mentra/workspace-contract"
import {FORWARDED_PRINCIPAL_HEADERS, verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import * as authorization from "../../services/workspaces/authorization.service"
import type {CorePrincipal, UserPrincipal} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import {createApp} from "../app"
import {portalModuleApi, portalModulePublicApi} from "./portal-modules.api"

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

/** Points Core at the stub as a Core whose environment is `environment` (null: unset). */
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
// As Core mounts them: the public reads ahead of the portal's person gate, the module behind it.
root.route("/api/portal/billing/public", portalModulePublicApi("billing"))
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

/** The principal of a public read: Core sent it, for nobody. */
const anyone: ForwardedPrincipal = {kind: "public", scope: {kind: "public"}}

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
      for (const rest of ["/workspaces/ws_1/licenses", "/ui/entry.js", "/nothing"]) {
        const reply = await billing(null, rest)
        expect([rest, reply.status, await reply.json()]).toEqual([rest, 401, {error: "unauthorized"}])
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a workspace key or an operator key is 403, even for its own workspace", async () => {
    configure("prod")
    for (const name of [as("ws-key", workspaceKey), as("op-key", operatorKey)]) {
      for (const rest of ["/workspaces/ws_1/licenses", "/ui/entry.js"]) {
        const reply = await billing(name, rest)
        expect([name, rest, reply.status, (await errorBody(reply)).error]).toEqual([name, rest, 403, "forbidden"])
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a module that is not installed is a 404 after authentication, for every path and method", async () => {
    for (const rest of ["/workspaces/ws_1/licenses", "/ui/entry.js", "/nothing"]) {
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

  test("an installed module whose settings are unusable is a 503 for every person, on every Core", async () => {
    for (const environment of ["prod", "staging"]) {
      configure(environment, {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
      const reply = await billing(as("member", member), "/workspaces/ws_1/licenses")
      expect([environment, reply.status, await reply.json()]).toEqual([environment, 503, {error: "module_unavailable"}])
      delete process.env.CLOUD_CORE_BILLING_SECRET
      process.env.CLOUD_CORE_BILLING_URL = `http://127.0.0.1:${module_.port}`
      const noSecret = await billing(as("member", member), "/ui/entry.js")
      expect([environment, noSecret.status, await noSecret.json()]).toEqual([environment, 503, {error: "module_unavailable"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("Core's own answers are labelled as data", async () => {
    for (const reply of [await billing(null, "/workspaces/ws_1/x"), await billing(as("member", member), "/workspaces/ws_1/x")]) {
      expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
      expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    }
  })
})

describe("billing on every Core", () => {
  test("on dev and staging a person who is not an Organization Admin is forwarded, as on prod", async () => {
    for (const environment of ["prod", "staging", "dev", "production", "local", "", null]) {
      configure(environment)
      calls = []
      for (const rest of ["/workspaces/ws_1/licenses", "/workspaces/ws_1/catalog", "/ui/entry.js", "/ui/icons/a.png"]) {
        const reply = await billing(as("member", member), rest)
        expect([environment, rest, reply.status]).toEqual([environment, rest, 200])
      }
      const purchase = await billing(as("member", member), "/workspaces/ws_1/purchase", {method: "POST", body: "{}"})
      expect([environment, purchase.status]).toEqual([environment, 200])
      expect(calls).toHaveLength(5)
      expect(verified()).toMatchObject({isOrganizationAdmin: false, scope: {kind: "workspace", workspaceId: "ws_1"}})
    }
  })

  test("a body over the limit is a 413 for everyone, and is not read where the module is absent or broken", async () => {
    const tooBig = "x".repeat(1024 * 1024 + 1)
    for (const environment of ["prod", "staging", "dev"]) {
      configure(environment)
      for (const [name, principal] of [["member", member], ["admin", admin]] as const) {
        const reply = await billing(as(name, principal), "/workspaces/ws_1/checkout", {method: "POST", body: tooBig})
        expect([environment, name, reply.status, await reply.json()]).toEqual([environment, name, 413, {error: "payload_too_large"}])
      }
    }
    for (const env of ENV_KEYS) delete process.env[env]
    const absent = await billing(as("member", member), "/workspaces/ws_1/checkout", {method: "POST", body: tooBig})
    expect([absent.status, await absent.json()]).toEqual([404, {error: "module_not_installed"}])
    configure("staging", {CLOUD_CORE_BILLING_URL: "ftp://nope.example.test"})
    const broken = await billing(as("member", member), "/workspaces/ws_1/checkout", {method: "POST", body: tooBig})
    expect([broken.status, await broken.json()]).toEqual([503, {error: "module_unavailable"}])
    expect(calls).toHaveLength(0)
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

describe("billing's account routes are gone", () => {
  /** Every request the person-scoped family took: its reads, its writes and the family itself. */
  const ACCOUNT: Array<[method: string, rest: string]> = [
    ["GET", "/account/catalog"],
    ["GET", "/account/catalog?locale=en-US"],
    ["GET", "/account/status"],
    ["GET", "/account/status?purchase=pur_1"],
    ["GET", "/account/licenses"],
    ["POST", "/account/purchase"],
    ["POST", "/account/session"],
    ["POST", "/account/checkout"],
    ["GET", "/account"],
    ["GET", "/account/"],
  ]

  test("/account/* is a 404 not_found for everyone, on prod and on a test Core, and nothing is called", async () => {
    for (const environment of ["prod", "staging", "dev", null] as const) {
      configure(environment)
      for (const [name, principal] of [["member", member], ["admin", admin], ["stranger", stranger]] as const) {
        // Billing is installed: the path is simply none of its routes.
        const error = "not_found"
        for (const [method, rest] of ACCOUNT) {
          const reply = await billing(as(name, principal), rest, {method, ...(method === "POST" ? {body: "{}"} : {})})
          expect([environment, name, method, rest, reply.status, await reply.json()]).toEqual([
            environment,
            name,
            method,
            rest,
            404,
            {error},
          ])
        }
      }
    }
    expect(calls).toHaveLength(0)
    expect(authorizeSpy).not.toHaveBeenCalled()
  })
})

describe("what the module receives", () => {
  test("only content-type and accept of the caller's headers; nothing under x-mentra-*, cookie or authorization", async () => {
    configure()
    await billing(as("member", member), "/workspaces/ws_1/x", {
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
    await billing(as("member", member), "/workspaces/ws_1/x", {method: "POST", body: '{"a":1}'})
    const call = calls[0]
    expect(verified(call)).not.toBeNull()
    expect(verified({...call, body: '{"a":2}'})).toBeNull()
    expect(verified({...call, pathWithQuery: "/v1/portal/workspaces/ws_1/y"})).toBeNull()
    expect(verified({...call, method: "PUT"})).toBeNull()
  })

  test("correlates: Core's request id goes out, the module's comes back, and one line is logged without a body or query", async () => {
    configure()
    respond = request => Response.json({ok: true}, {headers: {"x-request-id": `module-${request.headers.get("x-request-id")}`}})
    const reply = await billing(as("member", member), "/workspaces/ws_1/x?token=hunter2", {headers: {"x-request-id": "rid-1"}})
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
    respond = () => Response.json({error: "forbidden"}, {status: 401})
    const reply = await billing(as("member", member), "/workspaces/ws_1/x")
    expect([reply.status, await reply.json()]).toEqual([403, {error: "forbidden"}])
  })

  test("other statuses and bodies pass through, with content-type, cache-control and retry-after only", async () => {
    configure()
    respond = () =>
      Response.json({error: "slow_down"}, {status: 429, headers: {"retry-after": "9", "x-secret": "1", "set-cookie": "a=b"}})
    const reply = await billing(as("member", member), "/workspaces/ws_1/x")
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
      const reply = await billing(as("member", member), "/workspaces/ws_1/x")
      expect([name, reply.status, await reply.json()]).toEqual([name, 503, {error: "module_unavailable"}])
    }
  })

  test("a module that is down is a 503 module_unavailable", async () => {
    configure("prod", {CLOUD_CORE_BILLING_URL: "http://127.0.0.1:9"})
    const reply = await billing(as("member", member), "/workspaces/ws_1/x")
    expect([reply.status, await reply.json()]).toEqual([503, {error: "module_unavailable"}])
  })

  test("a body over the limit is a 413, and one that is not UTF-8 a 400, both without a call", async () => {
    configure()
    const big = await billing(as("member", member), "/workspaces/ws_1/x", {method: "POST", body: "x".repeat(1024 * 1024 + 1)})
    expect([big.status, await big.json()]).toEqual([413, {error: "payload_too_large"}])
    const bad = await billing(as("member", member), "/workspaces/ws_1/x", {method: "POST", body: new Uint8Array([0xff, 0xfe, 0x41])})
    expect([bad.status, await bad.json()]).toEqual([400, {error: "invalid_body"}])
    expect(calls).toHaveLength(0)
  })

  test("keeps the session cookie Core rotated", async () => {
    configure()
    const reply = await billing(as("member", member), "/workspaces/ws_1/x", {headers: {"x-test-set-cookie": "rotated=1; Path=/"}})
    expect(reply.headers.get("set-cookie")).toBe("rotated=1; Path=/")
  })
})

describe("what a cache may keep", () => {
  const icon = (headers: Record<string, string> = {}) =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {headers: {"content-type": "image/png", ...headers}})

  test("a forwarded answer the module set no cache-control on is private, no-store: one address answers each viewer for themselves", async () => {
    configure("staging")
    const reads: Array<[who: string, principal: UserPrincipal, method: string, rest: string]> = [
      ["member", member, "GET", "/workspaces/ws_1/catalog?locale=en-US"],
      ["member", member, "GET", "/workspaces/ws_1/status"],
      ["member", member, "POST", "/workspaces/ws_1/purchase"],
      ["admin", admin, "GET", "/workspaces/ws_1/catalog"],
      ["admin", admin, "GET", "/workspaces/ws_2/status?purchase=pur_1"],
    ]
    for (const [who, principal, method, rest] of reads) {
      const reply = await billing(as(who, principal), rest, {method, ...(method === "POST" ? {body: "{}"} : {})})
      expect([who, method, rest, reply.status, reply.headers.get("cache-control")]).toEqual([
        who,
        method,
        rest,
        200,
        "private, no-store",
      ])
    }
    expect(calls).toHaveLength(reads.length)

    // On prod too, and for an error the module relays or a failure Core reports.
    configure("prod")
    expect((await billing(as("member", member), "/workspaces/ws_1/status")).headers.get("cache-control")).toBe(
      "private, no-store",
    )
    respond = () => Response.json({error: "slow_down"}, {status: 429, headers: {"retry-after": "9"}})
    const relayed = await billing(as("member", member), "/workspaces/ws_1/catalog")
    expect([relayed.status, relayed.headers.get("cache-control")]).toEqual([429, "private, no-store"])
    respond = () => new Response("down", {status: 500})
    const failed = await billing(as("member", member), "/workspaces/ws_1/catalog")
    expect([failed.status, failed.headers.get("cache-control")]).toEqual([503, "private, no-store"])
  })

  test("a cache-control the module sets is relayed as it sent it", async () => {
    configure("staging")
    for (const cacheControl of ["private, max-age=30", "no-cache", "no-store"]) {
      respond = () => Response.json({ok: true}, {headers: {"cache-control": cacheControl}})
      const catalog = await billing(as("member", member), "/workspaces/ws_1/catalog")
      expect([cacheControl, catalog.headers.get("cache-control")]).toEqual([cacheControl, cacheControl])
    }
  })

  test("icons and the rest of the UI keep what the module sends, which is the same for everyone", async () => {
    configure("staging")
    respond = () => icon({"cache-control": "public, max-age=86400, immutable"})
    const cached = await billing(as("member", member), "/ui/icons/mentra.call.unlimited.png")
    expect([cached.status, cached.headers.get("cache-control")]).toEqual([200, "public, max-age=86400, immutable"])
    const head = await billing(as("member", member), "/ui/icons/mentra.call.unlimited.png", {method: "HEAD"})
    expect([head.status, head.headers.get("cache-control")]).toEqual([200, "public, max-age=86400, immutable"])

    // With none from the module, Core adds none.
    respond = () => icon()
    const plain = await billing(as("member", member), "/ui/icons/a.png")
    expect([plain.status, plain.headers.get("cache-control")]).toEqual([200, null])
    respond = () => new Response("export default {}", {headers: {"content-type": "text/javascript"}})
    const bundle = await billing(as("admin", admin), "/ui/entry.js")
    expect([bundle.status, bundle.headers.get("cache-control")]).toEqual([200, null])
  })
})

describe("paths", () => {
  test("a dot segment, an encoded separator, a control character or a double encoding is a 400 invalid_path, with no call", async () => {
    configure()
    const base = "http://localhost/api/portal/billing"
    for (const rest of [
      "/workspaces/ws_1/../ws_2/x",
      "/workspaces/ws_1/./x",
      "/workspaces/ws_1/%2e%2e/x",
      "/workspaces/ws_1/a%2fb",
      "/workspaces/ws_1/a%5cb",
      "/workspaces/ws_1/a%00b",
      "/workspaces/ws_1/%252e",
      "/workspaces/ws_1/%zz",
      "/workspaces/ws_1/../../ui/x",
      "/workspaces/ws_1%2f..%2fws_2/x",
      "/workspaces/%252e%252e/x",
    ]) {
      const reply = await root.fetch(rawUrlRequest(`${base}${rest}`, {"x-test-principal": as("member", member)}))
      expect([rest, reply.status, await reply.json()]).toEqual([rest, 400, {error: "invalid_path"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("anything but exactly workspaces/<id> or ui is a 404, however the first segment is spelled", async () => {
    configure()
    for (const rest of [
      "",
      "/",
      "/nothing",
      "/account",
      "/account/x",
      "/account/catalog",
      "/Account/x",
      "/ACCOUNT",
      "/Workspaces/ws_1/x",
      "/UI/entry.js",
      "/%75i/entry.js",
      "//account/x",
      "/accounts/x",
      "/workspace/ws_1/x",
    ]) {
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

  test("is gated like the rest: a module that is not installed is a 404 for a method it refuses too", async () => {
    const reply = await billing(as("member", member), "/ui/entry.js", {method: "POST", body: "{}"})
    expect([reply.status, (await errorBody(reply)).error]).toEqual([404, "module_not_installed"])
  })
})

describe("a product's public name", () => {
  const PRODUCT = "mentra.call.unlimited"
  const NAME_PATH = `/public/products/${PRODUCT}`
  const named = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) => () =>
    Response.json({name: "Mentra Call Unlimited", ...extra}, {headers})

  test("anyone reads it, signed in or not, on every Core: forwarded with the public principal, and only the name comes back", async () => {
    respond = named()
    for (const environment of ["prod", "staging", "dev", null] as const) {
      configure(environment)
      for (const [who, principal] of [["nobody", null], ["member", member], ["stranger", stranger], ["admin", admin]] as const) {
        calls = []
        const reply = await billing(principal ? as(who, principal) : null, NAME_PATH)
        expect([environment, who, reply.status, await reply.json()]).toEqual([environment, who, 200, {name: "Mentra Call Unlimited"}])
        expect(reply.headers.get("cache-control")).toBe("public, max-age=300")
        expect(reply.headers.get("content-type")).toStartWith("application/json")
        expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
        expect(calls).toHaveLength(1)
        expect([calls[0]!.method, calls[0]!.pathWithQuery]).toEqual(["GET", `/v1/portal/public/products/${PRODUCT}`])
        expect(verified()).toEqual(anyone)
      }
    }
  })

  test("no person reaches billing: not the signed-in one, nor anything the browser sends", async () => {
    configure("staging")
    respond = named()
    const reply = await billing(as("admin", admin), `${NAME_PATH}?mentraUserId=mu_admin&workspaceId=ws_1`, {
      headers: {
        cookie: "mentra_portal_session=abc",
        authorization: "Bearer token",
        "x-mentra-principal": "forged",
        "x-mentra-principal-signature": "forged",
        "x-forwarded-for": "203.0.113.9",
        accept: "application/json",
      },
    })
    expect(reply.status).toBe(200)
    const call = calls.at(-1)!
    // The query is not forwarded: the name is the same for everyone, whatever the address carries.
    expect(call.pathWithQuery).toBe(`/v1/portal/public/products/${PRODUCT}`)
    expect(call.headers.get("cookie")).toBeNull()
    expect(call.headers.get("authorization")).toBeNull()
    expect(call.headers.get("x-forwarded-for")).toBeNull()
    expect(call.headers.get("accept")).toBe("application/json")
    const header = call.headers.get(FORWARDED_PRINCIPAL_HEADERS.principal)!
    expect(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).toEqual(anyone)
    for (const [, value] of call.headers) {
      for (const leak of ["mu_admin", "mu_admin@example.test", "forged"]) expect(value).not.toContain(leak)
    }
    expect(verified()).toEqual(anyone)
  })

  test("Core relays the name and nothing else, cached by anyone for five minutes", async () => {
    configure()
    respond = named(
      {product: PRODUCT, priceId: "price_123", offer: {price: {scheme: "per_seat", unit: {amount: 1000, currency: "USD"}}}},
      {"cache-control": "private, no-store", "retry-after": "30", "set-cookie": "a=b"},
    )
    const reply = await billing(null, NAME_PATH)
    expect([reply.status, await reply.text()]).toEqual([200, JSON.stringify({name: "Mentra Call Unlimited"})])
    expect(reply.headers.get("cache-control")).toBe("public, max-age=300")
    expect(reply.headers.get("retry-after")).toBeNull()
    expect(reply.headers.get("set-cookie")).toBeNull()
  })

  test("a product billing doesn't name is a 404, and anything else billing answers is a 503: never its body", async () => {
    configure()
    respond = () => Response.json({error: "not_found", detail: "secret"}, {status: 404, headers: {"cache-control": "public, max-age=86400"}})
    const missing = await billing(null, NAME_PATH)
    expect([missing.status, await missing.json(), missing.headers.get("cache-control")]).toEqual([404, {error: "not_found"}, "no-store"])

    for (const answer of [
      () => Response.json({error: "forbidden"}, {status: 403}),
      () => Response.json({error: "forbidden"}, {status: 401}),
      () => Response.json({error: "slow_down"}, {status: 429}),
      () => Response.json({error: "invalid_request"}, {status: 400}),
      () => new Response(null, {status: 204}),
      () => Response.json({name: "x"}, {status: 201}),
      () => new Response("down", {status: 500}),
      () => new Response(null, {status: 302, headers: {location: "https://elsewhere.example"}}),
      () => new Response("<html>", {headers: {"content-type": "text/html"}}),
      () => new Response("not json", {headers: {"content-type": "application/json"}}),
      () => Response.json({}),
      () => Response.json({name: ""}),
      () => Response.json({name: 7}),
      () => Response.json(["Mentra Call"]),
      () => Response.json(null),
    ]) {
      respond = answer
      const reply = await billing(null, NAME_PATH)
      const body = await reply.json()
      expect([String(answer), reply.status, body, reply.headers.get("cache-control")]).toEqual([
        String(answer),
        503,
        {error: "module_unavailable"},
        "no-store",
      ])
    }
  })

  test("every other method, spelling and extra segment is a 404 with no call, its body unread", async () => {
    configure()
    const closed: Array<[method: string, rest: string]> = [
      ["HEAD", NAME_PATH],
      ["POST", NAME_PATH],
      ["PUT", NAME_PATH],
      ["PATCH", NAME_PATH],
      ["DELETE", NAME_PATH],
      ["OPTIONS", NAME_PATH],
      ["GET", "/public"],
      ["GET", "/public/"],
      ["GET", "/public/products"],
      ["GET", "/public/products/"],
      ["GET", `/public/products/${PRODUCT}/`],
      ["GET", `/public/products/${PRODUCT}/name`],
      ["GET", `/public/products//${PRODUCT}`],
      ["GET", `/public//products/${PRODUCT}`],
      ["GET", `/public/products/Mentra.Call.Unlimited`],
      ["GET", `/public/Products/${PRODUCT}`],
      ["GET", `/public/product/${PRODUCT}`],
      ["GET", `/public/catalog/${PRODUCT}`],
      ["GET", `/public/products/%6dentra.call.unlimited`],
      ["GET", `/public/products/mentra%2ecall`],
      ["GET", `/public/products/a%2fb`],
      ["GET", `/public/products/a%20b`],
      ["GET", `/public/products/%2e%2e`],
      ["GET", `/public/products/...`],
      ["GET", `/public/products/a;b`],
      ["GET", `/public/products/${"a".repeat(101)}`],
      ["GET", `/public/%70roducts/${PRODUCT}`],
      ["GET", `/public/ui/icons/a.png`],
    ]
    for (const [method, rest] of closed) {
      for (const principal of [null, as("admin", admin)]) {
        const big = method === "GET" || method === "HEAD" ? {} : {body: "x".repeat(2 * 1024 * 1024)}
        const reply = await billing(principal, rest, {method, ...big})
        expect([method, rest, principal, reply.status]).toEqual([method, rest, principal, 404])
        if (method !== "HEAD") expect(await reply.json()).toEqual({error: "module_not_installed"})
      }
    }
    expect(calls).toHaveLength(0)
  })

  test("a dot segment that reaches Core unresolved is no product either", async () => {
    configure()
    for (const raw of [`/public/products/..`, `/public/products/.`, `/public/products/../products/${PRODUCT}`]) {
      const reply = await root.fetch(rawUrlRequest(`http://localhost/api/portal/billing${raw}`, {}))
      expect([raw, reply.status]).toEqual([raw, 404])
    }
    expect(calls).toHaveLength(0)
  })

  test("a module that is not installed has no public names, and one whose settings are unusable is a 503", async () => {
    const missing = await billing(null, NAME_PATH)
    expect([missing.status, await missing.json()]).toEqual([404, {error: "module_not_installed"}])
    configure("prod", {CLOUD_CORE_BILLING_URL: "ftp://nope"})
    const broken = await billing(null, NAME_PATH)
    expect([broken.status, await broken.json(), broken.headers.get("cache-control")]).toEqual([503, {error: "module_unavailable"}, "no-store"])
    const brokenOther = await billing(null, "/public/products/A")
    expect([brokenOther.status, await brokenOther.json()]).toEqual([404, {error: "module_not_installed"}])
    expect(calls).toHaveLength(0)
  })

  test("is logged once, as a public request, without the product", async () => {
    configure()
    respond = named()
    await billing(null, NAME_PATH)
    const lines = logs.filter(line => line.message === "Portal module billing request forwarded")
    expect(lines).toHaveLength(1)
    expect(lines[0]!.fields.audience).toBe("public")
    expect(JSON.stringify(lines[0]!.fields)).not.toContain(PRODUCT)
  })
})

describe("mounted in Core", () => {
  test("the portal's sign-in gate is in front: a request with no session is 401 and the module is not called", async () => {
    configure()
    const app = createApp({readinessChecks: []})
    for (const rest of ["/workspaces/ws_1/licenses", "/ui/entry.js"]) {
      const reply = await app.request(`http://localhost/api/portal/billing${rest}`)
      expect([rest, reply.status]).toEqual([rest, 401])
    }
    expect(calls).toHaveLength(0)
  })

  test("a product's public name is ahead of the gate: read with no session, and no other spelling gets through", async () => {
    configure("staging")
    respond = () => Response.json({name: "Mentra Call Unlimited"})
    const app = createApp({readinessChecks: []})
    const reply = await app.request("http://localhost/api/portal/billing/public/products/mentra.call.unlimited")
    expect([reply.status, await reply.json()]).toEqual([200, {name: "Mentra Call Unlimited"}])
    expect(calls).toHaveLength(1)
    expect(verified()).toEqual(anyone)

    // Every other spelling is refused: by the public route itself (404), or, for one that is not under its exact
    // mount, by the person gate (401). Neither forwards.
    for (const rest of [
      "/public/products/Mentra.call.unlimited",
      "/public/products/mentra.call.unlimited/x",
      "/public/%70roducts/mentra.call.unlimited",
      "/%70ublic/products/mentra.call.unlimited",
      "/Public/products/mentra.call.unlimited",
      "/PUBLIC/products/mentra.call.unlimited",
      "/publicx/products/mentra.call.unlimited",
      "/public",
    ]) {
      const refused = await app.request(`http://localhost/api/portal/billing${rest}`)
      expect([rest, [401, 404].includes(refused.status)]).toEqual([rest, true])
    }
    const head = await app.request("http://localhost/api/portal/billing/public/products/mentra.call.unlimited", {method: "HEAD"})
    expect(head.status).toBe(404)
    expect(calls).toHaveLength(1)
  })
})
