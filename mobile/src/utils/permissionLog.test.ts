import {Platform} from "react-native"

import {logPermissionAlert, permissionKind} from "./permissionLog"

const mockLogPermission = jest.fn()
jest
  .spyOn(require("expo-modules-core"), "requireOptionalNativeModule")
  .mockImplementation(() => ({logPermission: mockLogPermission}))

describe("logPermissionAlert", () => {
  const originalOS = Platform.OS
  let log: jest.SpyInstance

  beforeEach(() => {
    mockLogPermission.mockClear()
    log = jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    Object.defineProperty(Platform, "OS", {value: originalOS, configurable: true, writable: true})
  })

  it("logs one greppable line with the system's answer, and sends it to the unified log on iOS", () => {
    Object.defineProperty(Platform, "OS", {value: "ios", configurable: true, writable: true})
    logPermissionAlert(
      "local_network",
      "NWConnection waiting unsatisfiedReason=localNetworkDenied for 5s",
      "local_network_permission_required",
    )
    const line = log.mock.calls[0][0] as string
    expect(line).toMatch(
      /^\[Permission\] local_network: NWConnection waiting unsatisfiedReason=localNetworkDenied for 5s → alert local_network_permission_required at \d{4}-\d\d-\d\dT/,
    )
    expect(mockLogPermission).toHaveBeenCalledWith(line)
  })

  it("serializes structured answers and keeps Android on the console", () => {
    Object.defineProperty(Platform, "OS", {value: "android", configurable: true, writable: true})
    logPermissionAlert("bluetooth", {"android.permission.BLUETOOTH_SCAN": "never_ask_again"}, "bluetooth_permission")
    expect(log.mock.calls[0][0]).toContain(
      '[Permission] bluetooth: {"android.permission.BLUETOOTH_SCAN":"never_ask_again"} → alert bluetooth_permission',
    )
    expect(mockLogPermission).not.toHaveBeenCalled()
  })

  it("never lets logging break the alert", () => {
    Object.defineProperty(Platform, "OS", {value: "ios", configurable: true, writable: true})
    mockLogPermission.mockImplementationOnce(() => {
      throw new Error("native module gone")
    })
    expect(() => logPermissionAlert("camera", undefined, "qr_scan")).not.toThrow()
  })

  it("maps permission feature names to kinds", () => {
    expect(permissionKind("Background Location")).toBe("location")
    expect(permissionKind("Notification Access")).toBe("notifications")
    expect(permissionKind("Glasses Camera")).toBe("camera")
    expect(permissionKind("Phone State")).toBe("permissions")
  })
})
