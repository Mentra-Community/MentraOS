/**
 * @fileoverview The shared forwarding code against a stub upstream: what a second user of it (a portal
 * module) can rely on. Fleet's routes run the same code, and `api/fleet/fleet-forwarding.test.ts` holds the
 * full matrix of its behavior; this file pins the parts that are parameters of the upstream, namely its
 * `unavailableError`, its log label and its limits, plus the pieces that have no Fleet route of their own, and the
 * full matrix of a 503 that names its own code (relayed) against everything that is not one (Core's own 503).
 */

import type {Logger} from "@mentra/cloud-shared"
import {FORWARDED_PRINCIPAL_HEADERS, verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import {afterAll, beforeEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import type {UserPrincipal} from "../signin/principal.service"
import type {AppEnv} from "../../types/hono.types"
import {forwardedUser, forwardJson, jsonAnswerHeaders, limitBody, type Upstream} from "./forward"
import {DEFAULT_FORWARDING_LIMITS, type ForwardingLimits} from "./upstream-url"

const SECRET = "forwarding-test-secret"

interface Captured {
  method: string
  pathWithQuery: string
  headers: Headers
  body: string
}

let calls: Captured[] = []
let respond: (request: Request) => Response | Promise<Response> = () => Response.json({ok: true})

const stub = Bun.serve({
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
afterAll(() => stub.stop(true))

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

beforeEach(() => {
  calls = []
  logs = []
  respond = () => Response.json({ok: true})
})

const LIMITS: ForwardingLimits = {...DEFAULT_FORWARDING_LIMITS, maxBodyBytes: 64, maxResponseBytes: 256, timeoutMs: 1_000}

function upstream(overrides: Partial<Upstream> = {}): Upstream {
  return {
    service: "test-forwarding",
    label: "Test module",
    unavailableError: "test_unavailable",
    baseUrl: new URL(`http://127.0.0.1:${stub.port}/base`),
    secret: SECRET,
    limits: LIMITS,
    ...overrides,
  }
}

const person: UserPrincipal = {
  kind: "user",
  mentraUserId: "mu_1",
  tenantId: "mentra",
  email: "person@example.test",
  emailVerified: true,
  isOrganizationAdmin: false,
  via: "session",
}

function appFor(options: Partial<Upstream> = {}) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("logger", recordingLogger())
    await next()
  })
  app.use("*", jsonAnswerHeaders)
  app.all(
    "/*",
    limitBody(() => LIMITS.maxBodyBytes),
    c =>
      forwardJson(c, {
        upstream: upstream(options),
        path: "/v1/test/echo",
        query: new URL(c.req.url).search,
        audience: "test",
        principal: () => forwardedUser(person, {kind: "person"}),
      }),
  )
  return app
}

describe("forwardJson", () => {
  test("signs the request and the principal, and sends only content-type and accept of the caller's headers", async () => {
    const reply = await appFor().request("http://core.test/x?a=1", {
      method: "POST",
      body: '{"n":1}',
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        cookie: "session=secret",
        authorization: "Bearer secret",
        "x-mentra-principal": "forged",
        "x-mentra-service": "forged",
        "x-forwarded-for": "6.6.6.6",
      },
    })

    expect(reply.status).toBe(200)
    expect(calls).toHaveLength(1)
    const [got] = calls
    expect(got.pathWithQuery).toBe("/base/v1/test/echo?a=1")
    expect(got.body).toBe('{"n":1}')
    expect(got.headers.get("content-type")).toBe("application/json")
    expect(got.headers.get("accept")).toBe("application/json")
    for (const name of ["cookie", "authorization", "x-forwarded-for"]) expect(got.headers.get(name)).toBeNull()
    const verified = verifyForwardedPrincipal(
      {method: got.method, pathWithQuery: got.pathWithQuery, body: got.body, headers: got.headers},
      [SECRET],
    )
    expect(verified).toEqual({
      kind: "user",
      mentraUserId: "mu_1",
      email: "person@example.test",
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "person"},
    })
    expect(got.headers.get(FORWARDED_PRINCIPAL_HEADERS.principal)).not.toBe("forged")
  })

  test("answers in the upstream's own error code when it cannot answer", async () => {
    const failures: Array<[string, () => Response | Promise<Response>]> = [
      ["a 5xx", () => new Response("down", {status: 502})],
      ["a redirect", () => new Response(null, {status: 302, headers: {location: "https://elsewhere.example"}})],
      ["a body over the response cap", () => Response.json({pad: "x".repeat(2_000)})],
      ["a success that is not JSON", () => new Response("<html></html>", {headers: {"content-type": "text/html"}})],
    ]
    for (const [name, answer] of failures) {
      respond = answer
      const reply = await appFor().request("http://core.test/x")
      expect([name, reply.status, await reply.json()]).toEqual([name, 503, {error: "test_unavailable"}])
    }
    // No answer at all: nothing listens on the URL.
    const gone = await appFor({baseUrl: new URL("http://127.0.0.1:9")}).request("http://core.test/x")
    expect([gone.status, await gone.json()]).toEqual([503, {error: "test_unavailable"}])
  })

  test("a service that stalls past the timeout is the upstream's own 503, logged as a timeout and not as what it said", async () => {
    respond = async () => {
      await Bun.sleep(LIMITS.timeoutMs + 500)
      return Response.json({ok: true})
    }
    const reply = await appFor().request("http://core.test/x")
    expect([reply.status, await reply.json()]).toEqual([503, {error: "test_unavailable"}])
    const line = logs.find(entry => entry.message === "Test module request forwarded")
    expect(line).toMatchObject({level: "warn", fields: {status: 503, upstreamStatus: null, reason: "TimeoutError"}})
  })

  test("repeats a 5xx's whole-second Retry-After, and no other", async () => {
    respond = () => new Response("busy", {status: 503, headers: {"retry-after": "7"}})
    expect((await appFor().request("http://core.test/x")).headers.get("retry-after")).toBe("7")
    respond = () => new Response("busy", {status: 503, headers: {"retry-after": "Wed, 21 Oct 2026 07:28:00 GMT"}})
    expect((await appFor().request("http://core.test/x")).headers.get("retry-after")).toBeNull()
  })

  test("relays an upstream 401 as a 403 with its body, and other errors as they are", async () => {
    respond = () => Response.json({error: "nope"}, {status: 401})
    const unauthorized = await appFor().request("http://core.test/x")
    expect([unauthorized.status, await unauthorized.json()]).toEqual([403, {error: "nope"}])
    respond = () => Response.json({error: "missing"}, {status: 404, headers: {"cache-control": "no-store"}})
    const missing = await appFor().request("http://core.test/x")
    expect([missing.status, missing.headers.get("cache-control"), await missing.json()]).toEqual([
      404,
      "no-store",
      {error: "missing"},
    ])
  })

  test("labels every answer as data and logs once under the upstream's label, never a body or query", async () => {
    const reply = await appFor().request("http://core.test/x?secret=1")
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
    expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    const lines = logs.filter(line => line.message === "Test module request forwarded")
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe("debug")
    expect(lines[0].fields).toMatchObject({audience: "test", status: 200, upstreamStatus: 200, ms: expect.any(Number)})
    expect(JSON.stringify(logs)).not.toContain("secret=1")
    respond = () => Response.json({error: "no"}, {status: 403})
    await appFor().request("http://core.test/x")
    expect(logs.at(-1)).toMatchObject({level: "info", message: "Test module request forwarded"})
    respond = () => new Response("down", {status: 500})
    await appFor().request("http://core.test/x")
    expect(logs.at(-1)).toMatchObject({level: "warn", message: "Test module request forwarded"})
  })

  test("a HEAD answered 503 is Core's own 503: there is no body to name a code", async () => {
    respond = () => Response.json({error: "directory_unavailable"}, {status: 503, headers: {"retry-after": "4"}})
    const reply = await appFor().request("http://core.test/x", {method: "HEAD"})
    expect([reply.status, reply.headers.get("retry-after")]).toEqual([503, "4"])
  })

  test("refuses a body over the limit before forwarding it, and a body that is not UTF-8", async () => {
    const big = await appFor().request("http://core.test/x", {method: "POST", body: "x".repeat(65)})
    expect([big.status, await big.json()]).toEqual([413, {error: "payload_too_large"}])
    const bad = await appFor().request("http://core.test/x", {method: "POST", body: new Uint8Array([0xff, 0xfe])})
    expect([bad.status, await bad.json()]).toEqual([400, {error: "invalid_body"}])
    expect(calls).toHaveLength(0)
  })
})

