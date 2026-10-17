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
import * as accountEmails from "../../services/account/account-email.service"
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
  "CLOUD_CORE_FLEET_MAX_ASSET_BYTES",
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
let emailLookup: ReturnType<typeof spyOn<typeof accountEmails, "accountEmail">>

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
  emailLookup = spyOn(accountEmails, "accountEmail").mockResolvedValue("phone@example.test")
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
  coreServer?.stop(true)
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
  // What `principalAuth` does when it rotates a portal session: a cookie set on the context, ahead of the handler.
  const rotated = c.req.header("x-test-set-cookie")
  if (rotated) c.header("set-cookie", rotated, {append: true})
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

/** Bytes that differ from position to position, so a dropped, repeated or reordered chunk shows. */
function patterned(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length)
  for (let i = 0; i < length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
  return bytes
}

/** An upstream body that counts what was pulled from it and whether it was cancelled. Nothing is pulled until it is read. */
function watchedBody(chunkBytes: number, chunks = Number.POSITIVE_INFINITY) {
  const state = {pulled: 0, cancelled: false}
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.pulled >= chunks) return controller.close()
        state.pulled++
        controller.enqueue(new Uint8Array(chunkBytes).fill(97))
      },
      cancel() {
        state.cancelled = true
      },
    },
    {highWaterMark: 0},
  )
  return {body, state}
}

/** A body that never ends, for the stub server to send: it pauses between chunks so the server stays responsive. */
function endlessBody(chunkBytes: number, onCancel: () => void = () => {}) {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      controller.enqueue(new Uint8Array(chunkBytes).fill(97))
      await Bun.sleep(1)
    },
    cancel: onCancel,
  })
}

async function eventually(condition: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (condition()) return true
    await Bun.sleep(5)
  }
  return condition()
}

let coreServer: ReturnType<typeof Bun.serve> | null = null

/** The stub app served over a real socket, for tests that need to see what a real HTTP client gets. */
function coreOverHttp(): string {
  coreServer ??= Bun.serve({hostname: "127.0.0.1", port: 0, fetch: request => root.fetch(request)})
  return `http://127.0.0.1:${coreServer.port}`
}

/**
 * A Fleet that dies mid-answer: it promises `declared` bytes, sends `sent` of them and closes the connection.
 * Raw TCP, because `Bun.serve` would not send a body shorter than its declared length.
 */
