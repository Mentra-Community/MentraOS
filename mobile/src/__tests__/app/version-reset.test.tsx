import {act, fireEvent, render} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {result as Res} from "typesafe-ts"

import InitScreen from "@/app/index"
import {createConsumerDeployment} from "@/services/deployment/officialManifest"
import {saveDeploymentCloudOverrides} from "@/services/deployment/debugOverrides"
import {deploymentStore} from "@/services/deployment/store"
import {fetchMinimumClientVersion} from "@/utils/cloudVersion"

const mockDeployment = createConsumerDeployment()
const mockReplaceAll = jest.fn()

jest.mock("expo-router", () => ({useRootNavigationState: () => ({key: "root"})}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: null, session: null, loading: false})}))
jest.mock("@/contexts/DeeplinkContext", () => ({useDeeplink: () => ({processUrl: jest.fn()})}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {}}})}))
jest.mock("@/services/deployment", () => ({
  ...jest.requireActual("@/services/deployment/store"),
  useDeployment: () => ({activeDeployment: mockDeployment, selectionResolved: true}),
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({replaceAll: mockReplaceAll, setAnimation: jest.fn()})},
}))
jest.mock("@/services/MantleManager", () => ({__esModule: true, default: {init: jest.fn()}}))
jest.mock("@/utils/cloudVersion", () => ({fetchMinimumClientVersion: jest.fn()}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("@/components/splash/SplashVideo", () => ({SplashVideo: () => null}))
jest.mock("@/components/ignite", () => {
  const {Text, View, Pressable} = require("react-native")
  return {
    Screen: View,
    Header: () => null,
    Icon: () => null,
    Text: ({text}: {text: string}) => <Text>{text}</Text>,
    Button: ({text, tx, onPress, disabled}: {text?: string; tx?: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable onPress={onPress} disabled={disabled}>
        <Text>{text ?? tx}</Text>
      </Pressable>
    ),
  }
})

const originalVersion = process.env.EXPO_PUBLIC_MENTRAOS_VERSION
beforeEach(async () => {
  jest.clearAllMocks()
  process.env.EXPO_PUBLIC_MENTRAOS_VERSION = "3.0.0"
  await deploymentStore.clearSelection()
  await deploymentStore.returnToMentra()
  await saveDeploymentCloudOverrides(mockDeployment, {core: "", runtime: "https://debug.example"})
  await engine.settings.setManyLocal({cached_required_version: "runtime:99.0.0"})
  jest.mocked(fetchMinimumClientVersion).mockResolvedValue(Res.error(new Error("Offline")))
})

afterAll(() => {
  if (originalVersion === undefined) delete process.env.EXPO_PUBLIC_MENTRAOS_VERSION
  else process.env.EXPO_PUBLIC_MENTRAOS_VERSION = originalVersion
})

it("removes the old backend's update block when Reset retries offline", async () => {
  const screen = render(<InitScreen />)
  await act(async () => {})
  expect(screen.getByText("versionCheck:updateRequiredButton")).toBeTruthy()
  expect(screen.queryByText("versionCheck:continueAnyway")).toBeNull()
  expect(fetchMinimumClientVersion).toHaveBeenLastCalledWith("https://debug.example", 3, 1000)

  await act(async () => fireEvent.press(screen.getByText("versionCheck:resetUrl")))

  expect(engine.settings.get(SETTINGS.cached_required_version.key)).toBe("")
  expect(engine.settings.get(SETTINGS.cloud_runtime_url.key)).toBe("")
  expect(fetchMinimumClientVersion).toHaveBeenLastCalledWith(mockDeployment.manifest.services.runtimeUrl, 3, 1000)
  expect(screen.queryByText("versionCheck:updateRequiredButton")).toBeNull()
  expect(screen.getByText("versionCheck:retryConnection")).toBeTruthy()
  expect(screen.getByText("versionCheck:continueAnyway")).toBeTruthy()
})

it("recaches a successful requirement after Reset even when it matches the old render", async () => {
  const screen = render(<InitScreen />)
  await act(async () => {})
  jest.mocked(fetchMinimumClientVersion).mockResolvedValue(Res.ok({required: "99.0.0", recommended: "99.0.0"}))
  await act(async () => fireEvent.press(screen.getByText("versionCheck:resetUrl")))
  expect(engine.settings.get(SETTINGS.cached_required_version.key)).toBe("runtime:99.0.0")
  expect(screen.getByText("versionCheck:updateRequiredButton")).toBeTruthy()
})
