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
      android_notification_listener_enabled: true,
      notifications_blocklist: [],
    })
  })

  test("requests Android listening by default", () => {
    startPhoneNotificationsSync()

    expect(mockSetNotificationConfig).toHaveBeenCalledWith(true, [])
  })

  test("keeps the debug setting as an emergency kill switch", () => {
    startPhoneNotificationsSync()
    values.android_notification_listener_enabled = false
    onSettingsChanged?.()

    expect(mockSetNotificationConfig).toHaveBeenLastCalledWith(false, [])
  })

  test("syncs the per-app blocklist without adding another listener gate", () => {
    Object.assign(values, {
      android_notification_listener_enabled: true,
      notifications_blocklist: ["com.example.noisy"],
    })

    startPhoneNotificationsSync()

    expect(mockSetNotificationConfig).toHaveBeenCalledWith(true, ["com.example.noisy"])
  })
})
