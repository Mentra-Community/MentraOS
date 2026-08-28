import {describe, expect, test} from "bun:test"

import {CloudClient} from "./client"
import {AuthExpiredError, CloudClientError} from "./errors"
import type {CloudClientConfig} from "./config"
import type {CloudClientTransports, WebSocketLike} from "./transports"

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
    expect(cloud.store).toBeUndefined()
    expect(() => cloud.auth.identity).toThrow(AuthExpiredError)
    expect(() => cloud.auth.identity).toThrow("runtime-only mode")
    await expect(cloud.auth.getMiniappToken("com.example.app")).rejects.toThrow("runtime-only mode")
  })

  test("routes Store resources to the independently configured Store endpoint", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    const calls: Array<{url: string; authorization: string | null}> = []
    const http: NonNullable<CloudClientTransports["http"]> = async (input, init) => {
      const headers = new Headers(init?.headers)
      const url = String(input)
      calls.push({url, authorization: headers.get("authorization")})
      if (url.endsWith("/api/client/auth/refresh")) {
        return jsonResponse({
          access_token: accessToken,
          refresh_token: "refresh-2",
          token_type: "Bearer",
          expires_in: 3600,
        })
      }
      return jsonResponse([])
    }

    const accessToken = testJwt({sub: "user-1", oem_id: "oem-1", exp: nowSeconds + 3600})
    const cloud = new CloudClient(
      config({
        endpoints: {
          core: "https://core.example.test",
          store: "https://store.example.test",
          runtime: "https://runtime.example.test",
        },
        auth: {
          core: {accessToken, refreshToken: "refresh-1"},
          runtime: {getToken: async () => "runtime-token"},
        },
        http,
      }),
    )

    expect(await cloud.store?.list()).toEqual([])
    expect(calls).toEqual([
      {
        url: "https://core.example.test/api/client/auth/refresh",
        authorization: null,
      },
      {
        url: "https://store.example.test/api/client/miniapps",
        authorization: `Bearer ${accessToken}`,
      },
    ])
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
})

function config(
  overrides: Pick<CloudClientConfig, "endpoints" | "auth"> & {
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
