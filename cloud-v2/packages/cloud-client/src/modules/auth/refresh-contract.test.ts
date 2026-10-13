import {describe, expect, test} from "bun:test"
import {Auth} from "./auth"
import {DEFAULT_REFRESH_TOKEN_KEY, TokenStore} from "./token-store"
import type {AuthConfig} from "../../config"
import {AuthExpiredError, AuthUnavailableError} from "../../errors"
import {noopLogger} from "../../logger"
import type {HttpTransport} from "../../transports"

/**
 * The refresh contract: the stored refresh token is cleared, and `onExpired` fires, only when Core definitively
 * rejects the refresh token. Any other failure (network, timeout, 408, 429, 5xx, a body that is not Core's, an
 * unrecognized 4xx) leaves the token in place and is retried by the next call.
 */

const KEY = DEFAULT_REFRESH_TOKEN_KEY

const jwt = (exp: number) => {
  const payload = Buffer.from(JSON.stringify({sub: "account-1", tenant_id: "consumer", exp})).toString("base64url")
  return `e30.${payload}.test`
}

const issued = (refreshToken: string) =>
  Response.json({
    access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: 3600,
  })

/** The body Core's global error translator renders for an `OauthError`. */
const oauthError = (status: number, error: string, description = "rejected") =>
  Response.json({error, error_description: description}, {status})

interface Call {
  /** `refresh` or `exchange`: the last path segment of the request. */
  endpoint: string
  /** 1-based count of requests to this endpoint, including this one. */
  n: number
  form: URLSearchParams
}

type Responder = (call: Call) => Response | Promise<Response>

const SUBJECT_CONFIG: AuthConfig = {
  core: {subjectToken: "subject", subjectTokenType: "oidc"},
  runtime: {source: "core"},
}

function harness(opts: {respond: Responder; config?: AuthConfig; refreshToken?: string | null}) {
  const values = new Map<string, string>()
  const seed = opts.refreshToken === undefined ? "refresh-1" : opts.refreshToken
  if (seed !== null) values.set(KEY, seed)
  const storage = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  }
  const calls: Call[] = []
  const counts: Record<string, number> = {}
  const transport: HttpTransport = async (url, init) => {
    const endpoint = String(url).split("/").pop() ?? ""
    counts[endpoint] = (counts[endpoint] ?? 0) + 1
    const call = {endpoint, n: counts[endpoint], form: new URLSearchParams(String(init?.body ?? ""))}
    calls.push(call)
    return opts.respond(call)
  }
  const auth = new Auth({
    store: new TokenStore({storage}),
    config: opts.config ?? SUBJECT_CONFIG,
    logger: noopLogger,
    baseUrl: "https://core.example.test",
    fetch: transport,
  })
  const state = {auth, storage, calls, expired: 0}
  auth.onExpired(() => {
    state.expired += 1
  })
  return state
}

const refreshTokensSent = (calls: Call[]) =>
  calls.filter((call) => call.endpoint === "refresh").map((call) => call.form.get("refresh_token"))

/** Every way a refresh can fail without Core saying the token is dead. [name, failure, HTTP status if any]. */
const TRANSIENT: Array<[string, () => Response, number | undefined]> = [
  [
    "a network error",
    () => {
      throw new TypeError("Network request failed")
    },
    undefined,
  ],
  [
    "a native HTTP timeout",
    () => {
      throw Object.assign(new Error("timed out"), {code: "E_NATIVE_HTTP_TIMEOUT"})
    },
    undefined,
  ],
  [
    "an AbortSignal.timeout style TimeoutError",
    () => {
      throw new DOMException("The operation timed out", "TimeoutError")
    },
    undefined,
  ],
  ["a 408", () => new Response(null, {status: 408}), 408],
  ["a 429 with Retry-After", () => new Response(null, {status: 429, headers: {"Retry-After": "30"}}), 429],
  ["a 500 with an HTML body", () => new Response("<html><h1>Oops</h1></html>", {status: 500, headers: {"Content-Type": "text/html"}}), 500],
  ["a 502 from a gateway", () => new Response("Bad Gateway", {status: 502}), 502],
  ["a 503", () => oauthError(503, "temporarily_unavailable"), 503],
  ["a 500 server_error", () => oauthError(500, "server_error", "internal server error"), 500],
  ["a 200 whose body is not JSON (a captive portal)", () => new Response("<html>Sign in to Wi-Fi</html>", {status: 200}), undefined],
  ["a 401 from a proxy with an HTML body", () => new Response("<html>Unauthorized</html>", {status: 401}), 401],
  ["a 400 with no body", () => new Response(null, {status: 400}), 400],
  ["an unknown 4xx", () => oauthError(403, "access_denied"), 403],
  ["a 401 with an unrecognized code", () => oauthError(401, "invalid_token"), 401],
  ["a 400 invalid_request (a mangled request, not a verdict on the token)", () => oauthError(400, "invalid_request", "refresh_token is required"), 400],
  ["a 400 unsupported_grant_type", () => oauthError(400, "unsupported_grant_type"), 400],
]

