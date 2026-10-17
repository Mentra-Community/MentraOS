/* eslint-disable import/first -- Register module mocks before importing the actual observer. */
jest.mock("@/utils/auth/pkce", () => ({randomUrlSafe: jest.fn(() => "abcdefghijklmnopqrstuv")}))

import {randomUrlSafe} from "@/utils/auth/pkce"
import {
  ACCOUNT_LOGIN_FAILURE_MARKER,
  ACCOUNT_ENDPOINT_MARKER,
  beginAccountLoginObservation,
  recordAccountLoginFailure,
  recordAccountEndpointResolution,
} from "./accountLoginObservation"

describe("account login failure observation", () => {
  let warn: jest.SpyInstance

  beforeEach(() => {
    jest.mocked(randomUrlSafe).mockReset().mockReturnValue("abcdefghijklmnopqrstuv")
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    jest.spyOn(Date, "now").mockReturnValue(1000)
  })

  afterEach(() => jest.restoreAllMocks())

  const receipt = () => {
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toHaveLength(1)
    const line = warn.mock.calls[0][0] as string
    expect(line.startsWith(ACCOUNT_LOGIN_FAILURE_MARKER)).toBe(true)
    return JSON.parse(line.slice(ACCOUNT_LOGIN_FAILURE_MARKER.length))
  }

  it("retains non-enumerable native Error facts without serializing the error", () => {
    const error = new TypeError("Network request failed")
    expect(JSON.stringify(error)).toBe("{}")
    const observation = beginAccountLoginObservation()
    jest.mocked(Date.now).mockReturnValue(1250)
    recordAccountLoginFailure(observation, "fetch", null, error)
    expect(receipt()).toEqual({
      schemaVersion: 1,
      method: "POST",
      route: "/api/account/login",
      requestId: "abcdefghijklmnopqrstuv",
      startedAtMs: 1000,
      observedAtMs: 1250,
      elapsedMs: 250,
      phase: "fetch",
      status: null,
      category: "network",
      errorName: "TypeError",
    })
  })

  it.each([
    ["Unable to resolve host private.example", "dns"],
    ["ECONNREFUSED private.example", "connect"],
    ["SSLHandshakeException private.example", "tls"],
    ["Request timed out", "timeout"],
    ["Network request failed", "network"],
    ["Something failed", "other"],
  ])("selects only a fixed category from %s", (message, expected) => {
    recordAccountLoginFailure(beginAccountLoginObservation(), "fetch", null, new TypeError(message))
    expect(receipt().category).toBe(expected)
    expect(warn.mock.calls[0][0]).not.toContain(message)
  })

  it("never records arbitrary error fields, user data, URLs or server bodies", () => {
    const error = Object.assign(new Error("email=private@example.test password=secret https://private/token"), {
      name: "private@example.test",
      code: "secret-token",
      cause: {authorization: "Bearer secret"},
      body: {email: "private@example.test", access_token: "secret-token"},
      toJSON: () => {
        throw new Error("must not serialize Error")
      },
    })
    recordAccountLoginFailure(beginAccountLoginObservation(), "http", 503, error)
    expect(receipt()).toMatchObject({category: "http", status: 503, errorName: "unknown"})
    const line = warn.mock.calls[0][0] as string
    for (const forbidden of ["private", "secret", "Bearer", "password", "access_token", "authorization", "https://"])
      expect(line).not.toContain(forbidden)
    expect(line.length).toBeLessThan(600)
  })

  it("fails closed on unknown errors, throwing getters and invalid timing/status", () => {
    const error = Object.defineProperties(
      {},
      {
        name: {
          get() {
            throw new Error("private")
          },
        },
        message: {
          get() {
            throw new Error("private")
          },
        },
      },
    )
    const observation = beginAccountLoginObservation()
    jest.mocked(Date.now).mockReturnValue(999)
    recordAccountLoginFailure(observation, "fetch", 0, error)
    expect(receipt()).toMatchObject({category: "other", errorName: "unknown", elapsedMs: null, status: null})
  })

  it("keeps missing randomness and clock explicit without throwing", () => {
    jest.mocked(randomUrlSafe).mockImplementation(() => {
      throw new Error("randomness unavailable")
    })
    jest.mocked(Date.now).mockImplementation(() => {
      throw new Error("clock unavailable")
    })
    const observation = beginAccountLoginObservation()
    expect(observation).toEqual({requestId: null, startedAtMs: null})
    expect(() => recordAccountLoginFailure(observation, "fetch", null, new Error("offline"))).not.toThrow()
    expect(receipt()).toMatchObject({requestId: null, startedAtMs: null, observedAtMs: null, elapsedMs: null})
  })

  it("contains a failing diagnostic sink", () => {
    warn.mockImplementation(() => {
      throw new Error("sink unavailable")
    })
    expect(() =>
      recordAccountLoginFailure(beginAccountLoginObservation(), "fetch", null, new Error("offline")),
    ).not.toThrow()
  })
})

