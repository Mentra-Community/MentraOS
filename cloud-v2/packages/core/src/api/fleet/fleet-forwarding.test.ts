/**
 * @fileoverview The Fleet forwarding seam against a stub upstream, without a database.
 *
 * The stub is a real `Bun.serve` on loopback, so the request Core sends (headers, signature, body)
 * and the way it handles a slow, failing or redirecting upstream are the real thing. Phones sign in
 * with a bearer that `verifyAccessToken` (stubbed) accepts; people reach the admin surface as the
 * principal a test places on the context, which `principalAuth` accepts as already resolved (as the
 * admin API tests do). `createApp` is used only to pin that the routes are mounted behind their gates.
 * `tests/fleet-forwarding.integration.test.ts` runs the same seam against real sign-ins and Mongo.
 */

import {createHmac} from "node:crypto"
import type {Logger} from "@mentra/cloud-shared"
import {OPERATOR_KEY_SCOPES, ORGANIZATION_CAPABILITIES} from "@mentra/workspace-contract"
import {
  FORWARDED_PRINCIPAL_HEADERS,
  SERVICE_HEADERS,
  verifyForwardedPrincipal,
  verifyServiceRequest,
} from "@mentra/workspace-contract/server"
import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {Hono} from "hono"
import * as trustedEmail from "../../services/account/trusted-email.service"
import {resetPhoneEmailCache} from "../../services/fleet/phone-email"
import * as sessions from "../../services/session.service"
import type {CorePrincipal} from "../../services/signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import {InvalidGrant} from "../../types/oauth.types"
import adminApi from "../admin/admin.api"
import {createApp} from "../app"
import {requestContext} from "../middleware/context.middleware"
import {clientFleetApi, upstreamTarget} from "./fleet-forwarding"

const FLEET_HEADERS = FORWARDED_PRINCIPAL_HEADERS

const SECRET = "fleet-secret-for-tests"

const ENV_KEYS = [
  "CLOUD_CORE_FLEET_URL",
  "CLOUD_CORE_FLEET_SECRET",
  "CLOUD_CORE_FLEET_MAX_BODY_BYTES",
  "CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES",
  "CLOUD_CORE_FLEET_TIMEOUT_MS",
  "CLOUD_CORE_ENABLED_FEATURES",
  "CLOUD_CORE_ENVIRONMENT",
  "NODE_ENV",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

interface Captured {
  method: string
  /** The request target exactly as it arrived on the wire: path and query, no origin. */
  pathWithQuery: string
  headers: Headers
  body: string
}

let calls: Captured[] = []
let respond: (request: Request, captured: Captured) => Response | Promise<Response> = () => Response.json({ok: true})

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const origin = new URL(request.url).origin
    const captured = {
      method: request.method,
      pathWithQuery: request.url.slice(origin.length),
      headers: request.headers,
      body: await request.text(),
    }
    calls.push(captured)
    return respond(request, captured)
  },
})

const upstreamUrl = () => `http://127.0.0.1:${upstream.port}`

function configure(env: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}) {
  process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
  process.env.CLOUD_CORE_FLEET_SECRET = SECRET
  for (const [key, value] of Object.entries(env)) process.env[key] = value
}

interface LogLine {
  level: string
  fields: Record<string, unknown>
  message: string
}
let logs: LogLine[] = []

/** A logger that records what it is given, bound to `bound` as `requestContext` binds the request id. */
function recordingLogger(bound: Record<string, unknown>): Logger {
  const record = (level: string) => (fields: unknown, message?: string) => {
    logs.push({level, fields: {...bound, ...(fields as Record<string, unknown>)}, message: message ?? ""})
  }
  return {debug: record("debug"), info: record("info"), warn: record("warn"), error: record("error")} as unknown as Logger
}

let verifyAccess: ReturnType<typeof spyOn<typeof sessions, "verifyAccessToken">>
let emailLookup: ReturnType<typeof spyOn<typeof trustedEmail, "trustedAccountEmail">>

beforeEach(() => {
  calls = []
  logs = []
  respond = () => Response.json({ok: true})
  for (const key of ENV_KEYS) delete process.env[key]
  resetPhoneEmailCache()
  // A phone's access token is `phone:<mentraUserId>`; anything else is not one.
  verifyAccess = spyOn(sessions, "verifyAccessToken").mockImplementation(async token => {
    if (!token.startsWith("phone:")) throw new InvalidGrant("access_token rejected")
    return {mentraUserId: token.slice("phone:".length), tenantId: "tenant_1", sessionId: "sess_1", jti: "jti_1", exp: 0}
  })
  emailLookup = spyOn(trustedEmail, "trustedAccountEmail").mockResolvedValue("phone@example.test")
})

