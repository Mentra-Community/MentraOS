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
