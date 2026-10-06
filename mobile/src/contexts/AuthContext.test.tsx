import {render, waitFor} from "@testing-library/react-native"

import {AuthProvider, useAuth} from "@/contexts/AuthContext"

const mockProvider = {
  getSession: jest.fn(),
  signIn: jest.fn(),
  signOut: jest.fn(async () => {}),
  getAccessToken: jest.fn(),
  onStateChange: jest.fn(() => () => {}),
}
const mockDeployment = {
  activeDeployment: {kind: "organization", manifest: {telemetry: false}},
  selectionResolved: true,
  store: {},
}

jest.mock("@sentry/react-native", () => ({setUser: jest.fn()}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => mockDeployment,
  createDeploymentAuthProvider: () => mockProvider,
}))
jest.mock("@/utils/LogoutUtils", () => ({LogoutUtils: {}}))
jest.mock("@/utils/dev/devModeAllowlist", () => ({ensureDevModeForUser: jest.fn()}))

const identity = {
  deploymentId: "deployment-1",
  issuer: "https://login.microsoftonline.com/tenant-1",
  subject: "subject-1",
  email: "person@example.com",
}

let observedUserId: string | undefined

function Probe() {
  observedUserId = useAuth().user?.id
  return null
}

// Local miniapp data is partitioned by this id, so the persisted prefix of a
// separately deployed cloud's users must not change when code is renamed.
it("derives the local miniapp user id with the persisted prefix", async () => {
  mockProvider.getSession.mockResolvedValue({identity, accessToken: "token"})
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await waitFor(() =>
    expect(observedUserId).toBe("workspace:deployment-1:https%3A%2F%2Flogin.microsoftonline.com%2Ftenant-1:subject-1"),
  )
})
