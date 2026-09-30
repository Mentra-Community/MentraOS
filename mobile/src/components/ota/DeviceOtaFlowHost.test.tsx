import {fireEvent, render} from "@testing-library/react-native"
import {DeviceOtaFlowHost} from "@/components/ota/DeviceOtaFlowHost"
import {useNavigationStore} from "@/stores/navigation"

let mockModel = "NIMO"
const mockBeforeRemove: Array<(event: {data: {action: {type: string}}; preventDefault: () => void}) => void> = []
const mockNavigated = jest.fn()
const mockReplaced = jest.fn()
let mockCancelled = false
const mockNavigation = {
  setOptions: jest.fn(),
  addListener: (_event: string, listener: (typeof mockBeforeRemove)[number]) => {
    mockBeforeRemove.push(listener)
    return () => {
      const index = mockBeforeRemove.indexOf(listener)
      if (index >= 0) mockBeforeRemove.splice(index, 1)
    }
  },
}
jest.mock("expo-router", () => ({
  useNavigation: () => mockNavigation,
  useFocusEffect: (callback: () => void | (() => void)) => require("react").useEffect(callback, [callback]),
  router: {
    canGoBack: () => true,
    replace: (...args: unknown[]) => mockReplaced(...args),
    back: () => {
      let prevented = false
      mockBeforeRemove.forEach((listener) =>
        listener({
          data: {action: {type: "GO_BACK"}},
          preventDefault: () => {
            prevented = true
          },
        }),
      )
      if (!prevented) mockNavigated()
    },
  },
}))
jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    default_wearable: {key: "model"},
    onboarding_live_completed: {key: "live"},
    onboarding_os_completed: {key: "os"},
    super_mode: {key: "super"},
  },
  useSetting: (key: string) => [key === "model" ? mockModel : true],
  engine: {firmwareUpdates: {pairingPolicy: () => ({onboardingFlowId: null, includeOsOnboarding: false})}},
}))
jest.mock("@mentra/engine/ota", () => ({
  FirmwareUpdateFlow: ({onFinished}: {onFinished: (result?: {kind: "finished"; outcome: "cancelled"}) => void}) => {
    const {Button} = require("react-native")
    return (
      <Button
        title="Done or Close"
        onPress={() => onFinished(mockCancelled ? {kind: "finished", outcome: "cancelled"} : undefined)}
      />
    )
  },
}))
jest.mock("@/contexts/ConnectionOverlayContext", () => ({
  useConnectionOverlayConfig: () => ({clearConfig: () => {}, setConfig: () => {}}),
}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {}}})}))

it.each(["NIMO", "AR99"])("allows %s settings completion through the actual host and navigation lock", (model) => {
  mockModel = model
  mockNavigated.mockClear()
  useNavigationStore.setState({
    history: ["/home", "/miniapps/settings", "/ota/check-for-updates"],
    historyParams: [{}, {}, {}],
    preventBackCount: 0,
    preventBack: false,
    interceptor: null,
  })
  const view = render(<DeviceOtaFlowHost entryPoint="settings" />)
  const preventDefault = jest.fn()
  mockBeforeRemove.forEach((listener) => listener({data: {action: {type: "GO_BACK"}}, preventDefault}))
  expect(preventDefault).toHaveBeenCalled()
  fireEvent.press(view.getByText("Done or Close"))
  expect(mockNavigated).toHaveBeenCalledTimes(1)
  expect(useNavigationStore.getState().history).toEqual(["/home", "/miniapps/settings"])
  view.unmount()
})

it("returns cancelled NIMO setup to device selection without advancing onboarding", () => {
  mockModel = "NIMO"
  mockCancelled = true
  mockNavigated.mockClear()
  mockReplaced.mockClear()
  useNavigationStore.setState({
    history: ["/home", "/pairing/success", "/ota/check-for-updates"],
    historyParams: [{}, {}, {}],
    preventBackCount: 0,
    preventBack: false,
    interceptor: null,
  })
  const view = render(<DeviceOtaFlowHost entryPoint="pairing" />)
  fireEvent.press(view.getByText("Done or Close"))
  expect(mockReplaced).toHaveBeenCalledTimes(1)
  expect(mockReplaced.mock.calls[0][0]).toMatchObject({pathname: "/pairing/select-glasses-model"})
  expect(mockNavigated).not.toHaveBeenCalled()
  view.unmount()
  mockCancelled = false
})
