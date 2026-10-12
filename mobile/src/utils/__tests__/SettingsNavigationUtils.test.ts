import CrustModule from "@mentra/crust"
import {Linking, Platform} from "react-native"

import {SettingsNavigationUtils} from "../SettingsNavigationUtils"

jest.mock("@mentra/crust", () => ({
  __esModule: true,
  default: {isIOSAppOnMac: false, openBluetoothSettings: jest.fn()},
}))

const originalPlatform = Platform.OS

describe("Bluetooth Settings navigation", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Platform.OS = "ios"
    Object.assign(CrustModule, {isIOSAppOnMac: false})
    jest.spyOn(Linking, "openURL").mockResolvedValue(undefined)
    jest.spyOn(Linking, "canOpenURL").mockResolvedValue(true)
  })
  afterEach(() => {
    Platform.OS = originalPlatform
    jest.restoreAllMocks()
  })

  it("uses the existing iPhone Settings destination", async () => {
    expect(await SettingsNavigationUtils.openBluetoothSettings()).toBe(true)
    expect(Linking.openURL).toHaveBeenCalledWith("App-prefs:")
  })

  it("falls back to app settings when the general Settings URL is unavailable", async () => {
    ;(Linking.canOpenURL as jest.Mock).mockResolvedValue(false)
    await SettingsNavigationUtils.openBluetoothSettings()
    expect(Linking.openURL).toHaveBeenCalledWith("app-settings:")
  })

  it("opens System Settings Bluetooth for iOS apps running natively on Mac", async () => {
    Object.assign(CrustModule, {isIOSAppOnMac: true})
    await SettingsNavigationUtils.openBluetoothSettings()
    expect(Linking.openURL).toHaveBeenCalledWith("x-apple.systempreferences:com.apple.Bluetooth")
  })

  it("keeps Android's native Bluetooth Settings action", async () => {
    Platform.OS = "android"
    await SettingsNavigationUtils.openBluetoothSettings()
    expect(CrustModule.openBluetoothSettings).toHaveBeenCalled()
    expect(Linking.openURL).not.toHaveBeenCalled()
  })

  it("reports a failed settings launch so the caller can show a fallback instruction", async () => {
    jest.spyOn(console, "error").mockImplementation(() => {})
    ;(Linking.openURL as jest.Mock).mockRejectedValue(new Error("not available"))
    expect(await SettingsNavigationUtils.openBluetoothSettings()).toBe(false)
  })
})