describe("a refresh that fails for a transient reason", () => {
  for (const [name, failure, status] of TRANSIENT) {
    test(`${name} keeps the refresh token and the next call retries it`, async () => {
      const t = harness({respond: ({n}) => (n === 1 ? failure() : issued("refresh-2"))})

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthUnavailableError)
      expect(error).not.toBeInstanceOf(AuthExpiredError)
      expect((error as AuthUnavailableError).status).toBe(status)
      expect(await t.storage.get(KEY)).toBe("refresh-1")
      expect(t.expired).toBe(0)

      await expect(t.auth.getCoreToken()).resolves.toBeString()
      expect(refreshTokensSent(t.calls)).toEqual(["refresh-1", "refresh-1"])
      expect(t.calls.some((call) => call.endpoint === "exchange")).toBe(false)
      expect(await t.storage.get(KEY)).toBe("refresh-2")
      expect(t.expired).toBe(0)
    })
  }

  test("a forced refresh that fails transiently still keeps the refresh token", async () => {
    const t = harness({respond: ({n}) => (n === 1 ? issued("refresh-2") : new Response(null, {status: 503}))})
    await t.auth.getCoreToken()

    await expect(t.auth.getCoreToken({forceRefresh: true})).rejects.toBeInstanceOf(AuthUnavailableError)
    expect(await t.storage.get(KEY)).toBe("refresh-2")
    expect(t.expired).toBe(0)
  })

  test("concurrent callers share one failed attempt and one error", async () => {
    const t = harness({respond: () => new Response(null, {status: 503})})

    const results = await Promise.allSettled([t.auth.getCoreToken(), t.auth.getCoreToken(), t.auth.getCoreToken()])

    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected", "rejected"])
    for (const r of results) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AuthUnavailableError)
    expect(t.calls).toHaveLength(1)
    expect(await t.storage.get(KEY)).toBe("refresh-1")
  })

  test("an abort propagates as the abort and keeps the refresh token", async () => {
    const t = harness({
      respond: ({n}) => {
        if (n === 1) throw new DOMException("The operation was aborted", "AbortError")
        return issued("refresh-2")
      },
    })

    const error = await t.auth.getCoreToken().catch((e) => e)
    expect((error as Error).name).toBe("AbortError")
    expect(error).not.toBeInstanceOf(AuthUnavailableError)
    expect(error).not.toBeInstanceOf(AuthExpiredError)
    expect(await t.storage.get(KEY)).toBe("refresh-1")
    expect(t.expired).toBe(0)

    await expect(t.auth.getCoreToken()).resolves.toBeString()
    expect(refreshTokensSent(t.calls)).toEqual(["refresh-1", "refresh-1"])
  })
})

/** What Core answers for a refresh token that is dead for good (see services/session.service.ts, refreshSession). */
const DEFINITIVE: Array<[string, () => Response]> = [
  ["400 invalid_grant (unknown, expired or already used)", () => oauthError(400, "invalid_grant", "refresh_token unknown, expired, or already used")],
  ["400 invalid_grant (account deleted)", () => oauthError(400, "invalid_grant", "account is deleted")],
  ["401 invalid_grant", () => oauthError(401, "invalid_grant")],
  ["401 unauthorized_client (tenant disabled)", () => oauthError(401, "unauthorized_client", "oem acme unknown or disabled")],
  ["400 unauthorized_client", () => oauthError(400, "unauthorized_client")],
]

