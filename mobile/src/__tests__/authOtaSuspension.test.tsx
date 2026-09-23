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
const mockWorkspace = {
  onStateChange: (fn: typeof mockWorkspaceCallback) => {
    mockWorkspaceCallback = fn
    return () => {}
  },
  getSession: async () => workspaceSession,
}
jest.mock("@sentry/react-native", () => ({setUser: jest.fn()}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({activeDeployment: mockDeployment, selectionResolved: true, store: mockStore}),
  createDeploymentAuthProvider: () => mockWorkspace,
}))
jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: async () => ({is_error: () => false, value: initial}),
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
  await act(async () => {
    mockAuthCallback("SIGNED_OUT", null)
  })
  expect(observedUser).toBeNull()
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
  expect(engine.stop).not.toHaveBeenCalled()
  expect(engine.glasses.disconnect).not.toHaveBeenCalled()
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
  await act(async () => {
    mockWorkspaceCallback({...workspaceSession, identity: {...workspaceSession.identity, subject: "second"}})
  })
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(1)
  await act(async () => {
    mockWorkspaceCallback(null)
  })
  expect(engine.firmwareUpdates.suspendNewWork).toHaveBeenCalledTimes(2)
  expect(observedUser).toBeNull()
  expect(engine.stop).not.toHaveBeenCalled()
})
