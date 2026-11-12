import {describe, expect, mock, test} from "bun:test"
import {createHttpClient} from "../../http"
import type {CloudClientTimers} from "../../timers"
import type {HttpTransport} from "../../transports"
import {CoreRequestError, CoreResponseError, SessionChangedError, type CoreTokenSource} from "./account-call"
import {Core} from "./core"
import {Registry} from "./registry"

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

const BASE = "https://core.test/api/client/registry"
const URL = "https://notes.example.com/"

function jwt(sub: string): string {
  const payload = Buffer.from(JSON.stringify({sub, exp: 4_000_000_000})).toString("base64url")
  return `e30.${payload}.sig`
}

class FakeAuth implements CoreTokenSource {
  refreshes = 0
  constructor(public account: string) {}
  async getCoreToken(opts?: {forceRefresh?: boolean}): Promise<string> {
    if (opts?.forceRefresh) this.refreshes += 1
    return `${jwt(this.account)}#${this.refreshes}`
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json", ...headers}})
}

function setup(handler: (url: string, attempt: number) => Response | Promise<Response>) {
  const auth = new FakeAuth("mu_alice")
  const requests: {url: string; method: string; authorization: string | undefined; body: unknown}[] = []
  const transport = mock(async (input: unknown, init?: unknown) => {
    const request = init as RequestInit
    requests.push({
      url: String(input),
      method: String(request.method),
      authorization: (request.headers as Record<string, string>)["Authorization"],
      body: typeof request.body === "string" ? JSON.parse(request.body) : request.body,
    })
    return handler(String(input), requests.length)
  })
  const http = createHttpClient({
    baseUrl: "https://core.test",
    logger,
    fetch: transport as unknown as HttpTransport,
    timers: instantTimers,
  })
  return {auth, requests, registry: new Registry(http, auth), http}
}

const entry = {
  url: URL,
  packageName: "com.example.notes",
  registrableDomain: "example.com",
  name: "Notes",
  version: "1.0.0",
  ageRating: "4+",
  iconUrl: "https://notes.example.com/icon.png",
  verification: "verified",
  private: false,
  status: "active",
  firstRegisteredAt: "2026-10-24T08:00:00.000Z",
  lastVerifiedAt: "2026-10-24T08:00:00.000Z",
}

const manifest = {
  packageName: "com.example.notes",
  version: "1.0.0",
  name: "Notes",
  entry: {ui: "ui/index.html"},
  bundle: {url: "com.example.notes-1.0.0.zip", sha256: "ab".repeat(32)},
}

describe("registerMiniappUrl", () => {
  test("posts the URL and the phone's report as the signed-in account, and reads each result", async () => {
    const answers = [
      {result: "accepted", entry, manifest},
      {result: "accepted_unverified", entry: {...entry, verification: "phone_reported", lastVerifiedAt: null}},
      {result: "not_a_miniapp", reason: "domain_mismatch"},
      {result: "archived"},
    ]
    const {registry, requests} = setup((_url, attempt) => json(200, answers[attempt - 1]))
    const request = {url: URL, reported: {packageName: "com.example.notes", name: "Notes", version: "1.0.0"}}

    const accepted = await registry.registerMiniappUrl(request)
    expect(accepted).toEqual({result: "accepted", entry, manifest} as never)
    // Fields the manifest schema doesn't name are kept.
    expect(accepted.result === "accepted" && (accepted.manifest as unknown as Record<string, unknown>).entry).toEqual({ui: "ui/index.html"})
    expect((await registry.registerMiniappUrl(request)).result).toBe("accepted_unverified")
    expect(await registry.registerMiniappUrl(request)).toEqual({result: "not_a_miniapp", reason: "domain_mismatch"})
    expect(await registry.registerMiniappUrl(request)).toEqual({result: "archived"})

    expect(requests[0]).toMatchObject({url: `${BASE}/register`, method: "POST", body: request})
    expect(requests[0]!.authorization).toStartWith(`Bearer ${jwt("mu_alice")}`)
  })

  test("an unknown result or another shape is a CoreResponseError", async () => {
    for (const [body, reason] of [
      [{result: "quarantined"}, "unknown_status"],
      [{result: "accepted", entry}, "invalid_shape"],
      [{result: "not_a_miniapp", reason: "something_else"}, "invalid_shape"],
      [{entry}, "invalid_shape"],
      [null, "invalid_shape"],
    ] as const) {
      const {registry} = setup(() => json(200, body))
      const error = await registry.registerMiniappUrl({url: URL}).catch((caught) => caught)
      expect({body, error: error instanceof CoreResponseError, reason: error.reason}).toEqual({body, error: true, reason})
    }
  })

  test("keeps Core's error code and Retry-After", async () => {
    const cases: Array<[() => Response, number, string, number | undefined]> = [
      [() => json(403, {error: "email_unverified"}), 403, "email_unverified", undefined],
      [() => json(429, {error: "rate_limited"}, {"Retry-After": "1800"}), 429, "rate_limited", 1800],
      [() => json(400, {error: "invalid_request"}), 400, "invalid_request", undefined],
    ]
    for (const [response, status, code, retryAfterSeconds] of cases) {
      const {registry} = setup(() => response())
      const error = await registry.registerMiniappUrl({url: URL}).catch((caught) => caught)
      expect(error).toBeInstanceOf(CoreRequestError)
      expect({status: error.status, code: error.code, retryAfterSeconds: error.retryAfterSeconds}).toEqual({
        status,
        code,
        retryAfterSeconds,
      })
    }
  })

  test("a 401 refreshes the token once and sends again", async () => {
    const {registry, requests, auth} = setup((_url, attempt) =>
      attempt === 1 ? json(401, {error: "unauthorized"}) : json(200, {result: "archived"}),
    )
    expect(await registry.registerMiniappUrl({url: URL})).toEqual({result: "archived"})
    expect(auth.refreshes).toBe(1)
    expect(requests).toHaveLength(2)
  })

  test("an answer that arrives after another account signed in is dropped", async () => {
    let auth: FakeAuth
    const setupResult = setup(() => {
      auth.account = "mu_bob"
      return json(200, {result: "archived"})
    })
    auth = setupResult.auth
    await expect(setupResult.registry.registerMiniappUrl({url: URL})).rejects.toBeInstanceOf(SessionChangedError)
  })
})

describe("registryStatus", () => {
  test("posts the batch and reads the statuses and how long they stay valid", async () => {
    const answer = {
      statuses: [
        {url: URL, status: "active"},
        {url: "https://old.example.com/", status: "archived"},
        {url: "https://x.example.com/", status: "unknown"},
      ],
      validForSeconds: 21600,
    }
    const {registry, requests} = setup(() => json(200, answer))
    const request = {
      entries: [
        {url: URL, version: "1.0.0"},
        {url: "https://old.example.com/", version: "2.0.0"},
        {url: "https://x.example.com/", version: "0.1.0"},
      ],
    }
    expect(await registry.registryStatus(request)).toEqual(answer as never)
    expect(requests[0]).toMatchObject({url: `${BASE}/status`, method: "POST", body: request})
  })

  test("an answer that doesn't cover the batch, or holds a status this client doesn't know, is a CoreResponseError", async () => {
    for (const body of [
      {statuses: [], validForSeconds: 60},
      {statuses: [{url: URL, status: "suspended"}], validForSeconds: 60},
      {statuses: [{url: URL, status: "active"}]},
      {statuses: [{url: URL, status: "active"}], validForSeconds: 0},
    ]) {
      const {registry} = setup(() => json(200, body))
      const error = await registry.registryStatus({entries: [{url: URL, version: "1.0.0"}]}).catch((caught) => caught)
      expect({body, error: error instanceof CoreResponseError}).toEqual({body, error: true})
    }
  })

  test("a network failure is retried, then a CoreRequestError with network_error", async () => {
    let attempts = 0
    const {registry} = setup(() => {
      attempts += 1
      throw new TypeError("network down")
    })
    const error = await registry.registryStatus({entries: []}).catch((caught) => caught)
    expect(error).toBeInstanceOf(CoreRequestError)
    expect(error.code).toBe("network_error")
    expect(attempts).toBeGreaterThan(1)
  })
})

test("cloud.core.registry exposes both calls", async () => {
  const {http, auth} = setup(() => json(200, {statuses: [], validForSeconds: 60}))
  const core = new Core({http, auth})
  const {registryStatus, registerMiniappUrl} = core.registry
  expect(typeof registerMiniappUrl).toBe("function")
  expect(await registryStatus({entries: []})).toEqual({statuses: [], validForSeconds: 60})
})