describe("a refresh Core definitively rejects", () => {
  for (const [name, rejection] of DEFINITIVE) {
    test(`${name} clears the refresh token and notifies exactly once`, async () => {
      const t = harness({
        respond: ({endpoint}) => (endpoint === "refresh" ? rejection() : oauthError(400, "invalid_grant")),
      })

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthExpiredError)
      expect(error).not.toBeInstanceOf(AuthUnavailableError)
      expect(await t.storage.get(KEY)).toBeNull()
      expect(t.expired).toBe(1)

      // The person is signed out: later calls do not present the dead token again, and do not notify again.
      await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthExpiredError)
      expect(refreshTokensSent(t.calls)).toEqual(["refresh-1"])
      expect(t.expired).toBe(1)
    })
  }

  test("concurrent callers share one rejection and one notification", async () => {
    const t = harness({respond: () => oauthError(400, "invalid_grant")})

    const results = await Promise.allSettled([t.auth.getCoreToken(), t.auth.getCoreToken()])

    for (const r of results) {
      expect(r.status).toBe("rejected")
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AuthExpiredError)
    }
    expect(t.calls).toHaveLength(1)
    expect(t.expired).toBe(1)
  })

  test("a transient failure followed by a rejection notifies once, at the rejection", async () => {
    const t = harness({
      respond: ({endpoint, n}) => {
        if (endpoint !== "refresh") return oauthError(400, "invalid_grant")
        return n === 1 ? new Response(null, {status: 503}) : oauthError(400, "invalid_grant")
      },
    })

    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthUnavailableError)
    expect(t.expired).toBe(0)
    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthExpiredError)
    expect(t.expired).toBe(1)
    expect(await t.storage.get(KEY)).toBeNull()
  })
})

describe("the fresh subject exchange after a refresh failure", () => {
  const subjectConfig = () => {
    const state = {subjectCalls: 0}
    const config: AuthConfig = {
      core: {
        getSubjectToken: async () => {
          state.subjectCalls += 1
          return {token: "fresh-subject", type: "supabase" as const}
        },
      },
      runtime: {source: "core"},
    }
    return {state, config}
  }

  test("a definitive rejection still exchanges a fresh subject token, without notifying", async () => {
    const {state, config} = subjectConfig()
    const t = harness({
      config,
      respond: ({endpoint}) => (endpoint === "refresh" ? oauthError(400, "invalid_grant") : issued("refresh-2")),
    })

    await expect(t.auth.getCoreToken()).resolves.toBeString()

    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh", "exchange"])
    expect(state.subjectCalls).toBe(1)
    expect(await t.storage.get(KEY)).toBe("refresh-2")
    expect(t.expired).toBe(0)
  })

  test("a definitive rejection followed by a failed exchange notifies once", async () => {
    const {state, config} = subjectConfig()
    const t = harness({config, respond: () => oauthError(400, "invalid_grant")})

    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthExpiredError)

    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh", "exchange"])
    expect(state.subjectCalls).toBe(1)
    expect(await t.storage.get(KEY)).toBeNull()
    expect(t.expired).toBe(1)
  })

  test("a transient failure neither exchanges nor clears, and the next call refreshes", async () => {
    const {state, config} = subjectConfig()
    const t = harness({
      config,
      respond: ({endpoint, n}) => {
        if (endpoint === "exchange") return issued("exchanged")
        return n === 1 ? new Response("<html>Gateway timeout</html>", {status: 504}) : issued("refresh-2")
      },
    })

    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthUnavailableError)

    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
    expect(state.subjectCalls).toBe(0)
    expect(await t.storage.get(KEY)).toBe("refresh-1")
    expect(t.expired).toBe(0)

    await expect(t.auth.getCoreToken()).resolves.toBeString()
    expect(refreshTokensSent(t.calls)).toEqual(["refresh-1", "refresh-1"])
    expect(state.subjectCalls).toBe(0)
    expect(await t.storage.get(KEY)).toBe("refresh-2")
  })

  test("a network error neither exchanges nor clears", async () => {
    const {state, config} = subjectConfig()
    const t = harness({
      config,
      respond: () => {
        throw new TypeError("Network request failed")
      },
    })

    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthUnavailableError)

    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
    expect(state.subjectCalls).toBe(0)
    expect(await t.storage.get(KEY)).toBe("refresh-1")
    expect(t.expired).toBe(0)
  })

  test("an abort neither exchanges nor clears", async () => {
    const {state, config} = subjectConfig()
    const t = harness({
      config,
      respond: () => {
        throw new DOMException("The operation was aborted", "AbortError")
      },
    })

    const error = await t.auth.getCoreToken().catch((e) => e)

    expect((error as Error).name).toBe("AbortError")
    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
    expect(state.subjectCalls).toBe(0)
    expect(await t.storage.get(KEY)).toBe("refresh-1")
    expect(t.expired).toBe(0)
  })

  test("a refresh that finishes after logout does not reacquire credentials or notify", async () => {
    const {state, config} = subjectConfig()
    let enter!: () => void
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const t = harness({
      config,
      respond: async ({endpoint}) => {
        if (endpoint === "refresh") {
          enter()
          await gate
        }
        return issued("late-refresh")
      },
    })

    const inFlight = t.auth.getCoreToken().catch((e) => e)
    await entered
    await t.auth.clearSession()
    release()

    expect(((await inFlight) as Error).message).toBe("auth session was cleared")
    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
    expect(state.subjectCalls).toBe(0)
    expect(await t.storage.get(KEY)).toBeNull()
    expect(t.expired).toBe(0)
  })
})

