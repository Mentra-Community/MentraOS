import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert} from "react-native"
import Toast from "react-native-toast-message"

import {engine} from "@mentra/engine"

import {ModalProvider} from "@/contexts/ModalContext"
import en from "@/i18n/en"

import {presentRunningUpdateFailure, presentRunningUpdatePrompt} from "./runningUpdatePromptBridge"

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
  useAppTheme: () => ({theme: {colors: {secondary_foreground: "#000", border: "#ddd"}, isDark: false}}),
}))
jest.mock("react-native-toast-message", () => ({__esModule: true, default: {show: jest.fn()}}))
jest.mock("@/components/home/AppIcon", () => ({
  __esModule: true,
  default: ({app}: {app: {packageName: string}}) => {
    const {View} = require("react-native")
    return <View testID={`appIcon.${app.packageName}`} />
  },
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

function pending() {
  return {packageName: "com.acme.notes", displayName: "Notes", version: "1.1.0", answer: jest.fn()}
}

/** The sheet's buttons, main action first: top to bottom when stacked, right to left when side by side. */
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

describe("the running update prompt on the real alert sheet", () => {
  it("waits for the sheet to mount, and never calls Alert.alert", async () => {
    const prompt = pending()
    let done!: Promise<void>
    act(() => {
      done = presentRunningUpdatePrompt(prompt)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(systemAlert).not.toHaveBeenCalled()
    expect(prompt.answer).not.toHaveBeenCalled()

    screen = render(<ModalProvider>{null}</ModalProvider>)
    expect(await screen.findByText("Update Notes?")).toBeTruthy()
    expect(screen.getByText("Notes will restart.")).toBeTruthy()
    expect(prompt.answer).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.press(screen!.getByText("Update"))
    })
    await act(async () => {
      await done
    })
    expect(prompt.answer).toHaveBeenCalledWith("update")
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("makes Update the main action and Not now the other, and the main action updates", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const prompt = pending()
    let done!: Promise<void>
    act(() => {
      done = presentRunningUpdatePrompt(prompt)
    })
    await screen.findByText("Update Notes?")
    expect(buttons(screen).filter((text) => ["Update", "Not now"].includes(text))).toEqual(["Update", "Not now"])

    await act(async () => {
      fireEvent.press(screen!.getByText(buttons(screen!)[0]))
    })
    await act(async () => {
      await done
    })
    expect(prompt.answer).toHaveBeenCalledWith("update")
    expect(prompt.answer).toHaveBeenCalledTimes(1)
  })

  it("defers on Not now", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const prompt = pending()
    let done!: Promise<void>
    act(() => {
      done = presentRunningUpdatePrompt(prompt)
    })
    await screen.findByText("Update Notes?")
    await act(async () => {
      fireEvent.press(screen!.getByText("Not now"))
    })
    await act(async () => {
      await done
    })
    expect(prompt.answer).toHaveBeenCalledWith("not_now")
  })

  it("answers Not now when the sheet is swiped away (the backdrop and the swipe both answer cancel)", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const prompt = pending()
    let done!: Promise<void>
    act(() => {
      done = presentRunningUpdatePrompt(prompt)
    })
    await screen.findByText("Update Notes?")
    await act(async () => {
      fireEvent.press(screen!.getByTestId("alert.backdrop", {includeHiddenElements: true}))
    })
    await act(async () => {
      await done
    })
    expect(prompt.answer).toHaveBeenCalledWith("not_now")
  })

  it("shows the miniapp's icon above the title", async () => {
    jest.mocked(engine.miniapps.list).mockReturnValueOnce([{packageName: "com.acme.notes", name: "Notes"} as never])
    screen = render(<ModalProvider>{null}</ModalProvider>)
    const prompt = pending()
    act(() => {
      void presentRunningUpdatePrompt(prompt)
    })
    expect(await screen.findByText("Update Notes?")).toBeTruthy()
    expect(screen.getByTestId("appIcon.com.acme.notes")).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen!.getByText("Not now"))
    })
  })

  it("shows the failure as a toast with the version the user keeps, not as a sheet", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    act(() => {
      presentRunningUpdateFailure({packageName: "com.acme.notes", displayName: "Notes", installedVersion: "1.0.0"})
    })
    expect(Toast.show).toHaveBeenCalledWith({
      type: "error",
      text1: "Couldn't update Notes. You're still on version 1.0.0.",
    })
    expect(screen.queryByText(/Couldn't update/)).toBeNull()
    expect(systemAlert).not.toHaveBeenCalled()
  })
})
