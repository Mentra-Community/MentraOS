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

beforeEach(() => {
  jest.clearAllMocks()
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
