/**
 * @fileoverview The Store package-count call, against a loopback stand-in for the Store.
 *
 * No database: the stand-in verifies each request's signature with the contract's
 * `verifyServiceRequest`, so a request signed any other way than the Store would
 * check it fails here. The workspace API's delete route is covered end to end in
 * `tests/workspaces-api.integration.test.ts`.
 */

import {SERVICE_HEADERS, verifyServiceRequest} from "@mentra/workspace-contract/server"
import {afterAll, afterEach, beforeEach, describe, expect, spyOn, test} from "bun:test"
import {countStorePackages} from "./store-package-count"
import {WorkspaceError} from "./workspace-error"

const SECRET = "test-store-service-secret"

interface Seen {
  path: string
  service: string | null
  signed: boolean
}

const seen: Seen[] = []
let respond: (req: Request) => Response | Promise<Response> = () => Response.json({count: 0})
const store = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    seen.push({
      path: url.pathname + url.search,
      service: req.headers.get(SERVICE_HEADERS.service),
      signed: verifyServiceRequest({
        method: req.method,
        pathWithQuery: url.pathname + url.search,
        body: "",
        timestampMs: Number(req.headers.get(SERVICE_HEADERS.timestamp)),
        secrets: [SECRET],
        signature: req.headers.get(SERVICE_HEADERS.signature) ?? "",
        nowMs: Date.now(),
      }),
    })
    return respond(req)
  },
})

const ENV_KEYS = ["MENTRA_STORE_INTERNAL_URL", "CLOUD_CORE_STORE_SERVICE_SECRET"] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  seen.length = 0
  respond = () => Response.json({count: 0})
  process.env.MENTRA_STORE_INTERNAL_URL = store.url.origin
  process.env.CLOUD_CORE_STORE_SERVICE_SECRET = SECRET
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
})

afterAll(() => {
  store.stop(true)
})

async function storeUnavailable(workspaceId = "ws_1"): Promise<WorkspaceError> {
  try {
    await countStorePackages(workspaceId)
  } catch (err) {
    expect(err).toBeInstanceOf(WorkspaceError)
    return err as WorkspaceError
  }
  throw new Error("expected countStorePackages to throw")
}

describe("countStorePackages", () => {
  test("asks the Store with a request signed as service `core` and returns its count", async () => {
    respond = () => Response.json({count: 3})

    expect(await countStorePackages("ws_1")).toBe(3)

    expect(seen).toEqual([{path: "/api/internal/workspaces/ws_1/package-count", service: "core", signed: true}])
  })

  test("a Store URL with a path prefix and a trailing slash is signed for the path actually sent", async () => {
    process.env.MENTRA_STORE_INTERNAL_URL = `${store.url.origin}/store/`

    expect(await countStorePackages("ws_1")).toBe(0)

    expect(seen).toEqual([{path: "/store/api/internal/workspaces/ws_1/package-count", service: "core", signed: true}])
  })

  test("a workspace id is escaped into the path and still verifies", async () => {
    await countStorePackages("ws/odd id?x=1")

    expect(seen).toHaveLength(1)
    expect(seen[0]!.path).toBe("/api/internal/workspaces/ws%2Fodd%20id%3Fx%3D1/package-count")
    expect(seen[0]!.signed).toBe(true)
  })

  test("no Store URL, or no shared secret, means no packages and no request", async () => {
    delete process.env.MENTRA_STORE_INTERNAL_URL
    expect(await countStorePackages("ws_1")).toBe(0)

    process.env.MENTRA_STORE_INTERNAL_URL = store.url.origin
    delete process.env.CLOUD_CORE_STORE_SERVICE_SECRET
    expect(await countStorePackages("ws_1")).toBe(0)

    process.env.CLOUD_CORE_STORE_SERVICE_SECRET = "   "
    expect(await countStorePackages("ws_1")).toBe(0)
    process.env.MENTRA_STORE_INTERNAL_URL = "  "
    process.env.CLOUD_CORE_STORE_SERVICE_SECRET = SECRET
    expect(await countStorePackages("ws_1")).toBe(0)

    expect(seen).toEqual([])
  })

  test("a Store that answers with an error status is store_unavailable (503)", async () => {
    for (const status of [401, 404, 500, 503]) {
      respond = () => new Response("nope", {status})
      const err = await storeUnavailable()
      expect({status, code: err.code, http: err.status}).toEqual({status, code: "store_unavailable", http: 503})
    }
  })

  test("an answer that is not a whole non-negative count is store_unavailable", async () => {
    for (const body of [{}, {count: "2"}, {count: -1}, {count: 1.5}, {count: null}, {total: 2}, [], "2", null, 7]) {
      respond = () => Response.json(body)
      expect({body, code: (await storeUnavailable()).code}).toEqual({body, code: "store_unavailable"})
    }
    respond = () => new Response("<html>gateway</html>", {headers: {"content-type": "text/html"}})
    expect((await storeUnavailable()).code).toBe("store_unavailable")
  })

  test("a redirect is refused rather than followed with the signed headers", async () => {
    respond = () => new Response(null, {status: 302, headers: {location: "http://127.0.0.1:1/elsewhere"}})

    expect((await storeUnavailable()).code).toBe("store_unavailable")
    expect(seen).toHaveLength(1)
  })

  test("a Store that cannot be reached is store_unavailable", async () => {
    const closed = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("")})
    process.env.MENTRA_STORE_INTERNAL_URL = closed.url.origin
    closed.stop(true)

    expect((await storeUnavailable()).code).toBe("store_unavailable")
  })

  test("a Store that never answers is given 5 seconds, then store_unavailable", async () => {
    const original = AbortSignal.timeout.bind(AbortSignal)
    const requested: number[] = []
    const spy = spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      requested.push(ms)
      // Same behavior, shorter wait.
      return original(50)
    })
    respond = () => new Promise<Response>(() => {})
    try {
      expect((await storeUnavailable()).code).toBe("store_unavailable")
    } finally {
      spy.mockRestore()
    }
    expect(requested).toEqual([5000])
  })
})
