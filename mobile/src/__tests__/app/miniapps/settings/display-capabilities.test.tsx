import React from "react"
import {fireEvent, render} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"

import DashboardSettingsScreen from "@/app/miniapps/settings/dashboard"
import ScreenSettingsScreen from "@/app/miniapps/settings/position"

jest.mock("expo-router", () => ({useFocusEffect: jest.fn()}))

jest.mock("@/components/ignite", () => {
  const {View} = require("react-native")
  return {Header: () => null, Screen: View}
})
jest.mock("@/components/settings/SliderSetting", () => {
  const {Text} = require("react-native")
  return ({label, min, max}: {label: string; min: number; max: number}) => <Text>{`${label}: ${min}-${max}`}</Text>
})
jest.mock("@/components/settings/ToggleSetting", () => () => null)
jest.mock("@/components/settings/HeadUpAngleComponent", () => {
  const {Text} = require("react-native")
  return ({visible, maxAngle}: {visible: boolean; maxAngle: number}) =>
    visible ? <Text>{`Maximum angle: ${maxAngle}`}</Text> : null
})
jest.mock("@/components/ui/RouteButton", () => {
  const {Text, Pressable} = require("react-native")
  return {
    RouteButton: ({label, onPress}: {label: string; onPress: () => void}) => (
      <Pressable onPress={onPress}>
        <Text>{label}</Text>
      </Pressable>
    ),
  }
})
jest.mock("@/utils/dev/konami", () => ({useKonamiCode: () => ({setEnabled: jest.fn()})}))

async function select(model: string) {
  await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, model, false)
  await useSettingsStore.getState().setSetting(SETTINGS.head_up_angle.key, 20, false)
  ;(engine.glasses.info as jest.Mock).mockReturnValue({model})
  ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "connected"})
}

describe("display settings use model capabilities", () => {
  test.each([
    ["NIMO", "0-10", "0-10"],
    ["Even Realities G1", "1-3", "1-8"],
    ["Mentra Display", "1-4", "1-8"],
  ])("%s supplies its own depth and height ranges", async (model, depth, height) => {
    await select(model)
    const screen = render(<ScreenSettingsScreen />)
    expect(screen.getByText(`Display Depth: ${depth}`)).toBeTruthy()
    expect(screen.getByText(`Display Height: ${height}`)).toBeTruthy()
  })

  test("an unsupported model cannot expose sliders through a direct route", async () => {
    await select("Mentra Live")
    const screen = render(<ScreenSettingsScreen />)
    expect(screen.queryByText(/Display Depth:/)).toBeNull()
    expect(screen.queryByText(/Display Height:/)).toBeNull()
  })

  test("having an IMU does not expose an unsupported head-angle control", async () => {
    await select("Mentra Live")
    const screen = render(<DashboardSettingsScreen />)
    expect(screen.queryByText("settings:adjustHeadAngleLabel")).toBeNull()
  })

  test("NIMO uses the firmware's 90-degree head-angle range", async () => {
    await select("NIMO")
    const screen = render(<DashboardSettingsScreen />)
    fireEvent.press(screen.getByText("settings:adjustHeadAngleLabel"))
    expect(screen.getByText("Maximum angle: 90")).toBeTruthy()
  })
})
