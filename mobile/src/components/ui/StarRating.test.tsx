import {fireEvent, render, screen} from "@testing-library/react-native"
import {useState} from "react"

import {initI18n} from "@/i18n"

import {StarRating} from "./StarRating"

// Like the real icon set: a glyph Text that receives the caller's props.
jest.mock("@expo/vector-icons", () => {
  const {Text} = require("react-native")
  return {MaterialCommunityIcons: ({name, ...props}: {name: string}) => <Text {...props}>{name}</Text>}
})
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {primary: "gold", border: "gray"}}, themed: () => ({})}),
}))

beforeAll(async () => {
  await initI18n()
})

function selectedRatings() {
  return screen
    .getAllByRole("button")
    .filter((star) => star.props.accessibilityState?.selected)
    .map((star) => star.props.accessibilityLabel)
}

function ControlledRating({max, onValueChange}: {max?: number; onValueChange: (value: number) => void}) {
  const [value, setValue] = useState<number | null>(null)
  return (
    <StarRating
      value={value}
      max={max}
      onValueChange={(rating) => {
        setValue(rating)
        onValueChange(rating)
      }}
    />
  )
}

test("exposes one distinctly labelled rating control per star with no initial selection", () => {
  render(<StarRating value={null} onValueChange={jest.fn()} />)

  const stars = screen.getAllByRole("button")
  expect(stars.map((star) => star.props.accessibilityLabel)).toEqual([
    "1 out of 5 stars",
    "2 out of 5 stars",
    "3 out of 5 stars",
    "4 out of 5 stars",
    "5 out of 5 stars",
  ])
  expect(stars.map((star) => star.props.testID)).toEqual([
    "starRating.1",
    "starRating.2",
    "starRating.3",
    "starRating.4",
    "starRating.5",
  ])
  expect(selectedRatings()).toEqual([])
  // Star glyphs are decoration inside each control, not separate announcements.
  expect(screen.queryAllByText(/star/).map((glyph) => glyph.props.children)).toEqual([])
  expect(screen.getAllByText("star-outline", {includeHiddenElements: true})).toHaveLength(5)
})

test.each([1, 3, 5])("choosing %i reports it and marks only that rating selected", (rating) => {
  const onValueChange = jest.fn()
  render(<ControlledRating onValueChange={onValueChange} />)

  fireEvent.press(screen.getByRole("button", {name: `${rating} out of 5 stars`}))

  expect(onValueChange).toHaveBeenCalledTimes(1)
  expect(onValueChange).toHaveBeenCalledWith(rating)
  expect(selectedRatings()).toEqual([`${rating} out of 5 stars`])
  expect(screen.getByRole("button", {name: `${rating} out of 5 stars`, selected: true})).toBeTruthy()
})

test("changing the rating moves the selection", () => {
  const onValueChange = jest.fn()
  render(<ControlledRating onValueChange={onValueChange} />)

  fireEvent.press(screen.getByTestId("starRating.4"))
  fireEvent.press(screen.getByTestId("starRating.2"))

  expect(onValueChange.mock.calls).toEqual([[4], [2]])
  expect(selectedRatings()).toEqual(["2 out of 5 stars"])
})

test("custom maximum labels every control against that maximum", () => {
  const onValueChange = jest.fn()
  render(<ControlledRating max={3} onValueChange={onValueChange} />)

  expect(screen.getAllByRole("button").map((star) => star.props.accessibilityLabel)).toEqual([
    "1 out of 3 stars",
    "2 out of 3 stars",
    "3 out of 3 stars",
  ])

  fireEvent.press(screen.getByRole("button", {name: "3 out of 3 stars"}))

  expect(onValueChange).toHaveBeenCalledWith(3)
  expect(selectedRatings()).toEqual(["3 out of 3 stars"])
})

test("a caller-supplied test ID prefixes each star", () => {
  render(<StarRating value={2} onValueChange={jest.fn()} testID="feedback.experienceRating" />)

  expect(screen.getByTestId("feedback.experienceRating.2").props.accessibilityState).toEqual({selected: true})
  expect(screen.getByTestId("feedback.experienceRating.1").props.accessibilityState).toEqual({selected: false})
  // Filled appearance still covers every star up to the value; only the value itself is selected.
  expect(screen.getAllByText("star", {includeHiddenElements: true})).toHaveLength(2)
  expect(screen.getAllByText("star-outline", {includeHiddenElements: true})).toHaveLength(3)
})
