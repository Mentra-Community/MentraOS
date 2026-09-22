import {act, fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import type {SharedValue} from "react-native-reanimated"

import AppSwitcherButton from "./AppSwitcherButtton"

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
jest.mock("@/components/home/AppIcon", () => () => null)
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
