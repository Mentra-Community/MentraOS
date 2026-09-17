import * as WebBrowser from "expo-web-browser"
import {Platform} from "react-native"

import {openAuthBrowser} from "./openAuthBrowser"

jest.mock("expo-web-browser", () => ({openAuthSessionAsync: jest.fn(), openBrowserAsync: jest.fn()}))

const callbackUrl = "com.mentra://auth/callback?code=handoff&state=state"

beforeEach(() => {
  jest.clearAllMocks()
  jest.replaceProperty(Platform, "OS", "android")
})

afterEach(() => jest.restoreAllMocks())

it("awaits callback processing from the native auth-session result", async () => {
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({type: "success", url: callbackUrl})
  let finish!: () => void
  const processUrl = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const finished = jest.fn()
  const result = openAuthBrowser("https://core.example/oauth/google/start", processUrl).then(finished)
  await Promise.resolve()

  expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
    "https://core.example/oauth/google/start",
    "com.mentra://auth/callback",
  )
  expect(processUrl).toHaveBeenCalledWith(callbackUrl)
  expect(finished).not.toHaveBeenCalled()
  finish()
  await result
  expect(finished).toHaveBeenCalledWith(true)
})

it.each(["cancel", "dismiss"] as const)("returns false for %s without exchanging credentials", async (type) => {
  jest.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({type} as WebBrowser.WebBrowserResult)
  const processUrl = jest.fn()
  expect(await openAuthBrowser("https://core.example/oauth/google/start", processUrl)).toBe(false)
  expect(processUrl).not.toHaveBeenCalled()
})

it("propagates browser failures to the caller's error handling", async () => {
  jest.mocked(WebBrowser.openAuthSessionAsync).mockRejectedValue(new Error("browser unavailable"))
  await expect(openAuthBrowser("https://core.example/oauth/google/start", jest.fn())).rejects.toThrow(
    "browser unavailable",
  )
})

it.each([
  ["cancel", false],
  ["dismiss", true],
] as const)("on iOS treats Safari %s as completed=%s without an auth-session prompt", async (type, completed) => {
  jest.replaceProperty(Platform, "OS", "ios")
  jest.mocked(WebBrowser.openBrowserAsync).mockResolvedValue({type} as WebBrowser.WebBrowserResult)
  const processUrl = jest.fn()

  expect(await openAuthBrowser("https://core.example/oauth/google/start", processUrl)).toBe(completed)
  expect(WebBrowser.openBrowserAsync).toHaveBeenCalledWith("https://core.example/oauth/google/start")
  expect(WebBrowser.openAuthSessionAsync).not.toHaveBeenCalled()
  // The native Linking event is handled by DeeplinkProvider on iOS.
  expect(processUrl).not.toHaveBeenCalled()
})

it("on iOS waits for Safari to close before settling", async () => {
  jest.replaceProperty(Platform, "OS", "ios")
  let close!: (result: WebBrowser.WebBrowserResult) => void
  jest.mocked(WebBrowser.openBrowserAsync).mockReturnValue(new Promise((resolve) => (close = resolve)))
  const finished = jest.fn()
  const result = openAuthBrowser("https://core.example/oauth/google/start", jest.fn()).then(finished)
  await Promise.resolve()

  expect(finished).not.toHaveBeenCalled()
  close({type: "cancel"} as WebBrowser.WebBrowserResult)
  await result
  expect(finished).toHaveBeenCalledWith(false)
})
