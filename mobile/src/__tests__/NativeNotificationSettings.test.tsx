import React from "react"
import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import {Platform} from "react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import NativeNotificationSettings from "@/components/settings/NativeNotificationSettings"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => {
  const React = require("react")
  const {Text, Pressable} = require("react-native")
  return {
    Text: ({tx, children}: {tx?: string; children?: React.ReactNode}) =>
      React.createElement(Text, null, tx ?? children),
    Button: ({tx, onPress}: {tx: string; onPress: () => void}) =>
      React.createElement(Pressable, {onPress}, React.createElement(Text, null, tx)),
  }
})
jest.mock("@/components/settings/ToggleSetting", () => {
  const React = require("react")
  const {Text, Pressable} = require("react-native")
  return {
    __esModule: true,
    default: ({
      label,
      value,
      onValueChange,
    }: {
      label: string
      value: boolean
      onValueChange: (value: boolean) => void
    }) =>
      React.createElement(
        Pressable,
        {
          accessibilityRole: "switch",
          accessibilityLabel: label,
          accessibilityState: {checked: value},
          onPress: () => onValueChange(!value),
        },
        React.createElement(Text, null, label),
      ),
  }
})
jest.mock("@/components/settings/NumberSetting", () => ({__esModule: true, default: () => null}))

describe("native notification settings", () => {
  const originalPlatform = Platform.OS
  beforeEach(async () => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: "ios"})
    ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "connected", fullyBooted: true})
    ;(engine.glasses.info as jest.Mock).mockReturnValue({model: "Even Realities G2"})
    await useSettingsStore.getState().setSetting(SETTINGS.native_notifications_enabled.key, true, false)
    ;(engine.phoneNotifications.nativeCapabilities as jest.Mock).mockReturnValue({supported: true})
    ;(engine.phoneNotifications.nativeStatus as jest.Mock).mockResolvedValue({
      supported: true,
      state: "submitted",
      authorization: "not_authorized",
    })
  })
  afterAll(() => {
    Object.defineProperty(Platform, "OS", {configurable: true, value: originalPlatform})
  })

  it("explains iOS content and permission limits without showing Android access controls", async () => {
    const ui = render(<NativeNotificationSettings />)
    await waitFor(() => expect(engine.phoneNotifications.nativeStatus).toHaveBeenCalled())
    expect(ui.getByText("settings:nativeNotificationsAncs")).toBeTruthy()
    expect(ui.getByText("settings:nativeNotificationsIosContent")).toBeTruthy()
    expect(ui.queryByText("settings:nativeNotificationsGrantAccess")).toBeNull()
  })

  it("updates the shared master setting and hides dependent controls", async () => {
    const ui = render(<NativeNotificationSettings />)
    await act(async () => fireEvent.press(ui.getByLabelText("settings:nativeNotificationsTitle")))
    expect(useSettingsStore.getState().getSetting(SETTINGS.native_notifications_enabled.key)).toBe(false)
    expect(ui.queryByText("settings:nativeNotificationsPopups")).toBeNull()
  })

  it("shows a real interrupted-transfer state and unsubscribes on unmount", async () => {
    const unsubscribe = jest.fn()
    ;(engine.phoneNotifications.onNativeStatus as jest.Mock).mockReturnValueOnce(unsubscribe)
    ;(engine.phoneNotifications.nativeStatus as jest.Mock).mockResolvedValueOnce({
      supported: true,
      state: "needs_reconnect",
      authorization: "authorized",
    })
    const ui = render(<NativeNotificationSettings />)
    await waitFor(() => expect(ui.getByText("settings:nativeNotificationsReconnect")).toBeTruthy())
    ui.unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})
