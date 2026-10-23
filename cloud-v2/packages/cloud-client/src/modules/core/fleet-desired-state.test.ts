import {describe, expect, mock, test} from "bun:test"
import {AuthExpiredError} from "../../errors"
import {createHttpClient} from "../../http"
import type {CloudClientTimers} from "../../timers"
import type {HttpTransport} from "../../transports"
import {CoreRequestError, CoreResponseError, SessionChangedError, type CoreTokenSource} from "./account-call"
import {Core} from "./core"
import {Fleet} from "./fleet"

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
}

const instantTimers: CloudClientTimers = {
  setTimeout(callback) {
    queueMicrotask(callback)
    return 0
  },
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
}

const URL_ = "https://core.test/api/client/fleet/desired-state"
const T = "2026-10-21T09:30:00Z"

function jwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({sub, tenant_id: "consumer", exp: 4_000_000_000})).toString("base64url")
  return `e30.${payload}.sig`
}

class FakeAuth implements CoreTokenSource {
  account: string | null
  generation = 0
  refreshes = 0
  constructor(account: string) {
    this.account = account
  }
  tokenOf(account: string, generation = this.generation): string {
    return `${jwt(account)}#${generation}`
  }
  async getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string> {
    if (this.account === null) throw new AuthExpiredError("auth session was cleared")
    if (opts?.forceRefresh) {
      this.refreshes += 1
      this.generation += 1
    }
    return this.tokenOf(this.account)
  }
  switchTo(account: string): void {
    this.account = account
    this.generation += 1
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}})
}

function setup(handler: (attempt: number) => Response | Promise<Response>) {
  const auth = new FakeAuth("account-a")
  const requests: {url: string; method: string; authorization: string | undefined}[] = []
  const transport = mock(async (input: unknown, init?: unknown) => {
    const request = init as RequestInit
    requests.push({
      url: String(input),
      method: String(request.method),
      authorization: (request.headers as Record<string, string>)["Authorization"],
    })
    return handler(requests.length)
  })
  const http = createHttpClient({
    baseUrl: "https://core.test",
    logger,
    fetch: transport as unknown as HttpTransport,
    timers: instantTimers,
  })
  return {auth, requests, fleet: new Fleet(http, auth), http}
}

const entry = {
  assignmentId: "asg_1",
  revision: 2,
  url: "https://private.example.com/miniapp",
  packageName: "com.example.private",
  selection: "latest",
}
const managed = (overrides: Record<string, unknown> = {}) => ({
  status: "managed",
  revision: 5,
  generatedAt: T,
  workspace: {workspaceId: "ws_1", name: "Ridgeline Field Services"},
  entries: [entry],
  ...overrides,
})
const unmanaged = {status: "unmanaged", revision: 6, generatedAt: T}

describe("Fleet.desiredState request", () => {
  test("is GET /api/client/fleet/desired-state with the signed-in account's token", async () => {
    const {fleet, requests, auth} = setup(() => json(200, managed()))
    await fleet.desiredState()
    expect(requests).toEqual([{url: URL_, method: "GET", authorization: `Bearer ${auth.tokenOf("account-a")}`}])
  })

  test("is exposed as cloud.core.fleet.desiredState, bound", async () => {
    const {http, auth, requests} = setup(() => json(200, unmanaged))
    const {desiredState} = new Core({http, auth}).fleet
    await desiredState()
    expect(requests[0]!.url).toBe(URL_)
  })

  test("a 401 refreshes once and sends again with the new token", async () => {
    const {fleet, requests, auth} = setup(n => (n === 1 ? json(401, {error: "unauthorized"}) : json(200, managed())))
    await expect(fleet.desiredState()).resolves.toMatchObject({status: "managed"})
    expect(auth.refreshes).toBe(1)
    expect(requests.map(r => r.authorization)).toEqual([
      `Bearer ${auth.tokenOf("account-a", 0)}`,
      `Bearer ${auth.tokenOf("account-a", 1)}`,
    ])
  })

  test("a second 401 is a CoreRequestError 401 after one refresh", async () => {
    const {fleet, requests, auth} = setup(() => json(401, {error: "unauthorized"}))
    await expect(fleet.desiredState()).rejects.toMatchObject({name: "CoreRequestError", status: 401})
    expect(auth.refreshes).toBe(1)
    expect(requests).toHaveLength(2)
  })

  test("expectedAccount for another account sends nothing", async () => {
    const {fleet, requests} = setup(() => json(200, managed()))
    await expect(fleet.desiredState({expectedAccount: "account-b"})).rejects.toBeInstanceOf(SessionChangedError)
    expect(requests).toHaveLength(0)
  })

  test("an answer that arrives after an account switch is dropped", async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const {fleet, requests, auth} = setup(async () => {
      await gate
      return json(200, managed())
    })
    const pending = fleet.desiredState()
    while (requests.length === 0) await new Promise(resolve => setTimeout(resolve, 0))
    auth.switchTo("account-b")
    release()
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.authorization).toBe(`Bearer ${auth.tokenOf("account-a", 0)}`)
  })
})