describe("a 503 that names its own code", () => {
  /** A 503 as a service answers one: a code, a sentence for its own logs, a backoff and headers of its own. */
  const named = (body: unknown, headers: Record<string, string> = {}) => () =>
    Response.json(body, {status: 503, headers: {"retry-after": "30", ...headers}})

  test("is relayed as a 503 with that code and its Retry-After, and nothing else of the body or the headers", async () => {
    respond = named(
      {error: "directory_unavailable", error_description: "the directory at http://10.0.0.7 is down", stack: "Error: at x"},
      {
        "cache-control": "public, max-age=600",
        "set-cookie": "a=1",
        "x-internal": "secret",
        "content-security-policy": "default-src *",
        "x-request-id": "up_1",
      },
    )
    const reply = await appFor().request("http://core.test/x")

    expect([reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([503, {error: "directory_unavailable"}, "30"])
    expect(reply.headers.get("content-type")).toBe("application/json")
    for (const name of ["cache-control", "set-cookie", "x-internal"]) expect([name, reply.headers.get(name)]).toEqual([name, null])
    // Core's labels, not the service's.
    expect(reply.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
    // Logged once, as an answer the service gave (info), with its request id and never its body.
    expect(logs.at(-1)).toMatchObject({
      level: "info",
      message: "Test module request forwarded",
      fields: {status: 503, upstreamStatus: 503, upstreamRequestId: "up_1"},
    })
    expect(logs.at(-1)!.fields.reason).toBeUndefined()
    expect(JSON.stringify(logs)).not.toContain("10.0.0.7")
  })

  test("is relayed whatever the method, and without a Retry-After when the service gave no usable one", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      respond = named({error: "registry_unavailable"}, {"retry-after": "soon"})
      const reply = await appFor().request("http://core.test/x", {method, ...(method === "GET" ? {} : {body: "{}"})})
      expect([method, reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([
        method,
        503,
        {error: "registry_unavailable"},
        null,
      ])
    }
  })

  test("accepts a code of 1 to 64 lowercase letters, digits and underscores that starts with a letter", async () => {
    for (const code of ["x", "billing_unavailable", "core_unavailable", "a1_b2", "a".repeat(64), "z_"]) {
      respond = named({error: code})
      const reply = await appFor().request("http://core.test/x")
      expect([code, reply.status, await reply.json()]).toEqual([code, 503, {error: code}])
    }
  })

  test("a code that is not one, or a body that is not an object naming one, is Core's own 503", async () => {
    const bodies: unknown[] = [
      {},
      {message: "directory_unavailable"},
      {error: ""},
      {error: "Directory_Unavailable"},
      {error: "DIRECTORY_UNAVAILABLE"},
      {error: "directory-unavailable"},
      {error: "directory.unavailable"},
      {error: "directory unavailable"},
      {error: "1directory"},
      {error: "_directory"},
      {error: "a".repeat(65)},
      {error: "directory_unavailable\n"},
      {error: "directory_unavailable\r\nset-cookie: a=1"},
      {error: "<script>alert(1)</script>"},
      {error: "../../etc/passwd"},
      {error: "unavailable\u0000"},
      {error: "dirеctory_unavailable"},
      {error: "ünavailable"},
      {error: 503},
      {error: true},
      {error: null},
      {error: ["directory_unavailable"]},
      {error: {code: "directory_unavailable"}},
      ["directory_unavailable"],
      [{error: "directory_unavailable"}],
      "directory_unavailable",
      503,
      null,
    ]
    for (const body of bodies) {
      respond = named(body)
      const reply = await appFor().request("http://core.test/x")
      const label = JSON.stringify(body)
      expect([label, reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([
        label,
        503,
        {error: "test_unavailable"},
        "30",
      ])
      expect([label, logs.at(-1)]).toMatchObject([
        label,
        {level: "warn", fields: {status: 503, upstreamStatus: 503, reason: "error_code_not_relayed"}},
      ])
    }
  })

  test("a code inherited rather than the body's own is not one", async () => {
    respond = () =>
      new Response('{"__proto__": {"error": "directory_unavailable"}}', {status: 503, headers: {"content-type": "application/json"}})
    const reply = await appFor().request("http://core.test/x")
    expect(await reply.json()).toEqual({error: "test_unavailable"})
  })

  test("a body that is not JSON, or not under a JSON content-type, is Core's own 503", async () => {
    const answers: Array<[string, () => Response]> = [
      ["text", () => new Response('{"error":"directory_unavailable"}', {status: 503, headers: {"content-type": "text/plain"}})],
      ["html", () => new Response('<html>{"error":"directory_unavailable"}</html>', {status: 503, headers: {"content-type": "text/html"}})],
      ["no content-type", () => new Response(new TextEncoder().encode('{"error":"directory_unavailable"}'), {status: 503})],
      ["a list of types", () => new Response('{"error":"directory_unavailable"}', {status: 503, headers: {"content-type": "application/json, text/html"}})],
      ["not JSON", () => new Response("directory_unavailable", {status: 503, headers: {"content-type": "application/json"}})],
      ["truncated JSON", () => new Response('{"error":"directory_unavailable"', {status: 503, headers: {"content-type": "application/json"}})],
      ["empty", () => new Response("", {status: 503, headers: {"content-type": "application/json"}})],
      ["not UTF-8", () => new Response(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]), {status: 503, headers: {"content-type": "application/json"}})],
    ]
    for (const [name, answer] of answers) {
      respond = answer
      const reply = await appFor().request("http://core.test/x")
      expect([name, reply.status, await reply.json()]).toEqual([name, 503, {error: "test_unavailable"}])
    }
  })

  test("a JSON content-type with parameters, or in another case, still names a code", async () => {
    for (const contentType of ["application/json; charset=utf-8", "Application/JSON"]) {
      respond = () => new Response('{"error":"directory_unavailable"}', {status: 503, headers: {"content-type": contentType}})
      const reply = await appFor().request("http://core.test/x")
      expect([contentType, await reply.json()]).toEqual([contentType, {error: "directory_unavailable"}])
    }
  })

  test("a body over 4 KiB is Core's own 503, whether its length is declared or it just keeps streaming, and the request is ended", async () => {
    const roomy = {limits: {...LIMITS, maxResponseBytes: 1024 * 1024}}
    const atCap = JSON.stringify({error: "directory_unavailable", pad: ""})
    respond = named({error: "directory_unavailable", pad: "x".repeat(4096 - atCap.length)})
    expect(await (await appFor(roomy).request("http://core.test/x")).json()).toEqual({error: "directory_unavailable"})

    respond = named({error: "directory_unavailable", pad: "x".repeat(4097 - atCap.length)})
    expect(await (await appFor(roomy).request("http://core.test/x")).json()).toEqual({error: "test_unavailable"})

    let cancelled = false
    let sent = 0
    respond = () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            controller.enqueue(new TextEncoder().encode(sent++ === 0 ? '{"error":"directory_unavailable","pad":"' : "x".repeat(512)))
            await Bun.sleep(1)
          },
          cancel() {
            cancelled = true
          },
        }),
        {status: 503, headers: {"content-type": "application/json", "retry-after": "8"}},
      )
    const streamed = await appFor(roomy).request("http://core.test/x")
    expect([streamed.status, await streamed.json(), streamed.headers.get("retry-after")]).toEqual([503, {error: "test_unavailable"}, "8"])
    for (let i = 0; i < 100 && !cancelled; i++) await Bun.sleep(10)
    expect(cancelled).toBe(true)
    expect(sent).toBeLessThan(100)
  })

  test("and so is one over the upstream's own response limit, when that is lower", async () => {
    // LIMITS.maxResponseBytes is 256.
    respond = named({error: "directory_unavailable", pad: "x".repeat(300)})
    expect(await (await appFor().request("http://core.test/x")).json()).toEqual({error: "test_unavailable"})
  })

  test("a body that stalls past the timeout is Core's own 503, with the service's Retry-After", async () => {
    respond = () => {
      let pulls = 0
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (pulls++ === 0) return controller.enqueue(new TextEncoder().encode('{"error":'))
            await Bun.sleep(LIMITS.timeoutMs + 500)
            controller.enqueue(new TextEncoder().encode('"directory_unavailable"}'))
            controller.close()
          },
        }),
        {status: 503, headers: {"content-type": "application/json", "retry-after": "12"}},
      )
    }
    const reply = await appFor().request("http://core.test/x")
    expect([reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([503, {error: "test_unavailable"}, "12"])
  })

  test("only a 503 names a code: any other 5xx with a well-formed one is Core's own 503", async () => {
    for (const status of [500, 501, 502, 504, 507, 599]) {
      respond = () => Response.json({error: "directory_unavailable"}, {status, headers: {"retry-after": "3"}})
      const reply = await appFor().request("http://core.test/x")
      expect([status, reply.status, await reply.json(), reply.headers.get("retry-after")]).toEqual([
        status,
        503,
        {error: "test_unavailable"},
        "3",
      ])
    }
  })
})

