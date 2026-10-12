import {fireEvent, render} from "@testing-library/react-native"

import {Header} from "./Header"

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const theme = {
      colors: {text: "white", primary_foreground: "black", secondary_foreground: "white"},
      spacing: {s10: 40},
    }
    return {theme, themed: (style: unknown) => (typeof style === "function" ? style(theme) : style)}
  },
}))
jest.mock("@/utils/useSafeAreaInsetsStyle", () => ({useSafeAreaInsetsStyle: () => ({})}))
jest.mock("@/i18n", () => ({isRTL: false, translate: (key: string) => key}))
jest.mock("./Icon", () => ({
  Icon: ({color}: {color: string}) => {
    const {View} = require("react-native")
    return <View testID="header-icon" style={{color}} />
  },
}))
jest.mock("./Text", () => ({
  Text: ({text}: {text: string}) => {
    const {Text} = require("react-native")
    return <Text>{text}</Text>
  },
}))

test("native Back activation and touch invoke the same navigation action once", () => {
  const goBack = jest.fn()
  const {getByTestId, rerender} = render(<Header leftIcon="chevron-left" onLeftPress={goBack} />)
  const back = getByTestId("navigation.back")

  expect(back.props.onAccessibilityTap).toBe(goBack)
  fireEvent(back, "accessibilityTap")
  expect(goBack).toHaveBeenCalledTimes(1)
  fireEvent.press(back)
  expect(goBack).toHaveBeenCalledTimes(2)

  rerender(<Header leftIcon="chevron-left" />)
  const disabled = getByTestId("navigation.back")
  expect(disabled.props.accessibilityState).toMatchObject({disabled: true})
  fireEvent(disabled, "accessibilityTap")
  fireEvent.press(disabled)
  expect(goBack).toHaveBeenCalledTimes(2)
})

test("Back preserves the theme foreground and explicit icon color", () => {
  const {getByTestId, rerender} = render(<Header leftIcon="chevron-left" onLeftPress={() => {}} />)
  expect(getByTestId("header-icon").props.style.color).toBe("white")

  rerender(<Header leftIcon="chevron-left" leftIconColor="red" onLeftPress={() => {}} />)
  expect(getByTestId("header-icon").props.style.color).toBe("red")
})