it("projects endpoint snapshots without serializing an extended object or arbitrary data", () => {
  const info = jest.spyOn(console, "info").mockImplementation(() => {})
  try {
    const endpoint = {
      activeDeployment: "consumer",
      origin: "custom",
      provenance: "override",
      overrideScope: "scoped",
      url: "https://private.example/secret",
      name: "private",
      toJSON: () => {
        throw Error("must not serialize")
      },
    } as const
    recordAccountEndpointResolution("provider-initialization", endpoint)
    recordAccountEndpointResolution("password-request", endpoint, "abcdefghijklmnopqrstuv")
    const rows = info.mock.calls.map(([line]) => JSON.parse(line.slice(ACCOUNT_ENDPOINT_MARKER.length)))
    expect(rows[0]).toMatchObject({phase: "provider-initialization", requestId: null})
    expect(rows[1]).toMatchObject({phase: "password-request", requestId: "abcdefghijklmnopqrstuv"})
    expect(JSON.stringify(rows)).not.toMatch(/private|secret|https|toJSON|url/)
    expect(Object.keys(rows[0]).sort()).toEqual(
      [
        "schemaVersion",
        "phase",
        "requestId",
        "observedAtMs",
        "activeDeployment",
        "origin",
        "provenance",
        "overrideScope",
      ].sort(),
    )
    info.mockImplementation(() => {
      throw Error("sink unavailable")
    })
    expect(() => recordAccountEndpointResolution("password-request", endpoint)).not.toThrow()
  } finally {
    info.mockRestore()
  }
})

it("refuses malformed endpoint facts instead of publishing arbitrary enum or request fields", () => {
  const info = jest.spyOn(console, "info").mockImplementation(() => {})
  try {
    const endpoint = {
      activeDeployment: "consumer",
      origin: "custom",
      provenance: "override",
      overrideScope: "scoped",
    } as const
    for (const key of Object.keys(endpoint)) {
      recordAccountEndpointResolution("password-request", {...endpoint, [key]: "private-secret"} as typeof endpoint)
    }
    recordAccountEndpointResolution("password-request", endpoint, "private@example.test")
    recordAccountEndpointResolution(
      "provider-initialization",
      Object.defineProperty({}, "origin", {
        get() {
          throw Error("private")
        },
      }) as typeof endpoint,
    )
    expect(info).not.toHaveBeenCalled()
  } finally {
    info.mockRestore()
  }
})

it("preserves the single marker verbatim through the existing incident phone ring", () => {
  const original = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }
  const nativeWarn = jest.fn()
  console.warn = nativeWarn
  try {
    const {logBuffer} = jest.requireActual(
      "../../../../modules/engine/src/utils/devLogging",
    ) as typeof import("../../../../modules/engine/src/utils/devLogging")
    logBuffer.clear()
    logBuffer.startConsoleInterception()
    recordAccountLoginFailure(beginAccountLoginObservation(), "fetch", null, new TypeError("Network request failed"))
    const line = nativeWarn.mock.calls[0][0]
    expect(logBuffer.getRecentLogs()).toEqual([
      expect.objectContaining({level: "warn", source: "console", message: line}),
    ])
    expect(JSON.parse(line.slice(ACCOUNT_LOGIN_FAILURE_MARKER.length))).toMatchObject({
      category: "network",
      errorName: "TypeError",
    })
    logBuffer.clear()
  } finally {
    Object.assign(console, original)
  }
})
