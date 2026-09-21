import NetInfo from "@react-native-community/netinfo"
import {AppState, Linking, Platform, type AppStateStatus} from "react-native"
import WifiManager from "react-native-wifi-reborn"

import {
  completePhoneWifiPrompt,
  getPhoneWifiPrompt,
  registerPhoneWifiPromptHost,
  requestPhoneWifiPrompt,
} from "./phoneWifiPrompt"
import {isPhoneWifiEnabled, requestPhoneWifiEnable} from "./phoneWifi"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("react-native-wifi-reborn", () => ({__esModule: true, default: {isEnabled: jest.fn()}}))
jest.mock("@react-native-community/netinfo", () => ({__esModule: true, default: {refresh: jest.fn()}}))

const events = new Map<string, (state?: AppStateStatus) => void>()
const removed = jest.fn()
const originalPlatform = Platform.OS
let unmountHost: () => void

beforeEach(() => {
  unmountHost = registerPhoneWifiPromptHost()
  jest.useFakeTimers()
  jest.clearAllMocks()
  events.clear()
  Object.defineProperty(Platform, "OS", {configurable: true, value: "android"})
  Object.defineProperty(Platform, "Version", {configurable: true, value: 35})
  Object.defineProperty(AppState, "currentState", {configurable: true, value: "active"})
  jest.spyOn(AppState, "addEventListener").mockImplementation((event, handler) => {
    events.set(event, (state = "active") => handler(state))
    return {remove: removed}
  })
  jest.spyOn(Linking, "sendIntent").mockResolvedValue(undefined)
  jest.spyOn(Linking, "openSettings").mockResolvedValue(undefined)
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(false)
  ;(NetInfo.refresh as jest.Mock).mockResolvedValue({type: "cellular", isConnected: true})
})

afterEach(() => {
  unmountHost()
  jest.useRealTimers()
  jest.restoreAllMocks()
  Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
})

async function acceptPrompt() {
  await jest.advanceTimersByTimeAsync(0)
  expect(getPhoneWifiPrompt()).not.toBeNull()
  completePhoneWifiPrompt(true)
  await jest.advanceTimersByTimeAsync(0)
}

test("Android reads the radio, independent of the default internet route", async () => {
  await expect(isPhoneWifiEnabled()).resolves.toBe(false)
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(true)
  await expect(isPhoneWifiEnabled()).resolves.toBe(true)
  expect(NetInfo.refresh).not.toHaveBeenCalled()
})

test("iOS reports unknown on cellular, never a false Wi-Fi-off diagnosis", async () => {
  Object.defineProperty(Platform, "OS", {value: "ios"})
  await expect(isPhoneWifiEnabled()).resolves.toBeNull()
  ;(NetInfo.refresh as jest.Mock).mockResolvedValue({type: "wifi", isConnected: true})
  await expect(isPhoneWifiEnabled()).resolves.toBe(true)
})

test("enabled Wi-Fi skips the prompt and settings", async () => {
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(true)
  await expect(requestPhoneWifiEnable()).resolves.toEqual({enabled: true, cancelled: false})
  expect(getPhoneWifiPrompt()).toBeNull()
  expect(Linking.sendIntent).not.toHaveBeenCalled()
})

test("cancel keeps settings closed", async () => {
  const pending = requestPhoneWifiEnable("Calling needs Wi-Fi")
  await jest.advanceTimersByTimeAsync(0)
  expect(getPhoneWifiPrompt()?.message).toContain("Calling needs Wi-Fi")
  completePhoneWifiPrompt(false)
  await expect(pending).resolves.toEqual({enabled: false, cancelled: true})
  expect(Linking.sendIntent).not.toHaveBeenCalled()
})

test.each([true, false])("panel focus rechecks the radio (%s) and cleans up listeners", async (enabled) => {
  const pending = requestPhoneWifiEnable()
  await acceptPrompt()
  expect(Linking.sendIntent).toHaveBeenCalledWith("android.settings.panel.action.WIFI")
  events.get("blur")!()
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(enabled)
  events.get("focus")!()
  await jest.advanceTimersByTimeAsync(500)
  await expect(pending).resolves.toEqual({enabled, cancelled: false})
  expect(removed).toHaveBeenCalledTimes(3)
  expect(jest.getTimerCount()).toBe(0)
})

