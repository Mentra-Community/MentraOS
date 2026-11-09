/* eslint-disable import/first -- Register runtime boundaries before the helper. */
const mockCalls: string[] = []
const mockLogout = jest.fn(async (_options?: unknown) => {
  mockCalls.push("logout")
})
const mockSave = jest.fn(async (_deployment: unknown, _urls: unknown) => {
  mockCalls.push("save")
})
const mockReconnect = jest.fn(() => {
  mockCalls.push("reconnect")
})
const mockReplaceAll = jest.fn((path: string) => {
  mockCalls.push(`replaceAll ${path}`)
})
const mockCloseCapsule = jest.fn(async (_back: boolean) => {
  mockCalls.push("closeMiniapp")
})
const mockProviderSignOut = jest.fn(async () => {
  mockCalls.push("providerSignOut")
})
const mockProviderGetSession = jest.fn()
const mockHasStoredSession = jest.fn()

jest.mock("@/utils/LogoutUtils", () => ({
  LogoutUtils: {performCompleteLogout: (options?: unknown) => mockLogout(options)},
}))
jest.mock("@/services/cloudClient", () => ({cloudClient: {reconnect: () => mockReconnect()}}))
jest.mock("@/services/deployment/debugOverrides", () => ({
  saveDeploymentCloudOverrides: (deployment: unknown, urls: unknown) => mockSave(deployment, urls),
  coreOverrideChangesCore: (_deployment: unknown, core: string) => core !== "https://core.same.example",
}))
jest.mock("@/services/deployment/auth", () => ({
  createDeploymentAuthProvider: () => ({
    getSession: () => mockProviderGetSession(),
    signOut: () => mockProviderSignOut(),
  }),
  queueProviderCleanup: (provider: {signOut: () => Promise<void>}) => provider.signOut(),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {
    getState: () => ({replaceAll: (path: string) => mockReplaceAll(path)}),
  },
}))
jest.mock("@/stores/capsule", () => ({
  useCapsuleStore: {getState: () => ({active: {handleRightPress: (back: boolean) => mockCloseCapsule(back)}})},
}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: async () => {}}))
jest.mock("@/utils/auth/accountCredentials", () => ({hasStoredAccountSession: () => mockHasStoredSession()}))

import type {ActiveDeployment} from "./types"
import {cloudSwitchSignsOut, hasSignedInSession, switchCloudEndpoints} from "./switchCloudEndpoints"

const consumer = {kind: "consumer"} as ActiveDeployment
const workspace = {kind: "workspace"} as ActiveDeployment
const urls = {core: "https://core.dev.example", runtime: "https://runtime.dev.example"}

beforeEach(() => {
  jest.clearAllMocks()
  mockCalls.length = 0
})

describe("switchCloudEndpoints", () => {
  it("signs out of the old Core, keeping the glasses, before saving, reconnecting and landing on sign-in", async () => {
    const result = await switchCloudEndpoints(consumer, urls, {signOut: true})

    expect(mockCalls).toEqual(["closeMiniapp", "replaceAll /auth/start", "logout", "save", "reconnect"])
    expect(mockLogout).toHaveBeenCalledWith({keepGlasses: true})
    expect(mockCloseCapsule).toHaveBeenCalledWith(true)
    expect(mockSave).toHaveBeenCalledWith(consumer, urls)
    expect(result).toEqual({signedOut: true})
  })

  it("only saves and reconnects when nobody is signed in", async () => {
    const result = await switchCloudEndpoints(consumer, urls, {signOut: false})

    expect(mockCalls).toEqual(["save", "reconnect"])
    expect(mockLogout).not.toHaveBeenCalled()
    expect(result).toEqual({signedOut: false})
  })

  it("signs a workspace out of its provider and lands on the workspace sign-in", async () => {
    await switchCloudEndpoints(workspace, urls, {signOut: true})

    expect(mockCalls).toEqual([
      "closeMiniapp",
      "replaceAll /auth/workspace-signin",
      "logout",
      "providerSignOut",
      "save",
      "reconnect",
    ])
    expect(mockLogout).toHaveBeenCalledWith({skipAuthSignOut: true, keepGlasses: true})
  })

  it("leaves routing to a caller that navigates itself", async () => {
    const result = await switchCloudEndpoints(consumer, urls, {signOut: true, navigate: false})

    expect(mockCalls).toEqual(["logout", "save", "reconnect"])
    expect(result).toEqual({signedOut: true})
  })
})

describe("cloudSwitchSignsOut", () => {
  it("reads the consumer's stored session", async () => {
    mockHasStoredSession.mockResolvedValue(true)
    await expect(cloudSwitchSignsOut(consumer, urls.core)).resolves.toBe(true)
    mockHasStoredSession.mockResolvedValue(false)
    await expect(cloudSwitchSignsOut(consumer, urls.core)).resolves.toBe(false)
  })

  it("keeps the session when the Core does not change", async () => {
    mockHasStoredSession.mockResolvedValue(true)
    await expect(cloudSwitchSignsOut(consumer, "https://core.same.example")).resolves.toBe(false)
    expect(mockHasStoredSession).not.toHaveBeenCalled()
  })
})

describe("hasSignedInSession", () => {
  it("asks the workspace provider for its session", async () => {
    mockProviderGetSession.mockResolvedValue({identity: {subject: "person"}})
    await expect(hasSignedInSession(workspace)).resolves.toBe(true)
    mockProviderGetSession.mockResolvedValue(null)
    await expect(hasSignedInSession(workspace)).resolves.toBe(false)
  })

  it("assumes a session when it cannot read one", async () => {
    mockHasStoredSession.mockRejectedValue(new Error("keychain locked"))
    await expect(hasSignedInSession(consumer)).resolves.toBe(true)
  })
})
