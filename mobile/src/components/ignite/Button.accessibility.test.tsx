import {fireEvent, render} from "@testing-library/react-native"

import {Button} from "./Button"

jest.mock("uniwind", () => ({withUniwind: (component: unknown) => component}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const {lightTheme} = require("@/theme")
    const themed = (style: unknown): unknown =>
      Array.isArray(style) ? style.map(themed) : typeof style === "function" ? style(lightTheme) : style
    return {theme: lightTheme, themed}
  },
}))
jest.mock("./Text", () => ({
  Text: ({text}: {text: string}) => {
    const {Text} = require("react-native")
    return <Text>{text}</Text>
  },
}))

test("touch and native activation use the same action and respect disabled", () => {
  const action = jest.fn()
  const {getByTestId, rerender} = render(<Button text="Pair" testID="pair" onPress={action} />)

  fireEvent(getByTestId("pair"), "accessibilityTap")
  expect(action).toHaveBeenCalledTimes(1)
  fireEvent.press(getByTestId("pair"))
  expect(action).toHaveBeenCalledTimes(2)

  rerender(<Button text="Pair" testID="pair" onPress={action} disabled />)
  expect(getByTestId("pair").props.accessibilityState).toMatchObject({disabled: true})
  fireEvent(getByTestId("pair"), "accessibilityTap")
  fireEvent.press(getByTestId("pair"))
  expect(action).toHaveBeenCalledTimes(2)
})

test("caller native hooks override the default without replacing touch", () => {
  const action = jest.fn()
  const tap = jest.fn()
  const accessibilityAction = jest.fn()
  const {getByTestId, rerender} = render(
    <Button
      text="Custom"
      testID="custom"
      onPress={action}
      onAccessibilityTap={tap}
      accessibilityActions={[{name: "activate"}]}
      onAccessibilityAction={accessibilityAction}
    />,
  )

  fireEvent(getByTestId("custom"), "accessibilityTap")
  expect(tap).toHaveBeenCalledTimes(1)
  expect(action).not.toHaveBeenCalled()
  const event = {nativeEvent: {actionName: "activate"}}
  fireEvent(getByTestId("custom"), "accessibilityAction", event)
  expect(accessibilityAction).toHaveBeenCalledWith(event)
  expect(action).not.toHaveBeenCalled()
  fireEvent.press(getByTestId("custom"))
  expect(action).toHaveBeenCalledTimes(1)

  rerender(<Button text="Custom" testID="custom" onPress={action} onAccessibilityTap={tap} disabled />)
  fireEvent(getByTestId("custom"), "accessibilityTap")
  expect(tap).toHaveBeenCalledTimes(1)
})
