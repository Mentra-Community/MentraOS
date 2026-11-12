import {act, render} from "@testing-library/react-native"
import {Alert} from "react-native"

import {hasAlertHost, ModalProvider, showAlert, waitForAlertHost} from "@/contexts/ModalContext"

jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const builder: Record<string, unknown> = {}
      for (const name of ["enabled", "activeOffsetY", "onUpdate", "onEnd"]) builder[name] = () => builder
      return builder
    },
  },
  GestureDetector: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock("react-native-safe-area-context", () => require("react-native-safe-area-context/jest/mock").default)
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {secondary_foreground: "#000", border: "#ddd", error: "#d00"}, isDark: false}}),
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

describe("waitForAlertHost", () => {
  it("waits for the sheet to mount, and never falls back on a system alert", async () => {
    const systemAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
    try {
      expect(hasAlertHost()).toBe(false)
      let ready = false
      const waiting = waitForAlertHost().then(() => {
        ready = true
      })
      await act(async () => {
        await Promise.resolve()
      })
      expect(ready).toBe(false)

      // A sheet asked for before the host is mounted gets no answer, and no native alert.
      await expect(showAlert({title: "Too early"})).resolves.toBe(-1)

      const screen = render(<ModalProvider>{null}</ModalProvider>)
      await act(async () => {
        await waiting
      })
      expect(ready).toBe(true)
      expect(hasAlertHost()).toBe(true)

      let answer!: Promise<number>
      await act(async () => {
        answer = showAlert({title: "Now", buttons: [{text: "OK"}]})
      })
      expect(screen.getByText("Now")).toBeTruthy()
      expect(systemAlert).not.toHaveBeenCalled()
      screen.unmount()
      void answer
    } finally {
      systemAlert.mockRestore()
    }
  })

  it("resolves at once when the sheet is already mounted, and waits again after it unmounts", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await expect(waitForAlertHost()).resolves.toBeUndefined()
    screen.unmount()

    let ready = false
    void waitForAlertHost().then(() => {
      ready = true
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(ready).toBe(false)

    const again = render(<ModalProvider>{null}</ModalProvider>)
    await act(async () => {
      await Promise.resolve()
    })
    expect(ready).toBe(true)
    again.unmount()
  })

  it("releases every caller that was waiting", async () => {
    const released: number[] = []
    const calls = [1, 2, 3].map((n) => waitForAlertHost().then(() => void released.push(n)))
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await act(async () => {
      await Promise.all(calls)
    })
    expect(released).toEqual([1, 2, 3])
    screen.unmount()
  })
})

describe("alert handle", () => {
  const open = async (props: Parameters<typeof showAlert>[0]) => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await act(async () => {
      void showAlert(props)
    })
    return screen
  }

  it("shows only when the sheet has a cancel button and can be swiped away", async () => {
    const cancellable = await open({
      title: "Leave?",
      buttons: [{text: "Cancel", style: "cancel"}, {text: "Leave"}],
      options: {allowDismiss: true},
    })
    expect(cancellable.queryByTestId("alert.handle")).not.toBeNull()
    cancellable.unmount()

    const okOnly = await open({title: "Joined", buttons: [{text: "OK"}], options: {allowDismiss: true}})
    expect(okOnly.queryByTestId("alert.handle")).toBeNull()
    okOnly.unmount()

    const notSwipeable = await open({
      title: "Invited",
      buttons: [{text: "Decline", style: "cancel"}, {text: "Join"}],
      options: {allowDismiss: false},
    })
    expect(notSwipeable.queryByTestId("alert.handle")).toBeNull()
    notSwipeable.unmount()
  })
})
