import {act, fireEvent, render, within} from "@testing-library/react-native"
import i18n from "i18next"
import {Alert} from "react-native"

import {HardwareType, type MiniappInstallPreview} from "@mentra/engine"

import {ModalProvider} from "@/contexts/ModalContext"
import en from "@/i18n/en"

import {confirmMiniappInstall, miniappInstallSheetCopy} from "./MiniappInstallSheet"

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
jest.mock("expo-image", () => {
  const {View} = require("react-native")
  return {
    Image: ({testID, source}: {testID?: string; source: {uri: string}}) => (
      <View testID={testID} accessibilityLabel={source.uri} />
    ),
  }
})
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

const preview = (overrides: Partial<MiniappInstallPreview> = {}): MiniappInstallPreview => ({
  url: "https://notes.example.com/",
  host: "notes.example.com",
  local: false,
  packageName: "com.example.notes",
  name: "Notes",
  iconUrl: "https://notes.example.com/icon.png",
  ageRating: null,
  private: false,
  alreadyInstalled: false,
  missingHardware: [],
  ...overrides,
})

/** The sheet's buttons, main action first. */
const buttons = (screen: ReturnType<typeof render>) => {
  const labels = screen
    .getAllByRole("button")
    .flatMap((button) => within(button).queryAllByText(/./))
    .map((text) => String(text.props.children))
  return screen.queryByTestId("alert.buttons.row") ? labels.reverse() : labels
}

beforeAll(async () => {
  await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
})

describe("the install sheet's copy", () => {
  it("names the miniapp and the host it comes from", () => {
    expect(miniappInstallSheetCopy(preview())).toEqual({title: "Notes", message: "From notes.example.com"})
  })

  it("shows the age rating beside the name", () => {
    expect(miniappInstallSheetCopy(preview({ageRating: "13+"})).title).toBe("Notes · 13+")
  })

  it("says a local-network miniapp comes from the local network, with its address", () => {
    expect(
      miniappInstallSheetCopy(preview({url: "http://192.168.1.20:8080/", host: "192.168.1.20", local: true})).message,
    ).toBe("From your local network\n192.168.1.20:8080")
  })

  it("says the install replaces a copy the person has", () => {
    expect(miniappInstallSheetCopy(preview({alreadyInstalled: true})).message).toBe(
      "From notes.example.com\n\nIt replaces the Notes you have now.",
    )
  })

  it("says what glasses it needs when the paired glasses (or none) lack it", () => {
    expect(miniappInstallSheetCopy(preview({missingHardware: [HardwareType.CAMERA]})).message).toBe(
      "From notes.example.com\n\nNeeds glasses with a camera.",
    )
    expect(
      miniappInstallSheetCopy(preview({missingHardware: [HardwareType.CAMERA, HardwareType.DISPLAY]})).message,
    ).toBe("From notes.example.com\n\nNeeds glasses with a camera and a display.")
    expect(
      miniappInstallSheetCopy(
        preview({missingHardware: [HardwareType.CAMERA, HardwareType.DISPLAY, HardwareType.SPEAKER]}),
      ).message,
    ).toBe("From notes.example.com\n\nNeeds glasses with a camera, a display and a speaker.")
  })

  it("puts that line after the replace line", () => {
    expect(
      miniappInstallSheetCopy(preview({alreadyInstalled: true, missingHardware: [HardwareType.IMU]})).message,
    ).toBe("From notes.example.com\n\nIt replaces the Notes you have now.\n\nNeeds glasses with a motion sensor.")
  })

  it("names the copy it replaces, which can carry another name", () => {
    expect(miniappInstallSheetCopy(preview({alreadyInstalled: true}), "Notes Dev").message).toBe(
      "From notes.example.com\n\nIt replaces the Notes Dev you have now.",
    )
    expect(miniappInstallSheetCopy(preview({alreadyInstalled: true}), "  ").message).toBe(
      "From notes.example.com\n\nIt replaces the Notes you have now.",
    )
  })
})

describe("the install sheet on the real alert sheet", () => {
  let systemAlert: jest.SpyInstance
  let screen: ReturnType<typeof render> | undefined

  beforeEach(() => {
    systemAlert = jest.spyOn(Alert, "alert").mockImplementation(() => {})
  })

  afterEach(() => {
    screen?.unmount()
    screen = undefined
    systemAlert.mockRestore()
  })

  const open = async (value: MiniappInstallPreview) => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    let answer!: Promise<boolean>
    act(() => {
      answer = confirmMiniappInstall(value)
    })
    await screen.findByText(value.name)
    return () => answer
  }

  it("shows the icon, the name and where it comes from, with Install as the main action", async () => {
    await open(preview())
    expect(screen!.getByText("From notes.example.com")).toBeTruthy()
    expect(screen!.getByTestId("miniappInstall.icon").props.accessibilityLabel).toBe(
      "https://notes.example.com/icon.png",
    )
    expect(buttons(screen!)).toEqual(["Install", "Cancel"])
    expect(systemAlert).not.toHaveBeenCalled()
  })

  it("names the installed copy it replaces", async () => {
    screen = render(<ModalProvider>{null}</ModalProvider>)
    act(() => {
      void confirmMiniappInstall(preview({alreadyInstalled: true}), "Notes Dev")
    })
    expect(await screen.findByText("From notes.example.com\n\nIt replaces the Notes Dev you have now.")).toBeTruthy()
  })

  it("shows the initial when the miniapp names no icon", async () => {
    await open(preview({iconUrl: null}))
    // The tile is decorative: hidden from screen readers, which read the title.
    expect(screen!.getByTestId("miniappInstall.iconTile", {includeHiddenElements: true})).toBeTruthy()
    expect(screen!.getByText("N", {includeHiddenElements: true})).toBeTruthy()
  })

  it("installs only on Install", async () => {
    const answer = await open(preview())
    await act(async () => {
      fireEvent.press(screen!.getByText("Install"))
    })
    await expect(act(async () => answer())).resolves.toBe(true)
  })

  it("installs nothing on Cancel", async () => {
    const answer = await open(preview())
    await act(async () => {
      fireEvent.press(screen!.getByText("Cancel"))
    })
    await expect(act(async () => answer())).resolves.toBe(false)
  })

  it("waits for the sheet to mount rather than answering no", async () => {
    let answer!: Promise<boolean>
    act(() => {
      answer = confirmMiniappInstall(preview())
    })
    await act(async () => {
      await Promise.resolve()
    })
    screen = render(<ModalProvider>{null}</ModalProvider>)
    expect(await screen.findByText("Notes")).toBeTruthy()
    await act(async () => {
      fireEvent.press(screen!.getByText("Install"))
    })
    await expect(act(async () => answer)).resolves.toBe(true)
  })
})
