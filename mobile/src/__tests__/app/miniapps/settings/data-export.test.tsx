import {act, fireEvent, render, screen} from "@testing-library/react-native"
import {Share} from "react-native"

import DataExportPage from "@/app/miniapps/settings/data-export"

let mockNativeApplicationVersion: string | null = null

jest.mock("expo-application", () => ({
  get nativeApplicationVersion() {
    return mockNativeApplicationVersion
  },
}))
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({user: null, session: null})}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {spacing: {s3: 12, s4: 16, s6: 24}, colors: {}}, themed: () => ({})}),
}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({goBack: jest.fn()})}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ui/Divider", () => ({Divider: () => null}))
jest.mock("@/components/ui/Spacer", () => ({Spacer: () => null}))
jest.mock("@/components/ui/Group", () => ({
  Group: ({children}: {children: React.ReactNode}) => children,
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text, View} = require("react-native")
  return {
    Screen: View,
    Header: () => null,
    Icon: () => null,
    Text: ({text}: {text: string}) => <Text>{text}</Text>,
    Button: ({text, onPress, disabled}: {text: string; onPress: () => void; disabled?: boolean}) => (
      <Pressable accessibilityRole="button" onPress={onPress} disabled={disabled}>
        <Text>{text}</Text>
      </Pressable>
    ),
  }
})

async function sharedExportMetadata() {
  const share = jest.spyOn(Share, "share").mockResolvedValue({action: Share.sharedAction})
  render(<DataExportPage />)
  await act(async () => {})
  await act(async () => fireEvent.press(screen.getByRole("button", {name: "profileSettings:dataExportShare"})))

  expect(share).toHaveBeenCalledTimes(1)
  const message = share.mock.calls[0][0].message ?? ""
  return JSON.parse(message.slice(message.indexOf("{"))).metadata
}

afterEach(() => {
  jest.restoreAllMocks()
})

test.each(["3.3.0", "4.0.1", "3.2.0-beta.4"])(
  "shared export records installed Mentra App version %s",
  async (version) => {
    mockNativeApplicationVersion = version

    const metadata = await sharedExportMetadata()

    expect(metadata.appVersion).toBe(version)
    expect(metadata.exportVersion).toBe("1.0.0")
  },
)

test.each([null, "", "  "])(
  "unavailable native version %p is exported as null, not a guessed version",
  async (version) => {
    mockNativeApplicationVersion = version

    const metadata = await sharedExportMetadata()

    expect(metadata).toHaveProperty("appVersion", null)
  },
)
