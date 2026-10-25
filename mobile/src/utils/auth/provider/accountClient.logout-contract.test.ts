/* eslint-disable import/first -- Register module mocks before importing the actual provider. */
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://core.example.test", runtime: "wss://runtime.example.test"}),
}))
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))
jest.mock("@/services/deployment", () => ({deploymentStore: {getActive: () => ({kind: "consumer"})}}))
jest.mock("@mentra/engine", () => ({
  BgTimer: {
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
  },
}))

import {AccountAuthProvider} from "./accountClient"
import {storage} from "@/utils/storage"
import {accountCredentials} from "@/utils/auth/accountCredentials"
import {resetAccountCredentials, storedCredential} from "@/test-utils/accountCredentials"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return {promise, resolve}
}

const response = (status: number, body: unknown = {}) => ({
  ok: status < 400,
  status,
  json: async () => body,
})
const user = {mentraUserId: "account-1", email: "account@example.test"}
const ACCESS = "mentra.account.accessToken"
const REFRESH = "mentra.account.refreshToken"
const PROFILE = "mentra.account.userProfile"

describe("AccountAuthProvider logout completion", () => {
  const originalFetch = global.fetch
  const fetchMock = jest.fn()

  beforeEach(async () => {
    storage.clearAll()
    await resetAccountCredentials()
    await accountCredentials.set(ACCESS, "access-1")
    await accountCredentials.set(REFRESH, "refresh-1")
    storage.save(PROFILE, JSON.stringify({id: user.mentraUserId, email: user.email}))
    fetchMock.mockReset()
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it.each(["probe", "revoke"])("a fresh provider stays signed out while remote %s is pending", async (stage) => {
    const entered = deferred<void>()
    const finish = deferred<ReturnType<typeof response>>()
    let gated = false
    fetchMock.mockImplementation(async (url: string) => {
      const target = stage === "probe" ? "/api/account/me" : "/api/account/logout"
      if (!gated && url.endsWith(target)) {
        gated = true
        entered.resolve(undefined)
        return finish.promise
      }
      return response(200, url.endsWith("/me") ? user : {})
    })

    const signingOut = new AccountAuthProvider().signOut()
    await entered.promise
    // A new provider reads the same persisted storage, as a cold process does.
    const freshSession = await new AccountAuthProvider().getSession()
    expect(freshSession.is_ok()).toBe(true)
    if (freshSession.is_error()) throw freshSession.error
    expect(freshSession.value).toEqual({token: undefined})
    expect(await storedCredential(REFRESH)).toBeNull()

    finish.resolve(response(200, stage === "probe" ? user : {}))
    expect((await signingOut).is_ok()).toBe(true)
    const after = await new AccountAuthProvider().getSession()
    expect(after.is_ok()).toBe(true)
    if (after.is_error()) throw after.error
    expect(after.value).toEqual({token: undefined})
    expect(await storedCredential(ACCESS)).toBeNull()
    expect(await storedCredential(REFRESH)).toBeNull()
  })

  it("an earlier session read cannot return a signed-in user after signOut completed", async () => {
    const entered = deferred<void>()
    const finish = deferred<ReturnType<typeof response>>()
    let first = true
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/me") && first) {
        first = false
        entered.resolve(undefined)
        return finish.promise
      }
      return response(200, url.endsWith("/me") ? user : {})
    })

    const provider = new AccountAuthProvider()
    const oldSession = provider.getSession()
    await entered.promise
    expect((await provider.signOut()).is_ok()).toBe(true)
    expect(await storedCredential(ACCESS)).toBeNull()
    finish.resolve(response(200, user))
    const stale = await oldSession
    expect(stale.is_error()).toBe(true)
    expect(storage.load(PROFILE).is_error()).toBe(true)
    expect(await storedCredential(ACCESS)).toBeNull()
    expect(await storedCredential(REFRESH)).toBeNull()
  })

  it("an already in-flight refresh cannot repersist tokens after signOut completed", async () => {
    const entered = deferred<void>()
    const finish = deferred<ReturnType<typeof response>>()
    let firstProbe = true
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/me") && firstProbe) {
        firstProbe = false
        return response(401, {error: "invalid_grant"})
      }
      if (url.endsWith("/refresh")) {
        entered.resolve(undefined)
        return finish.promise
      }
      return response(200, url.endsWith("/me") ? user : {})
    })
    const provider = new AccountAuthProvider()
    const refreshingSession = provider.getSession()
    await entered.promise
    // Logout's later /me succeeds with the old token, so it does not join the
    // earlier rotation; the outstanding refresh is allowed to finish later.
    expect((await provider.signOut()).is_ok()).toBe(true)
    expect(await storedCredential(ACCESS)).toBeNull()
    expect(await storedCredential(REFRESH)).toBeNull()
    finish.resolve(response(200, {access_token: "access-2", refresh_token: "refresh-2"}))
    expect((await refreshingSession).is_error()).toBe(true)
    const fresh = await new AccountAuthProvider().getSession()
    expect(fresh.is_ok()).toBe(true)
    if (fresh.is_error()) throw fresh.error
    expect(fresh.value).toEqual({token: undefined})
    expect(await storedCredential(REFRESH)).toBeNull()
  })

  it("revokes an expired access token through a private refreshed snapshot without saving it", async () => {
    fetchMock
      .mockResolvedValueOnce(response(401, {error: "invalid_grant"}))
      .mockImplementationOnce(async () => {
        expect(await storedCredential(ACCESS)).toBeNull()
        expect(await storedCredential(REFRESH)).toBeNull()
        return response(200, {access_token: "private-access", refresh_token: "private-refresh"})
      })
      .mockResolvedValueOnce(response(200))
    const result = await new AccountAuthProvider().signOut()
    expect(result.is_ok()).toBe(true)
    expect(fetchMock.mock.calls[1][1].body).toBe("grant_type=refresh_token&refresh_token=refresh-1")
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe("Bearer private-access")
    expect(await storedCredential(ACCESS)).toBeNull()
    expect(await storedCredential(REFRESH)).toBeNull()
  })

  it.each(["network", "rejected"])("keeps local logout and fanout when remote revoke is %s", async (failure) => {
    fetchMock.mockResolvedValueOnce(response(200, user))
    if (failure === "network") fetchMock.mockRejectedValueOnce(new Error("offline"))
    else fetchMock.mockResolvedValueOnce(response(503, {error: "unavailable"}))
    const provider = new AccountAuthProvider()
    const listener = jest.fn()
    const sub = provider.onAuthStateChange(listener)
    if (sub.is_error()) throw sub.error
    try {
      const result = await provider.signOut()
      expect(result.is_error()).toBe(true)
      expect(listener).toHaveBeenCalledWith("SIGNED_OUT", {token: undefined})
      expect(await storedCredential(ACCESS)).toBeNull()
      expect(await storedCredential(REFRESH)).toBeNull()
    } finally {
      sub.value.unsubscribe()
    }
  })

  it("bounds remote logout and does not send revoke after a timed-out private refresh completes", async () => {
    jest.useFakeTimers()
    const entered = deferred<void>()
    const finish = deferred<ReturnType<typeof response>>()
    fetchMock.mockResolvedValueOnce(response(401)).mockImplementationOnce(() => {
      entered.resolve(undefined)
      return finish.promise
    })
    try {
      const result = new AccountAuthProvider().signOut()
      await entered.promise
      jest.advanceTimersByTime(10_000)
      expect((await result).is_error()).toBe(true)
      expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true)
      finish.resolve(response(200, {access_token: "late-access", refresh_token: "late-refresh"}))
      await Promise.resolve()
      await Promise.resolve()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(await storedCredential(ACCESS)).toBeNull()
      expect(await storedCredential(REFRESH)).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it.each(["password", "verification", "reset", "oauth"])(
    "does not save a late %s sign-in result after logout",
    async (flow) => {
      const entered = deferred<void>()
      const finish = deferred<ReturnType<typeof response>>()
      const provider = new AccountAuthProvider()
      let gated = false
      fetchMock.mockImplementation(async (url: string) => {
        const target = {
          password: "/login",
          verification: "/exchange",
          reset: "/password/reset",
          oauth: "/oauth/complete",
        }[flow]
        if (!gated && url.endsWith(target!)) {
          gated = true
          entered.resolve(undefined)
          return finish.promise
        }
        return response(200, url.endsWith("/me") ? user : {})
      })
      await accountCredentials.set("mentra.account.oauth.state", "oauth-state")
      await accountCredentials.set("mentra.account.oauth.verifier", "oauth-verifier")
      const oldSignIn =
        flow === "password"
          ? provider.signInWithPassword({email: user.email, password: "test"})
          : flow === "verification"
            ? provider.completeSignupVerification("provider-token", async () => true)
            : flow === "reset"
              ? provider.resetPasswordByCode(user.email, "test-code", "new-password")
              : provider.completeOAuthHandoff({code: "handoff", state: "oauth-state"})
      await entered.promise
      expect((await provider.signOut()).is_ok()).toBe(true)
      finish.resolve(response(200, {access_token: "late-access", refresh_token: "late-refresh"}))
      expect((await oldSignIn).is_error()).toBe(true)
      expect(await storedCredential(ACCESS)).toBeNull()
      expect(await storedCredential(REFRESH)).toBeNull()
    },
  )

  it("signs out locally, OAuth state included, even when the stored session cannot be read", async () => {
    await accountCredentials.set("mentra.account.oauth.verifier", "oauth-verifier")
    const unreadable = jest.spyOn(accountCredentials, "get").mockRejectedValue(new Error("Keystore unavailable"))
    const provider = new AccountAuthProvider()
    const listener = jest.fn()
    const sub = provider.onAuthStateChange(listener)
    if (sub.is_error()) throw sub.error
    try {
      expect((await provider.signOut()).is_ok()).toBe(true)
      expect(listener).toHaveBeenCalledWith("SIGNED_OUT", {token: undefined})
    } finally {
      unreadable.mockRestore()
      sub.value.unsubscribe()
    }
    expect(await storedCredential(ACCESS)).toBeNull()
    expect(await storedCredential(REFRESH)).toBeNull()
    expect(await storedCredential("mentra.account.oauth.verifier")).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("can sign in again on the same provider after local logout", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      response(
        200,
        url.endsWith("/login")
          ? {access_token: "new-access", refresh_token: "new-refresh"}
          : url.endsWith("/me")
            ? user
            : {},
      ),
    )
    const provider = new AccountAuthProvider()
    expect((await provider.signOut()).is_ok()).toBe(true)
    const signedIn = await provider.signInWithPassword({email: user.email, password: "test"})
    expect(signedIn.is_ok()).toBe(true)
    const session = await provider.getSession()
    expect(session.is_ok()).toBe(true)
    if (session.is_error()) throw session.error
    expect(session.value).toMatchObject({token: "new-access", user: {id: "account-1"}})
  })
})
