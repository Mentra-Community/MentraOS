import {describe, expect, test} from "bun:test"

import {CloudClient} from "./client"
import {AuthExpiredError, CloudClientError, HttpError, SessionRevocationError} from "./errors"
import type {CloudClientConfig} from "./config"
import type {CloudClientTimers} from "./timers"
import type {CloudClientTransports, WebSocketLike} from "./transports"

/** Runs delayed callbacks immediately so retry backoff does not slow tests. */
const immediateTimers: CloudClientTimers = {
  setTimeout: (callback) => {
    callback()
    return 0
  },
  clearTimeout: () => undefined,
  setInterval: () => 0,
  clearInterval: () => undefined,
}

describe("CloudClient construction", () => {
  test("rejects Core auth without a Core endpoint", () => {
    expect(
      () =>
        new CloudClient(
          config({
            endpoints: {runtime: "https://runtime.example.test"},
            auth: {
              core: {subjectToken: "subject", subjectTokenType: "oem-jwt"},
              runtime: {getToken: async () => "runtime-token"},
            },
          }),
        ),
    ).toThrow(CloudClientError)
    expect(
      () =>
        new CloudClient(
          config({
            endpoints: {runtime: "https://runtime.example.test"},
            auth: {
              core: {subjectToken: "subject", subjectTokenType: "oem-jwt"},
              runtime: {getToken: async () => "runtime-token"},
            },
          }),
        ),
    ).toThrow("auth.core requires endpoints.core")
  })

  test("rejects Core-brokered Runtime auth without Core auth and endpoint", () => {
    expect(
      () =>
        new CloudClient(
          config({
            endpoints: {runtime: "https://runtime.example.test"},
            auth: {runtime: {source: "core"}},
          }),
        ),
    ).toThrow("auth.runtime.source='core' requires endpoints.core and auth.core")
  })

  test("constructs runtime-only clients without Core identity or miniapp auto-auth", async () => {
    const cloud = new CloudClient(
      config({
        endpoints: {runtime: "https://runtime.example.test"},
        auth: {runtime: {getToken: async () => "runtime-token"}},
      }),
    )

    expect(cloud.core).toBeUndefined()
    expect(() => cloud.auth.identity).toThrow(AuthExpiredError)
    expect(() => cloud.auth.identity).toThrow("runtime-only mode")
    await expect(cloud.auth.getMiniappToken("com.example.app")).rejects.toThrow("runtime-only mode")
  })

  test("remints miniapp tokens when requested TTL exceeds cached lifetime", async () => {
    const originalFetch = globalThis.fetch
    const nowSeconds = Math.floor(Date.now() / 1000)
    let miniappMints = 0

    globalThis.fetch = (async (input: Request | URL | string) => {
      const url = String(input)
      if (url.endsWith("/api/client/auth/refresh")) {
        return jsonResponse({
          access_token: testJwt({sub: "user-1", oem_id: "oem-1", exp: nowSeconds + 3600}),
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      if (url.endsWith("/api/client/auth/miniapp-token")) {
        miniappMints += 1
        return jsonResponse({
          token: `miniapp-${miniappMints}`,
          expiresAt: miniappMints === 1 ? nowSeconds + 180 : nowSeconds + 3600,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as typeof fetch

    try {
      const cloud = new CloudClient(
        config({
          endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
          auth: {
            core: {
              accessToken: testJwt({sub: "user-1", oem_id: "oem-1", exp: nowSeconds + 3600}),
              refreshToken: "refresh-1",
            },
            runtime: {getToken: async () => "runtime-token"},
          },
        }),
      )

      await expect(cloud.auth.getMiniappToken("com.example.app")).resolves.toMatchObject({
        token: "miniapp-1",
      })
      await expect(cloud.auth.getMiniappToken("com.example.app")).resolves.toMatchObject({
        token: "miniapp-1",
      })
      await expect(cloud.auth.getMiniappToken("com.example.app", {minTtlMs: 5 * 60 * 1000})).resolves.toMatchObject({
        token: "miniapp-2",
      })
      expect(miniappMints).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("uses the configured HTTP transport for refresh and subject exchange", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const storage = memoryStorage({"mentra.cloud-client.refreshToken": "stale-refresh"})
    const calls: string[] = []
    let expiredCalls = 0

    const http: NonNullable<CloudClientTransports["http"]> = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/client/auth/refresh")) {
        return new Response(JSON.stringify({error: "invalid_grant"}), {status: 400})
      }
      if (url.endsWith("/api/client/auth/exchange")) {
        return jsonResponse({
          access_token: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }

    const cloud = new CloudClient(
      config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {
            getSubjectToken: async () => ({token: "fresh-subject", type: "supabase"}),
          },
          runtime: {getToken: async () => "runtime-token"},
        },
        storage,
        http,
      }),
    )
    cloud.auth.onExpired(() => {
      expiredCalls += 1
    })

    await expect(cloud.auth.getCoreToken()).resolves.toBeDefined()
    expect(calls).toEqual([
      "https://core.example.test/api/client/auth/refresh",
      "https://core.example.test/api/client/auth/exchange",
    ])
    expect(expiredCalls).toBe(0)
    expect(await storage.get("mentra.cloud-client.refreshToken")).toBe("refresh-2")
  })

  test("isolates persisted sessions by deployment and revokes before logout", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const storage = memoryStorage()
    const calls: string[] = []
    const http: NonNullable<CloudClientTransports["http"]> = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith("/api/client/auth/refresh")) {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "workspace-refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      if (url.endsWith("/api/client/auth/revoke")) return jsonResponse({success: true})
      throw new Error(`unexpected fetch: ${url}`)
    }
    const accessToken = testJwt({
      sub: "user-1",
      tenant_id: "workspace-1",
      exp: nowSeconds + 3600,
    })
    const cloud = new CloudClient({
      ...config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {accessToken, refreshToken: "workspace-refresh"},
          runtime: {source: "core"},
        },
        storage,
        http,
      }),
      authStorageKey: "mentra.cloud-client.workspace-1.refreshToken",
    })

    await cloud.auth.getCoreToken()
    expect(await storage.get("mentra.cloud-client.workspace-1.refreshToken")).toBe("workspace-refresh-2")
    expect(await storage.get("mentra.cloud-client.refreshToken")).toBeNull()

    await cloud.auth.clearSession()
    expect(calls).toEqual([
      "https://core.example.test/api/client/auth/refresh",
      "https://core.example.test/api/client/auth/revoke",
    ])
    expect(await storage.get("mentra.cloud-client.workspace-1.refreshToken")).toBeNull()
  })

  test("logout without local credentials does not acquire a fresh subject token", async () => {
    let subjectRequests = 0
    let networkRequests = 0
    const cloud = new CloudClient(
      config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {
            getSubjectToken: async () => {
              subjectRequests += 1
              return {token: "fresh-subject", type: "oidc"}
            },
          },
          runtime: {source: "core"},
        },
        http: async () => {
          networkRequests += 1
          throw new Error("network must not be called")
        },
      }),
    )

    await expect(cloud.auth.clearSession()).resolves.toBeUndefined()
    expect(subjectRequests).toBe(0)
    expect(networkRequests).toBe(0)
    await expect(cloud.auth.getCoreToken()).rejects.toThrow("auth session was cleared")
  })

  test("logout clears local credentials and surfaces Core revocation failure after bounded retries", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const key = "mentra.cloud-client.workspace-1.refreshToken"
    const storage = memoryStorage({[key]: "refresh-1"})
    let revokeCalls = 0
    const cloud = new CloudClient({
      ...config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {subjectToken: "subject", subjectTokenType: "oidc"},
          runtime: {source: "core"},
        },
        storage,
        timers: immediateTimers,
        http: async (input) => {
          const url = String(input)
          if (url.endsWith("/api/client/auth/refresh")) {
            return jsonResponse({
              access_token: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
            })
          }
          if (url.endsWith("/api/client/auth/revoke")) {
            revokeCalls += 1
            return new Response("unavailable", {status: 503})
          }
          throw new Error(`unexpected fetch: ${url}`)
        },
      }),
      authStorageKey: key,
    })

    const failure = await cloud.auth.clearSession().catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(SessionRevocationError)
    expect((failure as SessionRevocationError).cause).toBeInstanceOf(HttpError)
    expect(revokeCalls).toBe(3)
    expect(await storage.get(key)).toBeNull()
    await expect(cloud.auth.getRuntimeToken()).rejects.toThrow("auth session was cleared")
  })

  test("logout retries a transient revoke failure and completes once Core confirms", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const key = "mentra.cloud-client.workspace-1.refreshToken"
    const storage = memoryStorage({[key]: "refresh-1"})
    let revokeCalls = 0
    const cloud = new CloudClient({
      ...config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {
            accessToken: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
            refreshToken: "refresh-1",
          },
          runtime: {source: "core"},
        },
        storage,
        timers: immediateTimers,
        http: async (input) => {
          const url = String(input)
          if (url.endsWith("/api/client/auth/refresh")) {
            return jsonResponse({
              access_token: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
            })
          }
          if (url.endsWith("/api/client/auth/revoke")) {
            revokeCalls += 1
            if (revokeCalls === 1) throw new Error("connection reset")
            if (revokeCalls === 2) return new Response("bad gateway", {status: 502})
            return jsonResponse({success: true})
          }
          throw new Error(`unexpected fetch: ${url}`)
        },
      }),
      authStorageKey: key,
    })

    await cloud.auth.getCoreToken()
    await expect(cloud.auth.clearSession()).resolves.toBeUndefined()
    expect(revokeCalls).toBe(3)
    expect(await storage.get(key)).toBeNull()
  })

  test("logout does not retry a definite Core rejection of the revoke", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const key = "mentra.cloud-client.workspace-1.refreshToken"
    const storage = memoryStorage({[key]: "refresh-1"})
    let revokeCalls = 0
    const cloud = new CloudClient({
      ...config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {
            accessToken: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
            refreshToken: "refresh-1",
          },
          runtime: {source: "core"},
        },
        storage,
        timers: immediateTimers,
        http: async (input) => {
          const url = String(input)
          if (url.endsWith("/api/client/auth/refresh")) {
            return jsonResponse({
              access_token: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
            })
          }
          if (url.endsWith("/api/client/auth/revoke")) {
            revokeCalls += 1
            return new Response("forbidden", {status: 403})
          }
          throw new Error(`unexpected fetch: ${url}`)
        },
      }),
      authStorageKey: key,
    })

    await cloud.auth.getCoreToken()
    await expect(cloud.auth.clearSession()).rejects.toBeInstanceOf(SessionRevocationError)
    expect(revokeCalls).toBe(1)
    expect(await storage.get(key)).toBeNull()
  })

  test("logout refreshes an access token inside the expiry margin before revoking", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const key = "mentra.cloud-client.workspace-1.refreshToken"
    const storage = memoryStorage()
    const calls: string[] = []
    const bearers: string[] = []
    const nearExpiry = testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 30})
    const fresh = testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600})
    const cloud = new CloudClient({
      ...config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {accessToken: nearExpiry, refreshToken: "refresh-1"},
          runtime: {source: "core"},
        },
        storage,
        http: async (input, init) => {
          const url = String(input)
          calls.push(url)
          if (url.endsWith("/api/client/auth/refresh")) {
            // The first refresh (from getCoreToken) hands back a token that is
            // itself inside the margin; the logout refresh hands back a fresh one.
            return jsonResponse({
              access_token: calls.filter((call) => call.endsWith("/refresh")).length === 1 ? nearExpiry : fresh,
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
            })
          }
          if (url.endsWith("/api/client/auth/revoke")) {
            bearers.push(String((init?.headers as Record<string, string> | undefined)?.Authorization))
            return jsonResponse({success: true})
          }
          throw new Error(`unexpected fetch: ${url}`)
        },
      }),
      authStorageKey: key,
    })

    await cloud.auth.getCoreToken()
    await expect(cloud.auth.clearSession()).resolves.toBeUndefined()
    expect(calls).toEqual([
      "https://core.example.test/api/client/auth/refresh",
      "https://core.example.test/api/client/auth/refresh",
      "https://core.example.test/api/client/auth/revoke",
    ])
    expect(bearers).toEqual([`Bearer ${fresh}`])
    expect(await storage.get(key)).toBeNull()
  })

  test("an in-flight exchange cannot restore credentials after logout", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const storage = memoryStorage()
    let finishExchange!: (response: Response) => void
    const exchangeResponse = new Promise<Response>((resolve) => {
      finishExchange = resolve
    })
    const cloud = new CloudClient(
      config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {subjectToken: "subject", subjectTokenType: "oidc"},
          runtime: {source: "core"},
        },
        storage,
        http: async (input) => {
          if (String(input).endsWith("/api/client/auth/exchange")) return exchangeResponse
          throw new Error(`unexpected fetch: ${String(input)}`)
        },
      }),
    )

    const inFlight = cloud.auth.getCoreToken()
    await Promise.resolve()
    await cloud.auth.clearSession()
    finishExchange(
      jsonResponse({
        access_token: testJwt({sub: "user-1", tenant_id: "tenant-1", exp: nowSeconds + 3600}),
        refresh_token: "late-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    )

    await expect(inFlight).rejects.toThrow("auth session was cleared")
    expect(await storage.get("mentra.cloud-client.refreshToken")).toBeNull()
  })
})

