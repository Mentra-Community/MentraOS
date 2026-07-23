/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const mockSetNotificationConfig = mock(() => Promise.resolve())
mock.module("@mentra/crust", () => ({
  __esModule: true,
  default: {
    setNotificationConfig: mockSetNotificationConfig,
  },
}))

const values: Record<string, unknown> = {}
let onSettingsChanged: (() => void) | null = null
const mockUnsubscribe = mock(() => {})

mock.module("../../stores/settings", () => ({
  SETTINGS: {
    android_notification_listener_enabled: {key: "android_notification_listener_enabled"},
    notifications_enabled: {key: "notifications_enabled"},
    notifications_blocklist: {key: "notifications_blocklist"},
  },
  useSettingsStore: {
    getState: () => ({
      getSetting: (key: string) => values[key],
    }),
    subscribe: (_selector: unknown, listener: () => void) => {
      onSettingsChanged = listener
      return mockUnsubscribe
    },
  },
}))

const {startPhoneNotificationsSync, stopPhoneNotificationsSync} = require("../PhoneNotificationsSync")

describe("PhoneNotificationsSync", () => {
  beforeEach(() => {
    stopPhoneNotificationsSync()
    mockSetNotificationConfig.mockClear()
    mockUnsubscribe.mockClear()
    onSettingsChanged = null
    Object.assign(values, {
      android_notification_listener_enabled: false,
      notifications_enabled: true,
      notifications_blocklist: [],
    })
  })

  test("keeps the Android listener disabled by default", () => {
    startPhoneNotificationsSync()

    expect(mockSetNotificationConfig).toHaveBeenCalledWith(false, true, [])
  })

  test("enables the listener only through the developer flag", () => {
    startPhoneNotificationsSync()
    values.android_notification_listener_enabled = true
    onSettingsChanged?.()

    expect(mockSetNotificationConfig).toHaveBeenLastCalledWith(true, true, [])
  })

  test("keeps the user notification toggle subordinate to the developer flag", () => {
    Object.assign(values, {
      android_notification_listener_enabled: true,
      notifications_enabled: false,
      notifications_blocklist: ["com.example.noisy"],
    })

    startPhoneNotificationsSync()

    expect(mockSetNotificationConfig).toHaveBeenCalledWith(true, false, ["com.example.noisy"])
  })
})
