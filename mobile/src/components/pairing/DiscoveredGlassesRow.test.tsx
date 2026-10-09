import {fireEvent, render} from "@testing-library/react-native"

import {DiscoveredGlassesRow} from "./DiscoveredGlassesRow"

jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {text: "white"}}})}))
jest.mock("@/components/ignite", () => ({
  Icon: () => {
    const {View} = require("react-native")
    return <View />
  },
  Text: ({text}: {text: string}) => {
    const {Text} = require("react-native")
    return <Text>{text}</Text>
  },
}))

test("touch and native accessibility activation select the exact discovered device once", () => {
  const selectFirst = jest.fn()
  const selectSecond = jest.fn()
  const {getByRole} = render(
    <>
      <DiscoveredGlassesRow title="Mentra Live" subtitle="03FF" onPress={selectFirst} />
      <DiscoveredGlassesRow title="Mentra Live" subtitle="0A0E" onPress={selectSecond} />
    </>,
  )

  const first = getByRole("button", {name: "Mentra Live, 03FF"})
  expect(first.props.onAccessibilityTap).toBe(selectFirst)
  fireEvent(first, "accessibilityTap")
  expect(selectFirst).toHaveBeenCalledTimes(1)
  expect(selectSecond).not.toHaveBeenCalled()

  fireEvent.press(getByRole("button", {name: "Mentra Live, 0A0E"}))
  expect(selectSecond).toHaveBeenCalledTimes(1)
  expect(selectFirst).toHaveBeenCalledTimes(1)
})

test("native activation uses the current selection callback and preserves caller layout", () => {
  const original = jest.fn()
  const replacement = jest.fn()
  const {getByRole, getByTestId, rerender} = render(
    <DiscoveredGlassesRow title="Mentra Live" subtitle="03FF" onPress={original} style={{marginTop: 8}} />,
  )
  const row = getByRole("button", {name: "Mentra Live, 03FF"})
  expect(row.props.style).toEqual([{marginTop: 8}, {opacity: 1}])
  expect(getByTestId("pairing-device-chevron").props.accessible).toBe(false)
  rerender(<DiscoveredGlassesRow title="Mentra Live" subtitle="03FF" onPress={replacement} />)
  fireEvent(getByRole("button", {name: "Mentra Live, 03FF"}), "accessibilityTap")
  expect(replacement).toHaveBeenCalledTimes(1)
  expect(original).not.toHaveBeenCalled()
})
