/* eslint-disable import/first -- Jest module mocks must be registered before these imports. */
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://core.example.test", runtime: "wss://runtime.example.test"}),
}))

// accountClient.ts and authClient.ts import each other. The provider overrides
// the methods used by these focused tests, so an extendable stub is sufficient.
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))

import {AccountAuthProvider} from "./accountClient"
import {storage} from "@/utils/storage"

type TestableProvider = {
  performRefresh(refresh: string): Promise<{access: string; refresh: string} | null>
}

describe("AccountAuthProvider refresh requests", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()
  let provider: TestableProvider

  beforeEach(() => {
    storage.clearAll()
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    provider = new AccountAuthProvider() as unknown as TestableProvider
  })

  afterAll(() => {
    global.fetch = originalFetch
  })

  it("sends the form body as a string for React Native fetch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({access_token: "new-access", refresh_token: "new-refresh"}),
    })

    await expect(provider.performRefresh("old-refresh")).resolves.toEqual({
      access: "new-access",
      refresh: "new-refresh",
    })
    expect(fetchMock).toHaveBeenCalledWith(
      "https://core.example.test/api/client/auth/refresh",
      expect.objectContaining({
        headers: {"content-type": "application/x-www-form-urlencoded"},
        body: "grant_type=refresh_token&refresh_token=old-refresh",
      }),
    )
  })

  it("does not treat a malformed refresh request as an expired session", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({error: "unsupported_grant_type"}),
    })

    await expect(provider.performRefresh("still-live")).rejects.toThrow(
      "refresh failed without rejecting session: HTTP 400 (unsupported_grant_type)",
    )
  })

  it("returns null for an actual invalid_grant", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({error: "invalid_grant"}),
    })

    await expect(provider.performRefresh("dead-refresh")).resolves.toBeNull()
  })
})

describe("AccountAuthProvider signup verification", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()
  const verifiedUser = {mentraUserId: "new-user", email: "new@example.test", name: "New account"}
  let provider: AccountAuthProvider
  let listener: jest.Mock
  let unsubscribe: () => void

  const stored = (key: string) => {
    const result = storage.load(key)
    if (result.is_error()) throw result.error
    return result.value
  }

  const response = (status: number, body: unknown) => ({ok: status < 400, status, json: async () => body})

  beforeEach(() => {
    storage.clearAll()
    storage.save("mentra.account.accessToken", "previous-access")
    storage.save("mentra.account.refreshToken", "previous-refresh")
    storage.save("mentra.account.userProfile", JSON.stringify({id: "previous-user"}))
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
    provider = new AccountAuthProvider()
    listener = jest.fn()
    const sub = provider.onAuthStateChange(listener)
    if (sub.is_error()) throw sub.error
    unsubscribe = sub.value.unsubscribe
  })

  afterEach(() => {
    unsubscribe()
    global.fetch = originalFetch
  })

  it("exchanges the provider token and publishes the new account before resolving", async () => {
    fetchMock
      .mockResolvedValueOnce(response(200, {access_token: "mentra-access", refresh_token: "mentra-refresh"}))
      .mockResolvedValueOnce(response(200, verifiedUser))
    const result = await provider.completeSignupVerification("provider-token")
    expect(result.is_ok()).toBe(true)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url).toBe("https://core.example.test/api/client/auth/exchange")
    expect(request.headers).toEqual({"content-type": "application/x-www-form-urlencoded"})
    expect(typeof request.body).toBe("string")
    expect(Object.fromEntries(new URLSearchParams(request.body))).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
      subject_token: "provider-token",
    })
    expect(fetchMock.mock.calls[1]).toEqual([
      "https://core.example.test/api/account/me",
      {headers: {authorization: "Bearer mentra-access"}},
    ])
    expect(stored("mentra.account.accessToken")).toBe("mentra-access")
    expect(stored("mentra.account.refreshToken")).toBe("mentra-refresh")
    expect(listener).toHaveBeenCalledWith("SIGNED_IN", {
      token: "mentra-access",
      user: {id: "new-user", email: verifiedUser.email, name: verifiedUser.name},
    })
  })

  it.each(["rejected", "network", "missing tokens", "profile rejected", "profile unavailable", "missing account"])(
    "preserves the previous account and emits no sign-in when %s",
    async (failure) => {
      if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"))
      else if (failure === "rejected") fetchMock.mockResolvedValueOnce(response(400, {error: "invalid_grant"}))
      else if (failure === "missing tokens") fetchMock.mockResolvedValueOnce(response(200, {}))
      else {
        fetchMock.mockResolvedValueOnce(response(200, {access_token: "mentra-access", refresh_token: "mentra-refresh"}))
        if (failure === "profile unavailable") fetchMock.mockRejectedValueOnce(new Error("offline"))
        else fetchMock.mockResolvedValueOnce(response(failure === "profile rejected" ? 403 : 200, {}))
      }
      const result = await provider.completeSignupVerification("provider-token")
      expect(result.is_error()).toBe(true)
      expect(stored("mentra.account.accessToken")).toBe("previous-access")
      expect(stored("mentra.account.refreshToken")).toBe("previous-refresh")
      expect(stored("mentra.account.userProfile")).toBe(JSON.stringify({id: "previous-user"}))
      expect(listener).not.toHaveBeenCalled()
    },
  )
})
