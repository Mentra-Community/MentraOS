/* eslint-disable import/first -- Register runtime boundaries before the actual logout utility. */
const mockCoreSignOut = jest.fn()
const mockAccountSignOut = jest.fn()
const mockDisconnect = jest.fn()
const mockForget = jest.fn()
const mockStop = jest.fn()
const mockReset = jest.fn()
const mockMantleCleanup = jest.fn()
const mockSettle = jest.fn()
jest.mock("@mentra/engine", () => ({
  engine: {
    glasses: {disconnect: () => mockDisconnect(), forget: () => mockForget()},
    stop: () => mockStop(),
    settings: {resetAllLocal: () => mockReset()},
  },
}))
jest.mock("@/services/cloudClient", () => ({cloudClient: {clearAuthSession: () => mockCoreSignOut()}}))
jest.mock("@/utils/auth/authClient", () => ({__esModule: true, default: {signOut: () => mockAccountSignOut()}}))
jest.mock("@/services/MantleManager", () => ({__esModule: true, default: {cleanup: () => mockMantleCleanup()}}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: () => mockSettle()}))
jest.mock("@/utils/GlobalEventEmitter", () => ({__esModule: true, default: {emit: jest.fn()}}))

import {LogoutUtils} from "./LogoutUtils"
import {result as Res} from "typesafe-ts"
import {ACCOUNT_CREDENTIAL_KEYS, accountCredentials} from "@/utils/auth/accountCredentials"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete
    reject = fail
  })
  return {promise, resolve, reject}
}

describe("LogoutUtils credential-owner ordering", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockDisconnect.mockResolvedValue(undefined)
    mockForget.mockResolvedValue(undefined)
    mockStop.mockResolvedValue(undefined)
    mockMantleCleanup.mockResolvedValue(undefined)
    mockSettle.mockResolvedValue(undefined)
  })

  it.each(["core", "account"])(
    "starts both owners before awaiting %s failure and still completes independent teardown",
    async (failedOwner) => {
      const core = deferred<void>()
      const account = deferred<ReturnType<typeof Res.ok<void, Error>>>()
      mockCoreSignOut.mockReturnValue(core.promise)
      mockAccountSignOut.mockReturnValue(account.promise)
      const complete = LogoutUtils.performCompleteLogout()
      expect(mockCoreSignOut).toHaveBeenCalledTimes(1)
      expect(mockAccountSignOut).toHaveBeenCalledTimes(1)
      expect(mockSettle).not.toHaveBeenCalled()
      if (failedOwner === "core") core.reject(new Error("Core unavailable"))
      else account.reject(new Error("Account unavailable"))
      await Promise.resolve()
      expect(mockDisconnect).not.toHaveBeenCalled()
      if (failedOwner === "core") account.resolve(Res.ok(undefined))
      else core.resolve(undefined)
      await complete
      expect(mockSettle).toHaveBeenCalledTimes(1)
      expect(mockDisconnect).toHaveBeenCalledTimes(1)
      expect(mockForget).toHaveBeenCalledTimes(1)
      expect(mockMantleCleanup).toHaveBeenCalledTimes(1)
      expect(mockStop).toHaveBeenCalledTimes(1)
      expect(mockReset).toHaveBeenCalledTimes(1)
    },
  )

  it("deletes every account credential from the secure store, which clearing MMKV does not reach", async () => {
    mockCoreSignOut.mockResolvedValue(undefined)
    await accountCredentials.set(ACCOUNT_CREDENTIAL_KEYS.refreshToken, "refresh-1")
    await accountCredentials.set(ACCOUNT_CREDENTIAL_KEYS.oauthVerifier, "verifier-1")
    // Joining a workspace tears down without a provider sign-out, as before.
    await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
    for (const key of Object.values(ACCOUNT_CREDENTIAL_KEYS)) expect(await accountCredentials.get(key)).toBeNull()
    expect(await LogoutUtils.verifyLogoutSuccess()).toBe(true)
  })

  it("account deletion skips provider signout and still waits for its Core logout", async () => {
    mockCoreSignOut.mockResolvedValue(undefined)
    await LogoutUtils.performCompleteLogout({skipAuthSignOut: true})
    expect(mockAccountSignOut).not.toHaveBeenCalled()
    expect(mockCoreSignOut).toHaveBeenCalledTimes(1)
    expect(mockStop).toHaveBeenCalledTimes(1)
  })
})
