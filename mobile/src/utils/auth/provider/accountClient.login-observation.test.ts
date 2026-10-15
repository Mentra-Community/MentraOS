/* eslint-disable import/first -- Register module mocks before importing the actual provider. */
jest.mock("@/services/cloudClient", () => ({resolvedEndpoints: () => ({core: "https://core.example.test"})}))
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))
jest.mock("@/utils/auth/pkce", () => ({randomUrlSafe: jest.fn(() => "abcdefghijklmnopqrstuv")}))
jest.mock("@mentra/engine", () => ({BgTimer: {}}))
jest.mock("@/services/deployment", () => ({deploymentStore: {getActive: () => ({kind: "consumer"})}}))

import {result as Res} from "typesafe-ts"
import {randomUrlSafe} from "@/utils/auth/pkce"
import {storage} from "@/utils/storage"
import {AccountAuthProvider} from "./accountClient"
import {ACCOUNT_LOGIN_FAILURE_MARKER} from "./accountLoginObservation"

describe("AccountAuthProvider password failure evidence", () => {
  const originalFetch = global.fetch
  const credentials = {email: "private@example.test", password: "private-password"}
  const fetchMock = jest.fn()
  let provider: AccountAuthProvider
  let warn: jest.SpyInstance

  beforeEach(() => {
    storage.clearAll()
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    jest.mocked(randomUrlSafe).mockReset().mockReturnValue("abcdefghijklmnopqrstuv")
    warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    provider = new AccountAuthProvider()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  const receipt = () => {
    expect(warn).toHaveBeenCalledTimes(1)
    return JSON.parse((warn.mock.calls[0][0] as string).slice(ACCOUNT_LOGIN_FAILURE_MARKER.length))
  }

  it("correlates the original single POST failure without changing its error or body", async () => {
    const error = new TypeError("Network request failed")
    fetchMock.mockRejectedValue(error)
    const result = await provider.signInWithPassword(credentials)
    expect(result.is_error()).toBe(true)
    if (!result.is_error()) throw new Error("Expected original failure")
    expect(result.error).toBe(error)
    expect(fetchMock.mock.calls).toEqual([
      [
        "https://core.example.test/api/account/login",
        {
          method: "POST",
          headers: {"content-type": "application/json", "x-request-id": "abcdefghijklmnopqrstuv"},
          body: JSON.stringify(credentials),
        },
      ],
    ])
    expect(receipt()).toMatchObject({
      requestId: "abcdefghijklmnopqrstuv",
      phase: "fetch",
      status: null,
      category: "network",
    })
    expect(warn.mock.calls[0][0]).not.toContain("private")
  })

  it("records HTTP failure status without copying the returned body or changing error mapping", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({error: "service_unavailable", error_description: "private server detail"}),
    })
    const result = await provider.signInWithPassword(credentials)
    expect(result.is_error()).toBe(true)
    if (!result.is_error()) throw new Error("Expected original HTTP failure")
    expect(result.error).toMatchObject({message: "private server detail", code: "service_unavailable"})
    expect(receipt()).toMatchObject({phase: "http", status: 503, category: "http"})
    expect(warn.mock.calls[0][0]).not.toContain("private")
    expect(warn.mock.calls[0][0]).not.toContain("service_unavailable")
  })

  it("distinguishes malformed response JSON from a failed request", async () => {
    const error = new SyntaxError("private malformed token body")
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw error
      },
    })
    const result = await provider.signInWithPassword(credentials)
    if (!result.is_error()) throw new Error("Expected original parse failure")
    expect(result.error).toBe(error)
    expect(receipt()).toMatchObject({
      phase: "response-json",
      status: 200,
      category: "response-json",
      errorName: "SyntaxError",
    })
    expect(warn.mock.calls[0][0]).not.toContain("private")
  })

  it("preserves the existing successful session and emits no failure marker", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({access_token: "new-access", refresh_token: "new-refresh"}),
    })
    jest.spyOn(provider, "getSession").mockResolvedValue(Res.ok({token: "new-access", user: {id: "test", name: "Test"}}))
    const listener = jest.fn()
    const subscription = provider.onAuthStateChange(listener)
    if (!subscription.is_ok()) throw subscription.error
    try {
      const result = await provider.signInWithPassword(credentials)
      expect(result.is_ok()).toBe(true)
      if (!result.is_ok()) throw result.error
      expect(result.value).toEqual({
        session: {token: "new-access", user: {id: "test", name: "Test"}},
        user: {id: "test", name: "Test"},
      })
      expect(listener).toHaveBeenCalledWith("SIGNED_IN", result.value.session)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      subscription.value.unsubscribe()
    }
  })

  it("preserves a session-lifetime refusal after the successful HTTP response", async () => {
    const error = new Error("auth session was cleared")
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({access_token: "new-access", refresh_token: "new-refresh"}),
    })
    jest.spyOn(provider, "getSession").mockRejectedValue(error)
    const result = await provider.signInWithPassword(credentials)
    if (!result.is_error()) throw new Error("Expected original session failure")
    expect(result.error).toBe(error)
    expect(receipt()).toMatchObject({phase: "session", status: 200, category: "other"})
  })

  it("still submits once when diagnostic preparation and logging fail", async () => {
    const error = new TypeError("Network request failed")
    jest.mocked(randomUrlSafe).mockImplementation(() => {
      throw new Error("randomness unavailable")
    })
    warn.mockImplementation(() => {
      throw new Error("sink unavailable")
    })
    fetchMock.mockRejectedValue(error)
    const result = await provider.signInWithPassword(credentials)
    if (!result.is_error()) throw new Error("Expected original failure")
    expect(result.error).toBe(error)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][1].headers).toEqual({"content-type": "application/json"})
  })
})
