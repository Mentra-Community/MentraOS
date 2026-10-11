import {act, fireEvent, render} from "@testing-library/react-native"
import * as Clipboard from "expo-clipboard"
import {TouchableOpacity} from "react-native"

import {VersionInfo} from "./VersionInfo"

const mockSetSuperMode = jest.fn()

jest.mock("@mentra/engine", () => ({
  engine: {session: {status: {audioTransport: "test"}, onStatus: jest.fn()}},
  SETTINGS: {
    debug_mode: {key: "debug_mode"},
    super_mode: {key: "super_mode"},
    cloud_core_url: {key: "cloud_core_url"},
  },
  useSetting: (key: string) => [key === "debug_mode", key === "super_mode" ? mockSetSuperMode : jest.fn()],
  getAppBuildInfo: () => ({appVersion: "test", buildBranch: "test", buildTime: "test", buildCommit: "test"}),
}))
jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({user: {id: "private-id", email: "private@example.test"}}),
}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({themed: () => ({})})}))
jest.mock("@/hooks/useEngineSnapshot", () => ({useEngineSnapshot: () => ({audioTransport: "test"})}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/services/cloudClient", () => ({
  resolvedEndpoints: () => ({core: "https://private.example.test", runtime: "test"}),
}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: jest.fn()}))
jest.mock("@/components/ignite", () => ({Text: require("react-native").Text}))
jest.mock("expo-clipboard", () => ({setStringAsync: jest.fn().mockResolvedValue(undefined)}))
jest.mock("react-native-toast-message", () => ({__esModule: true, default: {show: jest.fn()}}))

let now = 0
let info: jest.SpyInstance

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  now = 0
  jest.spyOn(performance, "now").mockImplementation(() => now)
  info = jest.spyOn(console, "info").mockImplementation(() => {})
})

afterEach(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
  jest.restoreAllMocks()
})

it("records timer activation at the existing ten-second threshold without copying on release", () => {
  const screen = render(<VersionInfo />)
  const footer = screen.UNSAFE_getByType(TouchableOpacity)
  fireEvent(footer, "pressIn")
  now = 9999
  act(() => jest.advanceTimersByTime(9999))
  expect(mockSetSuperMode).not.toHaveBeenCalled()
  now = 10000
  act(() => jest.advanceTimersByTime(1))
  fireEvent(footer, "pressOut")

  expect(mockSetSuperMode).toHaveBeenCalledTimes(1)
  expect(mockSetSuperMode).toHaveBeenCalledWith(true)
  expect(Clipboard.setStringAsync).not.toHaveBeenCalled()
  expect(info.mock.calls.map(([, fields]) => fields.phase)).toEqual([
    "press_in",
    "timer_requested",
    "timer_fired",
    "press_out",
  ])
  expect(info).toHaveBeenCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "timer_fired",
      pressId: 1,
      elapsedMs: 10000,
      requestedDurationMs: 10000,
      timerDelayMs: 0,
    }),
  )
  expect(info).toHaveBeenLastCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "press_out",
      elapsedMs: 10000,
      timerPending: false,
    }),
  )
})

it("records an overdue pending timer cancelled by release without claiming it fired", () => {
  const screen = render(<VersionInfo />)
  const footer = screen.UNSAFE_getByType(TouchableOpacity)
  fireEvent(footer, "pressIn")
  // Simulate the JS callback still queued when PressOut is delivered after the native hold.
  now = 10500
  fireEvent(footer, "pressOut")
  act(() => jest.advanceTimersByTime(20000))

  expect(mockSetSuperMode).not.toHaveBeenCalled()
  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1)
  expect(info.mock.calls.map(([, fields]) => fields.phase)).toEqual([
    "press_in",
    "timer_requested",
    "press_out",
    "timer_cancelled",
  ])
  expect(info).toHaveBeenCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "press_out",
      pressId: 1,
      elapsedMs: 10500,
      timerPending: true,
    }),
  )
  expect(info).toHaveBeenLastCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "timer_cancelled",
      pressId: 1,
      elapsedMs: 10500,
      reason: "press_out",
    }),
  )
  expect(JSON.stringify(info.mock.calls)).not.toMatch(/private|example\.test/)
})

it("correlates a delayed timer fire with its own press after an earlier cancellation", () => {
  const screen = render(<VersionInfo />)
  const footer = screen.UNSAFE_getByType(TouchableOpacity)
  fireEvent(footer, "pressIn")
  now = 1000
  fireEvent(footer, "pressOut")
  fireEvent(footer, "pressIn")
  now = 12000
  act(() => jest.advanceTimersByTime(10000))
  fireEvent(footer, "pressOut")

  expect(mockSetSuperMode).toHaveBeenCalledTimes(1)
  expect(Clipboard.setStringAsync).toHaveBeenCalledTimes(1)
  expect(info).toHaveBeenCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "timer_cancelled",
      pressId: 1,
      elapsedMs: 1000,
    }),
  )
  expect(info).toHaveBeenCalledWith(
    "[SUPER_MODE_PRESS]",
    expect.objectContaining({
      phase: "timer_fired",
      pressId: 2,
      elapsedMs: 11000,
      timerDelayMs: 1000,
    }),
  )
})
