import {act, fireEvent, render} from "@testing-library/react-native"
import {BackHandler} from "react-native"

import {dismissAlert, ModalProvider, NO_ANSWER, sheetButtonOrder, showAlert} from "@/contexts/ModalContext"

/** The sheet's drag gesture as last built: whether it's on, and its end handler. */
const mockDrag: {enabled: boolean; onEnd?: (event: {translationY: number; velocityY: number}) => void} = {
  enabled: false,
}
jest.mock("react-native-gesture-handler", () => ({
  Gesture: {
    Pan: () => {
      const builder = {
        enabled: (on: boolean) => ((mockDrag.enabled = on), builder),
        activeOffsetY: () => builder,
        onUpdate: () => builder,
        onEnd: (handler: typeof mockDrag.onEnd) => ((mockDrag.onEnd = handler), builder),
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
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Text: ({text}: {text?: string}) => <Text>{text}</Text>,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

const UPDATE = {title: "Update Notes?", buttons: [{text: "Not now", style: "cancel" as const}, {text: "Update"}]}

/** Shows an alert. The answer comes wrapped: an async function returning a promise would wait for it. */
async function show(props: Parameters<typeof showAlert>[0]): Promise<{answer: Promise<number>}> {
  let answer!: Promise<number>
  await act(async () => {
    answer = showAlert(props)
  })
  return {answer}
}

describe("alert sheet", () => {
  it("answers with the pressed button", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const {answer} = await show(UPDATE)
    await act(async () => {
      fireEvent.press(screen.getByText("Update"))
    })
    await expect(answer).resolves.toBe(1)
    expect(screen.queryByText("Update Notes?")).toBeNull()
  })

  it("shows alerts one at a time, in order", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const {answer: first} = await show(UPDATE)
    const {answer: second} = await show({title: "Notes couldn't update", buttons: [{text: "OK"}]})
    expect(screen.getByText("Update Notes?")).toBeTruthy()
    expect(screen.queryByText("Notes couldn't update")).toBeNull()

    await act(async () => {
      fireEvent.press(screen.getByText("Not now"))
    })
    await expect(first).resolves.toBe(0)
    expect(screen.getByText("Notes couldn't update")).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByText("OK"))
    })
    await expect(second).resolves.toBe(0)
  })

  it("joins an alert identical to one already waiting, and answers every caller", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const disconnected = {
      title: "Glasses disconnected",
      message: "Reconnect them in Settings.",
      buttons: [{text: "OK"}],
    }
    const {answer: first} = await show(disconnected)
    const {answer: again} = await show(disconnected)
    expect(screen.getAllByText("Glasses disconnected")).toHaveLength(1)
    await act(async () => {
      fireEvent.press(screen.getByText("OK"))
    })
    await expect(first).resolves.toBe(0)
    await expect(again).resolves.toBe(0)
    expect(screen.queryByText("Glasses disconnected")).toBeNull()
  })

  it("shows an alert with the same title but different buttons separately", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await show({title: "Update Notes?", buttons: [{text: "Update"}]})
    await show(UPDATE)
    await act(async () => {
      fireEvent.press(screen.getByText("Update"))
    })
    expect(screen.getByText("Not now")).toBeTruthy()
  })

  it("lets an alert with a cancel button be dismissed outside it, as cancel", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const {answer} = await show({...UPDATE, options: {allowDismiss: true}})
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop"))
    })
    await expect(answer).resolves.toBe(0)
  })

  it("waits for a button when there's no cancel button or dismissal isn't allowed", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    await show({title: "Pair your glasses", buttons: [{text: "Got it"}]})
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
    })
    expect(screen.getByText("Pair your glasses")).toBeTruthy()

    await act(async () => {
      fireEvent.press(screen.getByText("Got it"))
    })
    await show({...UPDATE, options: {allowDismiss: false}})
    await act(async () => {
      fireEvent.press(screen.getByTestId("alert.backdrop", {includeHiddenElements: true}))
    })
    expect(screen.getByText("Update Notes?")).toBeTruthy()
  })

  it("treats Android back as cancel, and swallows it when the alert can't be dismissed", async () => {
    const listeners: Array<() => boolean | null | undefined> = []
    const addListener = jest.spyOn(BackHandler, "addEventListener").mockImplementation((_event, listener) => {
      listeners.push(listener)
      return {remove: () => listeners.splice(listeners.indexOf(listener), 1)}
    })
    const pressBack = () => listeners[listeners.length - 1]?.()
    try {
      const screen = render(<ModalProvider>{null}</ModalProvider>)
      await show({title: "Pair your glasses", buttons: [{text: "Got it"}]})
      let handled: boolean | null | undefined
      await act(async () => {
        handled = pressBack()
      })
      expect(handled).toBe(true)
      expect(screen.getByText("Pair your glasses")).toBeTruthy()

      await act(async () => {
        fireEvent.press(screen.getByText("Got it"))
      })
      const {answer} = await show(UPDATE)
      await act(async () => {
        pressBack()
      })
      await expect(answer).resolves.toBe(0)
    } finally {
      addListener.mockRestore()
    }
  })

  it("swipes away as cancel when dismissible, and springs back from a short drag", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const {answer} = await show(UPDATE)
    expect(mockDrag.enabled).toBe(true)
    await act(async () => {
      mockDrag.onEnd?.({translationY: 40, velocityY: 100})
    })
    expect(screen.getByText("Update Notes?")).toBeTruthy()
    await act(async () => {
      mockDrag.onEnd?.({translationY: 160, velocityY: 0})
    })
    await expect(answer).resolves.toBe(0)

    await show({title: "Pair your glasses", buttons: [{text: "Got it"}]})
    expect(mockDrag.enabled).toBe(false)
  })

  it("closes an alert by title without a button, and drops queued copies", async () => {
    const screen = render(<ModalProvider>{null}</ModalProvider>)
    const {answer: showing} = await show({title: "Your glasses are in pairing mode", buttons: [{text: "OK"}]})
    const {answer: queued} = await show({
      title: "Your glasses are in pairing mode",
      message: "Again",
      buttons: [{text: "OK"}],
    })
    const {answer: other} = await show({title: "Something else", buttons: [{text: "OK"}]})
    await act(async () => {
      dismissAlert("Your glasses are in pairing mode")
    })
    await expect(showing).resolves.toBe(NO_ANSWER)
    await expect(queued).resolves.toBe(NO_ANSWER)
    expect(screen.getByText("Something else")).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen.getByText("OK"))
    })
    await expect(other).resolves.toBe(0)
  })
})

describe("sheetButtonOrder", () => {
  const order = (buttons: Parameters<typeof sheetButtonOrder>[0]) =>
    sheetButtonOrder(buttons).map(({button, primary}) => `${button.text}${primary ? "*" : ""}`)

  it("puts the main action on top and cancel at the bottom", () => {
    expect(
      order([
        {text: "Cancel", style: "cancel"},
        {text: "Leave", style: "destructive"},
      ]),
    ).toEqual(["Leave*", "Cancel"])
    expect(order([{text: "Turn On"}, {text: "Cancel", style: "cancel"}])).toEqual(["Turn On*", "Cancel"])
    expect(order([{text: "Settings"}, {text: "Continue Anyway"}])).toEqual(["Continue Anyway*", "Settings"])
  })

  it("makes a lone button the primary one", () => {
    expect(order([{text: "OK"}])).toEqual(["OK*"])
    expect(order([{text: "Close", style: "cancel"}])).toEqual(["Close*"])
  })
})
