import {describe, expect, mock, test} from "bun:test"
import {createHttpClient} from "../../http"
import type {CloudClientTimers} from "../../timers"
import type {HttpTransport} from "../../transports"
import {Account} from "./account"
import {CoreRequestError, CoreResponseError, SessionChangedError, type CoreTokenSource} from "./account-call"
import {Core} from "./core"

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

const PATH = "https://core.test/api/account/declared-age"
const AT = "2026-10-24T08:00:00.000Z"

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

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {status, headers: {"Content-Type": "application/json"}})
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
  return {auth, requests, account: new Account(http, auth), http}
}

describe("declaredAge", () => {
  test("reads the signed-in person's declared age, or none", async () => {
    const answers = [
      {declaredAge: null, declaredAgeAt: null},
      {declaredAge: 15, declaredAgeAt: AT, extra: "ignored"},
    ]
    const {account, requests} = setup((_url, attempt) => json(200, answers[attempt - 1]))

    expect(await account.declaredAge()).toEqual({declaredAge: null, declaredAgeAt: null})
    expect(await account.declaredAge()).toEqual({declaredAge: 15, declaredAgeAt: AT})
    expect(requests[0]).toMatchObject({url: PATH, method: "GET"})
    expect(requests[0]!.authorization).toStartWith(`Bearer ${jwt("mu_alice")}`)
  })

  test("another shape is a CoreResponseError, never read as no answer", async () => {
    for (const body of [{}, {declaredAge: 15, declaredAgeAt: null}, {declaredAge: "15", declaredAgeAt: AT}, null]) {
      const {account} = setup(() => json(200, body))
      await expect(account.declaredAge()).rejects.toBeInstanceOf(CoreResponseError)
    }
  })

  test("a call for another account is refused before anything is sent", async () => {
    const {account, requests} = setup(() => json(200, {declaredAge: null, declaredAgeAt: null}))
    await expect(account.declaredAge({expectedAccount: "mu_bob"})).rejects.toBeInstanceOf(SessionChangedError)
    expect(requests).toHaveLength(0)
  })
})

describe("setDeclaredAge", () => {
  test("puts the age as the signed-in person and answers what Core kept", async () => {
    const {account, requests} = setup(() => json(200, {declaredAge: 15, declaredAgeAt: AT}))
    expect(await account.setDeclaredAge(15, {expectedAccount: "mu_alice"})).toEqual({declaredAge: 15, declaredAgeAt: AT})
    expect(requests).toEqual([
      {url: PATH, method: "PUT", authorization: expect.stringContaining(jwt("mu_alice")), body: {age: 15}},
    ])
  })

  test("an answer that kept another age, or none, is a CoreResponseError", async () => {
    for (const body of [
      {declaredAge: 16, declaredAgeAt: AT},
      {declaredAge: null, declaredAgeAt: null},
    ]) {
      const {account} = setup(() => json(200, body))
      await expect(account.setDeclaredAge(15)).rejects.toBeInstanceOf(CoreResponseError)
    }
  })

  test("Core's refusal keeps its status and code", async () => {
    const {account} = setup(() => json(400, {error: "invalid_request", error_description: "age must be..."}))
    const error = await account.setDeclaredAge(0).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(CoreRequestError)
    expect(error).toMatchObject({status: 400, code: "invalid_request"})
  })

  test("the person switching accounts during the call drops the answer", async () => {
    const fixture = setup(() => {
      fixture.auth.account = "mu_bob"
      return json(200, {declaredAge: 15, declaredAgeAt: AT})
    })
    await expect(fixture.account.setDeclaredAge(15)).rejects.toBeInstanceOf(SessionChangedError)
  })
})

describe("cloud.core.account", () => {
  test("is wired to Core's account router", async () => {
    const {http, auth, requests} = setup(() => json(200, {declaredAge: 20, declaredAgeAt: AT}))
    const core = new Core({http, auth})
    expect(await core.account.declaredAge()).toEqual({declaredAge: 20, declaredAgeAt: AT})
    const {setDeclaredAge} = core.account
    expect(await setDeclaredAge(20)).toEqual({declaredAge: 20, declaredAgeAt: AT})
    expect(requests.map((request) => request.method)).toEqual(["GET", "PUT"])
  })
})
