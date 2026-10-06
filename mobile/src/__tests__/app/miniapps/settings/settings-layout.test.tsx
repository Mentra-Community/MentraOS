import {render, screen} from "@testing-library/react-native"
import {ScrollView} from "react-native"

import MainSettingsPage from "@/app/miniapps/settings/main"
import ProfileSettingsPage from "@/app/miniapps/settings/profile"
import {spacing} from "@/theme/spacing"

let mockDeployment = {
  kind: "consumer" as "consumer" | "workspace",
  manifest: {displayName: "Mentra"},
  workspaceOrigin: "https://workspace.example.test",
}
let mockUser = {name: "Test User", email: "user@example.test", provider: "email", createdAt: "2026-01-01"}

jest.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({loading: false, logout: jest.fn(), user: mockUser}),
}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const theme = {colors: {}, spacing: require("@/theme/spacing").spacing}
    return {theme, themed: (style: (value: typeof theme) => unknown) => style(theme)}
  },
}))
jest.mock("@/services/deployment", () => ({useDeployment: () => ({activeDeployment: mockDeployment})}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({goBack: jest.fn(), push: jest.fn(), replaceAll: jest.fn()})},
}))
jest.mock("@/stores/capsule", () => ({useCapsuleStore: {}, useRegisterCapsule: jest.fn()}))
jest.mock("@/utils/AlertUtils", () => ({__esModule: true, default: jest.fn()}))
jest.mock("@/utils/auth/authClient", () => ({__esModule: true, default: {}}))
jest.mock("@/utils/auth/authErrors", () => ({mapAuthError: jest.fn()}))
jest.mock("@/utils/settleFrame", () => ({settleFrame: jest.fn()}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/auth/WorkspaceBrand", () => ({WorkspaceBrand: () => null}))
jest.mock("@/components/settings/DeviceSettingsSection", () => ({DeviceSettingsSection: () => null}))
jest.mock("@/components/dev/VersionInfo", () => ({
  VersionInfo: () => {
    const {Text} = require("react-native")
    return <Text>Version</Text>
  },
}))
jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    debug_mode: {key: "debug_mode"},
    super_mode: {key: "super_mode"},
    appearance_menu_enabled: {key: "appearance_menu_enabled"},
  },
  useSetting: () => [false],
}))
jest.mock("react-native-gesture-handler", () => ({ScrollView: require("react-native").ScrollView}))
jest.mock("react-native-svg", () => ({__esModule: true, default: require("react-native").View, Path: () => null}))
jest.mock("@/components/ignite", () => {
  const {Text, View} = require("react-native")
  return {Screen: View, Text, Header: () => null, Icon: () => null}
})
jest.mock("@/components/ui/RouteButton", () => {
  const {Pressable, Text} = require("react-native")
  return {
    RouteButton: ({label, text, style}: {label: string; text?: string; style: unknown}) => (
      <Pressable accessibilityRole="button" accessibilityLabel={label} style={style}>
        <Text>{label}</Text>
        {text && <Text>{text}</Text>}
      </Pressable>
    ),
  }
})
jest.mock("@/components/ui/Spacer", () => ({
  Spacer: ({height}: {height: number}) => {
    const {View} = require("react-native")
    return <View style={{height}} />
  },
}))

beforeEach(() => {
  mockDeployment = {
    kind: "consumer",
    manifest: {displayName: "Mentra"},
    workspaceOrigin: "https://workspace.example.test",
  }
  mockUser = {name: "Test User", email: "user@example.test", provider: "email", createdAt: "2026-01-01"}
})

function expectBottomSpacing() {
  const scrollView = screen.UNSAFE_getByType(ScrollView)
  const children = scrollView.props.children.filter(Boolean)
  expect(children[children.length - 1].props.height).toBe(spacing.s16)
}

test.each(["email", "google", "apple"])("groups the visible %s account actions with correct corners", (provider) => {
  mockUser.provider = provider
  render(<ProfileSettingsPage />)

  const firstLabel = provider === "email" ? "profileSettings:changePassword" : "profileSettings:requestDataExport"
  const firstButton = screen.getByRole("button", {name: firstLabel})
  expect(firstButton).toHaveStyle({
    borderRadius: spacing.s4,
    borderBottomLeftRadius: spacing.s1,
    borderBottomRightRadius: spacing.s1,
  })
  const middleLabels =
    provider === "email"
      ? ["profileSettings:changeEmail", "profileSettings:requestDataExport", "profileSettings:deleteAccount"]
      : ["profileSettings:deleteAccount"]
  for (const label of middleLabels) {
    expect(screen.getByRole("button", {name: label})).toHaveStyle({
      borderRadius: spacing.s1,
    })
  }
  expect(screen.getByRole("button", {name: "common:logOut"})).toHaveStyle({
    borderRadius: spacing.s4,
    borderTopLeftRadius: spacing.s1,
    borderTopRightRadius: spacing.s1,
  })
  if (provider !== "email") {
    expect(screen.queryByText("profileSettings:changePassword")).toBeNull()
    expect(screen.queryByText("profileSettings:changeEmail")).toBeNull()
  }
})

test("hides the default Mentra workspace and leaves space under the profile content", () => {
  render(<ProfileSettingsPage />)

  expect(screen.queryByText("workspace:workspaceLabel")).toBeNull()
  expect(screen.queryByText("Mentra")).toBeNull()
  expectBottomSpacing()
})

test("preserves workspace details and rounds the sole workspace account action", () => {
  mockDeployment.kind = "workspace"
  mockDeployment.manifest.displayName = "Test Workspace"
  render(<ProfileSettingsPage />)

  expect(screen.getByText("workspace:workspaceLabel")).toBeTruthy()
  expect(screen.getByText("Test Workspace")).toBeTruthy()
  expect(screen.getByText(mockDeployment.workspaceOrigin)).toBeTruthy()
  expect(screen.queryByText("profileSettings:changePassword")).toBeNull()
  expect(screen.queryByText("profileSettings:requestDataExport")).toBeNull()
  expect(screen.queryByText("profileSettings:deleteAccount")).toBeNull()
  expect(screen.getByRole("button", {name: "common:logOut"})).toHaveStyle({
    borderRadius: spacing.s4,
  })
  expectBottomSpacing()
})

test("leaves additional space below the version on the main Settings screen", () => {
  render(<MainSettingsPage />)

  expect(screen.getByText("Version")).toBeTruthy()
  expectBottomSpacing()
})
