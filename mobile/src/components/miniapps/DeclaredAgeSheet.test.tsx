import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert} from "react-native"

import {ModalProvider} from "@/contexts/ModalContext"
import en from "@/i18n/en"

import {askDeclaredAge, parseDeclaredAge} from "./DeclaredAgeSheet"

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
  useAppTheme: () => ({
    theme: {colors: {secondary_foreground: "#000", border: "#ddd", foreground: "#000", muted_foreground: "#777"}},
  }),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text} = require("react-native")
  return {
    Text: ({text, testID}: {text?: string; testID?: string}) => <Text testID={testID}>{text}</Text>,
    Button: ({text, onPress}: {text: string; onPress: () => void}) => (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{text}</Text>
      </Pressable>
    ),
    Icon: () => null,
  }
})

/** The sheet's buttons, main action first. */
const buttons = (screen: ReturnType<typeof render>) => {
  const labels = screen
    .getAllByRole("button")
    .flatMap((button) => within(button).queryAllByText(/./))
    .map((text) => String(text.props.children))
  return screen.queryByTestId("alert.buttons.row") ? labels.reverse() : labels
}

let systemAlert: jest.SpyInstance
let screen: ReturnType<typeof render> | undefined

beforeAll(async () => {
  await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
})

beforeEach(() => {
  systemAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
})

afterEach(() => {
  screen?.unmount()
  screen = undefined
  systemAlert.mockRestore()
})

async function press(label: string) {
  await act(async () => {
    fireEvent.press(screen!.getByText(label))
  })
}

describe("the declared-age question", () => {
  test("asks on the alert sheet with the words the plan gives it, and answers the age typed", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    let answer!: Promise<number | null>
    act(() => {
      answer = askDeclaredAge()
    })
    expect(await screen.findByText("How old are you?")).toBeTruthy()
    expect(
      screen.getByText(
        "Some miniapps are rated for older ages. We keep your answer with your Mentra account and never share it with miniapps.",
      ),
    ).toBeTruthy()
    expect(buttons(screen).filter((label) => ["Continue", "Cancel"].includes(label))).toEqual(["Continue", "Cancel"])

    fireEvent.changeText(screen.getByTestId("declaredAge.input"), "16")
    await press("Continue")
    await act(async () => {
      expect(await answer).toBe(16)
    })
    expect(systemAlert).not.toHaveBeenCalled()
  })

  test("waits for the sheet to mount at startup instead of counting as cancelled", async () => {
    let answer!: Promise<number | null>
    let settled = false
    act(() => {
      answer = askDeclaredAge()
      void answer.then(() => (settled = true))
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled).toBe(false)

    screen = render(<ModalProvider>{null}</ModalProvider>)
    await screen.findByText("How old are you?")
    fireEvent.changeText(screen.getByTestId("declaredAge.input"), "40")
    await press("Continue")
    await act(async () => {
      expect(await answer).toBe(40)
    })
  })

  test("something that isn't an age asks again, saying why", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    let answer!: Promise<number | null>
    act(() => {
      answer = askDeclaredAge()
    })
    await screen.findByText("How old are you?")
    expect(screen.queryByTestId("declaredAge.invalid")).toBeNull()
    await press("Continue")

    expect(await screen.findByText("Enter your age as a number.")).toBeTruthy()
    fireEvent.changeText(screen.getByTestId("declaredAge.input"), "0")
    await press("Continue")
    expect(await screen.findByText("Enter your age as a number.")).toBeTruthy()
    fireEvent.changeText(screen.getByTestId("declaredAge.input"), " 13 ")
    await press("Continue")
    await act(async () => {
      expect(await answer).toBe(13)
    })
  })

  test("Cancel answers nothing", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    let answer!: Promise<number | null>
    act(() => {
      answer = askDeclaredAge()
    })
    await screen.findByText("How old are you?")
    fireEvent.changeText(screen.getByTestId("declaredAge.input"), "16")
    await press("Cancel")
    await act(async () => {
      expect(await answer).toBeNull()
    })
  })
})

describe("reading the age typed", () => {
  test("takes a whole number of years from 1 to 120", () => {
    expect(["1", "12", " 16 ", "120"].map(parseDeclaredAge)).toEqual([1, 12, 16, 120])
  })

  test("refuses anything else", () => {
    expect(["", "0", "121", "12.5", "-3", "twelve", "1e1", "0x10"].map(parseDeclaredAge)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ])
  })
})
