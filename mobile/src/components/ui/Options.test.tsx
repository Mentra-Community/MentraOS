import {fireEvent, render, screen} from "@testing-library/react-native"
import {useState} from "react"
import type {TextProps, ViewProps} from "react-native"

import {OptionList} from "./Options"

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {colors: {primary: "blue", primary_foreground: "white", palette: {transparent: "transparent"}}},
  }),
}))
jest.mock("@/components/ignite", () => {
  const {Text} = require("react-native")
  return {
    Text: ({text, ...props}: TextProps & {text: string}) => <Text {...props}>{text}</Text>,
    Icon: ({name, ...props}: TextProps & {name: string}) => <Text {...props}>{name}</Text>,
  }
})
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return {__esModule: true, default: (props: ViewProps) => <View {...props} />}
})
jest.mock("@/components/ui/Group", () => {
  const {View} = require("react-native")
  return {Group: (props: ViewProps) => <View {...props} />}
})
jest.mock("@/components/ui", () => {
  const {Text} = require("react-native")
  return {Badge: ({text}: {text: string}) => <Text>{text}</Text>}
})

const options = [
  {key: "low", label: "Low (960×720)"},
  {key: "max", label: "Max (4032×3024)"},
]

test("only the current camera option is selected and check glyphs are decorative", () => {
  render(<OptionList options={options} selected="max" onSelect={jest.fn()} />)

  expect(screen.getByRole("radio", {name: "Max (4032×3024)", checked: true})).toBeTruthy()
  expect(screen.getByRole("radio", {name: "Low (960×720)", checked: false})).toBeTruthy()
  expect(screen.getAllByRole("radio")).toHaveLength(2)
  expect(screen.queryAllByText("check")).toHaveLength(0)
  expect(screen.getAllByText("check", {includeHiddenElements: true})).toHaveLength(2)
})

test("normal selection moves the accessible selected state with the controlled value", () => {
  const onSelect = jest.fn()
  function ControlledOptions() {
    const [selected, setSelected] = useState("max")
    return (
      <OptionList
        options={options}
        selected={selected}
        onSelect={(key) => {
          onSelect(key)
          setSelected(key)
        }}
      />
    )
  }
  render(<ControlledOptions />)

  fireEvent.press(screen.getByRole("radio", {name: "Low (960×720)"}))

  expect(onSelect).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledWith("low")
  expect(screen.getByRole("radio", {name: "Low (960×720)", checked: true})).toBeTruthy()
  expect(screen.getByRole("radio", {name: "Max (4032×3024)", checked: false})).toBeTruthy()
})

test("a press does not claim selection if the caller declines the setting change", () => {
  const onSelect = jest.fn()
  render(<OptionList options={options} selected="max" onSelect={onSelect} />)

  fireEvent.press(screen.getByRole("radio", {name: "Low (960×720)"}))

  expect(onSelect).toHaveBeenCalledWith("low")
  expect(screen.getByRole("radio", {name: "Max (4032×3024)", checked: true})).toBeTruthy()
  expect(screen.getByRole("radio", {name: "Low (960×720)", checked: false})).toBeTruthy()
})

test("externally restored settings update selection without invoking a writer", () => {
  const onSelect = jest.fn()
  const {rerender} = render(<OptionList options={options} selected="low" onSelect={onSelect} />)

  rerender(<OptionList options={options} selected="max" onSelect={onSelect} />)

  expect(screen.getByRole("radio", {name: "Max (4032×3024)", checked: true})).toBeTruthy()
  expect(screen.getByRole("radio", {name: "Low (960×720)", checked: false})).toBeTruthy()
  expect(onSelect).not.toHaveBeenCalled()
})

test("an unavailable selected key does not invent a selected option", () => {
  render(<OptionList options={options} selected="legacy" onSelect={jest.fn()} />)

  expect(screen.queryAllByRole("radio", {checked: true})).toHaveLength(0)
  expect(screen.getAllByRole("radio", {checked: false})).toHaveLength(2)
})

test("accessible names preserve the visible label, badge and subtitle", () => {
  render(
    <OptionList
      options={[{key: "max", label: "Max", badge: "Recommended", subtitle: "4032×3024"}]}
      selected="max"
      onSelect={jest.fn()}
    />,
  )

  expect(screen.getByRole("radio", {name: "Max, Recommended, 4032×3024", checked: true})).toBeTruthy()
})
