import {SETTINGS, engine} from "@mentra/engine"
import {act, fireEvent, render} from "@testing-library/react-native"
import {Platform} from "react-native"

import IosCallSetting from "./IosCallSetting"

jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: jest.fn()}))
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

describe("iOS-only Call debug setting", () => {
  const originalOverride = process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
  beforeEach(async () => {
    jest.replaceProperty(Platform, "OS", "ios")
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    await engine.settings.set(SETTINGS.show_mentra_call_ios.key, false)
  })
  afterEach(() => {
    jest.restoreAllMocks()
    if (originalOverride === undefined) delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    else process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = originalOverride
  })

  it("defaults off and writes the persistent debug setting when toggled", async () => {
    const screen = render(<IosCallSetting />)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props.value).toBe(false)
    await act(async () => fireEvent(screen.getByTestId("debug-show-mentra-call-ios"), "valueChange", true))
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(true)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props.value).toBe(true)
  })

  it("shows an enabled, disabled switch for the build override without changing the saved setting", () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    const screen = render(<IosCallSetting />)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props).toMatchObject({value: true, disabled: true})
    expect(screen.getByText("debugSettings:mentraCallBuildOverride")).toBeTruthy()
    expect(engine.settings.get(SETTINGS.show_mentra_call_ios.key)).toBe(false)
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS
    screen.rerender(<IosCallSetting />)
    expect(screen.getByTestId("debug-show-mentra-call-ios").props).toMatchObject({value: false, disabled: false})
  })

  it("does not add a switch on Android even with the override", () => {
    jest.replaceProperty(Platform, "OS", "android")
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS = "true"
    expect(render(<IosCallSetting />).queryByTestId("debug-show-mentra-call-ios")).toBeNull()
  })
})
