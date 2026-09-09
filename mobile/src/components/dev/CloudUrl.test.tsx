import {engine, SETTINGS} from "@mentra/engine"
import {cloudClientService} from "@mentra/engine-host-internal"
import {act, fireEvent, render} from "@testing-library/react-native"

import {activeDeploymentEndpoints, cloudClient, resolvedEndpoints} from "@/services/cloudClient"
import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"

import CloudUrl from "./CloudUrl"

const mockConsumer = {kind: "consumer"}
const mockWorkspace = {
  kind: "workspace",
  manifest: {
    displayName: "Mentra Enterprise Demo",
    services: {coreUrl: "https://core.organization.example", runtimeUrl: "https://workspace.organization.example"},
  },
}
let mockActiveDeployment = mockConsumer
const mockAlert = jest.fn()
const originalFetch = global.fetch
const originalCoreEnv = process.env.EXPO_PUBLIC_CLOUD_CORE_URL
const originalRuntimeEnv = process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL

jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({activeDeployment: mockActiveDeployment}),
  deploymentStore: {getActive: () => mockActiveDeployment},
}))
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

beforeEach(() => {
  jest.clearAllMocks()
  mockActiveDeployment = mockConsumer
  jest.mocked(devServerHost).mockReturnValue(undefined)
  engine.settings.setManyLocal({
    [SETTINGS.cloud_core_url.key]: "",
    [SETTINGS.cloud_runtime_url.key]: "",
    [SETTINGS.saved_cloud_url_pairs.key]: [],
  })
  delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  jest.spyOn(global, "fetch").mockResolvedValue({ok: true, status: 200} as Response)
})

afterAll(() => {
  global.fetch = originalFetch
  if (originalCoreEnv === undefined) delete process.env.EXPO_PUBLIC_CLOUD_CORE_URL
  else process.env.EXPO_PUBLIC_CLOUD_CORE_URL = originalCoreEnv
  if (originalRuntimeEnv === undefined) delete process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL
  else process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = originalRuntimeEnv
})

it("keeps consumer debug overrides ahead of build environment URLs and reconnects to them", () => {
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.build.example"
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "https://runtime.build.example"
  expect(resolvedEndpoints()).toEqual({core: "https://core.build.example", runtime: "https://runtime.build.example"})

  engine.settings.setManyLocal({cloud_core_url: "http://localhost:3000", cloud_runtime_url: "http://localhost:3001"})
  cloudClient.reconnect()
  expect(cloudClientService.reconnect).toHaveBeenCalledWith({
    core: "http://localhost:3000",
    runtime: "http://localhost:3001",
  })
})

it("resolves the consumer Metro preset against the current laptop", () => {
  engine.settings.setManyLocal({cloud_core_url: METRO_AUTO, cloud_runtime_url: METRO_AUTO})
  jest.mocked(devServerHost).mockReturnValue("192.0.2.10")
  expect(activeDeploymentEndpoints()).toEqual({core: "http://192.0.2.10:3000", runtime: "http://192.0.2.10:3001"})
  jest.mocked(devServerHost).mockReturnValue("192.0.2.11")
  cloudClient.reconnect()
  expect(cloudClientService.reconnect).toHaveBeenCalledWith({
    core: "http://192.0.2.11:3000",
    runtime: "http://192.0.2.11:3001",
  })
})

it("shows workspace endpoints read-only and reconnects to the manifest despite stored consumer overrides", () => {
  mockActiveDeployment = mockWorkspace
  engine.settings.setManyLocal({cloud_core_url: "http://localhost:3000", cloud_runtime_url: "http://localhost:3001"})
  const screen = render(<CloudUrl />)

  expect(screen.getByText(mockWorkspace.manifest.services.coreUrl)).toBeTruthy()
  expect(screen.getByText(mockWorkspace.manifest.services.runtimeUrl)).toBeTruthy()
  expect(screen.queryByText("Save & Test")).toBeNull()
  expect(screen.queryByText("Reset")).toBeNull()
  expect(screen.queryByPlaceholderText("e.g., http://192.168.1.100:3000")).toBeNull()
  expect(global.fetch).not.toHaveBeenCalled()

  cloudClient.reconnect()
  expect(cloudClientService.reconnect).toHaveBeenCalledWith({
    core: mockWorkspace.manifest.services.coreUrl,
    runtime: mockWorkspace.manifest.services.runtimeUrl,
  })
  expect(engine.settings.get(SETTINGS.cloud_core_url.key)).toBe("http://localhost:3000")
})

it("still saves, tests, and applies consumer overrides, and Reset restores build defaults", async () => {
  process.env.EXPO_PUBLIC_CLOUD_CORE_URL = "https://core.build.example"
  process.env.EXPO_PUBLIC_CLOUD_RUNTIME_URL = "https://runtime.build.example"
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
  expect(cloudClientService.reconnect).toHaveBeenLastCalledWith({
    core: "https://core.debug.example",
    runtime: "https://runtime.debug.example",
  })

  fireEvent.press(screen.getByText("Reset"))
  expect(cloudClientService.reconnect).toHaveBeenLastCalledWith({
    core: "https://core.build.example",
    runtime: "https://runtime.build.example",
  })
})
