import {act, fireEvent, render} from "@testing-library/react-native"
import {Alert} from "react-native"

import {ModalProvider} from "@/contexts/ModalContext"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"

jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const builder = {
        enabled: () => builder,
        activeOffsetY: () => builder,
        onUpdate: () => builder,
        onEnd: () => builder,
      }
      return builder
    },
  },
  GestureDetector: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {secondary_foreground: "#000", border: "#ddd", error: "#d00"}, isDark: false}}),
}))
jest.mock("@/utils/SettingsNavigationUtils", () => ({SettingsNavigationUtils: {openSettingsForRequirement: jest.fn()}}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Icon: () => null,
    Text: ({text}: {text?: string}) => <Text>{text}</Text>,
    Button: ({text, onPress}: {text: string; onPress: () => void}) => (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

describe("AlertUtils.showAlert", () => {
  it("runs the pressed button's handler once the sheet has closed", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const leave = jest.fn()
    await act(async () => {
      showAlert("Leave Ridgeline Field Services?", "Its miniapps come off this phone.", [
        {text: "Cancel", style: "cancel"},
        {text: "Leave", style: "destructive", onPress: leave},
      ])
    })
    expect(leave).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.press(screen.getByText("Leave"))
    })
    expect(leave).toHaveBeenCalledTimes(1)
    expect(screen.queryByText("Leave Ridgeline Field Services?")).toBeNull()
  })

  it("runs each caller's own handler when an identical alert was already waiting", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    // Like PermissionsUtils' warnings: a promise that only a button settles.
    const ask = () =>
      new Promise<boolean>((resolve) => {
        showAlert("Camera Permission Limited", "You can enable full access in your device settings.", [
          {text: "Settings", onPress: () => resolve(false)},
          {text: "Continue Anyway", onPress: () => resolve(true)},
        ])
      })
    let first!: Promise<boolean>
    let second!: Promise<boolean>
    await act(async () => {
      first = ask()
      second = ask()
    })
    expect(screen.getAllByText("Camera Permission Limited")).toHaveLength(1)
    await act(async () => {
      fireEvent.press(screen.getByText("Continue Anyway"))
    })
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it("treats a button worded Cancel as cancel, so dismissing the sheet presses it", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const cancel = jest.fn()
    const remove = jest.fn()
    await act(async () => {
      showAlert("Remove Notes?", "", [
        {text: "Cancel", onPress: cancel},
        {text: "Remove", onPress: remove},
      ])
    })
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop"))
    })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(remove).not.toHaveBeenCalled()
  })

  it("keeps an alert that isn't cancelable until a button is pressed", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await act(async () => {
      showAlert("Background Location Permission", "", [{text: "Continue"}, {text: "Skip", style: "cancel"}], {
        cancelable: false,
      })
    })
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
    })
    expect(screen.getByText("Background Location Permission")).toBeTruthy()
  })

  it("closes by title without running a handler", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const ok = jest.fn()
    await act(async () => {
      showAlert("Your glasses are in pairing mode", "", [{text: "OK", onPress: ok}])
    })
    await act(async () => {
      dismissAlert("Your glasses are in pairing mode")
    })
    expect(screen.queryByText("Your glasses are in pairing mode")).toBeNull()
    expect(ok).not.toHaveBeenCalled()
  })

  it("falls back to the system alert before the sheet is mounted", () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
    const buttons = [{text: "OK"}]
    showAlert("Glasses not connected", "Please connect your smart glasses first.", buttons)
    expect(alert).toHaveBeenCalledWith(
      "Glasses not connected",
      "Please connect your smart glasses first.",
      buttons,
      undefined,
    )
    alert.mockRestore()
  })
})