/** A `getSubjectToken` host callback that throws for its first `failures` calls. */
function subjectProvider(failures = 0) {
  const state = {calls: 0}
  const config: AuthConfig = {
    core: {
      getSubjectToken: async () => {
        state.calls += 1
        if (state.calls <= failures) throw new Error("secure storage is unavailable")
        return {token: "fresh-subject", type: "supabase" as const}
      },
    },
    runtime: {source: "core"},
  }
  return {state, config}
}

/** Core refusing the subject token for good: the only answers to `/exchange` that mean the host must re-authenticate. */
const EXCHANGE_REFUSALS: Array<[string, () => Response]> = [
  ["400 invalid_grant", () => oauthError(400, "invalid_grant", "subject token verification failed")],
  ["401 unauthorized_client", () => oauthError(401, "unauthorized_client", "unknown oem: acme")],
  ["400 invalid_request", () => oauthError(400, "invalid_request", "subject_token is not a parseable JWT")],
]

/** Everything else a fresh exchange can come to says nothing about the subject token. */
const EXCHANGE_TRANSIENT = TRANSIENT.filter(([name]) => !name.startsWith("a 400 invalid_request"))

describe("a fresh exchange after a definitive refresh rejection", () => {
  for (const [name, failure, status] of EXCHANGE_TRANSIENT) {
    test(`${name} does not notify, and the next call exchanges again without refreshing`, async () => {
      const {state, config} = subjectProvider()
      const t = harness({
        config,
        respond: ({endpoint, n}) => {
          if (endpoint === "refresh") return oauthError(400, "invalid_grant")
          return n === 1 ? failure() : issued("exchanged")
        },
      })

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthUnavailableError)
      expect(error).not.toBeInstanceOf(AuthExpiredError)
      expect((error as AuthUnavailableError).status).toBe(status)
      expect(t.expired).toBe(0)
      // The dead refresh token stays cleared; there is nothing left to refresh with.
      expect(await t.storage.get(KEY)).toBeNull()

      await expect(t.auth.getCoreToken()).resolves.toBeString()
      expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh", "exchange", "exchange"])
      expect(state.calls).toBe(2)
      expect(await t.storage.get(KEY)).toBe("exchanged")
      expect(t.expired).toBe(0)
    })
  }

  for (const [name, refusal] of EXCHANGE_REFUSALS) {
    test(`Core's ${name} refusal of the fresh subject notifies exactly once`, async () => {
      const {config} = subjectProvider()
      const t = harness({
        config,
        respond: ({endpoint}) => (endpoint === "refresh" ? oauthError(400, "invalid_grant") : refusal()),
      })

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthExpiredError)
      expect(error).not.toBeInstanceOf(AuthUnavailableError)
      expect(t.expired).toBe(1)
      expect(await t.storage.get(KEY)).toBeNull()
    })
  }

  test("a failing getSubjectToken does not notify, and the next call asks it again", async () => {
    const {state, config} = subjectProvider(1)
    const t = harness({
      config,
      respond: ({endpoint}) => (endpoint === "refresh" ? oauthError(400, "invalid_grant") : issued("exchanged")),
    })

    await expect(t.auth.getCoreToken()).rejects.toBeInstanceOf(AuthUnavailableError)
    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
    expect(t.expired).toBe(0)

    await expect(t.auth.getCoreToken()).resolves.toBeString()
    expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh", "exchange"])
    expect(state.calls).toBe(2)
    expect(t.expired).toBe(0)
  })

  test("an abort propagates as the abort and does not notify", async () => {
    const {config} = subjectProvider()
    const t = harness({
      config,
      respond: ({endpoint}) => {
        if (endpoint === "refresh") return oauthError(400, "invalid_grant")
        throw new DOMException("The operation was aborted", "AbortError")
      },
    })

    const error = await t.auth.getCoreToken().catch((e) => e)
    expect((error as Error).name).toBe("AbortError")
    expect(t.expired).toBe(0)
  })

  const RACING_OUTCOMES: Array<[string, () => Response]> = [
    ["Core's refusal", () => oauthError(400, "invalid_grant")],
    ["a 503", () => new Response(null, {status: 503})],
    ["a success", () => issued("late-exchange")],
  ]
  for (const [name, outcome] of RACING_OUTCOMES) {
    test(`a logout racing the exchange wins over ${name}: nothing is notified or restored`, async () => {
      const {config} = subjectProvider()
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const t = harness({
        config,
        respond: async ({endpoint}) => {
          if (endpoint === "refresh") return oauthError(400, "invalid_grant")
          enter()
          await gate
          return outcome()
        },
      })

      const inFlight = t.auth.getCoreToken().catch((e) => e)
      await entered
      await t.auth.clearSession()
      release()

      const error = await inFlight
      expect(error).toBeInstanceOf(AuthExpiredError)
      expect((error as Error).message).toBe("auth session was cleared")
      expect(t.expired).toBe(0)
      expect(await t.storage.get(KEY)).toBeNull()
    })
  }
})

