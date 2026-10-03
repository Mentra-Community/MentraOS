import {engine} from "@mentra/engine"
import {act, fireEvent, render, screen} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {TextInput} from "react-native"

import FeedbackPage from "@/app/miniapps/settings/feedback"

jest.mock("expo-router", () => ({useLocalSearchParams: () => ({})}))
jest.mock("expo-image-picker", () => ({}))
jest.mock("expo-clipboard", () => ({setStringAsync: jest.fn()}))
jest.mock("@mentra/engine", () => ({
  engine: {reports: {submit: jest.fn()}},
  SETTINGS: {contact_email: {key: "contact_email"}},
  useSetting: () => ["", jest.fn()],
}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: {email: "reporter@example.test"}})}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {}}})}))
jest.mock("@/stores/capsule", () => ({useRegisterCapsule: jest.fn()}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({goBack: jest.fn(), getPreviousRoute: () => "/miniapps/settings"})},
}))
jest.mock("@/services/deployment", () => ({
  deploymentStore: {getActive: () => ({manifest: {appUpdates: {reviewUrls: {}}}})},
}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: jest.fn()}))
jest.mock("@/i18n", () => ({
  translate: (key: string) => {
    const en = require("@/i18n/en").default
    return key.split(":").reduce((value, part) => value[part], en)
  },
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text, View} = require("react-native")
  return {
    Screen: View,
    Icon: () => null,
    Text: ({children}: {children: ReactNode}) => <Text>{children}</Text>,
    Button: ({
      text,
      onPress,
      disabled,
      testID,
    }: {
      text: string
      onPress: () => void
      disabled?: boolean
      testID?: string
    }) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled} testID={testID}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})
jest.mock("@/components/ui", () => {
  const {Pressable, Text} = require("react-native")
  return {
    RadioGroup: () => null,
    StarRating: () => null,
    RatingButtons: ({onValueChange}: {onValueChange: (value: number) => void}) => (
      <Pressable accessibilityRole="button" onPress={() => onValueChange(3)}>
        <Text>Severity 3</Text>
      </Pressable>
    ),
  }
})

test("requires one description and submits it as the dashboard title without separate expected behavior", async () => {
  jest
    .mocked(engine.reports.submit)
    .mockResolvedValue({status: "submitted", reportId: "rep_test", reportStatus: "ready"})
  render(<FeedbackPage />)

  const description = screen.getByLabelText("What happened? What did you expect?")
  const submit = () => screen.getByRole("button", {name: "Continue"})
  expect(screen.getByTestId("feedback.description")).toBe(description)
  expect(screen.getByTestId("feedback.submit")).toBe(submit())
  expect(screen.UNSAFE_getAllByType(TextInput)).toHaveLength(1)
  expect(submit()).toBeDisabled()

  const answer = "Captions stopped after reconnecting. I expected them to resume."
  fireEvent.changeText(description, `  ${answer}  `)
  expect(submit()).toBeDisabled() // Severity is still required.
  fireEvent.press(screen.getByRole("button", {name: "Severity 3"}))
  expect(submit()).toBeEnabled()
  fireEvent.changeText(description, " \n ")
  expect(submit()).toBeDisabled()
  fireEvent.changeText(description, `  ${answer}  `)

  await act(async () => fireEvent.press(submit()))

  expect(engine.reports.submit).toHaveBeenCalledTimes(1)
  expect(engine.reports.submit).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "bug",
      trigger: {type: "manual", source: "feedback_screen", reason: "manual_bug_report"},
      report: {actualBehavior: answer, userSeverity: 3},
    }),
  )
  expect(description.props.value).toBe("")
})
