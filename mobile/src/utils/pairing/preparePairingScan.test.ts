import {PermissionsAndroid, Platform} from "react-native"

import {engine} from "@mentra/engine"

import {showAlert} from "@/utils/AlertUtils"
import {PermissionFeatures, checkConnectivityRequirementsUI, requestFeaturePermissions} from "@/utils/PermissionsUtils"

import {preparePairingScan} from "./preparePairingScan"

jest.mock("@mentra/engine", () => ({
  engine: {miniapps: {stopAll: jest.fn()}},
}))

jest.mock("@/../../cloud/packages/types/src", () => ({
  DeviceTypes: {SIMULATED: "Simulated"},
}))

jest.mock("@/i18n", () => ({translate: (key: string) => key}))

jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {
    BLUETOOTH: "bluetooth",
    LOCATION: "location",
    MICROPHONE: "microphone",
    PHONE_STATE: "phone_state",
  },
  checkConnectivityRequirementsUI: jest.fn(),
  requestFeaturePermissions: jest.fn(),
}))

const originalPlatformOS = Platform.OS
const originalPlatformVersion = Platform.Version

describe("preparePairingScan", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.defineProperty(Platform, "OS", {value: "ios", configurable: true})
    ;(checkConnectivityRequirementsUI as jest.Mock).mockResolvedValue(true)
    ;(requestFeaturePermissions as jest.Mock).mockResolvedValue(true)
    ;(engine.miniapps.stopAll as jest.Mock).mockResolvedValue(undefined)
  })

  afterAll(() => {
    Object.defineProperty(Platform, "OS", {value: originalPlatformOS, configurable: true})
    Object.defineProperty(Platform, "Version", {value: originalPlatformVersion, configurable: true})
  })

  it("checks iOS connectivity and permissions before allowing the scan", async () => {
    await expect(preparePairingScan("Mentra Live")).resolves.toBe(true)

    expect(checkConnectivityRequirementsUI).toHaveBeenCalledTimes(1)
    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(1, PermissionFeatures.BLUETOOTH)
    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(2, PermissionFeatures.MICROPHONE)
    expect(engine.miniapps.stopAll).toHaveBeenCalledTimes(1)
  })

  it("does not stop miniapps or continue when connectivity is unavailable", async () => {
    ;(checkConnectivityRequirementsUI as jest.Mock).mockResolvedValue(false)

    await expect(preparePairingScan("Mentra Live")).resolves.toBe(false)

    expect(requestFeaturePermissions).not.toHaveBeenCalled()
    expect(engine.miniapps.stopAll).not.toHaveBeenCalled()
  })

  it("surfaces a Bluetooth denial and leaves pairing where it started", async () => {
    ;(requestFeaturePermissions as jest.Mock).mockResolvedValueOnce(false)

    await expect(preparePairingScan("Mentra Live")).resolves.toBe(false)

    expect(showAlert).toHaveBeenCalledWith(
      "pairing:bluetoothPermissionRequiredTitle",
      "pairing:bluetoothPermissionRequiredMessageAlt",
      [{text: "common:ok"}],
    )
    expect(engine.miniapps.stopAll).not.toHaveBeenCalled()
  })

  it("preserves the Android permission order before checking connectivity", async () => {
    Object.defineProperty(Platform, "OS", {value: "android", configurable: true})
    Object.defineProperty(Platform, "Version", {value: 33, configurable: true})
    const grantedBluetoothPermissions = {
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN]: PermissionsAndroid.RESULTS.GRANTED,
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]: PermissionsAndroid.RESULTS.GRANTED,
      [PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE]: PermissionsAndroid.RESULTS.GRANTED,
    } as Awaited<ReturnType<typeof PermissionsAndroid.requestMultiple>>
    const requestMultiple = jest
      .spyOn(PermissionsAndroid, "requestMultiple")
      .mockResolvedValue(grantedBluetoothPermissions)

    await expect(preparePairingScan("Mentra Live")).resolves.toBe(true)

    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(1, PermissionFeatures.PHONE_STATE)
    expect(requestMultiple).toHaveBeenCalledWith([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
    ])
    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(2, PermissionFeatures.BLUETOOTH)
    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(3, PermissionFeatures.MICROPHONE)
    expect(requestFeaturePermissions).toHaveBeenNthCalledWith(4, PermissionFeatures.LOCATION)
    expect(checkConnectivityRequirementsUI).toHaveBeenCalledTimes(1)
    requestMultiple.mockRestore()
  })
})
