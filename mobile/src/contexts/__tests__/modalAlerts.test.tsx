import {act, fireEvent, render} from "@testing-library/react-native"

import {ModalProvider, showAlert} from "@/contexts/ModalContext"

jest.mock("expo-glass-effect", () => ({GlassView: require("react-native").View}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {secondary_foreground: "#000", border: "#ddd"}, isDark: false}}),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Text: ({text}: {text?: string}) => <Text>{text}</Text>,
    Button: ({text, onPress}: {text: string; onPress: () => void}) => (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

describe("alerts", () => {
  it("settle an alert that a newer alert replaces as dismissed", async () => {
    render(<ModalProvider>{null}</ModalProvider>)
    let first!: Promise<number>
    await act(async () => {
      first = showAlert({title: "Update Notes?", buttons: [{text: "Not now", style: "cancel"}, {text: "Update"}]})
    })
    await act(async () => {
      void showAlert({title: "Another alert"})
    })
    await expect(first).resolves.toBe(-1)
  })

  it("answer with the pressed button", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    let answer!: Promise<number>
    await act(async () => {
      answer = showAlert({title: "Update Notes?", buttons: [{text: "Not now", style: "cancel"}, {text: "Update"}]})
    })
    await act(async () => {
      fireEvent.press(screen.getByText("Update"))
    })
    await expect(answer).resolves.toBe(1)
  })
})
