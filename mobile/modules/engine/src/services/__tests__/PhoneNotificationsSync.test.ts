/// <reference types="bun-types" />
import {beforeEach, describe, expect, mock, test} from "bun:test"

const platform = {OS: "android"}
mock.module("react-native", () => ({Platform: platform}))
const configure = mock(() => Promise.resolve())
const send = mock(() => Promise.resolve())
const capture = mock(() => Promise.resolve())
mock.module("@mentra/crust", () => ({default: {setNotificationConfig: capture}}))
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  default: {configureNativeNotifications: configure, sendPhoneNotification: send},
}))
const values: Record<string, unknown> = {}
let settingsChanged: (() => void) | undefined
let glassesChanged: (() => void) | undefined
const glasses = {deviceModel: "G2", connection: {state: "connected", fullyBooted: true}}
const keys = [
  "android_notification_listener_enabled",
  "notifications_blocklist",
  "native_notifications_enabled",
  "native_notifications_auto_display",
  "native_notifications_duration",
  "native_notifications_do_not_disturb",
]
mock.module("../../stores/settings", () => ({
  SETTINGS: Object.fromEntries(keys.map((key) => [key, {key}])),
  useSettingsStore: {
    getState: () => ({getSetting: (key: string) => values[key]}),
    subscribe: (_selector: unknown, listener: () => void) => {
      settingsChanged = listener
      return () => {
        settingsChanged = undefined
      }
    },
  },
}))
mock.module("../../stores/glasses", () => ({
  isGlassesReady: (connection: typeof glasses.connection) => connection.state === "connected" && connection.fullyBooted,
  useGlassesStore: {
    getState: () => glasses,
    subscribe: (_selector: unknown, listener: () => void) => {
      glassesChanged = listener
      return () => {
        glassesChanged = undefined
      }
    },
  },
}))
mock.module("../../types/hardware", () => ({
  getModelCapabilities: (model: string) => ({hasNativeNotifications: model === "G2"}),
}))
const {
  startPhoneNotificationsSync: start,
  stopPhoneNotificationsSync: stop,
  setPhoneNotificationPresentationActive: activate,
  presentNativePhoneNotification: present,
  nativeNotificationCapabilities: capabilities,
} = require("../PhoneNotificationsSync")
const event = {
  notificationId: "n1",
  packageName: "com.example",
  app: "Example",
  title: "Title",
  content: "Body",
  timestamp: 42,
}

describe("shared phone notification policy", () => {
  beforeEach(() => {
    stop()
    configure.mockClear()
    send.mockClear()
    capture.mockClear()
    platform.OS = "android"
    glasses.deviceModel = "G2"
    glasses.connection = {state: "connected", fullyBooted: true}
    Object.assign(values, {
      android_notification_listener_enabled: true,
      notifications_blocklist: [],
      native_notifications_enabled: true,
      native_notifications_auto_display: true,
      native_notifications_duration: 5,
      native_notifications_do_not_disturb: false,
    })
  })
  test("capture stays enabled while Notify is stopped and firmware presentation is disabled", async () => {
    start()
    expect(capture).toHaveBeenCalledWith(true, [])
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: false})
    expect(await present(event)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
  test("Notify owns native presentation and stopping it sends disable", async () => {
    start()
    activate(true)
    expect(await present(event)).toBe(true)
    expect(send.mock.calls[0]?.[0]).toMatchObject({notificationId: "n1", body: "Body", action: 0})
    activate(false)
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: false})
    expect(await present(event)).toBe(false)
  })
  test("turning off native mode restores the host presentation route", async () => {
    start()
    activate(true)
    values.native_notifications_enabled = false
    settingsChanged?.()
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: false})
    expect(await present(event)).toBe(false)
  })
  test("blocklist is rechecked before a captured event is uploaded", async () => {
    start()
    activate(true)
    values.notifications_blocklist = ["com.example"]
    settingsChanged?.()
    expect(capture).toHaveBeenLastCalledWith(true, ["com.example"])
    expect(await present(event)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
  test("the capture kill switch also disables native presentation", async () => {
    start()
    activate(true)
    values.android_notification_listener_enabled = false
    settingsChanged?.()
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: false})
    expect(await present(event)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
  test("reconnect reapplies settings and disconnected events are not queued", async () => {
    start()
    activate(true)
    glasses.connection = {state: "disconnected", fullyBooted: false}
    glassesChanged?.()
    expect(await present(event)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    glasses.connection = {state: "connected", fullyBooted: true}
    glassesChanged?.()
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: true})
  })
  test("iOS configures authorized accessory presentation without uploading metadata", async () => {
    platform.OS = "ios"
    start()
    activate(true)
    expect(await present(event)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    expect(capabilities()).toMatchObject({contentAccess: "app_identity", perAppFiltering: false, removal: false})
  })
  test("quiet history and DND remain separate from the master switch", () => {
    values.native_notifications_auto_display = false
    values.native_notifications_do_not_disturb = true
    values.native_notifications_duration = 10
    start()
    activate(true)
    expect(configure.mock.calls.at(-1)?.[0]).toEqual({
      enabled: true,
      autoDisplay: false,
      durationSeconds: 10,
      doNotDisturb: true,
      blockedApps: [],
    })
  })
  test("unsupported glasses retain host presentation", async () => {
    glasses.deviceModel = "G1"
    start()
    activate(true)
    expect(configure).not.toHaveBeenCalled()
    expect(await present(event)).toBe(false)
  })
  test("shutdown disables firmware and removes subscriptions", () => {
    start()
    activate(true)
    stop()
    expect(configure.mock.calls.at(-1)?.[0]).toMatchObject({enabled: false})
    expect(settingsChanged).toBeUndefined()
    expect(glassesChanged).toBeUndefined()
  })
})