test("missing panel falls back to Wi-Fi settings; background/active also resumes", async () => {
  ;(Linking.sendIntent as jest.Mock).mockRejectedValueOnce(new Error("No panel"))
  const pending = requestPhoneWifiEnable()
  await acceptPrompt()
  expect(Linking.sendIntent).toHaveBeenLastCalledWith("android.settings.WIFI_SETTINGS")
  events.get("change")!("background")
  events.get("change")!("active")
  await jest.advanceTimersByTimeAsync(500)
  await pending
})

test("iOS opens public app settings and preserves unknown on return", async () => {
  Object.defineProperty(Platform, "OS", {value: "ios"})
  const pending = requestPhoneWifiEnable()
  await acceptPrompt()
  expect(Linking.openSettings).toHaveBeenCalledTimes(1)
  events.get("change")!("inactive")
  events.get("change")!("active")
  await jest.advanceTimersByTimeAsync(500)
  await expect(pending).resolves.toEqual({enabled: null, cancelled: false})
})

test("settings failure rejects and releases the prompt lock", async () => {
  ;(Linking.sendIntent as jest.Mock).mockRejectedValue(new Error("Settings unavailable"))
  const pending = requestPhoneWifiEnable()
  const assertion = expect(pending).rejects.toThrow("Settings unavailable")
  await acceptPrompt()
  await assertion
  expect(removed).toHaveBeenCalledTimes(3)
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(true)
  await expect(requestPhoneWifiEnable()).resolves.toEqual({enabled: true, cancelled: false})
})

test("concurrent prompts are rejected and an abandoned settings visit is bounded", async () => {
  const pending = requestPhoneWifiEnable()
  await expect(requestPhoneWifiEnable()).rejects.toMatchObject({code: "REQUEST_ABORTED"})
  await acceptPrompt()
  await jest.advanceTimersByTimeAsync(5 * 60_000)
  await expect(pending).resolves.toEqual({enabled: null, cancelled: true})
  expect(removed).toHaveBeenCalledTimes(3)
})

test("replacement and host unmount settle the prompt and release its lock", async () => {
  const pending = requestPhoneWifiEnable()
  await jest.advanceTimersByTimeAsync(0)
  const firstId = getPhoneWifiPrompt()!.id
  const replacement = requestPhoneWifiPrompt({title: "Wi-Fi", message: "Replacement", actionLabel: "Settings"})
  await expect(pending).resolves.toEqual({enabled: false, cancelled: true})
  completePhoneWifiPrompt(true, firstId)
  expect(getPhoneWifiPrompt()).not.toBeNull()
  completePhoneWifiPrompt(false)
  await expect(replacement).resolves.toBe(false)
  const next = requestPhoneWifiEnable()
  await jest.advanceTimersByTimeAsync(0)
  expect(getPhoneWifiPrompt()).not.toBeNull()
  completePhoneWifiPrompt(false)
  await expect(next).resolves.toEqual({enabled: false, cancelled: true})
})

test("host unmount during a Wi-Fi read cannot create an orphaned prompt", async () => {
  let finishRead!: (enabled: boolean) => void
  ;(WifiManager.isEnabled as jest.Mock).mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finishRead = resolve
    }),
  )
  const pending = requestPhoneWifiEnable()
  unmountHost()
  unmountHost = () => {}
  finishRead(false)
  await expect(pending).resolves.toEqual({enabled: false, cancelled: true})
  expect(getPhoneWifiPrompt()).toBeNull()
  unmountHost = registerPhoneWifiPromptHost()
  ;(WifiManager.isEnabled as jest.Mock).mockResolvedValue(true)
  await expect(requestPhoneWifiEnable()).resolves.toEqual({enabled: true, cancelled: false})
})