describe("limitBody", () => {
  test("applies no limit when the limit is null", async () => {
    const app = new Hono<AppEnv>()
    app.post("/x", limitBody(() => null), async c => c.json({length: (await c.req.text()).length}))
    const reply = await app.request("http://core.test/x", {method: "POST", body: "x".repeat(5_000)})
    expect(await reply.json()).toEqual({length: 5_000})
  })

  test("decides per request, from the request's context", async () => {
    const app = new Hono<AppEnv>()
    app.post(
      "/x",
      limitBody(c => (c.req.header("x-tight") ? 4 : null)),
      async c => c.json({length: (await c.req.text()).length}),
    )
    expect((await app.request("http://core.test/x", {method: "POST", body: "12345678"})).status).toBe(200)
    expect((await app.request("http://core.test/x", {method: "POST", body: "12345678", headers: {"x-tight": "1"}})).status).toBe(413)
  })
})

describe("forwardedUser", () => {
  test("describes the person and the scope Core chose, and an Organization Admin's capabilities", () => {
    expect(forwardedUser(person, {kind: "workspace", workspaceId: "ws_1"})).toEqual({
      kind: "user",
      mentraUserId: "mu_1",
      email: "person@example.test",
      emailVerified: true,
      isOrganizationAdmin: false,
      organizationCapabilities: [],
      scope: {kind: "workspace", workspaceId: "ws_1"},
    })
    const admin = forwardedUser({...person, isOrganizationAdmin: true}, {kind: "organization"})
    expect(admin.kind === "user" && admin.isOrganizationAdmin).toBe(true)
    expect(admin.kind === "user" && admin.organizationCapabilities.length).toBeGreaterThan(0)
    expect(admin.kind === "user" && admin.scope).toEqual({kind: "organization"})
  })
})