afterEach(() => {
  verifyAccess.mockRestore()
  emailLookup.mockRestore()
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

afterAll(() => {
  upstream.stop(true)
})

function person(isOrganizationAdmin: boolean, overrides: Partial<CorePrincipal> = {}): CorePrincipal {
  return {
    kind: "user",
    mentraUserId: "mu_1",
    tenantId: "mentra",
    email: "person@example.test",
    emailVerified: true,
    isOrganizationAdmin,
    via: "session",
    ...overrides,
  } as CorePrincipal
}

function key(credentialKind: "organization" | "workspace", scopes: string[]): CorePrincipal {
  return {
    kind: "credential",
    credentialId: "01HZKEY",
    credentialKind,
    workspaceId: credentialKind === "workspace" ? "ws_1" : null,
    scopes,
    packageNames: ["com.example.app"],
    label: "ci key",
  }
}

const principals = new Map<string, CorePrincipal>()

const root = new Hono<AppEnv>()
root.use("*", async (c, next) => {
  const principal = principals.get(c.req.header("x-test-principal") ?? "")
  if (principal) c.set("principal", principal)
  const reqId = c.get("reqId")
  c.set("logger", recordingLogger(reqId ? {reqId} : {}))
  await next()
})
root.route("/api/client/fleet", clientFleetApi)
root.route("/api/admin", adminApi)

function as(name: string, principal: CorePrincipal): string {
  principals.set(name, principal)
  return name
}

type Init = Omit<RequestInit, "headers"> & {headers?: Record<string, string>}

/** A request from a signed-in phone to `/api/client/fleet<rest>`. `user` is the phone's Mentra user. */
function phone(rest: string, init: Init & {user?: string} = {}) {
  const {user = "mu_phone", ...request} = init
  return root.request(`http://localhost/api/client/fleet${rest}`, {
    ...request,
    headers: {authorization: `Bearer phone:${user}`, ...init.headers},
  })
}

/** A request from an admin-surface principal to `/api/admin/fleet<rest>`; `null` is nobody. */
function admin(principal: string | null, rest: string, init: Init = {}) {
  return root.request(`http://localhost/api/admin/fleet${rest}`, {
    ...init,
    headers: {...(principal ? {"x-test-principal": principal} : {}), ...init.headers},
  })
}

/** A request whose URL is exactly `rawUrl`: the `Request` constructor would collapse `..` segments. */
function rawUrlRequest(rawUrl: string, headers: Record<string, string>): Request {
  const request = new Request("http://localhost/", {headers})
  Object.defineProperty(request, "url", {value: rawUrl})
  return request
}

const decodePrincipal = (header: string | null) => JSON.parse(Buffer.from(header ?? "", "base64url").toString())

const principalSignature = (secret: string, timestamp: string, principal: string) =>
  createHmac("sha256", secret).update(`${timestamp}\n${principal}`).digest("base64url")

function serviceSignatureVerifies(call: Captured): boolean {
  return verifyServiceRequest({
    secrets: [SECRET],
    method: call.method,
    pathWithQuery: call.pathWithQuery,
    body: call.body,
    timestampMs: Number(call.headers.get(SERVICE_HEADERS.timestamp)),
    signature: call.headers.get(SERVICE_HEADERS.signature) ?? "",
    nowMs: Date.now(),
  })
}

function principalSignatureVerifies(call: Captured, swap: {principal?: string; timestamp?: string} = {}): boolean {
  const expected = principalSignature(
    SECRET,
    swap.timestamp ?? call.headers.get(SERVICE_HEADERS.timestamp) ?? "",
    swap.principal ?? call.headers.get(FLEET_HEADERS.principal) ?? "",
  )
  return expected === call.headers.get(FLEET_HEADERS.principalSignature)
}

const verifies = (call: Captured) =>
  verifyForwardedPrincipal(
    {method: call.method, pathWithQuery: call.pathWithQuery, body: call.body, headers: call.headers},
    [SECRET],
  )

describe("what Core sends to Fleet", () => {
  test("a phone request reaches /v1/client with a valid service signature and its principal", async () => {
    configure()
    respond = () => Response.json({devices: []}, {headers: {"cache-control": "no-store"}})

    const response = await phone("/devices/42?state=online&label=a%20b", {headers: {accept: "application/json"}})

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({devices: []})
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.method).toBe("GET")
    expect(call.pathWithQuery).toBe("/v1/client/devices/42?state=online&label=a%20b")
    expect(call.headers.get("accept")).toBe("application/json")
    expect(call.headers.get(SERVICE_HEADERS.service)).toBe("core")
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "phone",
      mentraUserId: "mu_phone",
      tenantId: "tenant_1",
      sessionId: "sess_1",
      email: "phone@example.test",
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("the contract's verifyForwardedPrincipal accepts what Core sends, on both surfaces", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))

    await phone("/observations?batch=1", {method: "POST", body: '{"records":[]}'})
    await admin(organizationAdmin, "/devices?page=2")

    expect(calls.map(verifies)).toEqual([
      {kind: "phone", mentraUserId: "mu_phone", tenantId: "tenant_1", sessionId: "sess_1", email: "phone@example.test"},
      {
        kind: "user",
        mentraUserId: "mu_1",
        email: "person@example.test",
        emailVerified: true,
        isOrganizationAdmin: true,
        organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
        scope: {kind: "organization"},
      },
    ])
    // Another secret, or a body changed in transit, verifies nothing.
    const [call] = calls
    const request = {method: call.method, pathWithQuery: call.pathWithQuery, body: call.body, headers: call.headers}
    expect(verifyForwardedPrincipal(request, ["another-secret"])).toBeNull()
    expect(verifyForwardedPrincipal({...request, body: '{"records":[1]}'}, [SECRET])).toBeNull()
  })

  test("Core's request id goes upstream as x-request-id, and a fresh one when the request has none", async () => {
    configure()
    const withId = new Hono<AppEnv>()
    withId.use("*", async (c, next) => {
      c.set("reqId", "01CORE-REQUEST-ID")
      await next()
    })
    withId.route("/", root)

    await withId.request("http://localhost/api/client/fleet/devices", {headers: {authorization: "Bearer phone:mu_phone"}})
    await phone("/devices")

    expect(calls[0].headers.get("x-request-id")).toBe("01CORE-REQUEST-ID")
    expect(calls[1].headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test("the body, method and content-type are copied, and the signature covers the body", async () => {
    configure()
    const body = JSON.stringify({name: "café ☕", n: 3})

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      calls = []
      const response = await phone("/devices", {method, body, headers: {"content-type": "application/json"}})
      expect(response.status).toBe(200)
      expect(calls[0].method).toBe(method)
      expect(calls[0].body).toBe(body)
      expect(calls[0].headers.get("content-type")).toBe("application/json")
      expect(serviceSignatureVerifies(calls[0])).toBe(true)
      // A body changed in transit no longer verifies.
      expect(serviceSignatureVerifies({...calls[0], body: `${body} `})).toBe(false)
    }
  })

  test("a body sent without a content-type reaches upstream without one", async () => {
    configure()

    const response = await phone("/devices", {method: "POST", body: "plain"})

    expect(response.status).toBe(200)
    expect(calls[0].headers.get("content-type")).toBeNull()
    expect(calls[0].body).toBe("plain")
  })

  test("GET and HEAD carry no body, and the method reaches upstream as sent", async () => {
    configure()
    respond = () => new Response(null, {status: 200, headers: {"content-type": "application/json"}})

    const head = await phone("/devices", {method: "HEAD"})
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-type")).toBe("application/json")
    const get = await phone("/devices", {method: "GET"})
    expect(get.status).toBe(200)

    expect(calls.map(call => [call.method, call.body])).toEqual([
      ["HEAD", ""],
      ["GET", ""],
    ])
    for (const call of calls) expect(serviceSignatureVerifies(call)).toBe(true)
  })

  test("the bare mount and a trailing slash both forward", async () => {
    configure()

    expect((await phone("")).status).toBe(200)
    expect((await phone("/")).status).toBe(200)
    expect((await admin(as("organization-admin", person(true)), "")).status).toBe(200)

    expect(calls.map(call => call.pathWithQuery)).toEqual(["/v1/client", "/v1/client/", "/v1/admin"])
  })

  test("a client-sent identity never reaches upstream; Core's own does", async () => {
    configure()

    const response = await phone("/devices", {
      headers: {
        "cookie": "session=secret",
        "x-mentra-principal": "forged",
        "x-mentra-principal-signature": "forged",
        "x-mentra-service": "store",
        "x-mentra-service-timestamp": "1",
        "x-mentra-service-signature": "forged",
        "x-mentra-anything-else": "1",
        "X-Mentra-Mixed-Case": "1",
        "x-test-principal": "organization-admin",
        "if-none-match": '"v1"',
        "accept-language": "fr",
      },
    })

    expect(response.status).toBe(200)
    const [call] = calls
    expect(call.headers.get("authorization")).toBeNull()
    expect(call.headers.get("cookie")).toBeNull()
    expect(call.headers.get("x-test-principal")).toBeNull()
    expect(call.headers.get("if-none-match")).toBeNull()
    expect(call.headers.get("accept-language")).toBeNull()
    expect([...call.headers.keys()].filter(name => name.startsWith("x-mentra-")).sort()).toEqual(
      [
        FLEET_HEADERS.principal,
        FLEET_HEADERS.principalSignature,
        SERVICE_HEADERS.service,
        SERVICE_HEADERS.signature,
        SERVICE_HEADERS.timestamp,
      ].sort(),
    )
    expect(call.headers.get(SERVICE_HEADERS.service)).toBe("core")
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toMatchObject({
      kind: "phone",
      mentraUserId: "mu_phone",
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("the caller's bearer token never reaches upstream", async () => {
    configure()

    await phone("/devices", {user: "mu_secret_bearer"})

    expect(JSON.stringify([...calls[0].headers.entries()])).not.toContain("secret_bearer")
  })

  test("the principal signature binds the identity: a swapped principal or timestamp fails", async () => {
    configure()

    await phone("/devices", {user: "mu_a"})
    await phone("/devices", {user: "mu_b"})
    const [a, b] = calls

    expect(principalSignatureVerifies(a)).toBe(true)
    expect(principalSignatureVerifies(b)).toBe(true)
    // The service signature does not cover the identity headers; only the principal signature binds them.
    expect(serviceSignatureVerifies(a)).toBe(true)
    expect(principalSignatureVerifies(a, {principal: b.headers.get(FLEET_HEADERS.principal) ?? ""})).toBe(false)
    expect(
      principalSignatureVerifies(a, {timestamp: String(Number(a.headers.get(SERVICE_HEADERS.timestamp)) + 1)}),
    ).toBe(false)
    expect(principalSignatureVerifies(a, {principal: Buffer.from('{"kind":"phone"}').toString("base64url")})).toBe(
      false,
    )
    // Signed with another secret, it does not verify either.
    expect(
      principalSignature(
        "another-secret",
        a.headers.get(SERVICE_HEADERS.timestamp) ?? "",
        a.headers.get(FLEET_HEADERS.principal) ?? "",
      ),
    ).not.toBe(a.headers.get(FLEET_HEADERS.principalSignature))
  })

  test("a body that is not valid UTF-8 is refused rather than altered", async () => {
    configure()

    const response = await phone("/devices", {method: "POST", body: new Uint8Array([0xff, 0xfe, 0x41])})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: "invalid_body"})
    expect(calls).toHaveLength(0)
  })
})

describe("the upstream URL", () => {
  const target = (base: string, audience: "client" | "admin", suffix: string, query = "") =>
    upstreamTarget(new URL(base), audience, suffix, query).href

  test("joins the Fleet URL and /v1/<audience>/<rest> whether or not the URL ends in a slash", () => {
    for (const base of ["https://mfm.example.test", "https://mfm.example.test/", "https://mfm.example.test//"]) {
      expect(target(base, "client", "/report", "?a=1")).toBe("https://mfm.example.test/v1/client/report?a=1")
      expect(target(base, "admin", "/ui/entry.js")).toBe("https://mfm.example.test/v1/admin/ui/entry.js")
      expect(target(base, "client", "")).toBe("https://mfm.example.test/v1/client")
    }
    for (const base of ["https://mfm.example.test/fleet", "https://mfm.example.test/fleet/", "https://mfm.example.test/fleet//"]) {
      expect(target(base, "client", "/report", "?a=1")).toBe("https://mfm.example.test/fleet/v1/client/report?a=1")
      expect(target(base, "admin", "/overview")).toBe("https://mfm.example.test/fleet/v1/admin/overview")
      expect(target(base, "admin", "")).toBe("https://mfm.example.test/fleet/v1/admin")
    }
    expect(target("https://mfm.example.test/a/b/", "admin", "/x")).toBe("https://mfm.example.test/a/b/v1/admin/x")
    expect(target("http://127.0.0.1:3004", "client", "/report")).toBe("http://127.0.0.1:3004/v1/client/report")
  })

  test("on the wire, with and without a path prefix, and the signature covers what arrived", async () => {
    for (const [base, expected] of [
      [upstreamUrl(), "/v1/client/devices?x=1"],
      [`${upstreamUrl()}/`, "/v1/client/devices?x=1"],
      [`${upstreamUrl()}/fleet`, "/fleet/v1/client/devices?x=1"],
      [`${upstreamUrl()}/fleet/`, "/fleet/v1/client/devices?x=1"],
      [`${upstreamUrl()}/fleet/base/`, "/fleet/base/v1/client/devices?x=1"],
    ] as const) {
      configure({CLOUD_CORE_FLEET_URL: base})
      calls = []

      expect([base, (await phone("/devices?x=1")).status]).toEqual([base, 200])

      expect([base, calls[0].pathWithQuery]).toEqual([base, expected])
      expect([base, serviceSignatureVerifies(calls[0])]).toEqual([base, true])
    }
  })

  test("the admin surface joins the prefix the same way", async () => {
    configure({CLOUD_CORE_FLEET_URL: `${upstreamUrl()}/fleet/`})

    expect((await admin(as("organization-admin", person(true)), "/overview?range=7d")).status).toBe(200)

    expect(calls[0].pathWithQuery).toBe("/fleet/v1/admin/overview?range=7d")
    expect(serviceSignatureVerifies(calls[0])).toBe(true)
  })

  test("the path Core signs is exactly the path and query it sends, whatever characters they hold", async () => {
    configure()
    const REQUESTS = [
      "/devices/caf%C3%A9%20x?q=a%20b&r=%E2%98%95",
      "/devices/a+b/c;d=e?x=1&x=2&y=%2F",
      "/devices/it's/(1)/[2]/~!*?q='x'&z=\"y\"&w=<v>",
      "/devices/ü/ß?q=ü&r=日本",
      "/devices/{id}/`tick`|pipe^caret?x={y}",
      "/devices?",
      "/devices/?",
      "/devices//x///y?a=b",
      "/devices?a=b#fragment",
      "/devices/%7Euser/%2Bplus/%25pct",
    ]
    for (const rest of REQUESTS) {
      calls = []

      expect([rest, (await phone(rest)).status]).toEqual([rest, 200])

      expect([rest, calls.length]).toEqual([rest, 1])
      expect([rest, serviceSignatureVerifies(calls[0])]).toEqual([rest, true])
      expect([rest, principalSignatureVerifies(calls[0])]).toEqual([rest, true])
      // A lone "?" would be sent but not signed.
      expect([rest, calls[0].pathWithQuery.endsWith("?")]).toEqual([rest, false])
    }
  })
})

describe("unsafe paths", () => {
  const UNSAFE = [
    "/api/client/fleet/a/../b",
    "/api/client/fleet/../../admin/me",
    "/api/client/fleet/./a",
    "/api/client/fleet/%2e%2e/b",
    "/api/client/fleet/.%2E/b",
    "/api/client/fleet/%2E%2E",
    "/api/client/fleet/a%2fb",
    "/api/client/fleet/a%2Fb",
    "/api/client/fleet/%2f%2e%2e%2fadmin",
    "/api/client/fleet/a%5cb",
    "/api/client/fleet/a%5Cb",
    "/api/client/fleet/a\\b",
    "/api/client/fleet/%zz",
    "/api/client/fleet/a%00b",
    // Still an escape after one decoding: a Fleet that decodes twice would see a dot segment or a separator.
    "/api/client/fleet/%252e%252e/b",
    "/api/client/fleet/%252E%252E",
    "/api/client/fleet/a%252fb",
    "/api/client/fleet/a%252Fb",
    "/api/client/fleet/a%255cb",
    "/api/client/fleet/a%255Cb",
    "/api/client/fleet/%252e",
    "/api/client/fleet/.%252e/b",
  ]

  test("a client path with a dot segment, an encoded slash or a bad escape is a 400 and goes nowhere", async () => {
    configure()
    for (const rawUrl of UNSAFE) {
      const response = await root.fetch(rawUrlRequest(`http://localhost${rawUrl}?x=1`, {authorization: "Bearer phone:mu_phone"}))
      expect([rawUrl, response.status]).toEqual([rawUrl, 400])
      expect(await response.json()).toEqual({error: "invalid_path"})
    }
    expect(calls).toHaveLength(0)
    expect(emailLookup).not.toHaveBeenCalled()
  })

  test("the admin surface refuses them too", async () => {
    configure()
    as("organization-admin", person(true))
    for (const rawUrl of UNSAFE.map(path => path.replace("/api/client/", "/api/admin/"))) {
      const response = await root.fetch(rawUrlRequest(`http://localhost${rawUrl}`, {"x-test-principal": "organization-admin"}))
      expect([rawUrl, response.status]).toEqual([rawUrl, 400])
    }
    expect(calls).toHaveLength(0)
  })

  test("an escape that is not a separator or a dot segment passes unchanged", async () => {
    configure()

    expect((await phone("/devices/a%20b/caf%C3%A9%2Bx")).status).toBe(200)

    expect(calls[0].pathWithQuery).toBe("/v1/client/devices/a%20b/caf%C3%A9%2Bx")
  })

  test("an escaped percent sign is fine unless what follows it spells a dot or a separator", async () => {
    configure()

    expect((await phone("/devices/50%25/a%2520b/%252x")).status).toBe(200)

    expect(calls[0].pathWithQuery).toBe("/v1/client/devices/50%25/a%2520b/%252x")
  })
})

describe("limits and failures", () => {
  test("a body over the limit is a 413 and is not forwarded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})

    // No content-length: the stream is counted.
    const streamed = await phone("/devices", {method: "POST", body: "x".repeat(17)})
    expect(streamed.status).toBe(413)
    expect(await streamed.json()).toEqual({error: "payload_too_large"})

    // A declared length over the limit is refused before the body is read.
    const declared = await phone("/devices", {
      method: "POST",
      body: "x".repeat(17),
      headers: {"content-length": "17"},
    })
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({error: "payload_too_large"})

    expect(calls).toHaveLength(0)
  })

  test("a body is refused once it passes the limit, without waiting for the rest of the stream", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})
    const endless = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(17)))
        // Never closed: only a reader that counts as it goes can answer.
      },
    })

    const response = await phone("/devices", {method: "POST", body: endless, duplex: "half"} as Parameters<typeof phone>[1])

    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  test("a body exactly at the limit is forwarded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})

    const response = await phone("/devices", {method: "POST", body: "x".repeat(16)})

    expect(response.status).toBe(200)
    expect(calls[0].body).toBe("x".repeat(16))
  })

  test("the admin surface has the same limit", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})
    as("organization-admin", person(true))

    const response = await admin("organization-admin", "/devices", {method: "POST", body: "x".repeat(17)})

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({error: "payload_too_large"})
    expect(calls).toHaveLength(0)
  })

  test("the default limit is 1 MiB, and an unusable value does not lift it", async () => {
    for (const value of [undefined, "0", "-5", "abc", "1.5", ""]) {
      configure(value === undefined ? {} : {CLOUD_CORE_FLEET_MAX_BODY_BYTES: value})
      calls = []

      const atLimit = await phone("/devices", {method: "POST", body: "x".repeat(1024 * 1024)})
      const overLimit = await phone("/devices", {method: "POST", body: "x".repeat(1024 * 1024 + 1)})

      expect([value, atLimit.status, overLimit.status]).toEqual([value, 200, 413])
      expect(calls).toHaveLength(1)
    }
  })

  test("an upstream that does not answer within the timeout is a 503", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "150"})
    respond = () => new Promise<Response>(() => {})

    const started = Date.now()
    const response = await phone("/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("a timeout past what a timer holds is clamped before it reaches the fetch signal", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "9007199254740991"})
    const timeout = spyOn(AbortSignal, "timeout")

    const response = await phone("/devices")
    const timeouts = [...timeout.mock.calls]
    timeout.mockRestore()

    expect(response.status).toBe(200)
    expect(timeouts).toEqual([[2_147_483_647]])
  })

  test("the timeout covers reading the response body", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "150"})
    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'))
            // Never closed: the headers arrive, the body never finishes.
          },
        }),
        {headers: {"content-type": "application/json"}},
      )

    const started = Date.now()
    const response = await phone("/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("a response over the cap is a 503, whether its length is declared or it just keeps streaming", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16"})

    // Declared: a content-length over the cap is refused before any of the body is read.
    respond = () => new Response("x".repeat(17), {headers: {"content-type": "text/plain"}})
    const declared = await phone("/devices")
    expect(declared.status).toBe(503)
    expect(await declared.json()).toEqual({error: "fleet_unavailable"})

    // Undeclared: a stream with no length that never ends is cut off once it passes the cap.
    respond = () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode("12345678"))
            await Bun.sleep(1)
          },
        }),
      )
    const started = Date.now()
    const streamed = await phone("/devices")
    expect(streamed.status).toBe(503)
    expect(await streamed.json()).toEqual({error: "fleet_unavailable"})
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("a response exactly at the cap passes through", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16"})
    respond = () => new Response("x".repeat(16), {headers: {"content-type": "text/plain"}})

    const response = await phone("/devices")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("x".repeat(16))
  })

  test("the default cap is 10 MiB, and an unusable value does not lift it", async () => {
    const MIB10 = 10 * 1024 * 1024
    for (const value of [undefined, "0", "-5", "abc", "1.5", ""]) {
      configure(value === undefined ? {} : {CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: value})
      respond = () => new Response("x".repeat(MIB10), {headers: {"content-type": "text/plain"}})
      const atCap = await phone("/devices")
      expect([value, atCap.status, (await atCap.arrayBuffer()).byteLength]).toEqual([value, 200, MIB10])

      respond = () => new Response("x".repeat(MIB10 + 1), {headers: {"content-type": "text/plain"}})
      const overCap = await phone("/devices")
      expect([value, overCap.status]).toEqual([value, 503])
    }
  })

  test("a 204 or a body-less answer is never mistaken for an oversized one", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "1"})
    respond = () => new Response(null, {status: 204})

    expect((await phone("/devices/1", {method: "DELETE"})).status).toBe(204)
  })

  test("a HEAD answer declaring a body over the cap is not an outage: no body is read for it", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16"})
    // A HEAD answer's content-length describes the body a GET would get (here, a large export).
    respond = request =>
      request.method === "HEAD"
        ? new Response(null, {status: 200, headers: {"content-type": "text/csv", "content-length": "1048576"}})
        : new Response("x".repeat(17), {headers: {"content-type": "text/csv"}})

    const head = await phone("/exports/devices.csv", {method: "HEAD"})
    const get = await phone("/exports/devices.csv")

    expect(head.status).toBe(200)
    expect(head.headers.get("content-type")).toBe("text/csv")
    expect(await head.text()).toBe("")
    expect(get.status).toBe(503)
  })

  test("an upstream 5xx is a 503, never its own answer", async () => {
    configure()
    for (const status of [500, 502, 503, 504]) {
      respond = () => Response.json({secret: "internal details"}, {status})

      const response = await phone("/devices")

      expect([status, response.status]).toEqual([status, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
  })

  test("an upstream that cannot be reached is a 503", async () => {
    const gone = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")})
    const url = `http://127.0.0.1:${gone.port}`
    gone.stop(true)
    configure({CLOUD_CORE_FLEET_URL: url})

    const response = await phone("/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
  })

  test("a 304 is relayed as it is, not taken for a redirect", async () => {
    configure()
    respond = () => new Response(null, {status: 304, headers: {"cache-control": "private, max-age=5"}})

    const response = await phone("/devices")

    expect(response.status).toBe(304)
    expect(await response.text()).toBe("")
    expect(response.headers.get("content-type")).toBeNull()
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
  })

  test("a redirect is not followed and is a 503", async () => {
    configure()
    for (const status of [301, 302, 303, 307, 308]) {
      calls = []
      respond = () => new Response(null, {status, headers: {location: "/v1/client/elsewhere"}})

      const response = await phone("/devices")

      expect([status, response.status]).toEqual([status, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
      expect(response.headers.get("location")).toBeNull()
      expect(calls.map(call => call.pathWithQuery)).toEqual(["/v1/client/devices"])
    }
  })
})

describe("what comes back", () => {
  test("status, body, content-type, cache-control, retry-after and x-request-id pass through and nothing else does", async () => {
    configure()
    respond = () =>
      new Response('{"created":true}', {
        status: 201,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, max-age=5",
          "retry-after": "30",
          "x-request-id": "fleet-request-1",
          "set-cookie": "upstream=1",
          "x-internal-trace": "abc",
          "access-control-allow-origin": "*",
          "etag": '"v1"',
          "location": "/v1/client/devices/1",
        },
      })

    const response = await phone("/devices", {method: "POST", body: "{}"})

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('{"created":true}')
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
    expect(response.headers.get("retry-after")).toBe("30")
    expect(response.headers.get("x-request-id")).toBe("fleet-request-1")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-internal-trace")).toBeNull()
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
    expect(response.headers.get("etag")).toBeNull()
    expect(response.headers.get("location")).toBeNull()
  })

  test("Retry-After: 30 on an upstream 429 reaches the caller, on both surfaces", async () => {
    configure()
    respond = () => Response.json({error: "rate_limited"}, {status: 429, headers: {"retry-after": "30"}})
    const organizationAdmin = as("organization-admin", person(true))

    for (const response of [
      await phone("/observations", {method: "POST", body: "{}"}),
      await admin(organizationAdmin, "/overview"),
    ]) {
      expect(response.status).toBe(429)
      expect(response.headers.get("retry-after")).toBe("30")
      expect(await response.json()).toEqual({error: "rate_limited"})
    }
  })

  test("without an x-request-id from Fleet, the answer carries the id Core sent upstream", async () => {
    configure()

    const response = await phone("/devices")

    expect(response.headers.get("x-request-id")).toBe(calls[0].headers.get("x-request-id"))
  })

  test("behind Core's request-context middleware, the request's id reaches Fleet and comes back", async () => {
    configure()
    respond = request =>
      Response.json({ok: true}, {headers: {"x-request-id": request.headers.get("x-request-id") ?? ""}})
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const chosen = await withContext.request("http://localhost/api/client/fleet/devices", {
      headers: {"authorization": "Bearer phone:mu_phone", "x-request-id": "caller-chosen-id"},
    })
    const minted = await withContext.request("http://localhost/api/client/fleet/devices", {
      headers: {authorization: "Bearer phone:mu_phone"},
    })

    expect(chosen.status).toBe(200)
    expect(calls[0].headers.get("x-request-id")).toBe("caller-chosen-id")
    expect(chosen.headers.get("x-request-id")).toBe("caller-chosen-id")
    expect(minted.headers.get("x-request-id")).toBe(calls[1].headers.get("x-request-id"))
    expect(minted.headers.get("x-request-id")).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test("behind the request-context middleware, Fleet's own request id is the one the caller gets", async () => {
    configure()
    respond = () => Response.json({ok: true}, {headers: {"x-request-id": "fleet-own-id"}})
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const response = await withContext.request("http://localhost/api/client/fleet/devices", {
      headers: {"authorization": "Bearer phone:mu_phone", "x-request-id": "caller-chosen-id"},
    })

    expect(calls[0].headers.get("x-request-id")).toBe("caller-chosen-id")
    expect(response.headers.get("x-request-id")).toBe("fleet-own-id")
  })

  test("an upstream 401 reaches the caller as a 403 with Fleet's body, on both surfaces", async () => {
    // Phones and the admin dashboard read a 401 as "your session ended"; Fleet's 401 never means that.
    configure()
    respond = () => Response.json({error: "not_enrolled"}, {status: 401})
    const organizationAdmin = as("organization-admin", person(true))

    for (const response of [await phone("/devices"), await admin(organizationAdmin, "/devices")]) {
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({error: "not_enrolled"})
    }
  })

  test("a 4xx from Fleet is passed through, not turned into an outage", async () => {
    configure()
    for (const status of [400, 403, 404, 409, 422, 429]) {
      respond = () => Response.json({error: `fleet_says_${status}`}, {status})

      const response = await phone("/devices")

      expect([status, response.status]).toEqual([status, status])
      expect(await response.json()).toEqual({error: `fleet_says_${status}`})
    }
  })

  test("a 204 or 205 stays empty and gets no content-type Fleet did not send", async () => {
    configure()
    for (const status of [204, 205]) {
      respond = () => new Response(null, {status, headers: {"retry-after": "5"}})

      const response = await phone("/devices/1", {method: "DELETE"})

      expect(response.status).toBe(status)
      expect(await response.text()).toBe("")
      expect(response.headers.get("content-type")).toBeNull()
      expect(response.headers.get("content-length") ?? "0").toBe("0")
      expect(response.headers.get("retry-after")).toBe("5")
    }
  })

  test("a HEAD answer passes its status and headers through without a body", async () => {
    configure()
    respond = () => new Response(null, {status: 404, headers: {"content-type": "application/json"}})

    const response = await phone("/devices/9", {method: "HEAD"})

    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(await response.text()).toBe("")
  })
})

describe("what Core logs", () => {
  test("one line per forwarded request: request id, Fleet's request id, status and duration, nothing else of the request", async () => {
    configure()
    respond = () => Response.json({devices: ["secret-device-name"]}, {headers: {"x-request-id": "fleet-1"}})
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const response = await withContext.request("http://localhost/api/client/fleet/devices?token=query-secret", {
      method: "POST",
      body: '{"serial":"body-secret"}',
      headers: {"authorization": "Bearer phone:bearer-secret", "x-request-id": "req-1", "cookie": "cookie-secret"},
    })

    expect(response.status).toBe(200)
    const forwarded = logs.filter(line => line.message.includes("Fleet"))
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].fields).toEqual({
      reqId: "req-1",
      audience: "client",
      upstreamRequestId: "fleet-1",
      upstreamStatus: 200,
      status: 200,
      ms: expect.any(Number),
    })
    const everything = JSON.stringify(logs)
    for (const secret of [
      SECRET,
      "body-secret",
      "query-secret",
      "bearer-secret",
      "cookie-secret",
      "secret-device-name",
      "phone@example.test",
    ]) {
      expect([secret, everything.includes(secret)]).toEqual([secret, false])
    }
  })

  test("a failure is logged with what Core answered and what Fleet did, and still no bodies", async () => {
    configure()
    respond = () => Response.json({detail: "internal-secret"}, {status: 502})

    const response = await phone("/devices")

    expect(response.status).toBe(503)
    const line = logs.find(entry => entry.level === "warn")
    expect(line?.fields).toMatchObject({audience: "client", upstreamStatus: 502, status: 503, upstreamRequestId: null})
    expect(JSON.stringify(logs)).not.toContain("internal-secret")
  })

  test("an upstream 401 is a warning, since Fleet refusing Core's signature is an operator's problem", async () => {
    configure()
    respond = () => Response.json({error: "bad_signature"}, {status: 401})

    const response = await phone("/devices")

    expect(response.status).toBe(403)
    expect(logs.find(entry => entry.level === "warn")?.fields).toMatchObject({upstreamStatus: 401, status: 403})
  })
})

describe("configuration", () => {
  test("not configured is a 404 fleet_not_installed on both surfaces, once the caller is authenticated", async () => {
    const organizationAdmin = as("organization-admin", person(true))

    const client = await phone("/devices")
    const adminSide = await admin(organizationAdmin, "/devices")

    expect(client.status).toBe(404)
    expect(await client.json()).toEqual({error: "fleet_not_installed"})
    expect(adminSide.status).toBe(404)
    expect(await adminSide.json()).toEqual({error: "fleet_not_installed"})
    expect(calls).toHaveLength(0)
    expect(emailLookup).not.toHaveBeenCalled()
  })

  test("a blank URL counts as not configured, and a secret alone does not install Fleet", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "   "
    process.env.CLOUD_CORE_FLEET_SECRET = SECRET

    const response = await phone("/devices")

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "fleet_not_installed"})
  })

  test("not installed answers without reading a large body", async () => {
    const response = await phone("/devices", {method: "POST", body: "x".repeat(2 * 1024 * 1024)})

    expect(response.status).toBe(404)
  })

  test("a Private Cloud that did not list fleet.managed has no Fleet, however its URL looks", async () => {
    const organizationAdmin = as("organization-admin", person(true))
    for (const features of ["call.unlimited", "call.unlimited:acs+pstn", " , ", "Fleet.Managed", "fleet", "fleet.managed.extra"]) {
      configure({CLOUD_CORE_ENABLED_FEATURES: features})

      const client = await phone("/devices")
      const adminSide = await admin(organizationAdmin, "/devices")

      expect([features, client.status, await client.json()]).toEqual([features, 404, {error: "fleet_not_installed"}])
      expect([features, adminSide.status, await adminSide.json()]).toEqual([features, 404, {error: "fleet_not_installed"}])
    }
    expect(calls).toHaveLength(0)
  })

  test("a request that is not authenticated is still a 401 when Fleet is not installed for the deployment", async () => {
    configure({CLOUD_CORE_ENABLED_FEATURES: "call.unlimited"})

    const client = await root.request("http://localhost/api/client/fleet/report", {method: "POST", body: "{}"})
    const adminSide = await admin(null, "/overview")

    expect(client.status).toBe(401)
    expect(adminSide.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  test("a Private Cloud that listed fleet.managed forwards, and feature names beyond Fleet's are ignored", async () => {
    configure({CLOUD_CORE_ENABLED_FEATURES: "call.unlimited:acs+pstn, fleet.managed"})

    expect((await phone("/devices")).status).toBe(200)

    expect(calls).toHaveLength(1)
  })

  test("a URL without a secret is misconfigured: 503, not 404", async () => {
    for (const secret of [undefined, "", "   "]) {
      process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
      if (secret === undefined) delete process.env.CLOUD_CORE_FLEET_SECRET
      else process.env.CLOUD_CORE_FLEET_SECRET = secret

      const response = await phone("/devices")

      expect([secret, response.status]).toEqual([secret, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
    expect(calls).toHaveLength(0)
  })

  test("an invalid URL is misconfigured", async () => {
    for (const url of [
      "not a url",
      "fleet.internal:8080",
      "ftp://fleet.internal",
      "file:///etc/passwd",
      "https://user:pass@fleet.example.test",
      "https://fleet.example.test/?token=x",
      "https://fleet.example.test/#frag",
    ]) {
      configure({CLOUD_CORE_FLEET_URL: url})

      const response = await phone("/devices")

      expect([url, response.status]).toEqual([url, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
    expect(calls).toHaveLength(0)
  })

  test("production requires https, except for http on localhost and 127.0.0.1", async () => {
    configure({NODE_ENV: "production", CLOUD_CORE_FLEET_URL: "http://fleet.example.test"})
    expect((await phone("/devices")).status).toBe(503)
    process.env.CLOUD_CORE_FLEET_URL = "http://10.0.0.5:8080"
    expect((await phone("/devices")).status).toBe(503)
    // A refused URL is never contacted.
    expect(calls).toHaveLength(0)

    process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
    const response = await phone("/devices")

    expect(response.status).toBe(200)
    expect(serviceSignatureVerifies(calls[0])).toBe(true)
    expect(principalSignatureVerifies(calls[0])).toBe(true)
  })

  test("a deployed Core requires https too, even without NODE_ENV=production", async () => {
    // Deployed Cores set CLOUD_CORE_ENVIRONMENT, not NODE_ENV.
    configure({CLOUD_CORE_ENVIRONMENT: "dev", CLOUD_CORE_FLEET_URL: "http://fleet.example.test"})

    expect((await phone("/devices")).status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  test("outside production http is allowed on any host", async () => {
    configure({CLOUD_CORE_FLEET_URL: "http://fleet.internal:8080"})
    // The host does not exist here, so the request fails; it is attempted, which is the point.
    const attempted = spyOn(globalThis, "fetch").mockRejectedValue(new Error("unreachable"))

    const response = await phone("/devices")
    const target = String(attempted.mock.calls[0]?.[0])
    attempted.mockRestore()

    expect(response.status).toBe(503)
    expect(target).toBe("http://fleet.internal:8080/v1/client/devices")
  })

  test("the order is: authenticate, not installed, misconfigured, then the path and the body", async () => {
    const organizationAdmin = as("organization-admin", person(true))
    const unsafe = (surface: "client" | "admin") =>
      rawUrlRequest(`http://localhost/api/${surface}/fleet/a/../b`, {
        "authorization": "Bearer phone:mu_phone",
        "x-test-principal": organizationAdmin,
      })

    // Not installed: 404 before the path is looked at.
    expect((await root.fetch(unsafe("client"))).status).toBe(404)
    expect((await root.fetch(unsafe("admin"))).status).toBe(404)
    // Misconfigured: 503 before the path is looked at.
    process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
    expect((await root.fetch(unsafe("client"))).status).toBe(503)
    expect((await root.fetch(unsafe("admin"))).status).toBe(503)
    // Ready: now the path is refused.
    configure()
    expect((await root.fetch(unsafe("client"))).status).toBe(400)
    expect((await root.fetch(unsafe("admin"))).status).toBe(400)
    // And without authentication none of that is reached.
    delete process.env.CLOUD_CORE_FLEET_URL
    const nobody = rawUrlRequest("http://localhost/api/client/fleet/a/../b", {})
    expect((await root.fetch(nobody)).status).toBe(401)
    expect(calls).toHaveLength(0)
  })
})

describe("the phone principal's email", () => {
  test("is the account's verified email", async () => {
    configure()
    emailLookup.mockResolvedValue("verified@example.test")

    await phone("/report", {method: "POST", body: "{}", user: "mu_verified"})

    expect(emailLookup.mock.calls.map(call => call[0])).toEqual(["mu_verified"])
    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      kind: "phone",
      mentraUserId: "mu_verified",
      email: "verified@example.test",
    })
  })

  test("is null when the account's email is not verified", async () => {
    configure()
    emailLookup.mockResolvedValue(null)

    await phone("/report", {method: "POST", body: "{}", user: "mu_unverified"})

    const sent = decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))
    expect(sent.email).toBeNull()
    expect(Object.keys(sent).sort()).toEqual(["email", "kind", "mentraUserId", "sessionId", "tenantId"])
    expect(verifies(calls[0])).toMatchObject({kind: "phone", email: null})
  })

  test("is null, and the report still goes through, when the account lookup fails", async () => {
    configure()
    emailLookup.mockRejectedValue(new Error("account directory unavailable"))

    const response = await phone("/report", {method: "POST", body: "{}", user: "mu_directory_down"})

    expect(response.status).toBe(200)
    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal)).email).toBeNull()
  })

  test("is looked up once for a phone that reports again soon", async () => {
    configure()

    await phone("/report", {method: "POST", body: "{}", user: "mu_repeat"})
    await phone("/report", {method: "POST", body: "{}", user: "mu_repeat"})

    expect(emailLookup).toHaveBeenCalledTimes(1)
  })

  test("is not asked for when the request is refused before it would be forwarded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "4"})

    await phone("/report", {method: "POST", body: "too long"})
    await phone("/report", {method: "POST", body: new Uint8Array([0xff])})
    await root.request("http://localhost/api/client/fleet/report", {method: "POST", body: "{}"})

    expect(emailLookup).not.toHaveBeenCalled()
  })
})

describe("the admin surface", () => {
  test("an Organization Admin is forwarded as a user with the organization scope and every organization capability", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))

    const response = await admin(organizationAdmin, "/devices?page=2", {
      method: "POST",
      body: '{"a":1}',
      headers: {"accept": "application/json", "content-type": "application/json"},
    })

    expect(response.status).toBe(200)
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.pathWithQuery).toBe("/v1/admin/devices?page=2")
    expect(call.body).toBe('{"a":1}')
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "user",
      mentraUserId: "mu_1",
      email: "person@example.test",
      emailVerified: true,
      isOrganizationAdmin: true,
      organizationCapabilities: [...ORGANIZATION_CAPABILITIES],
      scope: {kind: "organization"},
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
    // A person is not looked up by the phone's email path.
    expect(emailLookup).not.toHaveBeenCalled()
  })

  test("an unverified email is forwarded as unverified, and the capabilities are those Core decided", async () => {
    configure()
    const claimed = as("claimed", person(true, {emailVerified: false, email: "claimed@example.test"}))

    await admin(claimed, "/devices")

    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      email: "claimed@example.test",
      emailVerified: false,
      isOrganizationAdmin: true,
      organizationCapabilities: expect.arrayContaining(["organization.fleet.administer"]),
    })
  })

  test("the scope is the organization whatever the query or the body ask for", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    const body = JSON.stringify({
      scope: {kind: "workspace", workspaceId: "ws_attacker"},
      workspaceId: "ws_attacker",
      isOrganizationAdmin: false,
    })

    for (const method of ["GET", "POST"]) {
      calls = []
      await admin(organizationAdmin, "/overview?scope=workspace&workspaceId=x&scope[kind]=workspace", {
        method,
        body: method === "GET" ? undefined : body,
        headers: {
          "content-type": "application/json",
          "x-mentra-scope": "workspace",
          "x-mentra-workspace-id": "ws_attacker",
          "x-scope": "workspace",
        },
      })

      expect(calls).toHaveLength(1)
      const [call] = calls
      expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal)).scope).toEqual({kind: "organization"})
      expect(verifies(call)).toMatchObject({kind: "user", scope: {kind: "organization"}})
      // The query and the body are Fleet's input, passed on untouched; the scope they name is not honoured.
      expect(call.pathWithQuery).toBe("/v1/admin/overview?scope=workspace&workspaceId=x&scope[kind]=workspace")
      expect(call.body).toBe(method === "GET" ? "" : body)
      expect(call.headers.get("x-mentra-scope")).toBeNull()
      expect(call.headers.get("x-mentra-workspace-id")).toBeNull()
      expect(call.headers.get("x-scope")).toBeNull()
    }
  })

  test("a workspace key and an operator key are refused with 403 and never reach Fleet", async () => {
    configure()
    const workspaceKey = as("workspace-key", key("workspace", ["miniapps.publish"]))
    const operatorKey = as("operator-key", key("organization", [...OPERATOR_KEY_SCOPES]))
    // Even a key that claims the Fleet scope: the capability is not one a key can hold.
    const claimingKey = as("claiming-key", key("organization", ["organization.fleet.administer"]))
    const fetched = spyOn(globalThis, "fetch")

    for (const name of [workspaceKey, operatorKey, claimingKey]) {
      for (const method of ["GET", "POST", "PUT", "DELETE"]) {
        const response = await admin(name, "/overview", {method, body: method === "GET" ? undefined : "{}"})
        expect([name, method, response.status]).toEqual([name, method, 403])
        expect(((await response.json()) as {error: string}).error).toBe("forbidden")
      }
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("a person without the Fleet capability is refused with 403 and never reaches Fleet", async () => {
    configure()
    const member = as("member", person(false))
    const claimed = as("claimed-admin", person(false, {email: "admin@example.test"}))
    const fetched = spyOn(globalThis, "fetch")

    for (const name of [member, claimed]) {
      const response = await admin(name, "/overview")
      expect([name, response.status]).toEqual([name, 403])
      expect(((await response.json()) as {error: string}).error).toBe("forbidden")
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("a refused caller is told 403, not 404, even when Fleet is not installed", async () => {
    const member = as("member", person(false))

    const response = await admin(member, "/overview")

    expect(response.status).toBe(403)
  })

  test("a forged identity header from the caller never reaches upstream", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    const forged = Buffer.from(
      '{"kind":"user","mentraUserId":"someone-else","scope":{"kind":"workspace","workspaceId":"ws_1"}}',
    ).toString("base64url")

    await admin(organizationAdmin, "/devices", {
      headers: {"x-mentra-principal": forged, "x-mentra-principal-signature": "forged", "authorization": "Bearer t"},
    })

    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      mentraUserId: "mu_1",
      scope: {kind: "organization"},
    })
    expect(calls[0].headers.get("authorization")).toBeNull()
    expect(principalSignatureVerifies(calls[0])).toBe(true)
  })

  test("the other admin areas still need their capability", async () => {
    configure()
    const member = as("member", person(false))

    for (const path of ["/reports", "/support-profiles/lookup", "/test-runs", "/routine-catalog", "/test-routines"]) {
      const response = await root.request(`http://localhost/api/admin${path}`, {headers: {"x-test-principal": member}})
      expect([path, response.status]).toEqual([path, 403])
    }
    expect(calls).toHaveLength(0)
  })
})

describe("who may call", () => {
  test("no phone request is forwarded without a phone access token", async () => {
    configure()
    const refused: Record<string, string>[] = [
      // Nothing at all.
      {},
      // An admin portal session cookie.
      {cookie: "__Host-mentra_admin_session=an-admin-session"},
      // A bearer that is not a phone's access token (a portal sign-in's, a Supabase token, a key).
      {authorization: "Bearer eyJhbGciOiJFZERTQSJ9.not.aphone"},
      {authorization: "Bearer msk_live_workspacekey"},
      {authorization: "Bearer mak_live_operatorkey"},
      // A malformed header.
      {authorization: "Basic dXNlcjpwYXNz"},
      {authorization: "Bearer "},
      {authorization: "phone:mu_phone"},
    ]
    const fetched = spyOn(globalThis, "fetch")

    for (const headers of refused) {
      for (const method of ["GET", "POST"]) {
        const response = await root.request("http://localhost/api/client/fleet/report", {
          method,
          headers,
          body: method === "POST" ? "{}" : undefined,
        })
        expect([headers, method, response.status]).toEqual([headers, method, 401])
        expect(((await response.json()) as {error: string}).error).toBe("unauthorized")
      }
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("a phone access token is not a credential on the admin surface", async () => {
    configure()
    const fetched = spyOn(globalThis, "fetch")

    const response = await root.request("http://localhost/api/admin/fleet/overview", {
      headers: {authorization: "Bearer phone:mu_phone"},
    })

    expect(response.status).toBe(401)
    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("a request with no credentials is a 401 on the admin surface, installed or not", async () => {
    for (const configured of [false, true]) {
      if (configured) configure()
      const response = await admin(null, "/overview")
      expect([configured, response.status]).toEqual([configured, 401])
    }
    expect(calls).toHaveLength(0)
  })

  test("a handler mounted without its gate fails closed", async () => {
    configure()
    const bare = new Hono<AppEnv>()
    bare.route("/api/client/fleet", clientFleetApi)
    bare.route("/api/admin", adminApi)

    for (const path of ["/api/client/fleet/devices", "/api/admin/fleet/devices"]) {
      const response = await bare.request(`http://localhost${path}`)
      expect([path, response.status]).toEqual([path, 401])
    }
    expect(calls).toHaveLength(0)
  })

  test("in the real app, a request without credentials never reaches Fleet", async () => {
    configure()
    const core = createApp({readinessChecks: []})
    const fetched = spyOn(globalThis, "fetch")

    for (const path of ["/api/client/fleet", "/api/client/fleet/devices", "/api/client/fleet/report"]) {
      for (const method of ["GET", "POST"]) {
        const response = await core.request(`http://localhost${path}`, {
          method,
          body: method === "POST" ? "{}" : undefined,
        })
        expect([method, path, response.status]).toEqual([method, path, 401])
      }
    }
    for (const path of ["/api/admin/fleet", "/api/admin/fleet/devices", "/api/admin/fleet/ui/entry.js"]) {
      const get = await core.request(`http://localhost${path}`)
      expect([path, get.status]).toEqual([path, 401])
      // An unsafe request with no bearer must come from the portal itself (CSRF), so with no Origin it is
      // refused as cross-origin before it is asked who it is. Either way it is refused.
      const post = await core.request(`http://localhost${path}`, {method: "POST", body: "{}"})
      expect([path, [401, 403].includes(post.status)]).toEqual([path, true])
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("there is no capabilities route: Fleet's presence is learned from the answer to a report", async () => {
    configure()
    const core = createApp({readinessChecks: []})

    const response = await core.request("http://localhost/api/client/capabilities", {
      headers: {authorization: "Bearer phone:mu_phone"},
    })

    expect(response.status).toBe(404)
  })
})
