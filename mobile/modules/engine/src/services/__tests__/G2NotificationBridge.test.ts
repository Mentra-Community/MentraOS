/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

// The bridge is Android-only, so the whole suite runs as Android.
mock.module("react-native", () => ({
  __esModule: true,
  Platform: {OS: "android"},
}))

let capturedHandler: ((event: unknown) => void) | null = null
const mockRemove = mock(() => {})
const mockAddListener = mock((_event: string, handler: (event: unknown) => void) => {
  capturedHandler = handler
  return {remove: mockRemove}
})
mock.module("@mentra/crust", () => ({
  __esModule: true,
  default: {addListener: mockAddListener},
}))

const mockSendPhoneNotification = mock(() => Promise.resolve())
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {sendPhoneNotification: mockSendPhoneNotification},
}))

const values: Record<string, unknown> = {}
mock.module("../../stores/settings", () => ({
  SETTINGS: {g2_native_notifications: {key: "g2_native_notifications"}},
  useSettingsStore: {
    getState: () => ({getSetting: (key: string) => values[key]}),
  },
}))

let deviceModel = "Even Realities G2"
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({deviceModel}),
  },
}))

const {startG2NotificationBridge, stopG2NotificationBridge} = require("../G2NotificationBridge")

const NOTIFICATION = {
  notificationId: "1237",
  app: "Snapchat",
  title: "Sarah",
  content: "is typing...",
  priority: 1,
  timestamp: 1785737563000,
  packageName: "com.snapchat.android",
}

describe("G2NotificationBridge", () => {
  beforeEach(() => {
    stopG2NotificationBridge()
    mockAddListener.mockClear()
    mockRemove.mockClear()
    mockSendPhoneNotification.mockClear()
    capturedHandler = null
    deviceModel = "Even Realities G2"
    values.g2_native_notifications = true
  })

  test("pushes to the glasses when the toggle is on and a G2 is connected", () => {
    startG2NotificationBridge()
    capturedHandler?.(NOTIFICATION)

    expect(mockSendPhoneNotification).toHaveBeenCalledWith({
      notificationId: "1237",
      packageName: "com.snapchat.android",
      appName: "Snapchat",
      title: "Sarah",
      subtitle: "",
      body: "is typing...",
      timestampMs: 1785737563000,
      action: 0,
    })
  })

  test("pushes nothing while the toggle is off", () => {
    values.g2_native_notifications = false
    startG2NotificationBridge()
    capturedHandler?.(NOTIFICATION)

    expect(mockSendPhoneNotification).not.toHaveBeenCalled()
  })

  test("pushes nothing on non-G2 glasses", () => {
    deviceModel = "Mentra Live"
    startG2NotificationBridge()
    capturedHandler?.(NOTIFICATION)

    expect(mockSendPhoneNotification).not.toHaveBeenCalled()
  })

  test("reads the toggle per notification, so flipping it needs no resubscribe", () => {
    startG2NotificationBridge()

    values.g2_native_notifications = false
    capturedHandler?.(NOTIFICATION)
    expect(mockSendPhoneNotification).not.toHaveBeenCalled()

    values.g2_native_notifications = true
    capturedHandler?.(NOTIFICATION)
    expect(mockSendPhoneNotification).toHaveBeenCalledTimes(1)
    expect(mockAddListener).toHaveBeenCalledTimes(1)
  })

  test("subscribes once across repeated starts and unsubscribes on stop", () => {
    startG2NotificationBridge()
    startG2NotificationBridge()
    expect(mockAddListener).toHaveBeenCalledTimes(1)

    stopG2NotificationBridge()
    expect(mockRemove).toHaveBeenCalledTimes(1)
  })

  test("a failed push is swallowed rather than surfacing as an unhandled rejection", () => {
    mockSendPhoneNotification.mockImplementationOnce(() => Promise.reject(new Error("not connected")))
    startG2NotificationBridge()

    expect(() => capturedHandler?.(NOTIFICATION)).not.toThrow()
  })
})
