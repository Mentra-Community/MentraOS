/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const FINE_LOCATION = "android.permission.ACCESS_FINE_LOCATION"
const BACKGROUND_LOCATION = "android.permission.ACCESS_BACKGROUND_LOCATION"

const permissionChecks = new Map<string, boolean>()
const permissionRequestResults = new Map<string, string>()

const androidCheck = mock(async (permission: string) => permissionChecks.get(permission) ?? false)
const androidRequest = mock(async (permission: string) => permissionRequestResults.get(permission) ?? "denied")
const androidRequestMultiple = mock(async (permissions: string[]) => {
  return Object.fromEntries(
    permissions.map((permission) => [permission, permissionRequestResults.get(permission) ?? "denied"]),
  )
})

mock.module("react-native", () => ({
  Linking: {openSettings: mock(async () => {})},
  PermissionsAndroid: {
    PERMISSIONS: {
      ACCESS_BACKGROUND_LOCATION: BACKGROUND_LOCATION,
      ACCESS_FINE_LOCATION: FINE_LOCATION,
      BLUETOOTH_ADVERTISE: "android.permission.BLUETOOTH_ADVERTISE",
      BLUETOOTH_CONNECT: "android.permission.BLUETOOTH_CONNECT",
      BLUETOOTH_SCAN: "android.permission.BLUETOOTH_SCAN",
      CAMERA: "android.permission.CAMERA",
      POST_NOTIFICATIONS: "android.permission.POST_NOTIFICATIONS",
      READ_CALENDAR: "android.permission.READ_CALENDAR",
      READ_PHONE_STATE: "android.permission.READ_PHONE_STATE",
      RECORD_AUDIO: "android.permission.RECORD_AUDIO",
      WRITE_CALENDAR: "android.permission.WRITE_CALENDAR",
    },
    RESULTS: {
      DENIED: "denied",
      GRANTED: "granted",
    },
    check: androidCheck,
    request: androidRequest,
    requestMultiple: androidRequestMultiple,
  },
  Platform: {OS: "android", Version: 30},
}))

mock.module("react-native-permissions", () => ({
  PERMISSIONS: {
    IOS: {
      BLUETOOTH: "ios.bluetooth",
      CALENDARS: "ios.calendars",
      CAMERA: "ios.camera",
      LOCATION_ALWAYS: "ios.location.always",
      LOCATION_WHEN_IN_USE: "ios.location.when_in_use",
      MICROPHONE: "ios.microphone",
    },
  },
  RESULTS: {
    GRANTED: "granted",
    LIMITED: "limited",
  },
  check: mock(async () => "granted"),
  request: mock(async () => "granted"),
}))

mock.module("../services/AppRegistry", () => ({
  default: {getInstalledMiniapps: mock(async () => [])},
}))

const {PermissionFeatures, permissions} = await import("./permissions")

describe("permissions facade", () => {
  beforeEach(() => {
    permissionChecks.clear()
    permissionRequestResults.clear()
    androidCheck.mockClear()
    androidRequest.mockClear()
    androidRequestMultiple.mockClear()
  })

  test("checks Android background location by requiring foreground and background grants", async () => {
    permissionChecks.set(FINE_LOCATION, true)
    permissionChecks.set(BACKGROUND_LOCATION, true)

    await expect(permissions.check(PermissionFeatures.BACKGROUND_LOCATION)).resolves.toBe(true)
    expect(androidCheck.mock.calls.map(([permission]) => permission)).toEqual([FINE_LOCATION, BACKGROUND_LOCATION])
  })

  test("reports Android background location missing when only foreground location is granted", async () => {
    permissionChecks.set(FINE_LOCATION, true)
    permissionChecks.set(BACKGROUND_LOCATION, false)

    await expect(permissions.check(PermissionFeatures.BACKGROUND_LOCATION)).resolves.toBe(false)
    expect(androidCheck.mock.calls.map(([permission]) => permission)).toEqual([FINE_LOCATION, BACKGROUND_LOCATION])
  })

  test("requests Android background location after foreground location is granted", async () => {
    permissionRequestResults.set(FINE_LOCATION, "granted")
    permissionRequestResults.set(BACKGROUND_LOCATION, "granted")
    permissionChecks.set(BACKGROUND_LOCATION, false)

    await expect(permissions.request(PermissionFeatures.BACKGROUND_LOCATION)).resolves.toBe(true)

    expect(androidRequestMultiple).toHaveBeenCalledWith([FINE_LOCATION])
    expect(androidCheck).toHaveBeenCalledWith(BACKGROUND_LOCATION)
    expect(androidRequest).toHaveBeenCalledWith(BACKGROUND_LOCATION)
  })

  test("does not request Android background location when foreground location is denied", async () => {
    permissionRequestResults.set(FINE_LOCATION, "denied")

    await expect(permissions.request(PermissionFeatures.BACKGROUND_LOCATION)).resolves.toBe(false)

    expect(androidRequestMultiple).toHaveBeenCalledWith([FINE_LOCATION])
    expect(androidCheck).not.toHaveBeenCalled()
    expect(androidRequest).not.toHaveBeenCalled()
  })
})
