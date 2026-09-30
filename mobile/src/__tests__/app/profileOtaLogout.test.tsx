import {act, fireEvent, render} from "@testing-library/react-native"
import {engine} from "@mentra/engine"

import ProfileSettingsPage from "@/app/miniapps/settings/profile"

const mockEvents: string[] = []
const mockLogout = jest.fn(async () => {
  mockEvents.push("logout")
})
const mockClose = jest.fn(async () => {
  mockEvents.push("close")
})
const mockReplace = jest.fn(() => {
  mockEvents.push("navigate")
})
const mockAlert = jest.fn()
jest.mock("@/contexts/AuthContext", () => ({useAuth: () => ({loading: false, logout: mockLogout, user: null})}))
jest.mock("@/stores/capsule", () => ({useCapsuleStore: {getState: () => ({active: {handleRightPress: mockClose}})}}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({replaceAll: mockReplace})}}))
jest.mock("@/services/deployment", () => ({
  useDeployment: () => ({activeDeployment: {kind: "consumer", manifest: {displayName: "Mentra"}}}),
}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {}, spacing: {s6: 24}}, themed: () => ({})}),
}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: async () => {}}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: (...args: unknown[]) => mockAlert(...args)}))
jest.mock("@/utils/auth/authClient", () => ({__esModule: true, default: {}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/auth/WorkspaceBrand", () => ({WorkspaceBrand: () => null}))
jest.mock("@/components/ignite", () => {
  const {View, Text} = require("react-native")
  return {Screen: View, Text, Header: () => null}
})
jest.mock("@/components/ui/Group", () => ({Group: require("react-native").View}))
jest.mock("@/components/ui/Spacer", () => ({Spacer: () => null}))
jest.mock("@/components/ui/RouteButton", () => {
  const {Pressable, Text} = require("react-native")
  return {
    RouteButton: ({label, onPress}: {label: string; onPress?: () => void}) => (
      <Pressable onPress={onPress}>
        <Text>{label}</Text>
      </Pressable>
    ),
  }
})

beforeEach(() => {
  jest.clearAllMocks()
  mockEvents.length = 0
  ;(engine.firmwareUpdates.assertSafeToRelease as jest.Mock).mockReset().mockImplementation(() => {
    mockEvents.push("admit")
  })
  ;(engine.firmwareUpdates.suspendNewWork as jest.Mock).mockImplementation(() => {
    mockEvents.push("suspend")
  })
})

async function confirmLogout() {
  const view = render(<ProfileSettingsPage />)
  fireEvent.press(view.getByText("common:logOut"))
  await act(async () => {
    await mockAlert.mock.calls[0][2][1].onPress()
  })
}

it("keeps Settings and authentication intact when native OTA rejects logout", async () => {
  ;(engine.firmwareUpdates.assertSafeToRelease as jest.Mock).mockImplementation(() => {
    throw new Error("Wait for the glasses update")
  })
  await confirmLogout()
  expect(mockClose).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(mockLogout).not.toHaveBeenCalled()
  expect(engine.firmwareUpdates.suspendNewWork).not.toHaveBeenCalled()
  expect(mockAlert).toHaveBeenLastCalledWith("common:error", "Wait for the glasses update")
})

it("admits and suspends optional OTA before preserving the existing unmount/logout order", async () => {
  await confirmLogout()
  expect(mockEvents).toEqual(["admit", "suspend", "close", "navigate", "logout"])
  expect(mockReplace).toHaveBeenCalledWith("/auth/start")
})
