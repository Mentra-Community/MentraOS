/**
 * @fileoverview The Fleet forwarding seam against a stub upstream, without a database.
 *
 * The stub is a real `Bun.serve` on loopback, so the request Core sends (headers, signature, body)
 * and the way it handles a slow, failing or redirecting upstream are the real thing. The caller is
 * placed on the context directly (what `userAuth` / `principalAuth` would have set), as the admin
 * API tests do. `createApp` is used only to pin that the routes are mounted behind those gates.
 */

import {createHmac} from "node:crypto"
import type {CorePrincipal} from "@mentra/workspace-contract"
import {SERVICE_HEADERS, verifyServiceRequest} from "@mentra/workspace-contract/server"
import {afterAll, afterEach, beforeEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import type {AppEnv} from "../../types/hono.types"
import adminApi from "../admin/admin.api"
import {createApp} from "../app"
import {clientFleetApi, FLEET_HEADERS} from "./fleet-forwarding"

const SECRET = "fleet-secret-for-tests"

const ENV_KEYS = [
  "CLOUD_CORE_FLEET_URL",
  "CLOUD_CORE_FLEET_SECRET",
  "CLOUD_CORE_FLEET_MAX_BODY_BYTES",
  "CLOUD_CORE_FLEET_TIMEOUT_MS",
  "CLOUD_CORE_ORGANIZATION_ID",
  "NODE_ENV",
  "WORKOS_API_KEY",
  "WORKOS_CLIENT_ID",
  "WORKOS_COOKIE_PASSWORD",
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

interface Captured {
  method: string
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
    const url = new URL(request.url)
    const captured = {
      method: request.method,
      pathWithQuery: url.pathname + url.search,
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

beforeEach(() => {
  calls = []
  respond = () => Response.json({ok: true})
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

afterAll(() => {
  upstream.stop(true)
})

function person(isOrganizationAdmin: boolean): CorePrincipal {
  return {
    kind: "user",
    organizationId: "local",
    mentraUserId: "mu_1",
    email: "person@example.test",
    emailVerified: true,
    name: null,
    workosUserId: "workos_1",
    isOrganizationAdmin,
  }
}

function key(credentialKind: "organization" | "workspace", scopes: string[]): CorePrincipal {
  return {
    kind: "credential",
    organizationId: "local",
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
  const phone = c.req.header("x-test-phone")
  if (phone) {
    c.set("user", {
      mentraUserId: phone,
      tenantId: "tenant_1",
      sessionId: "sess_1",
      accessTokenJti: "jti_1",
      accessTokenExpiresAt: 0,
    })
  }
  const principal = principals.get(c.req.header("x-test-principal") ?? "")
  if (principal) c.set("principal", principal)
  await next()
})
root.route("/api/client", clientFleetApi)
root.route("/api/admin", adminApi)

function as(name: string, principal: CorePrincipal): string {
  principals.set(name, principal)
  return name
}

/** A request from a signed-in phone. */
function phone(path: string, init: Omit<RequestInit, "headers"> & {headers?: Record<string, string>} = {}) {
  return root.request(`http://localhost/api/client${path}`, {
    ...init,
    headers: {"x-test-phone": "mu_phone", ...init.headers},
  })
}

/** A request from an admin-surface principal. */
function admin(
  principal: string | null,
  path: string,
  init: Omit<RequestInit, "headers"> & {headers?: Record<string, string>} = {},
) {
  return root.request(`http://localhost/api/admin${path}`, {
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

const principalSignature = (secret: string, timestamp: string, organization: string, principal: string) =>
  createHmac("sha256", secret).update(`${timestamp}\n${organization}\n${principal}`).digest("base64url")

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

function principalSignatureVerifies(
  call: Captured,
  swap: {organization?: string; principal?: string; timestamp?: string} = {},
): boolean {
  const expected = principalSignature(
    SECRET,
    swap.timestamp ?? call.headers.get(SERVICE_HEADERS.timestamp) ?? "",
    swap.organization ?? call.headers.get(FLEET_HEADERS.organizationId) ?? "",
    swap.principal ?? call.headers.get(FLEET_HEADERS.principal) ?? "",
  )
  return expected === call.headers.get(FLEET_HEADERS.principalSignature)
}

describe("what Core sends to Fleet", () => {
  test("a phone request reaches /v1/client with a valid service signature and its principal", async () => {
    configure({CLOUD_CORE_ORGANIZATION_ID: "acme"})
    respond = () => Response.json({devices: []}, {headers: {"cache-control": "no-store"}})

    const response = await phone("/fleet/devices/42?state=online&label=a%20b", {headers: {accept: "application/json"}})

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({devices: []})
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.method).toBe("GET")
    expect(call.pathWithQuery).toBe("/v1/client/devices/42?state=online&label=a%20b")
    expect(call.headers.get("accept")).toBe("application/json")
    expect(call.headers.get(SERVICE_HEADERS.service)).toBe("core")
    expect(call.headers.get(FLEET_HEADERS.organizationId)).toBe("acme")
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "phone",
      mentraUserId: "mu_phone",
      tenantId: "tenant_1",
      sessionId: "sess_1",
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("the body, method and content-type are copied, and the signature covers the body", async () => {
    configure()
    const body = JSON.stringify({name: "café ☕", n: 3})

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      calls = []
      const response = await phone("/fleet/devices", {method, body, headers: {"content-type": "application/json"}})
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

    const response = await phone("/fleet/devices", {method: "POST", body: "plain"})

    expect(response.status).toBe(200)
    expect(calls[0].headers.get("content-type")).toBeNull()
    expect(calls[0].body).toBe("plain")
  })

  test("GET and HEAD carry no body, and the method reaches upstream as sent", async () => {
    configure()
    respond = () => new Response(null, {status: 200, headers: {"content-type": "application/json"}})

    const head = await phone("/fleet/devices", {method: "HEAD"})
    expect(head.status).toBe(200)
    const get = await phone("/fleet/devices", {method: "GET"})
    expect(get.status).toBe(200)

    expect(calls.map((call) => [call.method, call.body])).toEqual([
      ["HEAD", ""],
      ["GET", ""],
    ])
    for (const call of calls) expect(serviceSignatureVerifies(call)).toBe(true)
  })

  test("a path prefix on the Fleet URL is kept and the signature covers it", async () => {
    configure({CLOUD_CORE_FLEET_URL: `${upstreamUrl()}/fleet-base/`})

    expect((await phone("/fleet/devices?x=1")).status).toBe(200)

    expect(calls[0].pathWithQuery).toBe("/fleet-base/v1/client/devices?x=1")
    expect(serviceSignatureVerifies(calls[0])).toBe(true)
  })

  test("the bare mount and a trailing slash both forward", async () => {
    configure()

    expect((await phone("/fleet")).status).toBe(200)
    expect((await phone("/fleet/")).status).toBe(200)

    expect(calls.map((call) => call.pathWithQuery)).toEqual(["/v1/client", "/v1/client/"])
  })

  test("a client-sent identity never reaches upstream; Core's own does", async () => {
    configure({CLOUD_CORE_ORGANIZATION_ID: "acme"})

    const response = await phone("/fleet/devices", {
      headers: {
        "authorization": "Bearer a-token-fleet-must-never-see",
        "cookie": "session=secret",
        "x-mentra-principal": "forged",
        "x-mentra-principal-signature": "forged",
        "x-mentra-organization-id": "someone-else",
        "x-mentra-service": "store",
        "x-mentra-service-timestamp": "1",
        "x-mentra-service-signature": "forged",
        "x-mentra-anything-else": "1",
        "X-Mentra-Mixed-Case": "1",
      },
    })

    expect(response.status).toBe(200)
    const [call] = calls
    expect(call.headers.get("authorization")).toBeNull()
    expect(call.headers.get("cookie")).toBeNull()
    expect(call.headers.get("x-test-phone")).toBeNull()
    expect([...call.headers.keys()].filter((name) => name.startsWith("x-mentra-")).sort()).toEqual(
      [
        FLEET_HEADERS.organizationId,
        FLEET_HEADERS.principal,
        FLEET_HEADERS.principalSignature,
        SERVICE_HEADERS.service,
        SERVICE_HEADERS.signature,
        SERVICE_HEADERS.timestamp,
      ].sort(),
    )
    expect(call.headers.get(FLEET_HEADERS.organizationId)).toBe("acme")
    expect(call.headers.get(SERVICE_HEADERS.service)).toBe("core")
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toMatchObject({
      kind: "phone",
      mentraUserId: "mu_phone",
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("the principal signature binds the identity: a swapped principal, organization or timestamp fails", async () => {
    configure({CLOUD_CORE_ORGANIZATION_ID: "acme"})

    await phone("/fleet/devices", {headers: {"x-test-phone": "mu_a"}})
    await phone("/fleet/devices", {headers: {"x-test-phone": "mu_b"}})
    const [a, b] = calls

    expect(principalSignatureVerifies(a)).toBe(true)
    expect(principalSignatureVerifies(b)).toBe(true)
    // The service signature does not cover the identity headers; only the principal signature binds them.
    expect(serviceSignatureVerifies(a)).toBe(true)
    expect(principalSignatureVerifies(a, {principal: b.headers.get(FLEET_HEADERS.principal) ?? ""})).toBe(false)
    expect(principalSignatureVerifies(a, {organization: "other-org"})).toBe(false)
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
        "acme",
        a.headers.get(FLEET_HEADERS.principal) ?? "",
      ),
    ).not.toBe(a.headers.get(FLEET_HEADERS.principalSignature))
  })

  test("a body that is not valid UTF-8 is refused rather than altered", async () => {
    configure()

    const response = await phone("/fleet/devices", {method: "POST", body: new Uint8Array([0xff, 0xfe, 0x41])})

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({error: "invalid_body"})
    expect(calls).toHaveLength(0)
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
  ]

  test("a client path with a dot segment, an encoded slash or a bad escape is a 400 and goes nowhere", async () => {
    configure()
    for (const rawUrl of UNSAFE) {
      const response = await root.fetch(rawUrlRequest(`http://localhost${rawUrl}?x=1`, {"x-test-phone": "mu_phone"}))
      expect([rawUrl, response.status]).toEqual([rawUrl, 400])
      expect(await response.json()).toEqual({error: "invalid_path"})
    }
    expect(calls).toHaveLength(0)
  })

  test("the admin surface refuses them too", async () => {
    configure()
    as("member", person(false))
    for (const rawUrl of UNSAFE.map((path) => path.replace("/api/client/", "/api/admin/"))) {
      const response = await root.fetch(rawUrlRequest(`http://localhost${rawUrl}`, {"x-test-principal": "member"}))
      expect([rawUrl, response.status]).toEqual([rawUrl, 400])
    }
    expect(calls).toHaveLength(0)
  })

  test("an escape that is not a separator or a dot segment passes unchanged", async () => {
    configure()

    expect((await phone("/fleet/devices/a%20b/caf%C3%A9%2Bx")).status).toBe(200)

    expect(calls[0].pathWithQuery).toBe("/v1/client/devices/a%20b/caf%C3%A9%2Bx")
  })
})

describe("limits and failures", () => {
  test("a body over the limit is a 413 and is not forwarded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})

    // No content-length: the stream is counted.
    const streamed = await phone("/fleet/devices", {method: "POST", body: "x".repeat(17)})
    expect(streamed.status).toBe(413)
    expect(await streamed.json()).toEqual({error: "payload_too_large"})

    // A declared length over the limit is refused before the body is read.
    const declared = await phone("/fleet/devices", {
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

    const response = await phone("/fleet/devices", {method: "POST", body: endless, duplex: "half"} as Parameters<
      typeof phone
    >[1])

    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  test("a body exactly at the limit is forwarded", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})

    const response = await phone("/fleet/devices", {method: "POST", body: "x".repeat(16)})

    expect(response.status).toBe(200)
    expect(calls[0].body).toBe("x".repeat(16))
  })

  test("the admin surface has the same limit", async () => {
    configure({CLOUD_CORE_FLEET_MAX_BODY_BYTES: "16"})
    as("member", person(false))

    const response = await admin("member", "/fleet/devices", {method: "POST", body: "x".repeat(17)})

    expect(response.status).toBe(413)
    expect(calls).toHaveLength(0)
  })

  test("the default limit is 1 MiB, and an unusable value does not lift it", async () => {
    for (const value of [undefined, "0", "-5", "abc", "1.5", ""]) {
      configure(value === undefined ? {} : {CLOUD_CORE_FLEET_MAX_BODY_BYTES: value})
      calls = []

      const atLimit = await phone("/fleet/devices", {method: "POST", body: "x".repeat(1024 * 1024)})
      const overLimit = await phone("/fleet/devices", {method: "POST", body: "x".repeat(1024 * 1024 + 1)})

      expect([value, atLimit.status, overLimit.status]).toEqual([value, 200, 413])
      expect(calls).toHaveLength(1)
    }
  })

  test("an upstream that does not answer within the timeout is a 503", async () => {
    configure({CLOUD_CORE_FLEET_TIMEOUT_MS: "150"})
    respond = () => new Promise<Response>(() => {})

    const started = Date.now()
    const response = await phone("/fleet/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(Date.now() - started).toBeLessThan(3000)
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
    const response = await phone("/fleet/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
    expect(Date.now() - started).toBeLessThan(3000)
  })

  test("an upstream 5xx is a 503, never its own answer", async () => {
    configure()
    for (const status of [500, 502, 503, 504]) {
      respond = () => Response.json({secret: "internal details"}, {status})

      const response = await phone("/fleet/devices")

      expect([status, response.status]).toEqual([status, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
  })

  test("an upstream that cannot be reached is a 503", async () => {
    const gone = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")})
    const url = `http://127.0.0.1:${gone.port}`
    gone.stop(true)
    configure({CLOUD_CORE_FLEET_URL: url})

    const response = await phone("/fleet/devices")

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error: "fleet_unavailable"})
  })

  test("a redirect is not followed and is a 503", async () => {
    configure()
    for (const status of [301, 302, 303, 307, 308]) {
      calls = []
      respond = () => new Response(null, {status, headers: {location: "/v1/client/elsewhere"}})

      const response = await phone("/fleet/devices")

      expect([status, response.status]).toEqual([status, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
      expect(response.headers.get("location")).toBeNull()
      expect(calls.map((call) => call.pathWithQuery)).toEqual(["/v1/client/devices"])
    }
  })
})

describe("what comes back", () => {
  test("status, body, content-type and cache-control pass through and nothing else does", async () => {
    configure()
    respond = () =>
      new Response('{"created":true}', {
        status: 201,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "private, max-age=5",
          "set-cookie": "upstream=1",
          "x-internal-trace": "abc",
          "access-control-allow-origin": "*",
        },
      })

    const response = await phone("/fleet/devices", {method: "POST", body: "{}"})

    expect(response.status).toBe(201)
    expect(await response.text()).toBe('{"created":true}')
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("private, max-age=5")
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(response.headers.get("x-internal-trace")).toBeNull()
    expect(response.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("a 4xx from Fleet is passed through, not turned into an outage", async () => {
    configure()
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      respond = () => Response.json({error: `fleet_says_${status}`}, {status})

      const response = await phone("/fleet/devices")

      expect([status, response.status]).toEqual([status, status])
      expect(await response.json()).toEqual({error: `fleet_says_${status}`})
    }
  })

  test("a 204 stays empty", async () => {
    configure()
    respond = () => new Response(null, {status: 204})

    const response = await phone("/fleet/devices/1", {method: "DELETE"})

    expect(response.status).toBe(204)
    expect(await response.text()).toBe("")
  })
})

describe("configuration", () => {
  test("not configured is a 404 fleet_not_installed on both surfaces", async () => {
    as("member", person(false))

    const client = await phone("/fleet/devices")
    const adminSide = await admin("member", "/fleet/devices")

    expect(client.status).toBe(404)
    expect(await client.json()).toEqual({error: "fleet_not_installed"})
    expect(adminSide.status).toBe(404)
    expect(await adminSide.json()).toEqual({error: "fleet_not_installed"})
    expect(calls).toHaveLength(0)
  })

  test("a blank URL counts as not configured, and a secret alone does not install Fleet", async () => {
    process.env.CLOUD_CORE_FLEET_URL = "   "
    process.env.CLOUD_CORE_FLEET_SECRET = SECRET

    const response = await phone("/fleet/devices")

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({error: "fleet_not_installed"})
  })

  test("not installed answers without reading a large body", async () => {
    const response = await phone("/fleet/devices", {method: "POST", body: "x".repeat(2 * 1024 * 1024)})

    expect(response.status).toBe(404)
  })

  test("a URL without a secret is misconfigured: 503, not 404", async () => {
    for (const secret of [undefined, "", "   "]) {
      process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
      if (secret === undefined) delete process.env.CLOUD_CORE_FLEET_SECRET
      else process.env.CLOUD_CORE_FLEET_SECRET = secret

      const response = await phone("/fleet/devices")

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

      const response = await phone("/fleet/devices")

      expect([url, response.status]).toEqual([url, 503])
      expect(await response.json()).toEqual({error: "fleet_unavailable"})
    }
    expect(calls).toHaveLength(0)
  })

  test("production requires https, except for http on localhost and 127.0.0.1", async () => {
    configure({NODE_ENV: "production", CLOUD_CORE_ORGANIZATION_ID: "acme"})
    const installed = async (url: string) => {
      process.env.CLOUD_CORE_FLEET_URL = url
      const response = await phone("/capabilities")
      expect(response.status).toBe(200)
      return ((await response.json()) as {fleet: {installed: boolean}}).fleet.installed
    }

    expect(await installed("https://fleet.example.test")).toBe(true)
    expect(await installed("http://fleet.example.test")).toBe(false)
    expect(await installed("http://10.0.0.5:8080")).toBe(false)
    expect(await installed("http://localhost:8080")).toBe(true)
    expect(await installed(upstreamUrl())).toBe(true)

    // A refused URL is never contacted: it is a 503, and nothing reaches the stub.
    process.env.CLOUD_CORE_FLEET_URL = "http://fleet.example.test"
    expect((await phone("/fleet/devices")).status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  test("production forwards to a loopback http Fleet", async () => {
    configure({NODE_ENV: "production", CLOUD_CORE_ORGANIZATION_ID: "acme"})

    const response = await phone("/fleet/devices")

    expect(response.status).toBe(200)
    expect(calls[0].headers.get(FLEET_HEADERS.organizationId)).toBe("acme")
  })

  test("outside production http is allowed on any host", async () => {
    configure({CLOUD_CORE_FLEET_URL: "http://fleet.internal:8080"})

    const response = await phone("/capabilities")

    expect(await response.json()).toEqual({organizationId: "local", fleet: {installed: true}})
  })
})

describe("GET /api/client/capabilities", () => {
  test("reports the organization and whether Fleet is installed", async () => {
    configure({CLOUD_CORE_ORGANIZATION_ID: "acme"})

    const response = await phone("/capabilities")

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({organizationId: "acme", fleet: {installed: true}})
  })

  test("says installed: false when Fleet is not configured or is misconfigured", async () => {
    const unset = await phone("/capabilities")
    expect(await unset.json()).toEqual({organizationId: "local", fleet: {installed: false}})

    process.env.CLOUD_CORE_FLEET_URL = upstreamUrl()
    const noSecret = await phone("/capabilities")
    expect(await noSecret.json()).toEqual({organizationId: "local", fleet: {installed: false}})

    configure({CLOUD_CORE_FLEET_URL: "not a url"})
    const badUrl = await phone("/capabilities")
    expect(await badUrl.json()).toEqual({organizationId: "local", fleet: {installed: false}})
  })

  test("never contacts Fleet", async () => {
    configure()

    await phone("/capabilities")

    expect(calls).toHaveLength(0)
  })
})

describe("the admin surface", () => {
  test("a workspace user who is not an Organization Admin reaches Fleet; upstream decides", async () => {
    configure({CLOUD_CORE_ORGANIZATION_ID: "acme"})
    respond = () => Response.json({error: "forbidden"}, {status: 403})
    const member = as("member", person(false))

    const response = await admin(member, "/fleet/devices?page=2", {headers: {accept: "application/json"}})

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({error: "forbidden"})
    expect(calls).toHaveLength(1)
    const [call] = calls
    expect(call.pathWithQuery).toBe("/v1/admin/devices?page=2")
    expect(call.headers.get(FLEET_HEADERS.organizationId)).toBe("acme")
    expect(decodePrincipal(call.headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "user",
      mentraUserId: "mu_1",
      email: "person@example.test",
      isOrganizationAdmin: false,
    })
    expect(serviceSignatureVerifies(call)).toBe(true)
    expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("an Organization Admin is forwarded with isOrganizationAdmin: true", async () => {
    configure()
    const organizationAdmin = as("organization-admin", person(true))

    const response = await admin(organizationAdmin, "/fleet/devices", {method: "POST", body: '{"a":1}'})

    expect(response.status).toBe(200)
    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      kind: "user",
      isOrganizationAdmin: true,
    })
    expect(calls[0].body).toBe('{"a":1}')
  })

  test("credentials are forwarded with their kind, workspace and scopes, and no organization capability is needed", async () => {
    configure()
    const workspaceKey = as("workspace-key", key("workspace", ["miniapps.publish"]))
    const bareOperatorKey = as("bare-operator-key", key("organization", []))

    for (const principal of [workspaceKey, bareOperatorKey]) {
      expect([principal, (await admin(principal, "/fleet/devices")).status]).toEqual([principal, 200])
    }

    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "credential",
      credentialId: "01HZKEY",
      credentialKind: "workspace",
      workspaceId: "ws_1",
      scopes: ["miniapps.publish"],
    })
    expect(decodePrincipal(calls[1].headers.get(FLEET_HEADERS.principal))).toEqual({
      kind: "credential",
      credentialId: "01HZKEY",
      credentialKind: "organization",
      workspaceId: null,
      scopes: [],
    })
    // The key's label and the package restriction are not part of what Fleet is told.
    expect(calls[0].headers.get(FLEET_HEADERS.principal)).not.toContain(Buffer.from("ci key").toString("base64url"))
    for (const call of calls) expect(principalSignatureVerifies(call)).toBe(true)
  })

  test("a forged identity header from the caller never reaches upstream", async () => {
    configure()
    const member = as("member", person(false))
    const forged = Buffer.from('{"kind":"user","mentraUserId":"admin","isOrganizationAdmin":true}').toString(
      "base64url",
    )

    await admin(member, "/fleet/devices", {headers: {"x-mentra-principal": forged, "authorization": "Bearer t"}})

    expect(decodePrincipal(calls[0].headers.get(FLEET_HEADERS.principal))).toMatchObject({
      mentraUserId: "mu_1",
      isOrganizationAdmin: false,
    })
    expect(calls[0].headers.get("authorization")).toBeNull()
    expect(principalSignatureVerifies(calls[0])).toBe(true)
  })

  test("the other admin areas still need their capability", async () => {
    configure()
    const member = as("member", person(false))

    for (const path of ["/reports", "/support-profiles/lookup", "/test-runs", "/fix-flows", "/test-routines"]) {
      expect([path, (await admin(member, path)).status]).toEqual([path, 403])
    }
    expect(calls).toHaveLength(0)
  })
})

describe("who may call", () => {
  test("a handler mounted without its gate fails closed", async () => {
    configure()
    const bare = new Hono<AppEnv>()
    bare.route("/api/client", clientFleetApi)
    bare.route("/api/admin", adminApi)

    for (const path of ["/api/client/fleet/devices", "/api/client/capabilities"]) {
      const response = await bare.request(`http://localhost${path}`)
      expect([path, response.status]).toEqual([path, 401])
    }
    expect(calls).toHaveLength(0)
  })

  test("in the real app, a request without credentials never reaches Fleet", async () => {
    configure()
    for (const key of ["WORKOS_API_KEY", "WORKOS_CLIENT_ID", "WORKOS_COOKIE_PASSWORD"] as const) delete process.env[key]
    const core = createApp({readinessChecks: []})

    for (const path of ["/api/client/fleet", "/api/client/fleet/devices", "/api/client/capabilities"]) {
      for (const method of ["GET", "POST"]) {
        const response = await core.request(`http://localhost${path}`, {
          method,
          body: method === "POST" ? "{}" : undefined,
        })
        // userAuth refuses a request with no bearer as an invalid request.
        expect([method, path, response.status]).toEqual([method, path, 400])
        expect(await response.json()).toMatchObject({error: "invalid_request"})
      }
    }
    for (const path of ["/api/admin/fleet", "/api/admin/fleet/devices"]) {
      for (const method of ["GET", "POST"]) {
        const response = await core.request(`http://localhost${path}`, {
          method,
          body: method === "POST" ? "{}" : undefined,
        })
        expect([method, path, response.status]).toEqual([method, path, 401])
      }
    }
    expect(calls).toHaveLength(0)
  })
})