describe("a definitive rejection that arrives after logout", () => {
  for (const [name, makeConfig] of [
    ["with a host that can supply a fresh subject token", () => subjectProvider()],
    ["without one", () => ({state: {calls: 0}, config: SUBJECT_CONFIG})],
  ] as const) {
    test(`${name} neither notifies, clears, nor exchanges`, async () => {
      const {state, config} = makeConfig()
      let enter!: () => void
      const entered = new Promise<void>((resolve) => {
        enter = resolve
      })
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const t = harness({
        config,
        respond: async ({endpoint}) => {
          if (endpoint === "refresh") {
            enter()
            await gate
          }
          return oauthError(400, "invalid_grant")
        },
      })

      const inFlight = t.auth.getCoreToken().catch((e) => e)
      await entered
      await t.auth.clearSession()
      // A new session saved after the logout (here by "another client" over the same storage) must survive the late answer.
      await t.storage.set(KEY, "refresh-of-the-next-session")
      release()

      const error = await inFlight
      expect(error).toBeInstanceOf(AuthExpiredError)
      expect((error as Error).message).toBe("auth session was cleared")
      expect(t.calls.map((call) => call.endpoint)).toEqual(["refresh"])
      expect(state.calls).toBe(0)
      expect(t.expired).toBe(0)
      expect(await t.storage.get(KEY)).toBe("refresh-of-the-next-session")
    })
  }
})

describe("the first-use exchange", () => {
  for (const [name, failure, status] of EXCHANGE_TRANSIENT) {
    test(`${name} is retryable: nothing stored or notified, and the next call exchanges again`, async () => {
      const t = harness({refreshToken: null, respond: ({n}) => (n === 1 ? failure() : issued("exchanged"))})

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthUnavailableError)
      expect(error).not.toBeInstanceOf(AuthExpiredError)
      expect((error as AuthUnavailableError).status).toBe(status)
      expect(await t.storage.get(KEY)).toBeNull()
      expect(t.expired).toBe(0)

      await expect(t.auth.getCoreToken()).resolves.toBeString()
      expect(t.calls.map((call) => call.endpoint)).toEqual(["exchange", "exchange"])
      expect(await t.storage.get(KEY)).toBe("exchanged")
    })
  }

  for (const [name, refusal] of EXCHANGE_REFUSALS) {
    test(`Core's ${name} refusal is an AuthExpiredError, without a notification`, async () => {
      const t = harness({refreshToken: null, respond: () => refusal()})

      const error = await t.auth.getCoreToken().catch((e) => e)
      expect(error).toBeInstanceOf(AuthExpiredError)
      expect(error).not.toBeInstanceOf(AuthUnavailableError)
      expect(t.expired).toBe(0)
      expect(await t.storage.get(KEY)).toBeNull()
    })
  }

  test("an abort propagates as the abort", async () => {
    const t = harness({
      refreshToken: null,
      respond: () => {
        throw new DOMException("The operation was aborted", "AbortError")
      },
    })

    const error = await t.auth.getCoreToken().catch((e) => e)
    expect((error as Error).name).toBe("AbortError")
  })

  test("a failing getSubjectToken propagates as it always has", async () => {
    const {config} = subjectProvider(1)
    const t = harness({config, refreshToken: null, respond: () => issued("exchanged")})

    await expect(t.auth.getCoreToken()).rejects.toThrow("secure storage is unavailable")
    expect(t.calls).toHaveLength(0)
  })
})
