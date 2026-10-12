import {act, fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import {Platform} from "react-native"
import type {SharedValue} from "react-native-reanimated"

import AppSwitcherButton from "./AppSwitcherButtton"
import {useMiniappPresentationStore} from "@/stores/miniappLaunch"

let mockApps: ClientApp[] = []
jest.mock("@mentra/engine", () => ({
  SETTINGS: {android_blur: {key: "android_blur"}},
  useSetting: () => [false],
  useActiveBackgroundApps: () => mockApps,
  useActiveForegroundApp: () => null,
  useForegroundApp: () => null,
  sortAppsByLastOpenTime: async (apps: ClientApp[]) => apps,
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {spacing: {s1: 4, s4: 16, s5: 20, s6: 24, s12: 48, s16: 64}, colors: {foreground: "black"}},
  }),
}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({bottom: 0})}))
jest.mock("@/contexts/ModalContext", () => ({__esModule: true, default: jest.fn()}))
jest.mock("@/utils/utils", () => ({hapticBuzz: jest.fn()}))
jest.mock("@/stores/appSwitcher", () => ({
  OPEN_SPRING: {},
  SWIPE_DISTANCE_THRESHOLD: 100,
  SWIPE_PERCENT_THRESHOLD: 0.5,
}))
jest.mock(
  "@/components/home/AppIcon",
  () =>
    function MockAppIcon({app}: {app: ClientApp}) {
      const {View} = require("react-native")
      return <View testID={`trayIcon.${app.packageName}`} />
    },
)
jest.mock("@/components/ui/GlassView", () => require("react-native").View)
jest.mock("expo-blur", () => ({BlurView: require("react-native").View}))
jest.mock("expo-linear-gradient", () => ({LinearGradient: require("react-native").View}))
jest.mock("@react-native-masked-view/masked-view", () => require("react-native").View)
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {Icon: () => null, Text: ({text, tx}: {text?: string; tx?: string}) => <Text>{text ?? tx}</Text>}
})
jest.mock("react-native-gesture-handler", () => {
  const gesture = () => {
    const builder = {
      activeOffsetY: () => builder,
      onUpdate: () => builder,
      onEnd: () => builder,
    }
    return builder
  }
  return {
    Gesture: {Pan: gesture, Tap: gesture, Exclusive: jest.fn()},
    GestureDetector: ({children}: {children: React.ReactNode}) => children,
  }
})

beforeEach(() => {
  useMiniappPresentationStore.setState({closingPackageName: null})
})

afterEach(() => {
  jest.restoreAllMocks()
})

test.each([
  ["ios", false],
  ["ios", true],
  ["android", false],
  ["android", true],
] as const)("native and touch activation open All Apps on %s, populated=%s", async (platform, populated) => {
  jest.replaceProperty(Platform, "OS", platform)
  mockApps = populated ? [{packageName: "com.mentra.settings", name: "Settings"} as ClientApp] : []
  const openGrid = jest.fn()
  render(
    <AppSwitcherButton
      swipeProgress={{value: 0} as SharedValue<number>}
      onGridButtonPress={openGrid}
      blurTargetRef={{current: null}}
    />,
  )
  await act(async () => {})

  const grid = screen.getByRole("button", {name: "home:openAllApps"})
  fireEvent(grid, "accessibilityTap")
  expect(openGrid).toHaveBeenCalledTimes(1)

  fireEvent.press(grid)
  expect(openGrid).toHaveBeenCalledTimes(2)
})

test("X-button close immediately removes its icon from the running tray", async () => {
  mockApps = ["one", "two"].map((packageName) => {
    const app = {packageName, name: packageName}
    return app as ClientApp
  })
  render(
    <AppSwitcherButton
      swipeProgress={{value: 0} as SharedValue<number>}
      onGridButtonPress={jest.fn()}
      blurTargetRef={{current: null}}
    />,
  )
  await act(async () => {})
  expect(screen.getByTestId("trayIcon.one")).toBeTruthy()
  act(() => useMiniappPresentationStore.getState().setClosingPackageName("one"))
  expect(screen.queryByTestId("trayIcon.one")).toBeNull()
  expect(screen.getByTestId("trayIcon.two")).toBeTruthy()
  await act(async () => {})
})

test.each([false, true])("accessible activation opens the tray, populated=%s", async (populated) => {
  mockApps = populated ? [{packageName: "com.mentra.settings", name: "Settings"} as ClientApp] : []
  const swipeProgress = {value: 0} as SharedValue<number>
  const openGrid = jest.fn()
  render(
    <AppSwitcherButton swipeProgress={swipeProgress} onGridButtonPress={openGrid} blurTargetRef={{current: null}} />,
  )
  await act(async () => {})

  const tray = screen.getByRole("button", {name: "appSwitcher:open"})
  fireEvent(tray, "accessibilityTap")
  expect(swipeProgress.value).toBe(1)

  swipeProgress.value = 0
  fireEvent(tray, "accessibilityAction", {nativeEvent: {actionName: "activate"}})
  expect(swipeProgress.value).toBe(1)

  swipeProgress.value = 0
  fireEvent(tray, "accessibilityAction", {nativeEvent: {actionName: "unknown"}})
  expect(swipeProgress.value).toBe(0)

  fireEvent.press(screen.getByRole("button", {name: "home:openAllApps"}))
  expect(openGrid).toHaveBeenCalledTimes(1)
})
