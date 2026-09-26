import {act, render} from "@testing-library/react-native"
import {engine} from "@mentra/engine"

import {AuthProvider, useAuth} from "@/contexts/AuthContext"
import type {MentraAuthSession} from "@/utils/auth/authProvider.types"

let mockAuthCallback: (event: string, next: MentraAuthSession | null) => void
let mockWorkspaceCallback: (next: unknown) => void
const mockDeployment = {kind: "consumer", manifest: {telemetry: false}}
const mockStore = {}
const initial = {token: "token", user: {id: "first", email: "first@example.com"}} as MentraAuthSession
const workspaceSession = {
  accessToken: "token",
  identity: {deploymentId: "workspace", issuer: "issuer", subject: "first"},
}
const mockConsumerSession = jest.fn(async (): Promise<MentraAuthSession | null> => initial)
const mockWorkspaceSession = jest.fn(async (): Promise<typeof workspaceSession | null> => workspaceSession)
const mockWorkspace = {
  onStateChange: (fn: typeof mockWorkspaceCallback) => {
    mockWorkspaceCallback = fn
    return () => {}
  },
  getSession: () => mockWorkspaceSession(),
}
jest.mock("@sentry/react-native", () => ({setUser: jest.fn()}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({activeDeployment: mockDeployment, selectionResolved: true, store: mockStore}),
  createDeploymentAuthProvider: () => mockWorkspace,
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: async () => ({is_error: () => false, value: await mockConsumerSession()}),
    onAuthStateChange: async (fn: typeof mockAuthCallback) => {
      mockAuthCallback = fn
      return {is_error: () => false, value: {unsubscribe: () => {}}}
    },
  },
}))
jest.mock("@/utils/LogoutUtils", () => ({LogoutUtils: {performCompleteLogout: jest.fn()}}))
jest.mock("@/utils/dev/devModeAllowlist", () => ({ensureDevModeForUser: async () => {}}))
jest.mock("@/services/deployment/debugOverrides", () => ({clearDeploymentDebugOverrides: async () => {}}))
let observedUser: string | null = null
function Probe() {
  observedUser = useAuth().user?.id ?? null
  return null
}

beforeEach(() => {
  jest.clearAllMocks()
  mockDeployment.kind = "consumer"
  mockConsumerSession.mockImplementation(async () => initial)
  mockWorkspaceSession.mockImplementation(async () => workspaceSession)
  observedUser = null
})

it("suspends on the actual consumer auth-loss callback without stopping device recovery", async () => {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(observedUser).toBe("first")
  expect(engine.firmwareUpdates.suspendNewWork).not.toHaveBeenCalled()
  expect(engine.firmwareUpdates.resumeDiscovery).toHaveBeenCalledTimes(1)
  await act(async () => {
    mockAuthCallback("SIGNED_OUT", null)
  })
  expect(observedUser).toBeNull()
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
  expect(engine.stop).not.toHaveBeenCalled()
  expect(engine.glasses.disconnect).not.toHaveBeenCalled()
  await act(async () => {
    mockAuthCallback("SIGNED_IN", initial)
  })
  expect(observedUser).toBe("first")
  expect(engine.firmwareUpdates.resumeDiscovery).toHaveBeenCalledTimes(2)
  await act(async () => {
    mockAuthCallback("TOKEN_REFRESHED", {...initial, token: "refreshed"})
  })
  expect(engine.firmwareUpdates.resumeDiscovery).toHaveBeenCalledTimes(2)
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
})

it("suspends workspace provider loss and account replacement too", async () => {
  mockDeployment.kind = "workspace"
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(observedUser).toContain("first")
  // A cloud listener may receive the replacement first. The host must restore
  // discovery after suspending the old account regardless of that ordering.
  engine.firmwareUpdates.resumeDiscovery()
  await act(async () => {
    mockWorkspaceCallback({...workspaceSession, identity: {...workspaceSession.identity, subject: "second"}})
  })
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
  const resume = engine.firmwareUpdates.resumeDiscovery as jest.Mock
  const suspend = engine.firmwareUpdates.suspendNewWork as jest.Mock
  expect(resume.mock.invocationCallOrder.at(-1)).toBeGreaterThan(suspend.mock.invocationCallOrder.at(-1)!)
  await act(async () => {
    mockWorkspaceCallback(null)
  })
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(2)
  expect(observedUser).toBeNull()
  expect(engine.stop).not.toHaveBeenCalled()
  const resumesBeforeSignIn = resume.mock.calls.length
  await act(async () => {
    mockWorkspaceCallback(workspaceSession)
  })
  expect(observedUser).toContain("first")
  expect(resume).toHaveBeenCalledTimes(resumesBeforeSignIn + 1)
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(2)
})

it("ignores an initial consumer snapshot that resolves after a newer sign-in", async () => {
  let resolve!: (next: MentraAuthSession | null) => void
  mockConsumerSession.mockReturnValueOnce(new Promise((done) => (resolve = done)))
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await act(async () => {
    mockAuthCallback("SIGNED_IN", initial)
  })
  await act(async () => {
    resolve(null)
  })
  expect(observedUser).toBe("first")
  expect(engine.firmwareUpdates.suspendNewWork).not.toHaveBeenCalled()
  expect(engine.firmwareUpdates.resumeDiscovery).toHaveBeenCalledTimes(1)
})

it("ignores an initial workspace snapshot that resolves after revocation", async () => {
  mockDeployment.kind = "workspace"
  let resolve!: (next: typeof workspaceSession | null) => void
  mockWorkspaceSession.mockReturnValueOnce(new Promise((done) => (resolve = done)))
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await act(async () => {
    mockWorkspaceCallback(workspaceSession)
    mockWorkspaceCallback(null)
  })
  await act(async () => {
    resolve(workspaceSession)
  })
  expect(observedUser).toBeNull()
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
  expect(engine.firmwareUpdates.resumeDiscovery).toHaveBeenCalledTimes(1)
})