function resettingFleet(declared: number, sent: number) {
  const bytes = Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: text/javascript\r\netag: "from-fleet"\r\ncache-control: public, max-age=31536000\r\ncontent-length: ${declared}\r\nconnection: close\r\n\r\n`),
    Buffer.alloc(sent, 97),
  ])
  const states = new WeakMap<Bun.Socket, {request: string; offset: number; started: boolean}>()
  let answering: Bun.Socket | undefined
  const send = (socket: Bun.Socket) => {
    const state = states.get(socket)!
    const written = socket.write(bytes.subarray(state.offset))
    if (written > 0) state.offset += written
  }
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const state = states.get(socket) ?? {request: "", offset: 0, started: false}
        states.set(socket, state)
        if (state.started) return
        state.request += chunk.toString()
        if (state.request.length > 65536) {socket.end(); return}
        // TCP data callbacks need not contain the complete HTTP request headers.
        if (!state.request.includes("\r\n\r\n")) return
        state.started = true
        answering = socket
        send(socket)
      },
      drain(socket) {
        const state = states.get(socket)
        if (state?.started && state.offset < bytes.length) send(socket)
      },
    },
  })
  return {
    port: listener.port,
    afterHeaders() {
      // The real client's Response is the witness. Closing earlier can make fetch
      // reject before it reports headers, exercising a different failure path.
      expect(answering).toBeDefined()
      expect(states.get(answering!)?.offset).toBe(bytes.length)
      answering!.shutdown(true)
    },
    stop() {listener.stop(true)},
  }
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

  test("a response over the cap ends the request to Fleet: the connection closes and the rest is not downloaded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "64"})
    let sent = 0
    let cancelled = false
    // Bun's fetch ignores a body cancel and keeps downloading; only aborting the request closes the connection.
    respond = () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            sent++
            controller.enqueue(new Uint8Array(1024).fill(97))
            await Bun.sleep(1)
          },
          cancel() {
            cancelled = true
          },
        }),
        {headers: {"content-type": "application/json"}},
      )

    const response = await phone("/devices")

    expect(response.status).toBe(503)
    expect(await eventually(() => cancelled)).toBe(true)
    // It had no end: had Core read it to the end this test would not finish.
    expect(sent).toBeLessThan(2000)
  })

  test("so does a failure or a redirect whose body never ends: the request is ended, not just the read", async () => {
    configure()
    for (const [status, headers] of [
      [500, {}],
      [503, {"retry-after": "5"}],
      [302, {location: "https://elsewhere.example/x"}],
    ] as const) {
      let cancelled = false
      respond = () => new Response(endlessBody(1024, () => (cancelled = true)), {status, headers})

      const response = await phone("/overview")

      expect([status, response.status]).toEqual([status, 503])
      expect([status, await eventually(() => cancelled)]).toEqual([status, true])
    }
  })

  test("a response exactly at the cap passes through", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16"})
    respond = () => new Response("x".repeat(16), {headers: {"content-type": "application/json"}})

    const response = await phone("/devices")

    expect(response.status).toBe(200)
    expect(await response.text()).toBe("x".repeat(16))
  })

  test("the default cap is 10 MiB, and an unusable value does not lift it", async () => {
    const MIB10 = 10 * 1024 * 1024
    for (const value of [undefined, "0", "-5", "abc", "1.5", ""]) {
      configure(value === undefined ? {} : {CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: value})
      respond = () => new Response("x".repeat(MIB10), {headers: {"content-type": "application/json"}})
      const atCap = await phone("/devices")
      expect([value, atCap.status, (await atCap.arrayBuffer()).byteLength]).toEqual([value, 200, MIB10])

      respond = () => new Response("x".repeat(MIB10 + 1), {headers: {"content-type": "application/json"}})
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

  test("a valid Retry-After on an upstream 5xx reaches the caller on Core's own 503, and an invalid one does not", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))

    for (const [retryAfter, passed] of [
      ["30", "30"],
      ["0", "0"],
      ["120", "120"],
      [undefined, null],
      ["soon", null],
      ["-5", null],
      ["1.5", null],
      ["30 seconds", null],
      ["Wed, 21 Oct 2026 07:28:00 GMT", null],
      ["99999999999999999999", null],
    ] as const) {
      for (const status of [500, 503]) {
        respond = () =>
          Response.json({secret: "internal details"}, {status, headers: retryAfter ? {"retry-after": retryAfter} : {}})

        for (const response of [await phone("/devices"), await admin(organizationAdmin, "/devices")]) {
          expect([retryAfter, status, response.status]).toEqual([retryAfter, status, 503])
          expect([retryAfter, status, response.headers.get("retry-after")]).toEqual([retryAfter, status, passed])
          expect(await response.json()).toEqual({error: "fleet_unavailable"})
        }
      }
    }
  })

  test("a failure that is not an upstream answer carries no Retry-After", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "100"})
    respond = () => new Promise<Response>(() => {})

    const response = await phone("/devices")

    expect(response.status).toBe(503)
    expect(response.headers.get("retry-after")).toBeNull()
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
      respond = () => new Response(null, {status, headers: {"location": "/v1/client/elsewhere", "retry-after": "30"}})

      const response = await phone("/devices")

      expect([status, response.status]).toEqual([status, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
      expect(response.headers.get("location")).toBeNull()
      // A redirect Core does not follow is not Fleet asking for time.
      expect(response.headers.get("retry-after")).toBeNull()
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

describe("what the JSON routes answer with", () => {
  // The admin session cookie is SameSite=Lax, so a top-level GET to `/api/admin/fleet/<rest>` carries it, and
  // what the route answers is read by the browser as a document of the admin origin. Core therefore labels
  // every answer of the JSON routes as data nothing may render or run, and relays only JSON.
  const NOSNIFF = "nosniff"
  const SANDBOX_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox"
  const ROTATED = "__Host-mentra_admin_session=rotated-value; Path=/; HttpOnly; Secure; SameSite=Lax"

  const securityHeaders = (response: Response) => ({
    nosniff: response.headers.get("x-content-type-options"),
    csp: response.headers.get("content-security-policy"),
  })
  const labelled = {nosniff: NOSNIFF, csp: SANDBOX_CSP}

  /** One request on each surface, as the caller each needs. */
  const surfaces: Array<[string, (rest: string, init?: Init) => Promise<Response> | Response]> = [
    ["the phone's", (rest, init) => phone(rest, init)],
    ["the admin's", (rest, init) => admin(as("organization-admin", person(true)), rest, init)],
  ]

  test("every answer carries nosniff and a sandbox CSP: relayed ones, Fleet's failures and Core's own", async () => {
    const organizationAdmin = as("organization-admin", person(true))
    const answers: Record<string, [() => Response | Promise<Response>, Init?]> = {
      "a 200": [() => Response.json({ok: true})],
      "a 201 with a charset": [
        () => new Response("{}", {status: 201, headers: {"content-type": "application/json; charset=utf-8"}}),
      ],
      "a 4xx": [() => Response.json({error: "nope"}, {status: 404})],
      "a 204": [() => new Response(null, {status: 204})],
      "a 304": [() => new Response(null, {status: 304})],
      "a HEAD": [() => new Response(null, {status: 200, headers: {"content-type": "application/json"}}), {method: "HEAD"}],
      "an upstream 401, relayed as 403": [() => Response.json({error: "x"}, {status: 401})],
      "an upstream 500, answered 503": [() => Response.json({error: "x"}, {status: 500})],
      "an upstream redirect, answered 503": [() => new Response(null, {status: 302, headers: {location: "/x"}})],
      "an html answer, answered 503": [() => new Response("<script>1</script>", {headers: {"content-type": "text/html"}})],
    }

    configure()
    for (const [name, [reply, init]] of Object.entries(answers)) {
      respond = reply
      for (const response of [await phone("/overview", init), await admin(organizationAdmin, "/overview", init)]) {
        expect([name, securityHeaders(response)]).toEqual([name, labelled])
      }
    }

    // Core's own answers, before anything is forwarded.
    const own: Record<string, () => Promise<Response> | Response> = {
      "a Fleet that is not installed": () => {
        delete process.env.CLOUD_CORE_FLEET_URL
        return admin(organizationAdmin, "/overview")
      },
      "a Fleet that is misconfigured": () => {
        process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
        delete process.env.CLOUD_CORE_FLEET_SECRET
        return phone("/overview")
      },
      "a body that is too large": () => {
        configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "4"})
        return admin(organizationAdmin, "/overview", {method: "POST", body: "too long for it"})
      },
      "a body that is not UTF-8": () => {
        configure()
        return admin(organizationAdmin, "/overview", {method: "POST", body: new Uint8Array([0xff])})
      },
      "an unsafe path": () => {
        configure()
        return root.fetch(rawUrlRequest("http://localhost/api/client/fleet/a/../b", {authorization: "Bearer phone:mu_phone"}))
      },
      "an unsafe admin path": () => {
        configure()
        return root.fetch(rawUrlRequest("http://localhost/api/admin/fleet/a/../b", {"x-test-principal": organizationAdmin}))
      },
      "a spelling of ui the forwarder refuses": () => {
        configure()
        return admin(organizationAdmin, "/UI/entry.js")
      },
      "a phone with no token": () => {
        configure()
        return root.request("http://localhost/api/client/fleet/overview")
      },
      "a person without the capability": () => {
        configure()
        return admin(as("member", person(false)), "/overview")
      },
      "a key": () => {
        configure()
        return admin(as("operator-key", key("organization", [...OPERATOR_KEY_SCOPES])), "/overview")
      },
      "a person without the capability, Fleet not installed": () => {
        delete process.env.CLOUD_CORE_FLEET_URL
        return admin(as("member", person(false)), "/overview")
      },
    }
    for (const [name, answer] of Object.entries(own)) {
      const response = await answer()
      expect([name, response.status >= 400, securityHeaders(response)]).toEqual([name, true, labelled])
    }
  })

  test("the labels are set on the context, so a rotated session cookie and Fleet's headers survive beside them", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    respond = () =>
      new Response('{"a":1}', {
        status: 201,
        headers: {"content-type": "application/json", "cache-control": "no-store", "x-request-id": "fleet-1"},
      })

    const response = await admin(organizationAdmin, "/overview", {headers: {"x-test-set-cookie": ROTATED}})

    expect(response.status).toBe(201)
    expect(securityHeaders(response)).toEqual(labelled)
    expect(response.headers.getSetCookie()).toEqual([ROTATED])
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-request-id")).toBe("fleet-1")
  })

  test("Fleet cannot loosen the labels: its own x-content-type-options and content-security-policy are not relayed", async () => {
    configure()
    respond = () =>
      Response.json(
        {ok: true},
        {headers: {"x-content-type-options": "", "content-security-policy": "default-src *", "x-frame-options": "ALLOWALL"}},
      )

    for (const [, request] of surfaces) {
      const response = await request("/overview")
      expect(securityHeaders(response)).toEqual(labelled)
      expect(response.headers.get("x-frame-options")).toBeNull()
    }
  })

  test("the UI asset route keeps its own headers: no sandbox on a script, and SVG's own policy", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    respond = () => new Response("export {}", {headers: {"content-type": "text/javascript"}})

    const script = await admin(organizationAdmin, "/ui/entry.js")

    expect(script.status).toBe(200)
    expect(script.headers.get("x-content-type-options")).toBe(NOSNIFF)
    expect(script.headers.get("content-security-policy")).toBeNull()
    expect(script.headers.get("cross-origin-resource-policy")).toBe("same-origin")
  })

  test("a 2xx that is not JSON is a 503 fleet_unavailable and none of its body or headers reach the caller", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    const notJson: Array<[string, () => Response]> = [
      ["text/html", () => new Response("<script>alert(1)</script>", {headers: {"content-type": "text/html; charset=utf-8"}})],
      ["text/html with a 201", () => new Response("<b>created</b>", {status: 201, headers: {"content-type": "text/html"}})],
      ["text/plain", () => new Response("hello", {headers: {"content-type": "text/plain"}})],
      ["text/javascript", () => new Response("alert(1)", {headers: {"content-type": "text/javascript"}})],
      ["image/svg+xml", () => new Response("<svg onload=alert(1)/>", {headers: {"content-type": "image/svg+xml"}})],
      ["application/xhtml+xml", () => new Response("<html/>", {headers: {"content-type": "application/xhtml+xml"}})],
      ["a vendor json type", () => new Response("{}", {headers: {"content-type": "application/vnd.fleet+json"}})],
      ["a body with no content type", () => new Response(new Uint8Array([0x7b, 0x7d]))],
      ["a list holding html", () => new Response("<b/>", {headers: {"content-type": "application/json, text/html"}})],
      ["json as a parameter of html", () => new Response("<b/>", {headers: {"content-type": "text/html; profile=application/json"}})],
      ["json as a prefix", () => new Response("{}", {headers: {"content-type": "application/jsonp"}})],
    ]

    for (const [name, answer] of notJson) {
      for (const [surface, request] of [
        ["phone", (rest: string) => phone(rest)],
        ["admin", (rest: string) => admin(organizationAdmin, rest)],
      ] as const) {
        respond = answer
        logs = []

        const response = await request("/overview")

        expect([name, surface, response.status]).toEqual([name, surface, 503])
        expect([name, surface, await response.json()]).toEqual([name, surface, {error: "fleet_unavailable"}])
        expect([name, surface, response.headers.get("content-type")]).toEqual([name, surface, "application/json"])
        expect([name, surface, securityHeaders(response)]).toEqual([name, surface, labelled])
        // The refusal is a warning that names why, never what was said.
        const line = logs.find(entry => entry.message === "Fleet request forwarded")
        expect([name, surface, line?.level, line?.fields]).toEqual([
          name,
          surface,
          "warn",
          expect.objectContaining({status: 503, upstreamStatus: answer().status, reason: "content_type_not_json"}),
        ])
      }
    }
  })

  test("JSON passes, with or without parameters and whatever its case", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    for (const contentType of [
      "application/json",
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "Application/JSON",
      "application/json ; charset=utf-8",
    ]) {
      respond = () => new Response('{"ok":true}', {status: 201, headers: {"content-type": contentType}})
      for (const response of [await phone("/overview"), await admin(organizationAdmin, "/overview")]) {
        expect([contentType, response.status]).toEqual([contentType, 201])
        expect(await response.json()).toEqual({ok: true})
        expect(response.headers.get("content-type")).toBe(contentType)
      }
    }
  })

  test("no body, no check: a 204, 205, 304, a HEAD and an empty answer pass whatever they are labelled", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    const bodiless: Array<[string, () => Response, Init?]> = [
      ["a 204", () => new Response(null, {status: 204, headers: {"content-type": "text/html"}})],
      ["a 205", () => new Response(null, {status: 205, headers: {"content-type": "text/html"}})],
      ["a 304", () => new Response(null, {status: 304, headers: {"content-type": "text/html"}})],
      ["a HEAD", () => new Response(null, {status: 200, headers: {"content-type": "text/html", "content-length": "99"}}), {method: "HEAD"}],
      ["a HEAD with no content type", () => new Response(null, {status: 200}), {method: "HEAD"}],
      ["an empty 200", () => new Response(null, {status: 200})],
      ["an empty 200 labelled html", () => new Response("", {status: 200, headers: {"content-type": "text/html"}})],
    ]

    for (const [name, reply, init] of bodiless) {
      respond = reply
      for (const response of [await phone("/overview", init), await admin(organizationAdmin, "/overview", init)]) {
        expect([name, response.status]).toEqual([name, reply().status])
        expect([name, await response.text()]).toEqual([name, ""])
        expect([name, securityHeaders(response)]).toEqual([name, labelled])
      }
    }
  })

  test("an error answer is relayed whatever it is labelled: the labels make it inert, and it is Fleet's status to give", async () => {
    configure()
    respond = () => new Response("<h1>Bad gateway page</h1>", {status: 404, headers: {"content-type": "text/html"}})

    for (const [, request] of surfaces) {
      const response = await request("/overview")
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toBe("text/html")
      expect(securityHeaders(response)).toEqual(labelled)
    }
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

  test("an upstream 401 is a warning: Fleet's 401 is never an answer, so something is misconfigured", async () => {
    configure()
    respond = () => Response.json({error: "bad_signature"}, {status: 401})

    const response = await phone("/devices")

    expect(response.status).toBe(403)
    expect(logs.find(entry => entry.level === "warn")?.fields).toMatchObject({upstreamStatus: 401, status: 403})
  })

  test("an answer Fleet gives that is not a success is logged at info, so a secret mismatch (Fleet's 403) shows in production", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))

    for (const status of [400, 403, 404, 409, 413, 422, 429]) {
      logs = []
      respond = () => Response.json({error: "fleet_says_no"}, {status, headers: {"x-request-id": `fleet-${status}`}})

      const fromPhone = await phone("/devices")
      const fromAdmin = await admin(organizationAdmin, "/devices")

      expect([status, fromPhone.status, fromAdmin.status]).toEqual([status, status, status])
      const lines = logs.filter(line => line.message.includes("Fleet"))
      expect(lines.map(line => line.level)).toEqual(["info", "info"])
      expect(lines.map(line => line.fields)).toEqual([
        {audience: "client", upstreamRequestId: `fleet-${status}`, upstreamStatus: status, status, ms: expect.any(Number)},
        {audience: "admin", upstreamRequestId: `fleet-${status}`, upstreamStatus: status, status, ms: expect.any(Number)},
      ])
    }
  })

  test("a request that did not reach Fleet's answer is a warning", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "100"})
    respond = () => new Promise<Response>(() => {})

    await phone("/devices")

    const line = logs.find(entry => entry.level === "warn")
    expect(line?.fields).toMatchObject({status: 503, upstreamStatus: null, upstreamRequestId: null})
    expect(line?.fields.reason).toBeString()
  })

  test("a success is only debug, so routine reports do not fill the log", async () => {
    configure()

    for (const [status, init] of [
      [200, {}],
      [201, {}],
      [204, {}],
      [304, {}],
    ] as const) {
      logs = []
      respond = () =>
        new Response(status === 204 || status === 304 ? null : "{}", {
          status,
          headers: {"content-type": "application/json"},
          ...init,
        })

      expect((await phone("/devices")).status).toBe(status)

      const lines = logs.filter(line => line.message.includes("Fleet"))
      expect([status, lines.map(line => line.level)]).toEqual([status, ["debug"]])
    }
  })
})

describe("a cookie the request already set", () => {
  // `principalAuth` rotates a portal session older than a day and sets the new cookie on the context before
  // the handler runs. A handler that returns a raw `Response` replaces the context's headers and loses it,
  // which signs the Organization Admin out a minute later. Every answer must be built through the context.
  const ROTATED = "__Host-mentra_admin_session=rotated-value; Path=/; HttpOnly; Secure; SameSite=Lax"

  test("survives every answer the forwarder gives, relayed or its own", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16", CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})
    const organizationAdmin = as("organization-admin", person(true))
    const answers: Record<string, [() => Response | Promise<Response>, Init?]> = {
      "200": [() => Response.json({ok: true})],
      "201 with every passed header": [
        () =>
          new Response("{}", {
            status: 201,
            headers: {"content-type": "application/json", "cache-control": "no-store", "retry-after": "5", "x-request-id": "f-1"},
          }),
      ],
      "204": [() => new Response(null, {status: 204})],
      "304": [() => new Response(null, {status: 304})],
      "HEAD": [() => new Response(null, {status: 200}), {method: "HEAD"}],
      "404": [() => Response.json({error: "nope"}, {status: 404})],
      "429": [() => Response.json({error: "slow"}, {status: 429, headers: {"retry-after": "30"}})],
      "an upstream 401, relayed as 403": [() => Response.json({error: "x"}, {status: 401})],
      "an upstream 500, answered 503": [() => Response.json({error: "x"}, {status: 500, headers: {"retry-after": "30"}})],
      "an upstream redirect, answered 503": [() => new Response(null, {status: 302, headers: {location: "/x"}})],
      "a response over the cap, answered 503": [() => new Response("x".repeat(17))],
      "a request that never gets an answer": [() => new Promise<Response>(() => {})],
    }

    for (const [name, [reply, init]] of Object.entries(answers)) {
      respond = reply
      if (name === "a request that never gets an answer") process.env.CLOUD_CORE_FLEET_TIMEOUT_MS = "100"
      else process.env.CLOUD_CORE_FLEET_TIMEOUT_MS = "10000"

      for (const response of [
        await admin(organizationAdmin, "/overview", {...init, headers: {"x-test-set-cookie": ROTATED}}),
        await phone("/overview", {...init, headers: {"x-test-set-cookie": ROTATED}}),
      ]) {
        expect([name, response.headers.getSetCookie()]).toEqual([name, [ROTATED]])
      }
    }
  })

  test("survives Core's own answers before anything is forwarded", async () => {
    const organizationAdmin = as("organization-admin", person(true))
    const headers = {"x-test-set-cookie": ROTATED}
    const cookies = async (response: Promise<Response> | Response) => (await response).headers.getSetCookie()

    // Not installed, misconfigured.
    expect(await cookies(admin(organizationAdmin, "/overview", {headers}))).toEqual([ROTATED])
    process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
    expect(await cookies(admin(organizationAdmin, "/overview", {headers}))).toEqual([ROTATED])
    // Ready: a refused path, a refused body, a body over the limit.
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "4"})
    const unsafe = rawUrlRequest("http://localhost/api/admin/fleet/a/../b", {...headers, "x-test-principal": organizationAdmin})
    expect(await cookies(root.fetch(unsafe))).toEqual([ROTATED])
    expect(await cookies(admin(organizationAdmin, "/overview", {method: "POST", body: new Uint8Array([0xff]), headers}))).toEqual([
      ROTATED,
    ])
    expect(await cookies(admin(organizationAdmin, "/overview", {method: "POST", body: "too long for it", headers}))).toEqual([
      ROTATED,
    ])
  })

  test("is not mistaken for Fleet's: a Set-Cookie from Fleet never reaches the caller", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    respond = () => new Response("{}", {headers: {"set-cookie": "fleet=1; Path=/"}})

    const response = await admin(organizationAdmin, "/overview", {headers: {"x-test-set-cookie": ROTATED}})

    expect(response.headers.getSetCookie()).toEqual([ROTATED])
  })

  test("leaves the answer's own headers alone, and Fleet's request id replaces the one set earlier", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))
    respond = () =>
      new Response('{"a":1}', {
        status: 201,
        headers: {"content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=5", "x-request-id": "fleet-own-id"},
      })
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const response = await withContext.request("http://localhost/api/admin/fleet/overview", {
      headers: {"x-test-principal": organizationAdmin, "x-test-set-cookie": ROTATED, "x-request-id": "caller-id"},
    })

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('{"a":1}')
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
    expect(response.headers.get("x-request-id")).toBe("fleet-own-id")
    expect(response.headers.getSetCookie()).toEqual([ROTATED])
  })
})

describe("Fleet UI assets", () => {
  // `/api/admin/fleet/ui/<rest>` is the browser-loadable module the admin portal imports. It has its own
  // route ahead of the JSON forwarder: GET and HEAD only, the body read whole under a byte cap and
  // checked against its declared length before any of it is relayed, and a content-type allowlist, because
  // what it relays runs in the portal's origin.
  const ENTRY = "/ui/entry.js"
  const JS = "text/javascript; charset=utf-8"
  const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"
  const ROTATED = "__Host-mentra_admin_session=rotated-value; Path=/; HttpOnly; Secure; SameSite=Lax"

  /** Core's `fetch` to Fleet answers with `response` (the stub server cannot show what was read from a body). */
  function fleetAnswers(response: Response) {
    return spyOn(globalThis, "fetch").mockResolvedValue(response)
  }

  const organizationAdmin = () => as("organization-admin", person(true))

  test("a 3 MiB JS asset arrives intact, with its etag and nosniff", async () => {
    configure()
    const bytes = patterned(3 * 1024 * 1024)
    respond = () =>
      new Response(bytes, {
        headers: {
          "content-type": JS,
          "etag": '"entry-v1"',
          "last-modified": "Tue, 13 Oct 2026 10:00:00 GMT",
          "cache-control": "public, max-age=3600",
          "vary": "Accept-Encoding",
          "x-request-id": "fleet-asset-1",
        },
      })

    const response = await admin(organizationAdmin(), `${ENTRY}?v=2`)

    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true)
    expect(response.headers.get("content-type")).toBe(JS)
    expect(response.headers.get("etag")).toBe('"entry-v1"')
    expect(response.headers.get("last-modified")).toBe("Tue, 13 Oct 2026 10:00:00 GMT")
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
    expect(response.headers.get("vary")).toBe("Accept-Encoding")
    expect(response.headers.get("content-length")).toBe(String(bytes.byteLength))
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(response.headers.get("x-request-id")).toBe("fleet-asset-1")
    // Only SVG gets a content-security-policy from Core.
    expect(response.headers.get("content-security-policy")).toBeNull()
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("GET")
    expect(calls[0].pathWithQuery).toBe("/v1/admin/ui/entry.js?v=2")
    expect(serviceSignatureVerifies(calls[0])).toBe(true)
    expect(principalSignatureVerifies(calls[0])).toBe(true)
    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      kind: "user",
      mentraUserId: "mu_1",
      scope: {kind: "organization"},
    })
  })

  test("the asset limit is CLOUD_CORE_FLEET_MAX_ASSET_BYTES, not the response limit of the JSON routes", async () => {
    configure({CLOUD_CORE_FLEET_MAX_RESPONSE_BYTES: "16"})
    respond = () => new Response(patterned(1024), {headers: {"content-type": JS}})

    const asset = await admin(organizationAdmin(), ENTRY)
    const json = await admin(organizationAdmin(), "/overview")

    expect(asset.status).toBe(200)
    expect((await asset.arrayBuffer()).byteLength).toBe(1024)
    // The same 1 KiB on a JSON route is over its own cap of 16.
    expect(json.status).toBe(503)
  })

  test("only the revalidation headers go upstream, and the caller's own credentials never do", async () => {
    configure()

    await admin(organizationAdmin(), ENTRY, {
      headers: {
        "if-none-match": '"entry-v1"',
        "if-modified-since": "Tue, 13 Oct 2026 10:00:00 GMT",
        "range": "bytes=0-9",
        "if-range": '"entry-v1"',
        "accept": "text/html",
        "cookie": "__Host-mentra_admin_session=a-session",
        "authorization": "Bearer caller-token",
        "x-mentra-principal": "forged",
        "x-mentra-service-signature": "forged",
      },
    })

    expect(calls).toHaveLength(1)
    const upstreamHeaders = calls[0].headers
    expect(upstreamHeaders.get("if-none-match")).toBe('"entry-v1"')
    expect(upstreamHeaders.get("if-modified-since")).toBe("Tue, 13 Oct 2026 10:00:00 GMT")
    for (const name of ["range", "if-range", "cookie", "authorization", "x-test-principal"]) {
      expect([name, upstreamHeaders.get(name)]).toEqual([name, null])
    }
    // The only accept Fleet sees is none from the caller: not the browser's `text/html`.
    expect(upstreamHeaders.get("accept")).not.toBe("text/html")
    // What Fleet is sent is still signed by Core alone.
    expect(upstreamHeaders.get("x-mentra-principal")).not.toBe("forged")
    expect(principalSignatureVerifies(calls[0])).toBe(true)
    expect(serviceSignatureVerifies(calls[0])).toBe(true)
    // The bytes Core relays are the bytes Fleet sent: it asks for no content-encoding.
    expect(upstreamHeaders.get("accept-encoding")).toBe("identity")
  })

  test("if-none-match round-trips to a 304 with no body, and so does if-modified-since", async () => {
    configure()
    respond = request =>
      request.headers.get("if-none-match") === '"entry-v1"' || request.headers.get("if-modified-since")
        ? new Response(null, {
            status: 304,
            headers: {
              "etag": '"entry-v1"',
              "last-modified": "Tue, 13 Oct 2026 10:00:00 GMT",
              "cache-control": "public, max-age=3600",
              "vary": "Accept-Encoding",
              "content-length": "9999",
              "content-type": "text/html",
            },
          })
        : new Response(patterned(100), {headers: {"content-type": JS, "etag": '"entry-v1"'}})

    const byEtag = await admin(organizationAdmin(), ENTRY, {headers: {"if-none-match": '"entry-v1"'}})
    const byDate = await admin(organizationAdmin(), ENTRY, {headers: {"if-modified-since": "Tue, 13 Oct 2026 10:00:00 GMT"}})
    const fresh = await admin(organizationAdmin(), ENTRY)

    for (const response of [byEtag, byDate]) {
      expect(response.status).toBe(304)
      expect(await response.text()).toBe("")
      expect(response.headers.get("etag")).toBe('"entry-v1"')
      expect(response.headers.get("last-modified")).toBe("Tue, 13 Oct 2026 10:00:00 GMT")
      expect(response.headers.get("cache-control")).toBe("public, max-age=3600")
      expect(response.headers.get("vary")).toBe("Accept-Encoding")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      // A 304 has no representation: no length, and no content-type to check or relay.
      expect(response.headers.get("content-length")).toBeNull()
      expect(response.headers.get("content-type")).toBeNull()
    }
    expect(calls[0].headers.get("if-none-match")).toBe('"entry-v1"')
    expect(calls[1].headers.get("if-modified-since")).toBe("Tue, 13 Oct 2026 10:00:00 GMT")
    expect(fresh.status).toBe(200)
    expect((await fresh.arrayBuffer()).byteLength).toBe(100)
  })

  test("an answer that crosses the cap is cut off: a declared length is a 503 before any of it is read", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "1024"})
    const {body, state} = watchedBody(512)
    const fetched = fleetAnswers(new Response(body, {headers: {"content-type": JS, "content-length": "1025"}}))

    const response = await admin(organizationAdmin(), ENTRY)
    fetched.mockRestore()

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(state.pulled).toBe(0)
    expect(state.cancelled).toBe(true)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
  })

  test("an answer exactly at the cap passes, declared or not, and is sent with its true length", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "1024"})
    respond = () => new Response(patterned(1024), {headers: {"content-type": JS}})
    const declared = await admin(organizationAdmin(), ENTRY)
    expect(declared.status).toBe(200)
    expect((await declared.arrayBuffer()).byteLength).toBe(1024)

    const {body} = watchedBody(256, 4)
    const fetched = fleetAnswers(new Response(body, {headers: {"content-type": JS}}))
    const undeclared = await admin(organizationAdmin(), ENTRY)
    fetched.mockRestore()
    expect(undeclared.status).toBe(200)
    expect(undeclared.headers.get("content-length")).toBe("1024")
    expect((await undeclared.arrayBuffer()).byteLength).toBe(1024)
  })

  test("an undeclared body that passes the cap is a 503 with none of Fleet's headers, and the upstream is cancelled", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "64"})
    // Endless, and it declares no length: only a counter can stop it.
    const {body, state} = watchedBody(8)
    const fetched = fleetAnswers(
      new Response(body, {headers: {"content-type": JS, "etag": '"from-fleet"', "cache-control": "public, max-age=31536000"}}),
    )

    const response = await admin(organizationAdmin(), ENTRY)
    fetched.mockRestore()

    // A status cannot change once a body is on its way, so Core reads the body whole first: 503, not a short 200.
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(response.headers.get("etag")).toBeNull()
    expect(response.headers.get("cache-control")).toBeNull()
    expect(response.headers.get("content-type")).toBe("application/json")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await eventually(() => state.cancelled)).toBe(true)
    // It had no end: a handful of chunks past the cap at most.
    expect(state.pulled).toBeLessThan(20)
    expect(logs.some(line => line.level === "warn" && line.fields.reason === "asset_over_cap" && line.fields.upstreamStatus === 200)).toBe(
      true,
    )
  })

  test("a real client of Core sees that 503, never a 200, and the connection to Fleet is closed", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: String(256 * 1024)})
    let sent = 0
    let cancelled = false
    const chunk = patterned(64 * 1024)
    respond = () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            sent++
            controller.enqueue(chunk)
            await Bun.sleep(1)
          },
          cancel() {
            cancelled = true
          },
        }),
        {headers: {"content-type": "text/css", "etag": '"from-fleet"', "cache-control": "public, max-age=31536000"}},
      )

    const response = await fetch(`${coreOverHttp()}/api/admin/fleet/ui/entry.css`, {
      headers: {"x-test-principal": organizationAdmin()},
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(response.headers.get("etag")).toBeNull()
    expect(response.headers.get("cache-control")).toBeNull()
    expect(await eventually(() => cancelled)).toBe(true)
    // It had no end: had Core read it to the end this test would not finish.
    expect(sent).toBeLessThan(2000)
  })

  test("a body shorter or longer than its declared length is a 503, and so is a Fleet that dies mid-answer", async () => {
    configure()
    for (const [declared, actual] of [
      [1000, 100],
      [100, 200],
    ]) {
      const fetched = fleetAnswers(
        new Response(patterned(actual), {headers: {"content-type": JS, "etag": '"from-fleet"', "content-length": String(declared)}}),
      )
      const response = await admin(organizationAdmin(), ENTRY)
      fetched.mockRestore()
      expect([declared, actual, response.status]).toEqual([declared, actual, 503])
      expect(response.headers.get("etag")).toBeNull()
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
    expect(logs.filter(line => line.fields.reason === "length_mismatch")).toHaveLength(2)

    // On a real socket: Fleet promises 1000 bytes, sends 100 and closes. A real client of Core sees a 503.
    logs = []
    const dying = resettingFleet(1000, 100)
    const target = `http://127.0.0.1:${dying.port}`
    const actualFetch = globalThis.fetch.bind(globalThis)
    let headersObserved = 0
    const observedFetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const response = await actualFetch(input, init)
      const url = input instanceof Request ? input.url : String(input)
      if (url === `${target}/v1/admin/ui/entry.js` && (init?.method ?? (input instanceof Request ? input.method : "GET")) === "GET") {
        expect(response.status).toBe(200)
        headersObserved++
        dying.afterHeaders()
      }
      return response
    }, {preconnect: globalThis.fetch.preconnect})
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(observedFetch)
    try {
      process.env.CLOUD_CORE_FLEET_URL = target
      const response = await fetch(`${coreOverHttp()}/api/admin/fleet/ui/entry.js`, {
        headers: {"x-test-principal": organizationAdmin()},
      })
      expect(headersObserved).toBe(1)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
      expect(response.headers.get("etag")).toBeNull()
      expect(response.headers.get("cache-control")).toBeNull()
      // It shows in the logs: a warning that names what failed and what Fleet had answered, never the content.
      const failure = logs.find(line => line.message.includes("Fleet request forwarded") && line.fields.status === 503)
      expect(failure?.level).toBe("warn")
      expect(failure?.fields.upstreamStatus).toBe(200)
      expect(typeof failure?.fields.reason).toBe("string")
    } finally {
      fetchSpy.mockRestore()
      dying.stop()
    }
  })

  test("an encoding Core did not ask for is a 503: it asks for none, and a length of encoded bytes proves nothing", async () => {
    configure()
    const plain = patterned(5000)
    const encoded = Bun.gzipSync(plain)
    respond = request =>
      new URL(request.url).pathname.endsWith("gz.js")
        ? new Response(encoded, {headers: {"content-type": JS, "content-encoding": "gzip"}})
        : new Response(plain, {headers: {"content-type": JS, "content-encoding": "identity", "etag": '"plain"'}})

    const identity = await admin(organizationAdmin(), "/ui/plain.js")
    const gzipped = await admin(organizationAdmin(), "/ui/gz.js")

    expect(identity.status).toBe(200)
    expect(identity.headers.get("content-length")).toBe("5000")
    expect(identity.headers.get("content-encoding")).toBeNull()
    expect(Buffer.from(await identity.arrayBuffer()).equals(Buffer.from(plain))).toBe(true)
    expect(gzipped.status).toBe(503)
    expect(gzipped.headers.get("content-encoding")).toBeNull()
    expect(await gzipped.json()).toEqual({error: "fleet_unavailable"})
    expect(logs.some(line => line.level === "warn" && line.fields.reason === "content_encoding_not_identity")).toBe(true)
    // Even a small body that would decode to far more than the cap is refused before anything is read.
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "1024"})
    respond = () => new Response(Bun.gzipSync(new Uint8Array(100_000)), {headers: {"content-type": JS, "content-encoding": "gzip"}})
    expect((await admin(organizationAdmin(), ENTRY)).status).toBe(503)
  })

  test("the content types allowed are scripts, styles, images, fonts and JSON", async () => {
    configure()
    const allowed = [
      "text/javascript",
      "text/javascript; charset=utf-8",
      "application/javascript",
      "TEXT/JavaScript; Charset=UTF-8",
      "text/css",
      "text/css; charset=utf-8",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "image/avif",
      "font/woff2",
      "font/woff",
      "application/json",
      "application/json; charset=utf-8",
    ]
    for (const type of allowed) {
      respond = () => new Response(patterned(32), {headers: {"content-type": type}})
      const response = await admin(organizationAdmin(), "/ui/asset")
      expect([type, response.status]).toEqual([type, 200])
      // Relayed as Fleet sent it.
      expect([type, response.headers.get("content-type")]).toEqual([type, type])
      expect((await response.arrayBuffer()).byteLength).toBe(32)
    }
  })

  test("text/html and every other content type is a 503 and none of the body reaches the caller", async () => {
    configure()
    const refused = [
      "text/html",
      "text/html; charset=utf-8",
      "TEXT/HTML",
      "application/xhtml+xml",
      "text/plain",
      "text/xml",
      "application/xml",
      "application/octet-stream",
      "application/wasm",
      "application/pdf",
      "image/x-icon",
      "image/svg+xml-compressed",
      "text/javascript-evil",
      "multipart/form-data; boundary=x",
      "",
    ]
    for (const type of refused) {
      respond = () => new Response("<script>steal()</script>", {headers: type ? {"content-type": type} : {}})
      const response = await admin(organizationAdmin(), "/ui/page")
      const text = await response.text()
      expect([type, response.status]).toEqual([type, 503])
      expect([type, JSON.parse(text)]).toEqual([type, {error: "fleet_unavailable"}])
      expect([type, response.headers.get("content-type")]).toEqual([type, "application/json"])
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }

    // An error answer is held to the same list: a text/html 404 is not relayed either.
    respond = () => new Response("<h1>Not found</h1>", {status: 404, headers: {"content-type": "text/html"}})
    expect((await admin(organizationAdmin(), "/ui/missing.js")).status).toBe(503)
    // A content type Fleet did not send at all is not a type that is allowed, unless the answer is empty.
    respond = () => new Response(new Uint8Array([1, 2, 3]))
    const typeless = await admin(organizationAdmin(), "/ui/typeless")
    expect(typeless.status).toBe(503)
  })

  test("a content-type holding a comma is a 503: a browser keeps the last of the values", async () => {
    configure()
    for (const type of [
      "text/javascript; charset=utf-8, text/html",
      "text/javascript,text/html",
      "text/html, text/javascript",
      "application/json, text/css",
      "image/png, image/svg+xml",
    ]) {
      respond = () => new Response(patterned(32), {headers: {"content-type": type}})
      const get = await admin(organizationAdmin(), "/ui/page")
      const head = await admin(organizationAdmin(), "/ui/page", {method: "HEAD"})
      expect([type, get.status, head.status]).toEqual([type, 503, 503])
      expect(await get.json()).toEqual({error: "fleet_unavailable"})
    }

    // Two content-type lines arrive as one comma-joined value.
    const fetched = fleetAnswers(
      new Response(patterned(32), {
        headers: new Headers([
          ["content-type", "text/javascript"],
          ["content-type", "text/html"],
        ]),
      }),
    )
    const joined = await admin(organizationAdmin(), "/ui/page")
    fetched.mockRestore()
    expect(joined.status).toBe(503)
    expect(logs.filter(line => line.fields.reason === "content_type_not_allowed").length).toBeGreaterThanOrEqual(5)
  })

  test("a 404 or a 403 from Fleet passes through as JSON, and an empty one with no content type does too", async () => {
    configure()
    respond = () => Response.json({error: "not_found"}, {status: 404, headers: {"cache-control": "no-store"}})
    const missing = await admin(organizationAdmin(), "/ui/missing.js")
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({error: "not_found"})
    expect(missing.headers.get("cache-control")).toBe("no-store")
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff")

    respond = () => new Response(new Uint8Array(0), {status: 404})
    const empty = await admin(organizationAdmin(), "/ui/missing.js")
    expect(empty.status).toBe(404)
    expect(await empty.text()).toBe("")
  })

  test("SVG is relayed with Core's content-security-policy, whatever Fleet sent", async () => {
    configure()
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>steal()</script></svg>'
    respond = () =>
      new Response(svg, {
        headers: {"content-type": "image/svg+xml", "content-security-policy": "default-src *", "etag": '"s1"'},
      })

    const get = await admin(organizationAdmin(), "/ui/logo.svg")
    const head = await admin(organizationAdmin(), "/ui/logo.svg", {method: "HEAD"})

    for (const response of [get, head]) {
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("image/svg+xml")
      expect(response.headers.get("content-security-policy")).toBe(SVG_CSP)
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    }
    expect(await get.text()).toBe(svg)
    expect(await head.text()).toBe("")

    // Variants of the type are SVG too.
    respond = () => new Response(svg, {headers: {"content-type": "Image/SVG+XML; charset=utf-8"}})
    expect((await admin(organizationAdmin(), "/ui/logo.svg")).headers.get("content-security-policy")).toBe(SVG_CSP)
  })

  test("a HEAD gets the status and headers a GET would, with no body", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "4096"})
    const bytes = patterned(2048)
    respond = request =>
      new Response(request.method === "HEAD" ? null : bytes, {
        headers: {"content-type": JS, "etag": '"entry-v1"', "content-length": String(bytes.byteLength)},
      })

    const head = await admin(organizationAdmin(), ENTRY, {method: "HEAD"})

    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect(head.headers.get("content-type")).toBe(JS)
    expect(head.headers.get("etag")).toBe('"entry-v1"')
    expect(head.headers.get("content-length")).toBe("2048")
    expect(head.headers.get("x-content-type-options")).toBe("nosniff")
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe("HEAD")
    expect(serviceSignatureVerifies(calls[0])).toBe(true)

    // The same rules as a GET: a HEAD whose GET would be refused is refused.
    respond = () => new Response(null, {headers: {"content-type": JS, "content-length": "4097"}})
    expect((await admin(organizationAdmin(), ENTRY, {method: "HEAD"})).status).toBe(503)
    respond = () => new Response(null, {headers: {"content-type": "text/html"}})
    expect((await admin(organizationAdmin(), ENTRY, {method: "HEAD"})).status).toBe(503)
  })

  test("any other method is a 405 that allows GET and HEAD, and nothing is forwarded", async () => {
    configure()
    const fetched = spyOn(globalThis, "fetch")

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = await admin(organizationAdmin(), ENTRY, {method, body: method === "POST" ? "{}" : undefined})
      expect([method, response.status]).toEqual([method, 405])
      expect([method, response.headers.get("allow")]).toEqual([method, "GET, HEAD"])
      expect(await response.json()).toEqual({error: "method_not_allowed"})
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("the admin gates apply to ui/*: a person without the capability, a key, a phone token and nobody are refused before Fleet", async () => {
    configure()
    const member = as("member", person(false))
    const workspaceKey = as("workspace-key", key("workspace", ["miniapps.publish"]))
    const operatorKey = as("operator-key", key("organization", [...OPERATOR_KEY_SCOPES]))
    const claimingKey = as("claiming-key", key("organization", ["organization.fleet.administer"]))
    const fetched = spyOn(globalThis, "fetch")

    for (const method of ["GET", "HEAD", "POST", "DELETE"]) {
      for (const name of [member, workspaceKey, operatorKey, claimingKey]) {
        const response = await admin(name, ENTRY, {method})
        expect([method, name, response.status]).toEqual([method, name, 403])
      }
      // An unsafe request with no bearer is refused as cross-origin (403) before it is asked who it is (401).
      const nobody = (await admin(null, ENTRY, {method})).status
      const refusals = method === "GET" || method === "HEAD" ? [401] : [401, 403]
      expect([method, refusals.includes(nobody)]).toEqual([method, true])
      const phoneToken = await root.request(`http://localhost/api/admin/fleet${ENTRY}`, {
        method,
        headers: {authorization: "Bearer phone:mu_phone"},
      })
      expect([method, phoneToken.status]).toEqual([method, 401])
    }

    expect(fetched).not.toHaveBeenCalled()
    fetched.mockRestore()
    expect(calls).toHaveLength(0)
  })

  test("a person without the capability gets 403 on ui/entry.js even when Fleet is not installed", async () => {
    const member = as("member", person(false))

    const response = await admin(member, ENTRY)

    expect(response.status).toBe(403)
    expect(((await response.json()) as {error: string}).error).toBe("forbidden")
  })

  test("it is not installed (404), misconfigured (503), or given an unsafe path (400), as the JSON routes are", async () => {
    const portalAdmin = organizationAdmin()
    expect(await (await admin(portalAdmin, ENTRY)).json()).toEqual({error: "fleet_not_installed"})
    process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
    const misconfigured = await admin(portalAdmin, ENTRY)
    expect([misconfigured.status, await misconfigured.json()]).toEqual([503, {error: "fleet_unavailable"}])

    configure()
    const unsafe = [
      "/ui/../entry.js",
      "/ui/./entry.js",
      "/ui/%2e%2e/entry.js",
      "/ui/.%2E/entry.js",
      "/ui/a%2fb.js",
      "/ui/a%5cb.js",
      "/ui/a\\b.js",
      "/ui/%252e%252e/x",
      "/ui/a%252fb",
      "/ui/a%00b",
      "/ui/%zz",
    ]
    for (const rest of unsafe) {
      const response = await root.fetch(rawUrlRequest(`http://localhost/api/admin/fleet${rest}`, {"x-test-principal": portalAdmin}))
      expect([rest, response.status]).toEqual([rest, 400])
      expect(await response.json()).toEqual({error: "invalid_path"})
    }
    expect(calls).toHaveLength(0)
  })

  test("the path and query go upstream as received, under /v1/admin/ui, and are signed as sent", async () => {
    configure()

    await admin(organizationAdmin(), "/ui/chunks/chart-1a2b3c.js?x=a%20b&y=")
    await admin(organizationAdmin(), "/ui/")
    await admin(organizationAdmin(), "/ui")

    expect(calls.map(call => call.pathWithQuery)).toEqual([
      "/v1/admin/ui/chunks/chart-1a2b3c.js?x=a%20b&y=",
      "/v1/admin/ui/",
      "/v1/admin/ui",
    ])
    for (const call of calls) expect(serviceSignatureVerifies(call)).toBe(true)
  })

  test("no spelling of ui reaches the JSON forwarder, whose answers are not held to the asset rules", async () => {
    configure()
    const fetched = spyOn(globalThis, "fetch")
    const rawRequest = (path: string) =>
      rawUrlRequest(`http://localhost/api/admin/fleet${path}`, {"x-test-principal": organizationAdmin()})
    // Each spelling and the exact answer it gets. `%55` is "U": routing decodes it, so "/%55i/" is "/Ui/".
    const spellings: Array<[string, number]> = [
      ["/UI/entry.js", 404],
      ["/Ui/entry.js", 404],
      ["/%55i/entry.js", 404],
      ["/%55I/entry.js", 404],
      ["//ui/entry.js", 404],
      ["//UI/entry.js", 404],
      ["/./ui/entry.js", 400],
      ["/ui/entry.js", 200],
      ["/%75i/entry.js", 200],
    ]

    for (const [path, status] of spellings) {
      const response = await root.fetch(rawRequest(path))
      expect([path, response.status]).toEqual([path, status])
      // The ones that are answered are answered by the asset route: its security headers are on them.
      if (status === 200) expect([path, response.headers.get("x-content-type-options")]).toEqual([path, "nosniff"])
      else expect(await response.json()).toEqual({error: status === 404 ? "not_found" : "invalid_path"})
    }
    fetched.mockRestore()
    // Only the two that are `ui` reached Fleet, as received.
    expect(calls.map(call => call.pathWithQuery)).toEqual(["/v1/admin/ui/entry.js", "/v1/admin/%75i/entry.js"])

    // A path that only starts with the letters is an ordinary one.
    await admin(organizationAdmin(), "/uikit/x")
    expect(calls.at(-1)?.pathWithQuery).toBe("/v1/admin/uikit/x")
  })

  test("a failing or unreachable Fleet is a 503, a 401 is a 403, and a redirect is not followed", async () => {
    configure()
    for (const status of [500, 502, 503]) {
      respond = () => new Response("<html>internal</html>", {status, headers: {"content-type": "text/html", "retry-after": "17"}})
      const response = await admin(organizationAdmin(), ENTRY)
      expect([status, response.status]).toEqual([status, 503])
      expect([status, response.headers.get("retry-after")]).toEqual([status, "17"])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }

    respond = () => new Response(null, {status: 302, headers: {location: "https://elsewhere.example/entry.js", "retry-after": "17"}})
    const redirected = await admin(organizationAdmin(), ENTRY)
    expect(redirected.status).toBe(503)
    expect(redirected.headers.get("retry-after")).toBeNull()
    expect(calls).toHaveLength(4)

    respond = () => Response.json({error: "x"}, {status: 401})
    const unauthorized = await admin(organizationAdmin(), ENTRY)
    expect(unauthorized.status).toBe(403)
    expect(await unauthorized.json()).toEqual({error: "x"})

    const fetched = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connection refused"))
    const unreachable = await admin(organizationAdmin(), ENTRY)
    fetched.mockRestore()
    expect(unreachable.status).toBe(503)
    expect(await unreachable.json()).toEqual({error: "fleet_unavailable"})
  })

  test("an upstream that does not answer within the timeout is a 503, and so is one that stalls mid-body", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "150"})
    respond = () => new Promise<Response>(() => {})
    const started = Date.now()
    const silent = await admin(organizationAdmin(), ENTRY)
    expect(silent.status).toBe(503)
    expect(Date.now() - started).toBeLessThan(3000)

    respond = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(patterned(100))
            // Never closed: the headers arrive, the body never finishes.
          },
        }),
        {headers: {"content-type": JS, "etag": '"from-fleet"', "cache-control": "public, max-age=31536000"}},
      )
    logs = []
    const stalled = await admin(organizationAdmin(), ENTRY)
    expect(stalled.status).toBe(503)
    expect(await stalled.json()).toEqual({error: "fleet_unavailable"})
    expect(stalled.headers.get("etag")).toBeNull()
    expect(stalled.headers.get("cache-control")).toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
    // Fleet outlasting the timeout is a warning that names the reason and what Fleet had answered.
    const failure = logs.find(line => line.message.includes("Fleet request forwarded"))
    expect([failure?.level, failure?.fields.reason, failure?.fields.upstreamStatus]).toEqual(["warn", "TimeoutError", 200])

    // What a real client of Core sees is the same 503, not a 200 that ends early.
    const real = await fetch(`${coreOverHttp()}/api/admin/fleet/ui/entry.js`, {headers: {"x-test-principal": organizationAdmin()}})
    expect(real.status).toBe(503)
    expect(real.headers.get("etag")).toBeNull()
  })

  test("the default cap is 25 MiB, and an unusable value does not lift it", async () => {
    const CAP = 25 * 1024 * 1024
    for (const value of [undefined, "0", "-5", "abc", "1.5", ""]) {
      configure(value === undefined ? {} : {CLOUD_CORE_FLEET_MAX_ASSET_BYTES: value})
      const fetched = fleetAnswers(new Response(null, {headers: {"content-type": JS, "content-length": String(CAP + 1)}}))
      const over = await admin(organizationAdmin(), ENTRY, {method: "HEAD"})
      fetched.mockRestore()
      expect([value, over.status]).toEqual([value, 503])
    }

    configure()
    respond = () => new Response(new Uint8Array(CAP), {headers: {"content-type": JS}})
    const atCap = await admin(organizationAdmin(), ENTRY)
    expect(atCap.status).toBe(200)
    expect((await atCap.arrayBuffer()).byteLength).toBe(CAP)
  })

  test("logs once per asset request without a body, header, query or secret, and says why one was refused", async () => {
    configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "1024"})
    respond = () => new Response(patterned(100), {headers: {"content-type": JS, "etag": '"etag-secret"', "x-request-id": "fleet-9"}})
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const response = await withContext.request("http://localhost/api/admin/fleet/ui/entry.js?token=query-secret", {
      headers: {"x-test-principal": organizationAdmin(), "x-request-id": "req-asset", "cookie": "cookie-secret"},
    })
    await response.arrayBuffer()

    const forwarded = logs.filter(line => line.message.includes("Fleet"))
    expect(forwarded).toHaveLength(1)
    expect(forwarded[0].level).toBe("debug")
    expect(forwarded[0].fields).toEqual({
      reqId: "req-asset",
      audience: "admin",
      upstreamRequestId: "fleet-9",
      upstreamStatus: 200,
      status: 200,
      ms: expect.any(Number),
    })

    // Refusals carry a reason that names no content.
    respond = () => new Response("<h1>secret page</h1>", {headers: {"content-type": "text/html"}})
    await admin(organizationAdmin(), "/ui/page?token=query-secret")
    respond = () => new Response(null, {headers: {"content-type": JS, "content-length": "2048"}})
    await admin(organizationAdmin(), "/ui/page?token=query-secret", {method: "HEAD"})
    const {body: endless} = watchedBody(8)
    const fetched = fleetAnswers(new Response(endless, {headers: {"content-type": JS}}))
    await admin(organizationAdmin(), "/ui/page?token=query-secret")
    fetched.mockRestore()
    const refusals = logs.filter(line => line.message.includes("Fleet") && line.fields.status === 503)
    expect(refusals.map(line => [line.level, line.fields.reason])).toEqual([
      ["warn", "content_type_not_allowed"],
      ["warn", "asset_over_cap"],
      ["warn", "asset_over_cap"],
    ])

    const everything = JSON.stringify(logs)
    for (const secret of [SECRET, "query-secret", "cookie-secret", "etag-secret", "secret page", "text/html"]) {
      expect([secret, everything.includes(secret)]).toEqual([secret, false])
    }
  })

  describe("a cookie the request already set", () => {
    // `principalAuth` rotates the portal session before the handler runs; the asset route answers through the
    // context for the same reason the JSON route does, or the Organization Admin is signed out a minute later.
    test("survives every answer of the asset route, relayed or its own", async () => {
      configure({CLOUD_CORE_FLEET_MAX_ASSET_BYTES: "64"})
      const organization = organizationAdmin()
      const html = () => new Response("<h1>x</h1>", {headers: {"content-type": "text/html"}})
      const answers: Record<string, [() => Response | Promise<Response>, Init?]> = {
        "200 with every passed header": [
          () =>
            new Response(patterned(32), {
              headers: {"content-type": JS, "etag": '"e"', "last-modified": "Tue, 13 Oct 2026 10:00:00 GMT", "cache-control": "no-cache", "vary": "Accept-Encoding", "x-request-id": "f-1"},
            }),
        ],
        "an svg": [() => new Response("<svg/>", {headers: {"content-type": "image/svg+xml"}})],
        "304": [() => new Response(null, {status: 304, headers: {etag: '"e"'}})],
        "HEAD": [() => new Response(null, {headers: {"content-type": JS, "content-length": "32"}}), {method: "HEAD"}],
        "404": [() => Response.json({error: "nope"}, {status: 404})],
        "an upstream 401, relayed as 403": [() => Response.json({error: "x"}, {status: 401})],
        "an upstream 500, answered 503": [() => Response.json({error: "x"}, {status: 500, headers: {"retry-after": "30"}})],
        "an upstream redirect, answered 503": [() => new Response(null, {status: 302, headers: {location: "/x"}})],
        "text/html, answered 503": [html],
        "a declared length over the cap, answered 503": [() => new Response("x".repeat(65), {headers: {"content-type": JS}})],
        "an undeclared body past the cap, answered 503": [() => new Response(endlessBody(16), {headers: {"content-type": JS}})],
        "a content-type with a comma, answered 503": [() => new Response("x", {headers: {"content-type": "text/javascript, text/html"}})],
        "a request that never gets an answer": [() => new Promise<Response>(() => {})],
        "a method that is not allowed": [() => html(), {method: "POST", body: "{}"}],
      }

      for (const [name, [reply, init]] of Object.entries(answers)) {
        respond = reply
        process.env.CLOUD_CORE_FLEET_TIMEOUT_MS = name === "a request that never gets an answer" ? "100" : "10000"

        const response = await admin(organization, ENTRY, {...init, headers: {"x-test-set-cookie": ROTATED}})
        expect([name, response.headers.getSetCookie()]).toEqual([name, [ROTATED]])
        await response.body?.cancel().catch(() => {})
      }
    })

    test("survives Core's own answers before anything is forwarded", async () => {
      const organization = organizationAdmin()
      const headers = {"x-test-set-cookie": ROTATED}
      const cookies = async (response: Promise<Response> | Response) => (await response).headers.getSetCookie()

      // Not installed, misconfigured.
      expect(await cookies(admin(organization, ENTRY, {headers}))).toEqual([ROTATED])
      process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
      expect(await cookies(admin(organization, ENTRY, {headers}))).toEqual([ROTATED])
      // Ready: a refused path.
      configure()
      const unsafe = rawUrlRequest("http://localhost/api/admin/fleet/ui/a/../b", {...headers, "x-test-principal": organization})
      expect(await cookies(root.fetch(unsafe))).toEqual([ROTATED])
    })

    test("is not mistaken for Fleet's: a Set-Cookie from Fleet never reaches the caller", async () => {
      configure()
      respond = () => new Response("{}", {headers: {"content-type": "application/json", "set-cookie": "fleet=1; Path=/"}})

      const response = await admin(organizationAdmin(), "/ui/manifest.json", {headers: {"x-test-set-cookie": ROTATED}})

      expect(response.headers.getSetCookie()).toEqual([ROTATED])
    })

    test("leaves what an earlier middleware set on the context in place: its Vary, and Fleet's request id replaces the earlier one", async () => {
      configure()
      respond = () => new Response("{}", {headers: {"content-type": JS, "vary": "Accept-Encoding", "x-request-id": "fleet-own-id"}})
      const withContext = new Hono<AppEnv>()
      withContext.use("/api/*", requestContext)
      withContext.use("/api/*", async (c, next) => {
        c.header("vary", "Origin", {append: true})
        await next()
      })
      withContext.route("/", root)

      const response = await withContext.request("http://localhost/api/admin/fleet/ui/entry.js", {
        headers: {"x-test-principal": organizationAdmin(), "x-test-set-cookie": ROTATED, "x-request-id": "caller-id"},
      })

      expect(response.status).toBe(200)
      expect(response.headers.get("vary")?.split(/,\s*/).sort()).toEqual(["Accept-Encoding", "Origin"])
      expect(response.headers.get("x-request-id")).toBe("fleet-own-id")
      expect(response.headers.getSetCookie()).toEqual([ROTATED])
    })
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

  test("a lookup that fails is warned about on the request's logger, so the warning names the request", async () => {
    configure()
    emailLookup.mockRejectedValue(new Error("account directory unavailable"))
    const withContext = new Hono<AppEnv>()
    withContext.use("/api/*", requestContext)
    withContext.route("/", root)

    const response = await withContext.request("http://localhost/api/client/fleet/report", {
      method: "POST",
      body: "{}",
      headers: {"authorization": "Bearer phone:mu_directory_down", "x-request-id": "caller-chosen-id"},
    })

    expect(response.status).toBe(200)
    const warning = logs.find(line => line.message === "Fleet phone principal sent without an email")
    expect(warning).toMatchObject({level: "warn", fields: {reqId: "caller-chosen-id", reason: "Error"}})
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

    for (const path of ["/api/client/fleet/devices", "/api/admin/fleet/devices", "/api/admin/fleet/ui/entry.js"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await bare.request(`http://localhost${path}`, {method})
        expect([method, path, response.status]).toEqual([method, path, 401])
      }
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
