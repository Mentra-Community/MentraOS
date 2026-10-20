/**
 * @fileoverview The shared UI asset relay against a stub upstream. Fleet's route runs the same code and
 * `api/fleet/fleet-forwarding.test.ts` holds its full matrix; this pins what is a parameter of the upstream
 * (its error code and limits) and the rules a portal module's `ui/entry.js` relies on.
 */

import type {Logger} from "@mentra/cloud-shared"
import {verifyForwardedPrincipal} from "@mentra/workspace-contract/server"
import {afterAll, beforeEach, describe, expect, test} from "bun:test"
import {Hono} from "hono"
import type {AppEnv} from "../../types/hono.types"
import {relayAsset, assetResponseHeaders, methodNotAllowed, UI_ASSET_SEGMENT} from "./assets"
import {forwardedUser, jsonAnswerHeaders, type Upstream} from "./forward"
import {DEFAULT_FORWARDING_LIMITS} from "./upstream-url"

const SECRET = "asset-test-secret"

interface Captured {
  method: string
  pathWithQuery: string
  headers: Headers
}

let calls: Captured[] = []
let respond: (request: Request) => Response | Promise<Response> = () => new Response("export default 1", {headers: {"content-type": "text/javascript"}})

const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const origin = new URL(request.url).origin
    calls.push({method: request.method, pathWithQuery: request.url.slice(origin.length), headers: request.headers})
    return respond(request)
  },
})
afterAll(() => stub.stop(true))

beforeEach(() => {
  calls = []
  respond = () => new Response("export default 1", {headers: {"content-type": "text/javascript"}})
})

function upstream(overrides: Partial<Upstream> = {}): Upstream {
  return {
    service: "test-forwarding",
    label: "Test module",
    unavailableError: "test_unavailable",
    baseUrl: new URL(`http://127.0.0.1:${stub.port}/base`),
    secret: SECRET,
    limits: {...DEFAULT_FORWARDING_LIMITS, maxAssetBytes: 64, timeoutMs: 1_000},
    ...overrides,
  }
}

function appFor(options: Partial<Upstream> = {}) {
  const app = new Hono<AppEnv>()
  app.use("*", async (c, next) => {
    c.set("logger", {debug() {}, info() {}, warn() {}, error() {}} as unknown as Logger)
    c.header("set-cookie", "rotated=1; Path=/")
    await next()
  })
  app.use("*", jsonAnswerHeaders)
  app.use(`/${UI_ASSET_SEGMENT}/*`, assetResponseHeaders)
  app.on(["GET", "HEAD"], `/${UI_ASSET_SEGMENT}/*`, c =>
    relayAsset(c, {
      upstream: upstream(options),
      path: `/v1/test${new URL(c.req.url).pathname}`,
      query: new URL(c.req.url).search,
      audience: "test",
      principal: () => forwardedUser({
        kind: "user",
        mentraUserId: "mu_1",
        tenantId: "mentra",
        email: null,
        emailVerified: false,
        isOrganizationAdmin: false,
        via: "session",
      }, {kind: "person"}),
    }),
  )
  app.all(`/${UI_ASSET_SEGMENT}/*`, methodNotAllowed)
  return app
}

describe("relayAsset", () => {
  test("relays a script whole with nosniff, the true length and the validators, and keeps the context's cookie", async () => {
    respond = () =>
      new Response("export default 1", {
        headers: {"content-type": "text/javascript", etag: '"v1"', "cache-control": "public, max-age=60", "set-cookie": "evil=1"},
      })

    const reply = await appFor().request("http://core.test/ui/entry.js?v=2")

    expect(reply.status).toBe(200)
    expect(await reply.text()).toBe("export default 1")
    expect(reply.headers.get("x-content-type-options")).toBe("nosniff")
    expect(reply.headers.get("cross-origin-resource-policy")).toBe("same-origin")
    expect(reply.headers.get("content-length")).toBe("16")
    expect(reply.headers.get("etag")).toBe('"v1"')
    expect(reply.headers.get("cache-control")).toBe("public, max-age=60")
    // The data labels of the JSON routes must not stay on a module that has to run, and the upstream sets no cookie.
    expect(reply.headers.get("content-security-policy")).toBeNull()
    expect(reply.headers.get("set-cookie")).toBe("rotated=1; Path=/")
    expect(calls[0].pathWithQuery).toBe("/base/v1/test/ui/entry.js?v=2")
    expect(calls[0].headers.get("accept-encoding")).toBe("identity")
    expect(
      verifyForwardedPrincipal(
        {method: "GET", pathWithQuery: calls[0].pathWithQuery, body: "", headers: calls[0].headers},
        [SECRET],
      )?.kind,
    ).toBe("user")
  })

  test("passes a browser's conditional request through and relays the 304 with its validators", async () => {
    respond = request =>
      request.headers.get("if-none-match") === '"v1"'
        ? new Response(null, {status: 304, headers: {etag: '"v1"'}})
        : new Response("x")

    const reply = await appFor().request("http://core.test/ui/entry.js", {
      headers: {"if-none-match": '"v1"', cookie: "session=secret", "x-mentra-principal": "forged"},
    })

    expect(reply.status).toBe(304)
    expect(reply.headers.get("etag")).toBe('"v1"')
    expect(calls[0].headers.get("if-none-match")).toBe('"v1"')
    expect(calls[0].headers.get("cookie")).toBeNull()
    expect(calls[0].headers.get("x-mentra-principal")).not.toBe("forged")
  })

  test("relays the listed content types and SVG only under Core's own policy", async () => {
    for (const type of ["text/css", "application/json", "image/png", "font/woff2", "application/javascript"]) {
      respond = () => new Response("x", {headers: {"content-type": type}})
      expect([type, (await appFor().request("http://core.test/ui/a")).status]).toEqual([type, 200])
    }
    respond = () =>
      new Response("<svg/>", {headers: {"content-type": "image/svg+xml", "content-security-policy": "script-src *"}})
    const svg = await appFor().request("http://core.test/ui/a.svg")
    expect(svg.status).toBe(200)
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'")
  })

  test("answers in the upstream's own error code for html, a comma list, no type, an oversize or short body", async () => {
    const refusals: Array<[string, () => Response]> = [
      ["html", () => new Response("<html></html>", {headers: {"content-type": "text/html"}})],
      ["a type list", () => new Response("x", {headers: {"content-type": "text/javascript, text/html"}})],
      ["no type", () => new Response("x")],
      ["a body over the cap", () => new Response("x".repeat(65), {headers: {"content-type": "text/javascript"}})],
      ["a 5xx", () => new Response("down", {status: 500, headers: {"content-type": "text/javascript"}})],
      ["a redirect", () => new Response(null, {status: 302, headers: {location: "https://elsewhere.example"}})],
    ]
    for (const [name, answer] of refusals) {
      respond = answer
      const reply = await appFor().request("http://core.test/ui/a")
      expect([name, reply.status, await reply.json()]).toEqual([name, 503, {error: "test_unavailable"}])
    }
  })

  test("a HEAD gets the headers of the GET and no body, and any other method is a 405", async () => {
    const head = await appFor().request("http://core.test/ui/entry.js", {method: "HEAD"})
    expect(head.status).toBe(200)
    expect(head.headers.get("content-type")).toBe("text/javascript")
    expect(await head.text()).toBe("")
    calls = []
    const post = await appFor().request("http://core.test/ui/entry.js", {method: "POST", body: "{}"})
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET, HEAD"])
    expect(calls).toHaveLength(0)
  })
})
