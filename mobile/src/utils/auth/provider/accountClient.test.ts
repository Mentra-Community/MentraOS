/* eslint-disable import/first -- Jest module mocks must be registered before these imports. */
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://core.example.test", runtime: "wss://runtime.example.test"}),
}))

// accountClient.ts and authClient.ts import each other. The provider overrides
// the methods used by these focused tests, so an extendable stub is sufficient.
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))

import {AccountAuthProvider} from "./accountClient"
import {storage} from "@/utils/storage"
import {isDuplicateSignupError, mapAuthError} from "@/utils/auth/authErrors"

type TestableProvider = {
  performRefresh(refresh: string): Promise<{access: string; refresh: string} | null>
}

describe("AccountAuthProvider signup", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it("preserves the conflict code so signup can offer sign-in instead of verification", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: "email_taken",
        error_description: "This email is already registered. Please sign in.",
      }),
    })
    const result = await new AccountAuthProvider().signUp({email: "returning@example.test", password: "new-password"})
    expect(result.is_error()).toBe(true)
    if (!result.is_error()) throw new Error("Expected a signup conflict")
    expect(result.error).toMatchObject({code: "email_taken"})
    expect(isDuplicateSignupError(result.error)).toBe(true)
    expect(mapAuthError(result.error)).toBe("login:errors.emailAlreadyRegistered")
  })

  it("new signup remains a successful verification flow", async () => {
    fetchMock.mockResolvedValue({ok: true, status: 202, json: async () => ({status: "verification_sent"})})
    const result = await new AccountAuthProvider().signUp({email: "new@example.test", password: "new-password"})
    expect(result.is_ok()).toBe(true)
    if (!result.is_ok()) throw result.error
    expect(result.value).toEqual({session: null, user: null})
  })
})

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
    const confirm = jest.fn(async () => true)
    const result = await provider.completeSignupVerification("provider-token", confirm)
    expect(result.is_ok() && result.value).toBe("signed_in")
    // Another account is signed in, so the person was asked first.
    expect(confirm).toHaveBeenCalledWith({email: verifiedUser.email, current: {email: undefined}})
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
      const confirm = jest.fn(async () => true)
      const result = await provider.completeSignupVerification("provider-token", confirm)
      expect(result.is_error()).toBe(true)
      expect(confirm).not.toHaveBeenCalled()
      expect(stored("mentra.account.accessToken")).toBe("previous-access")
      expect(stored("mentra.account.refreshToken")).toBe("previous-refresh")
      expect(stored("mentra.account.userProfile")).toBe(JSON.stringify({id: "previous-user"}))
      expect(listener).not.toHaveBeenCalled()
    },
  )
})

const storedValue = (key: string) => {
  const result = storage.load<string>(key)
  return result.is_ok() ? (result.value ?? null) : null
}

describe("AccountAuthProvider signup links never switch accounts silently", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()
  const linkAccount = {mentraUserId: "link-user", email: "Link@Example.test", name: "Link account"}
  const response = (status: number, body: unknown) => ({ok: status < 400, status, json: async () => body})
  let provider: AccountAuthProvider
  let listener: jest.Mock
  let unsubscribe: () => void

  const exchangeFor = (me: unknown) => {
    fetchMock
      .mockResolvedValueOnce(response(200, {access_token: "link-access", refresh_token: "link-refresh"}))
      .mockResolvedValueOnce(response(200, me))
  }
  const signInAs = async (profile: {id: string; email?: string}) => {
    storage.save("mentra.account.accessToken", "current-access")
    storage.save("mentra.account.refreshToken", "current-refresh")
    storage.save("mentra.account.userProfile", JSON.stringify(profile))
  }

  beforeEach(async () => {
    storage.clearAll()
    fetchMock.mockReset()
    // Revoking a declined session: /me, then /logout.
    fetchMock.mockResolvedValue(response(200, {}))
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

  it("keeps the signed-in account when the person declines another account's link", async () => {
    await signInAs({id: "victim", email: "victim@example.test"})
    exchangeFor(linkAccount)
    const confirm = jest.fn(async () => false)
    const result = await provider.completeSignupVerification("attacker-provider-token", confirm)
    expect(result.is_ok() && result.value).toBe("declined")
    expect(confirm).toHaveBeenCalledWith({email: linkAccount.email, current: {email: "victim@example.test"}})
    expect(storedValue("mentra.account.accessToken")).toBe("current-access")
    expect(storedValue("mentra.account.refreshToken")).toBe("current-refresh")
    expect(listener).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const urls = fetchMock.mock.calls.map(([url]) => url)
    expect(urls).toContain("https://core.example.test/api/account/logout")
  })

  it("asks a signed-out person whose phone didn't start this sign-up", async () => {
    exchangeFor(linkAccount)
    const confirm = jest.fn(async () => false)
    const result = await provider.completeSignupVerification("attacker-provider-token", confirm)
    expect(result.is_ok() && result.value).toBe("declined")
    expect(confirm).toHaveBeenCalledWith({email: linkAccount.email, current: null})
    expect(storedValue("mentra.account.accessToken")).toBeNull()
    expect(listener).not.toHaveBeenCalled()
  })

  it("asks when this phone signed up with a different email", async () => {
    fetchMock.mockResolvedValueOnce(response(202, {status: "verification_sent"}))
    expect((await provider.signUp({email: "mine@example.test", password: "pw-123456"})).is_ok()).toBe(true)
    exchangeFor(linkAccount)
    const confirm = jest.fn(async () => false)
    await provider.completeSignupVerification("attacker-provider-token", confirm)
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(storedValue("mentra.account.accessToken")).toBeNull()
  })

  it.each(["signUp", "resendSignupEmail"] as const)(
    "signs in without asking when it confirms the sign-up this phone started (%s)",
    async (start) => {
      fetchMock.mockResolvedValueOnce(response(202, {status: "verification_sent"}))
      if (start === "signUp") await provider.signUp({email: " link@example.TEST ", password: "pw-123456"})
      else await provider.resendSignupEmail("link@example.test")
      exchangeFor(linkAccount)
      const confirm = jest.fn(async () => false)
      const result = await provider.completeSignupVerification("provider-token", confirm)
      expect(result.is_ok() && result.value).toBe("signed_in")
      expect(confirm).not.toHaveBeenCalled()
      expect(storedValue("mentra.account.accessToken")).toBe("link-access")
      // The marker is spent: a second link for the same account asks.
      const marker = storage.load<string>("mentra.account.pendingSignupEmail")
      expect(marker.is_ok() ? marker.value : undefined).toBeFalsy()
    },
  )

  it("signs in without asking when the link is for the account already signed in", async () => {
    await signInAs({id: "link-user", email: "link@example.test"})
    exchangeFor(linkAccount)
    const confirm = jest.fn(async () => false)
    const result = await provider.completeSignupVerification("provider-token", confirm)
    expect(result.is_ok() && result.value).toBe("signed_in")
    expect(confirm).not.toHaveBeenCalled()
  })

  it("refuses a link whose account has no email to show", async () => {
    exchangeFor({mentraUserId: "link-user"})
    const confirm = jest.fn(async () => true)
    const result = await provider.completeSignupVerification("provider-token", confirm)
    expect(result.is_error()).toBe(true)
    expect(confirm).not.toHaveBeenCalled()
    expect(storedValue("mentra.account.accessToken")).toBeNull()
  })

  it("has no way to adopt a session handed over in a link", () => {
    expect("updateSessionWithTokens" in provider).toBe(false)
  })
})
