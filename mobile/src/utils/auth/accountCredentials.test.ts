/* eslint-disable import/first -- Jest module mocks must be registered before these imports. */
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://core.example.test", runtime: "wss://runtime.example.test"}),
}))
jest.mock("@/utils/auth/authClient", () => ({AuthClient: class {}}))

import {storage} from "@/utils/storage"

// Written by an earlier build, before anything opens the vault: the first read is the upgrade's first launch.
storage.save("mentra.account.accessToken", "upgraded-access")
storage.save("mentra.account.refreshToken", "upgraded-refresh")
storage.save("mentra.account.oauth.verifier", "upgraded-verifier")
storage.save("mentra.account.userProfile", JSON.stringify({id: "account-1", email: "account@example.test", name: "A"}))
storage.save("authing_session", {access_token: "authing-access", expires_at: 1})
storage.save("supabase.auth.token", "retired-supabase-token")
storage.save("sb-exampleproject-auth-token", {access_token: "retired-supabase-js-access", refresh_token: "r"})
storage.save("core_token", "retired-cloud-v1-token")

import {ACCOUNT_CREDENTIAL_KEYS, accountCredentials, hasStoredAccountSession} from "./accountCredentials"
import {AccountAuthProvider} from "./provider/accountClient"

describe("account credentials after an upgrade", () => {
  const originalFetch = global.fetch

  afterAll(() => {
    global.fetch = originalFetch
  })

  it("keeps the person signed in and leaves no credential in MMKV", async () => {
    const fetchMock = jest.fn(async (_url: string, init?: {headers?: Record<string, string>}) => ({
      ok: init?.headers?.authorization === "Bearer upgraded-access",
      status: init?.headers?.authorization === "Bearer upgraded-access" ? 200 : 401,
      json: async () => ({mentraUserId: "account-1", email: "account@example.test"}),
    }))
    global.fetch = fetchMock as unknown as typeof fetch

    const session = await new AccountAuthProvider().getSession()
    if (session.is_error()) throw session.error
    expect(session.value).toMatchObject({token: "upgraded-access", user: {id: "account-1"}})
    expect(await accountCredentials.location()).toBe("secure-store")

    expect(await accountCredentials.get(ACCOUNT_CREDENTIAL_KEYS.refreshToken)).toBe("upgraded-refresh")
    expect(await accountCredentials.get(ACCOUNT_CREDENTIAL_KEYS.oauthVerifier)).toBe("upgraded-verifier")
    expect(JSON.parse((await accountCredentials.get(ACCOUNT_CREDENTIAL_KEYS.authingSession))!)).toEqual({
      access_token: "authing-access",
      expires_at: 1,
    })
    const retired = ["supabase.auth.token", "sb-exampleproject-auth-token", "core_token"]
    for (const key of [...Object.values(ACCOUNT_CREDENTIAL_KEYS), ...retired]) {
      expect(storage.load(key).is_error()).toBe(true)
    }
    // The cached profile is not a credential.
    expect(storage.load("mentra.account.userProfile").is_ok()).toBe(true)

    expect(await hasStoredAccountSession()).toBe(true)
    expect((await new AccountAuthProvider().signOut()).is_error()).toBe(false)
    expect(await hasStoredAccountSession()).toBe(false)
  })
})
