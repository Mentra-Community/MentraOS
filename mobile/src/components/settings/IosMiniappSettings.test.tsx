import {SETTINGS, engine} from "@mentra/engine"
import {act, fireEvent, render} from "@testing-library/react-native"
import {Platform} from "react-native"

import IosMiniappSettings from "./IosMiniappSettings"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("./ToggleSetting", () => {
  const React = require("react")
  const {Switch, Text, View} = require("react-native")
  return {
    __esModule: true,
    default: (props: {subtitle: string; label: string}) =>
      React.createElement(
        View,
        null,
        React.createElement(Text, null, props.subtitle),
        React.createElement(Switch, {...props, accessibilityLabel: props.label}),
      ),
  }
})

describe("iOS miniapp debug settings", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  afterEach(() => {
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })
  beforeEach(async () => {
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    jest.replaceProperty(Platform, "OS", "ios")
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
    await engine.settings.set(SETTINGS.show_notify_ios.key, false)
  })
  afterEach(() => jest.restoreAllMocks())

  it("defaults both switches off and toggles either independently", async () => {
    const screen = render(<IosMiniappSettings />)
    const call = () => screen.getByTestId("debug-show-mentra-call-ios")
    const notify = () => screen.getByTestId("debug-show-notify-ios")
    expect(call().props.value).toBe(false)
    expect(notify().props.value).toBe(false)
    await act(async () => fireEvent(notify(), "valueChange", true))
    expect(engine.settings.get(SETTINGS.show_notify_ios.key)).toBe(true)
    expect(call().props.value).toBe(false)
    expect(notify().props.value).toBe(true)
    await act(async () => fireEvent(call(), "valueChange", true))
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(true)
    expect(call().props.value).toBe(true)
    expect(notify().props.value).toBe(true)
    await act(async () => fireEvent(notify(), "valueChange", false))
    expect(call().props.value).toBe(true)
    expect(notify().props.value).toBe(false)
  })

  it("does not add either switch on Android", () => {
    jest.replaceProperty(Platform, "OS", "android")
    const screen = render(<IosMiniappSettings />)
    expect(screen.queryByTestId("debug-show-mentra-call-ios")).toBeNull()
    expect(screen.queryByTestId("debug-show-notify-ios")).toBeNull()
  })
  it("forces only Call on for the build override and preserves its saved preference", async () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    const screen = render(<IosMiniappSettings />)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props).toMatchObject({value: true, disabled: true})
    expect(screen.getByText("debugSettings:mentraCallBuildOverride")).toBeTruthy()
    expect(screen.getByTestId("debug-show-notify-ios").props.value).toBe(false)
    await act(async () => fireEvent(screen.getByTestId("debug-show-notify-ios"), "valueChange", true))
    expect(engine.settings.get(SETTINGS.show_notify_ios.key)).toBe(true)
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    screen.rerender(<IosMiniappSettings />)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props).toMatchObject({value: false, disabled: false})
    expect(screen.getByTestId("debug-show-notify-ios").props.value).toBe(true)
  })
})