describe("Core-brokered Runtime token retries", () => {
  function photoClient(
    mintToken: () => Promise<Response>,
    allocatePhoto = async () =>
      jsonResponse({requestId: "photo-1", uploadUrl: "https://upload", readUrl: "https://read"}),
  ) {
    const calls: string[] = []
    const delays: number[] = []
    const coreToken = testJwt({sub: "user-1", tenant_id: "tenant-1", exp: Math.floor(Date.now() / 1000) + 3600})
    const cloud = new CloudClient(
      config({
        endpoints: {core: "https://core.example.test", runtime: "https://runtime.example.test"},
        auth: {
          core: {accessToken: coreToken, refreshToken: "refresh-1"},
          runtime: {source: "core"},
        },
        timers: {
          ...immediateTimers,
          setTimeout(callback, delayMs) {
            delays.push(delayMs)
            callback()
            return 0
          },
        },
        http: async (input, init) => {
          const path = new URL(String(input)).pathname
          calls.push(path)
          if (path === "/api/client/auth/refresh") {
            return jsonResponse({
              access_token: coreToken,
              refresh_token: "refresh-2",
              token_type: "Bearer",
              expires_in: 3600,
            })
          }
          if (path === "/api/client/auth/runtime-token") {
            expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${coreToken}`)
            return mintToken()
          }
          if (path === "/api/camera/photo") {
            expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer runtime-token")
            return allocatePhoto()
          }
          throw new Error(`unexpected fetch: ${path}`)
        },
      }),
    )
    return {cloud, calls, delays}
  }

  function mintedToken() {
    return jsonResponse({access_token: "runtime-token", token_type: "Bearer", expires_in: 3600})
  }

  test("recovers a photo from a transient token transport failure and caches the token for the next photo", async () => {
    let attempts = 0
    const {cloud, calls, delays} = photoClient(async () => {
      if (++attempts === 1) throw new TypeError("Network request failed")
      return mintedToken()
    })

    await expect(cloud.runtime.startManagedPhoto()).resolves.toMatchObject({requestId: "photo-1"})
    await expect(cloud.runtime.startManagedPhoto()).resolves.toMatchObject({requestId: "photo-1"})
    expect(calls).toEqual([
      "/api/client/auth/refresh",
      "/api/client/auth/runtime-token",
      "/api/client/auth/runtime-token",
      "/api/camera/photo",
      "/api/camera/photo",
    ])
    expect(delays).toEqual([250])
  })

  test("concurrent callers share one token retry sequence", async () => {
    let attempts = 0
    const {cloud, delays} = photoClient(async () => {
      if (++attempts < 3) throw new TypeError("Network request failed")
      return mintedToken()
    })

    await expect(Promise.all([cloud.auth.getRuntimeToken(), cloud.auth.getRuntimeToken()])).resolves.toEqual([
      "runtime-token",
      "runtime-token",
    ])
    expect(attempts).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  test("exhaustion preserves the network error without allocating a photo and allows a later request", async () => {
    let offline = true
    let attempts = 0
    const {cloud, calls, delays} = photoClient(async () => {
      attempts += 1
      if (offline) throw new TypeError("Network request failed")
      return mintedToken()
    })

    const error = await cloud.runtime.startManagedPhoto().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({status: 0, code: "NETWORK_ERROR"})
    expect(attempts).toBe(3)
    expect(delays).toEqual([250, 500])
    expect(calls).not.toContain("/api/camera/photo")

    offline = false
    await expect(cloud.runtime.startManagedPhoto()).resolves.toMatchObject({requestId: "photo-1"})
    expect(attempts).toBe(4)
  })

  test.each([401, 403, 503])("does not retry a definite HTTP %i token response", async (status) => {
    let attempts = 0
    const {cloud, calls, delays} = photoClient(async () => {
      attempts += 1
      return new Response(JSON.stringify({code: "TOKEN_REJECTED"}), {status})
    })

    const error = await cloud.runtime.startManagedPhoto().catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(HttpError)
    expect(error).toMatchObject({status, code: "TOKEN_REJECTED"})
    expect(attempts).toBe(1)
    expect(delays).toEqual([])
    expect(calls).not.toContain("/api/camera/photo")
  })

  test("does not retry the non-idempotent photo allocation POST", async () => {
    let allocations = 0
    const {cloud, delays} = photoClient(
      async () => mintedToken(),
      async () => {
        allocations += 1
        throw new TypeError("Network request failed")
      },
    )

    await expect(cloud.runtime.startManagedPhoto()).rejects.toMatchObject({status: 0, code: "NETWORK_ERROR"})
    expect(allocations).toBe(1)
    expect(delays).toEqual([])
  })
})

function config(
  overrides: Pick<CloudClientConfig, "endpoints" | "auth" | "timers"> & {
    storage?: CloudClientTransports["storage"]
    http?: CloudClientTransports["http"]
  },
): CloudClientConfig {
  const {storage, http, ...clientOverrides} = overrides
  return {
    ...clientOverrides,
    transports: dummyTransports(storage, http),
  }
}

function dummyTransports(
  storage: CloudClientTransports["storage"] = memoryStorage(),
  http?: CloudClientTransports["http"],
): CloudClientTransports {
  return {
    ws: () => dummyWs(),
    udp: () => ({
      send: () => undefined,
      onMessage: () => undefined,
      close: () => undefined,
    }),
    storage,
    http,
  }
}

function memoryStorage(initial: Record<string, string> = {}): CloudClientTransports["storage"] {
  const values = new Map(Object.entries(initial))
  return {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value)
    },
    delete: async (key: string) => {
      values.delete(key)
    },
  }
}

function dummyWs(): WebSocketLike {
  return {
    send: () => undefined,
    sendBinary: () => undefined,
    close: () => undefined,
    onOpen: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {"Content-Type": "application/json"},
  })
}

function testJwt(claims: Record<string, unknown>): string {
  return [base64UrlJson({alg: "none", typ: "JWT"}), base64UrlJson(claims), "signature"].join(".")
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}
