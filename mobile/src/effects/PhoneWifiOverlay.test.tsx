import {act, render} from "@testing-library/react-native"
import {Animated} from "react-native"

import {PhoneWifiOverlay} from "./PhoneWifiOverlay"
import {getPhoneWifiPrompt, requestPhoneWifiPrompt} from "@/services/phoneWifiPrompt"

jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({theme: {colors: {modalOverlay: "#0008"}}})}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => {
  const {Text, Pressable} = require("react-native")
  return {
    Icon: () => null,
    Text: ({text}: {text: string}) => <Text>{text}</Text>,
    Button: ({text, onPress}: {text: string; onPress: () => void}) => (
      <Pressable onPress={onPress}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

beforeEach(() => {
  jest.spyOn(Animated, "parallel").mockReturnValue({start: jest.fn(), stop: jest.fn(), reset: jest.fn()})
})
afterEach(() => jest.restoreAllMocks())

test("unmount cancels the owned prompt and a new host can prompt again", async () => {
  const host = render(<PhoneWifiOverlay />)
  let first!: Promise<boolean>
  act(() => {
    first = requestPhoneWifiPrompt({title: "Wi-Fi", message: "Video", actionLabel: "Settings"})
  })
  expect(getPhoneWifiPrompt()).not.toBeNull()
  host.unmount()
  await expect(first).resolves.toBe(false)
  expect(getPhoneWifiPrompt()).toBeNull()

  const replacementHost = render(<PhoneWifiOverlay />)
  let second!: Promise<boolean>
  act(() => {
    second = requestPhoneWifiPrompt({title: "Wi-Fi", message: "Video", actionLabel: "Settings"})
  })
  expect(getPhoneWifiPrompt()).not.toBeNull()
  replacementHost.unmount()
  await expect(second).resolves.toBe(false)
})
