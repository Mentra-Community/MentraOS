import {describe, expect, test} from "bun:test"
import {Auth} from "./auth"
import {TokenStore, DEFAULT_REFRESH_TOKEN_KEY} from "./token-store"
import {createHttpClient} from "../../http"
import {noopLogger} from "../../logger"
import {systemTimers} from "../../timers"
import {SessionRevocationError} from "../../errors"
import type {HttpTransport} from "../../transports"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return {promise, resolve}
}

const jwt = (exp: number) => {
  const payload = Buffer.from(JSON.stringify({sub: "account-1", tenant_id: "consumer", exp})).toString("base64url")
  return `e30.${payload}.test`
}

describe("Cloud auth logout completion", () => {
  test("a fresh client stays signed out while remote revocation is pending", async () => {
    const values = new Map<string, string>()
    const storage = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    }
    const store = new TokenStore({storage})
    await store.save({accessToken: jwt(Math.floor(Date.now() / 1000) + 3600), refreshToken: "refresh-1"})
    const entered = deferred<void>()
    const finish = deferred<Response>()
    const transport: HttpTransport = async (url) => {
      if (String(url).endsWith("/revoke")) {
        entered.resolve(undefined)
        return finish.promise
      }
      if (String(url).endsWith("/refresh")) {
        return Response.json({
          access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      throw new Error("unexpected request")
    }
    const config = {
      core: {
        getSubjectToken: async (): Promise<never> => {
          throw new Error("not signed in")
        },
      },
      runtime: {source: "core" as const},
    }
    const build = (tokenStore: TokenStore) =>
      new Auth({
        store: tokenStore,
        config,
        logger: noopLogger,
        baseUrl: "https://core.example.test",
        fetch: transport,
        http: createHttpClient({baseUrl: "https://core.example.test", logger: noopLogger, fetch: transport}),
      })
    const auth = build(store)
    const clearing = auth.clearSession()
    await entered.promise
    await expect(auth.getCoreToken()).rejects.toThrow("auth session was cleared")
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
    // The in-memory session-cleared latch does not survive a process restart.
    const fresh = build(new TokenStore({storage}))
    await expect(fresh.getCoreToken()).rejects.toThrow("not signed in")
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
    finish.resolve(Response.json({success: true}))
    await clearing
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
  })

  test("starts local deletion before waiting for storage snapshot or the network", async () => {
    const snapshot = deferred<string | null>()
    let deleted = false
    const storage = {
      get: () => snapshot.promise,
      set: async () => {},
      delete: async () => {
        deleted = true
      },
    }
    const transport = async () => Response.json({success: true})
    const auth = new Auth({
      store: new TokenStore({storage}),
      logger: noopLogger,
      config: {runtime: {getToken: async () => "runtime-token"}},
      http: createHttpClient({baseUrl: "https://core.example.test", logger: noopLogger, fetch: transport}),
    })
    const clearing = auth.clearSession()
    expect(deleted).toBe(true)
    snapshot.resolve(null)
    await clearing
  })

  test("bounds remote revoke and does not resume mutation after a late refresh response", async () => {
    const values = new Map([[DEFAULT_REFRESH_TOKEN_KEY, "refresh-1"]])
    const storage = {
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => {
        values.set(key, value)
      },
      delete: async (key: string) => {
        values.delete(key)
      },
    }
    const entered = deferred<void>()
    const finish = deferred<Response>()
    let expire!: () => void
    let signal: AbortSignal | undefined
    let revokeCalls = 0
    const transport: HttpTransport = async (url, input) => {
      if (String(url).endsWith("/refresh")) {
        signal = input?.signal ?? undefined
        entered.resolve(undefined)
        return finish.promise
      }
      revokeCalls += 1
      return Response.json({success: true})
    }
    const auth = new Auth({
      store: new TokenStore({storage}),
      logger: noopLogger,
      baseUrl: "https://core.example.test",
      fetch: transport,
      http: createHttpClient({baseUrl: "https://core.example.test", logger: noopLogger, fetch: transport}),
      config: {core: {subjectToken: "subject", subjectTokenType: "oidc"}, runtime: {source: "core"}},
      timers: {
        ...systemTimers,
        setTimeout: (callback, delayMs) => {
          expect(delayMs).toBe(10_000)
          expire = callback
          return 0
        },
        clearTimeout: () => {},
      },
    })
    const clearing = auth.clearSession()
    await entered.promise
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
    expire()
    await expect(clearing).rejects.toBeInstanceOf(SessionRevocationError)
    expect(signal?.aborted).toBe(true)
    finish.resolve(
      Response.json({access_token: jwt(Math.floor(Date.now() / 1000) + 3600), refresh_token: "late-refresh"}),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(revokeCalls).toBe(0)
    expect(await storage.get(DEFAULT_REFRESH_TOKEN_KEY)).toBeNull()
  })
})
