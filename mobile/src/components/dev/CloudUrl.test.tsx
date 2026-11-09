import {engine, SETTINGS} from "@mentra/engine"
import {cloudClientService} from "@mentra/engine-host-internal"
import {act, fireEvent, render} from "@testing-library/react-native"

import {resolvedEndpoints} from "@/services/cloudClient"
import {deploymentStore} from "@/services/deployment"
import {createOfficialManifest} from "@/services/deployment/officialManifest"
import {devServerHost} from "@/utils/cloudClient/devHost"

import CloudUrl from "./CloudUrl"

const workspace = {
  workspaceOrigin: "https://organization.example",
  manifestUrl: "https://organization.example/.well-known/mentra-deployment.json",
  manifest: {
    ...createOfficialManifest(),
    deploymentId: "enterprise-demo",
    displayName: "Mentra Enterprise Demo",
    services: {coreUrl: "https://core.organization.example", runtimeUrl: "https://organization.example"},
  },
}
const mockAlert = jest.fn()
const originalFetch = global.fetch
const originalCoreEnv = process.env.EXPO_PUBLIC_CLOUD_CORE_URL
const originalRuntimeEnv = process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL

const mockHasStoredSession = jest.fn()
const mockWorkspaceSession = jest.fn()
const mockLogout = jest.fn()
const mockConfirm = jest.fn()
const mockReplaceAll = jest.fn()
jest.mock("@/utils/auth/accountCredentials", () => ({hasStoredAccountSession: () => mockHasStoredSession()}))
jest.mock("@/services/deployment/auth", () => ({
  ...jest.requireActual("@/services/deployment/auth"),
  createDeploymentAuthProvider: () => ({getSession: () => mockWorkspaceSession(), signOut: async () => {}}),
}))
jest.mock("@/utils/LogoutUtils", () => ({
  LogoutUtils: {performCompleteLogout: (options?: unknown) => mockLogout(options)},
}))
jest.mock("@/utils/confirmCloudSwitch", () => ({confirmCloudSwitch: (kind: string) => mockConfirm(kind)}))
jest.mock("@/stores/capsule", () => ({useCapsuleStore: {getState: () => ({active: null})}}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({replaceAll: (path: string) => mockReplaceAll(path)})},
}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: async () => {}}))
jest.mock("@/services/deployment", () => {
  const actual = jest.requireActual("@/services/deployment")
  return {...actual, useDeployment: () => ({activeDeployment: actual.deploymentStore.getActive()})}
})
jest.mock("@/utils/cloudClient/devHost", () => ({METRO_AUTO: "metro-auto", devServerHost: jest.fn()}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockAlert(...args)}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {textDim: "gray"}}})}))
jest.mock("@/i18n", () => ({translate: (key: string, options?: {name?: string}) => `${key} ${options?.name ?? ""}`}))
jest.mock("@/components/ui/GlassView", () => ({__esModule: true, default: require("react-native").View}))
jest.mock("@/components/ignite", () => {
  const {Text, Pressable} = require("react-native")
  return {
    Text,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

beforeEach(async () => {
  jest.clearAllMocks()
  jest.mocked(devServerHost).mockReturnValue(undefined)
  mockHasStoredSession.mockResolvedValue(false)
  mockWorkspaceSession.mockResolvedValue(null)
  mockLogout.mockResolvedValue(undefined)
  await engine.settings.setManyLocal({
    [SETTINGS.cloud_core_url.key]: "",
    [SETTINGS.cloud_runtime_url.key]: "",
    [SETTINGS.saved_cloud_url_pairs.key]: [],
  })
  delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  await deploymentStore.clearSelection()
  await deploymentStore.returnToMentra()
  jest.spyOn(global, "fetch").mockResolvedValue({ok: true, status: 200} as Response)
})

afterAll(() => {
  global.fetch = originalFetch
  if (originalCoreEnv === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = originalCoreEnv
  if (originalRuntimeEnv === undefined) delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  else process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = originalRuntimeEnv
})

it.each(["consumer", "workspace"])("saves, tests, and resets %s overrides to the selected manifest", async (kind) => {
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.build.example"
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "https://runtime.build.example"
  await deploymentStore.returnToMentra()
  if (kind === "workspace") await deploymentStore.activate(workspace)
  const baseline = deploymentStore.getActive().manifest.services
  const screen = render(<CloudUrl />)
  fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3000"), "https://core.debug.example/")
  fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3001"), "https://runtime.debug.example/")
  await act(async () => fireEvent.press(screen.getByText("Save & Test")))

  expect(global.fetch).toHaveBeenCalledWith(
    "https://core.debug.example/healthz",
    expect.objectContaining({method: "GET"}),
  )
  expect(global.fetch).toHaveBeenCalledWith(
    "https://runtime.debug.example/healthz",
    expect.objectContaining({method: "GET"}),
  )
  expect(resolvedEndpoints()).toEqual({core: "https://core.debug.example", runtime: "https://runtime.debug.example"})
  expect(cloudClientService.reconnect).toHaveBeenLastCalledWith(null)

  await act(async () => fireEvent.press(screen.getByText("Reset")))
  expect(resolvedEndpoints()).toEqual({core: baseline.coreUrl, runtime: baseline.runtimeUrl})
  expect(cloudClientService.reconnect).toHaveBeenLastCalledWith(null)
})

it("does not apply an in-flight health check to another deployment", async () => {
  expect(deploymentStore.getActive().kind).toBe("consumer")
  let finishProbe!: (value: Response) => void
  jest.spyOn(global, "fetch").mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishProbe = resolve
      }),
  )
  const screen = render(<CloudUrl />)
  fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3000"), "https://core.debug.example")
  fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3001"), "https://runtime.debug.example")
  fireEvent.press(screen.getByText("Save & Test"))
  await act(async () => {
    await deploymentStore.activate(workspace)
  })
  await act(async () => finishProbe({ok: true, status: 200} as Response))
  expect(resolvedEndpoints()).toEqual({
    core: workspace.manifest.services.coreUrl,
    runtime: workspace.manifest.services.runtimeUrl,
  })
  expect(cloudClientService.reconnect).not.toHaveBeenCalled()
})

describe("signed in", () => {
  const enterDev = (screen: ReturnType<typeof render>) => {
    fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3000"), "https://core.dev.example")
    fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3001"), "https://runtime.dev.example")
  }

  beforeEach(() => mockHasStoredSession.mockResolvedValue(true))

  it("keeps the session and the URLs when the person cancels the switch", async () => {
    mockConfirm.mockResolvedValue(false)
    const screen = render(<CloudUrl />)
    enterDev(screen)
    await act(async () => fireEvent.press(screen.getByText("Save & Test")))

    expect(mockConfirm).toHaveBeenCalledWith("change")
    expect(mockLogout).not.toHaveBeenCalled()
    expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("")
    expect(cloudClientService.reconnect).not.toHaveBeenCalled()
  })

  it("signs out, then switches and lands on sign-in without the reconnect notice", async () => {
    mockConfirm.mockResolvedValue(true)
    const screen = render(<CloudUrl />)
    enterDev(screen)
    await act(async () => fireEvent.press(screen.getByText("Save & Test")))

    expect(mockLogout).toHaveBeenCalledWith({keepGlasses: true})
    expect(resolvedEndpoints()).toEqual({core: "https://core.dev.example", runtime: "https://runtime.dev.example"})
    expect(cloudClientService.reconnect).toHaveBeenLastCalledWith(null)
    expect(mockReplaceAll).toHaveBeenCalledWith("/auth/start")
    expect(mockAlert).not.toHaveBeenCalled()
  })

  it("asks before Reset signs the person out", async () => {
    await engine.settings.setManyLocal({
      [SETTINGS.cloud_core_url.key]: "https://core.dev.example",
      [SETTINGS.cloud_runtime_url.key]: "https://runtime.dev.example",
    })
    mockConfirm.mockResolvedValue(true)
    const screen = render(<CloudUrl />)
    await act(async () => fireEvent.press(screen.getByText("Reset")))

    expect(mockConfirm).toHaveBeenCalledWith("reset")
    expect(mockLogout).toHaveBeenCalledTimes(1)
    expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("")
    expect(mockAlert).not.toHaveBeenCalled()
  })

  it("keeps the session when only the Runtime changes", async () => {
    const screen = render(<CloudUrl />)
    const core = resolvedEndpoints().core
    fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3000"), core)
    fireEvent.changeText(screen.getByPlaceholderText("e.g., http://192.168.1.100:3001"), "https://runtime.dev.example")
    await act(async () => fireEvent.press(screen.getByText("Save & Test")))

    expect(mockConfirm).not.toHaveBeenCalled()
    expect(mockLogout).not.toHaveBeenCalled()
    expect(engine.settings.get(SETTINGS.cloud_runtime_url.key)).toBe("https://runtime.dev.example")
  })
})
