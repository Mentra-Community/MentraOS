import {fireEvent, render} from "@testing-library/react-native"

import {RouteButton} from "./RouteButton"

jest.mock("@/components/ui/GlassView", () => require("react-native").View)
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {spacing: {s1: 4}, colors: {secondary_foreground: "white", muted_foreground: "gray", foreground: "black"}},
  }),
}))
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {Icon: () => null, Text: ({text}: {text: string}) => <Text>{text}</Text>}
})

test("native and touch activation navigate once and disabled rows cannot navigate", () => {
  const navigate = jest.fn()
  const {getByText, rerender} = render(<RouteButton label="Profile" onPress={navigate} />)
  fireEvent(getByText("Profile"), "accessibilityTap")
  expect(navigate).toHaveBeenCalledTimes(1)
  fireEvent.press(getByText("Profile"))
  expect(navigate).toHaveBeenCalledTimes(2)

  rerender(<RouteButton label="Profile" onPress={navigate} disabled />)
  expect(getByText("Profile")).toBeDisabled()
  fireEvent(getByText("Profile"), "accessibilityTap")
  fireEvent.press(getByText("Profile"))
  expect(navigate).toHaveBeenCalledTimes(2)

  rerender(<RouteButton label="Profile" />)
  fireEvent(getByText("Profile"), "accessibilityTap")
  expect(getByText("Profile")).toBeDisabled()
})
