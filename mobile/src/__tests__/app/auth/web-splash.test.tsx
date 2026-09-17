import {act, render} from "@testing-library/react-native"
import {AppState, type AppStateStatus} from "react-native"

import WebSplash from "@/app/auth/web-splash"

const mockGoBack = jest.fn()
const mockProcessUrl = jest.fn()
const mockOpenAuthBrowser = jest.fn()
const mockShowAlert = jest.fn()

jest.mock("expo-router", () => ({useLocalSearchParams: () => ({url: "https://core.example/oauth/google/start"})}))
jest.mock("@/components/ignite", () => ({Screen: ({children}: {children: React.ReactNode}) => children}))
jest.mock("@/components/splash/SplashVideo", () => ({SplashVideo: () => null}))
jest.mock("@/contexts/DeeplinkContext", () => ({useDeeplink: () => ({processUrl: mockProcessUrl})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({goBack: mockGoBack})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockShowAlert(...args)}))
jest.mock("@/utils/auth/authErrors", () => ({mapAuthError: (error: Error) => error.message}))
jest.mock("@/utils/auth/openAuthBrowser", () => ({
  openAuthBrowser: (...args: unknown[]) => mockOpenAuthBrowser(...args),
}))

let finishBrowser: (completed: boolean) => void

beforeEach(() => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  mockOpenAuthBrowser.mockImplementation(
    () =>
      new Promise<boolean>((resolve) => {
        finishBrowser = resolve
      }),
  )
})
afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
})

it("keeps login open across password-manager app state changes", async () => {
  const listeners: Array<(state: AppStateStatus) => void> = []
  jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
    listeners.push(listener)
    return {remove: jest.fn()}
  })
  render(<WebSplash />)
  await act(async () => {
    for (const state of ["background", "active", "inactive", "active"] as const) {
      listeners.forEach((listener) => listener(state))
      jest.advanceTimersByTime(2000)
    }
  })

  expect(mockGoBack).not.toHaveBeenCalled()
  expect(mockOpenAuthBrowser).toHaveBeenCalledTimes(1)
})

it("returns to login when the user cancels the browser", async () => {
  render(<WebSplash />)
  await act(async () => {
    finishBrowser(false)
  })
  expect(mockGoBack).toHaveBeenCalledTimes(1)
})

it("does not navigate back after successful callback processing", async () => {
  render(<WebSplash />)
  await act(async () => {
    finishBrowser(true)
  })
  expect(mockGoBack).not.toHaveBeenCalled()
})

it("does not reopen the auth session on a component render", () => {
  const tree = render(<WebSplash />)
  tree.rerender(<WebSplash />)
  expect(mockOpenAuthBrowser).toHaveBeenCalledTimes(1)
})

it("does not pop another screen after the splash unmounts", async () => {
  const tree = render(<WebSplash />)
  tree.unmount()
  await act(async () => {
    finishBrowser(false)
  })
  expect(mockGoBack).not.toHaveBeenCalled()
})

it("returns to login and displays browser startup errors", async () => {
  mockOpenAuthBrowser.mockRejectedValue(new Error("browser unavailable"))
  render(<WebSplash />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(mockGoBack).toHaveBeenCalledTimes(1)
  expect(mockShowAlert).toHaveBeenCalledWith("common:error", "browser unavailable")
})
