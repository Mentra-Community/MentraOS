import {act, fireEvent, render} from "@testing-library/react-native"

import AddMiniappScreen from "@/app/miniapps/add"

const mockStartInstall = jest.fn(async (..._args: unknown[]) => "installed")
jest.mock("@/services/miniapps/miniappInstallFlow", () => ({
  startMiniappInstallFromLink: (...args: unknown[]) => mockStartInstall(...args),
}))
const mockScan = jest.fn(
  async (..._args: unknown[]): Promise<{data: string} | {cancelled: true}> => ({cancelled: true}),
)
jest.mock("@/services/qrScanRequest", () => ({requestPhoneQrScan: (...args: unknown[]) => mockScan(...args)}))
const mockGoBack = jest.fn()
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({goBack: mockGoBack})}}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {foreground: "#000", muted_foreground: "#888"}}}),
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ui/GlassView", () => ({
  __esModule: true,
  default: ({children}: {children: unknown}) => children,
}))
jest.mock("@/components/ui/Group", () => ({Group: ({children}: {children: unknown}) => children}))
jest.mock("@/components/ui/RouteButton", () => ({
  RouteButton: ({label, onPress}: {label: string; onPress?: () => void}) => {
    const {Pressable, Text} = require("react-native")
    return (
      <Pressable accessibilityRole="button" onPress={onPress}>
        <Text>{label}</Text>
      </Pressable>
    )
  },
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text, View} = require("react-native")
  return {
    Screen: ({children}: {children: unknown}) => <View>{children}</View>,
    Header: ({title}: {title: string}) => <Text>{title}</Text>,
    Text: ({tx, text}: {tx?: string; text?: string}) => <Text>{tx ?? text}</Text>,
    Button: ({
      tx,
      onPress,
      disabled,
      testID,
    }: {
      tx: string
      onPress: () => void
      disabled?: boolean
      testID?: string
    }) => (
      <Pressable accessibilityRole="button" onPress={disabled ? undefined : onPress} testID={testID}>
        <Text>{tx}</Text>
      </Pressable>
    ),
  }
})

beforeEach(() => jest.clearAllMocks())

it("installs from a pasted URL", async () => {
  const screen = render(<AddMiniappScreen />)
  fireEvent.changeText(screen.getByTestId("miniappAdd.url"), "https://notes.example.com/miniapp.json")
  await act(async () => {
    fireEvent.press(screen.getByTestId("miniappAdd.continue"))
  })
  expect(mockStartInstall).toHaveBeenCalledWith(
    "https://notes.example.com/miniapp.json",
    "paste",
    expect.objectContaining({onPresent: expect.any(Function)}),
  )
})

it("does nothing until a URL is pasted", async () => {
  const screen = render(<AddMiniappScreen />)
  await act(async () => {
    fireEvent.press(screen.getByTestId("miniappAdd.continue"))
  })
  expect(mockStartInstall).not.toHaveBeenCalled()
})

it("installs from a scanned QR code", async () => {
  mockScan.mockResolvedValueOnce({data: "https://apps.mentraglass.com/package/com.example.notes"})
  const screen = render(<AddMiniappScreen />)
  await act(async () => {
    fireEvent.press(screen.getByText("miniappInstall:scanLabel"))
  })
  expect(mockScan).toHaveBeenCalledWith({title: "miniappInstall:scanTitle", hint: "miniappInstall:scanHint"})
  expect(mockStartInstall).toHaveBeenCalledWith(
    "https://apps.mentraglass.com/package/com.example.notes",
    "scanner",
    expect.anything(),
  )
})

it("installs nothing when the scan is cancelled", async () => {
  const screen = render(<AddMiniappScreen />)
  await act(async () => {
    fireEvent.press(screen.getByText("miniappInstall:scanLabel"))
  })
  expect(mockStartInstall).not.toHaveBeenCalled()
})
