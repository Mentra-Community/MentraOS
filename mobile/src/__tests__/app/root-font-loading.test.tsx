import {act, render} from "@testing-library/react-native"
import {useFonts} from "expo-font"
import * as SplashScreen from "expo-splash-screen"
import type {ReactNode} from "react"

import Root from "@/app/_layout"
import {useNavigationStore} from "@/stores/navigation"

jest.mock("react-native-get-random-values", () => ({}))
jest.mock("@/utils/polyfills/event", () => ({}))
jest.mock("@/global.css", () => ({}))
jest.mock("@sentry/react-native", () => ({wrap: (component: unknown) => component}))
jest.mock("expo-font", () => ({useFonts: jest.fn()}))
jest.mock("expo-router", () => ({useNavigationContainerRef: () => null}))
jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(),
  setOptions: jest.fn(),
  hideAsync: jest.fn(),
}))
jest.mock("@/effects/SentrySetup", () => ({SentrySetup: jest.fn(), SentryNavigationIntegration: {}}))
jest.mock("@/theme", () => ({customFontsToLoad: {redHatDisplayRegular: 1}}))
jest.mock("@/i18n", () => ({initI18n: jest.fn().mockResolvedValue(undefined)}))
jest.mock("@/utils/formatDate", () => ({loadDateFnsLocale: jest.fn().mockResolvedValue(undefined)}))
jest.mock("@mentra/engine", () => ({engine: {settings: {loadAll: jest.fn()}}}))
jest.mock("@mentra/engine-host-internal", () => ({logBuffer: {startConsoleInterception: jest.fn()}}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/contexts/AllProviders", () => ({AllProviders: ({children}: {children: ReactNode}) => children}))
jest.mock("@/effects/AllEffects", () => ({
  AllEffects: () => {
    const {Text} = require("react-native")
    return <Text>App content</Text>
  },
}))

it("waits for fonts before showing content or resetting navigation on a warm relaunch", async () => {
  const replaceAll = jest.fn()
  ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replaceAll})
  jest.mocked(useFonts).mockReturnValue([false, null])
  const cold = render(<Root />)
  await act(async () => {})
  expect(cold.queryByText("App content")).toBeNull()
  expect(SplashScreen.hideAsync).not.toHaveBeenCalled()

  jest.mocked(useFonts).mockReturnValue([true, null])
  cold.rerender(<Root />)
  expect(cold.getByText("App content")).toBeTruthy()
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1)
  expect(replaceAll).not.toHaveBeenCalled()
  cold.unmount()

  jest.mocked(useFonts).mockReturnValue([false, null])
  const warm = render(<Root />)
  await act(async () => {})
  expect(warm.queryByText("App content")).toBeNull()
  expect(replaceAll).not.toHaveBeenCalled()
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1)

  jest.mocked(useFonts).mockReturnValue([true, null])
  warm.rerender(<Root />)
  expect(warm.getByText("App content")).toBeTruthy()
  expect(replaceAll).toHaveBeenCalledWith("/")
  expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(2)
})