describe("Fleet.desiredState accepts only valid desired state", () => {
  test("managed with entries", async () => {
    const {fleet} = setup(() => json(200, managed()))
    await expect(fleet.desiredState()).resolves.toEqual(managed() as never)
  })

  test("managed with no entries is still managed", async () => {
    const {fleet} = setup(() => json(200, managed({entries: []})))
    await expect(fleet.desiredState()).resolves.toMatchObject({status: "managed", entries: []})
  })

  test("unmanaged", async () => {
    const {fleet} = setup(() => json(200, unmanaged))
    await expect(fleet.desiredState()).resolves.toEqual(unmanaged as never)
  })

  async function rejection(body: unknown): Promise<CoreResponseError> {
    const {fleet} = setup(() => json(200, body))
    const error = await fleet.desiredState().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CoreResponseError)
    return error as CoreResponseError
  }

  test("an unknown status is a typed error, never unmanaged", async () => {
    expect((await rejection({status: "paused", revision: 7, generatedAt: T})).reason).toBe("unknown_status")
    expect((await rejection({status: "something_new", revision: 7, generatedAt: T})).reason).toBe("unknown_status")
  })

  test("an entry without a url is invalid", async () => {
    const {url: _url, ...withoutUrl} = entry
    expect((await rejection(managed({entries: [withoutUrl]}))).reason).toBe("invalid_shape")
  })

  test("an entry whose url is not https is invalid", async () => {
    expect((await rejection(managed({entries: [{...entry, url: "http://private.example.com/miniapp"}]}))).reason).toBe(
      "invalid_shape",
    )
  })

  test("an entry with a field it should not have (paused) is invalid", async () => {
    expect((await rejection(managed({entries: [{...entry, paused: true}]}))).reason).toBe("invalid_shape")
  })

  test("a managed answer without a workspace or entries is invalid", async () => {
    expect((await rejection({status: "managed", revision: 5, generatedAt: T, entries: []})).reason).toBe("invalid_shape")
    expect(
      (await rejection({status: "managed", revision: 5, generatedAt: T, workspace: {workspaceId: "ws_1", name: "x"}}))
        .reason,
    ).toBe("invalid_shape")
  })

  test("a missing or malformed revision is invalid", async () => {
    expect((await rejection({status: "unmanaged", generatedAt: T})).reason).toBe("invalid_shape")
    expect((await rejection({status: "unmanaged", revision: 0, generatedAt: T})).reason).toBe("invalid_shape")
  })

  test("a body with no status is invalid", async () => {
    expect((await rejection({})).reason).toBe("invalid_shape")
    expect((await rejection([])).reason).toBe("invalid_shape")
    expect((await rejection(null)).reason).toBe("invalid_shape")
  })

  test("an empty body (204 or 200) is invalid, not unmanaged", async () => {
    for (const status of [200, 204]) {
      const {fleet} = setup(() => new Response(null, {status}))
      await expect(fleet.desiredState()).rejects.toBeInstanceOf(CoreResponseError)
    }
  })

  test("a body that is not JSON is invalid", async () => {
    const {fleet} = setup(() => new Response("<html>gateway</html>", {status: 200}))
    await expect(fleet.desiredState()).rejects.toBeInstanceOf(CoreResponseError)
  })

  test("a connection that drops while the body is read is a network error, not an empty answer", async () => {
    const {fleet} = setup(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("network connection was lost"))
            },
          }),
          {status: 200},
        ),
    )
    await expect(fleet.desiredState()).rejects.toMatchObject({name: "CoreRequestError", status: 0, code: "network_error"})
  })
})

describe("Fleet.desiredState failures are typed errors with Core's status and code", () => {
  test("503 fleet_unavailable keeps status, code and Retry-After", async () => {
    const {fleet} = setup(() => json(503, {error: "fleet_unavailable"}, {"Retry-After": "30"}))
    const error = (await fleet.desiredState().catch((e: unknown) => e)) as CoreRequestError
    expect(error).toBeInstanceOf(CoreRequestError)
    expect(error).toMatchObject({status: 503, code: "fleet_unavailable", retryAfterSeconds: 30})
  })

  test("404 fleet_not_installed and 404 from a Core with no such route stay distinguishable", async () => {
    const installed = setup(() => json(404, {error: "fleet_not_installed"}))
    await expect(installed.fleet.desiredState()).rejects.toMatchObject({status: 404, code: "fleet_not_installed"})
    const noRoute = setup(() => new Response("Not Found", {status: 404}))
    await expect(noRoute.fleet.desiredState()).rejects.toMatchObject({status: 404, code: undefined})
  })

  test("403, 429 and 500 are errors with their status", async () => {
    for (const status of [403, 429, 500]) {
      const {fleet} = setup(() => json(status, {error: "nope"}))
      await expect(fleet.desiredState()).rejects.toMatchObject({name: "CoreRequestError", status})
    }
  })

  test("Core's wording never reaches the message", async () => {
    const {fleet} = setup(() => json(503, {error: "fleet_unavailable", error_description: "mfm.internal timed out"}))
    const error = (await fleet.desiredState().catch((e: unknown) => e)) as CoreRequestError
    expect(error.message).toBe("Core request failed (HTTP 503)")
  })

  test("a network error is a CoreRequestError with status 0, after the GET retries", async () => {
    const {fleet, requests} = setup(() => {
      throw new TypeError("Network request failed")
    })
    await expect(fleet.desiredState()).rejects.toMatchObject({name: "CoreRequestError", status: 0, code: "network_error"})
    expect(requests).toHaveLength(3)
  })

  test("a failure never resolves", async () => {
    const results = await Promise.allSettled(
      [500, 503, 404, 403].map(status => setup(() => json(status, {error: "x"})).fleet.desiredState()),
    )
    expect(results.every(result => result.status === "rejected")).toBe(true)
  })

  test("an abort rejects with the abort reason", async () => {
    const {fleet, requests} = setup(() => json(200, managed()))
    const controller = new AbortController()
    const reason = new Error("stop")
    controller.abort(reason)
    await expect(fleet.desiredState({signal: controller.signal})).rejects.toBe(reason)
    expect(requests).toHaveLength(0)
  })

  test("without a token source it rejects without sending", async () => {
    const {http, requests} = setup(() => json(200, managed()))
    await expect(new Fleet(http).desiredState()).rejects.toThrow("no Core sign-in")
    expect(requests).toHaveLength(0)
  })
})
