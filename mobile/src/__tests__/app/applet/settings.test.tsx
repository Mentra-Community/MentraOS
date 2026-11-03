import {render} from "@testing-library/react-native"
import i18n from "i18next"

import AppSettings from "@/app/applet/settings"
import en from "@/i18n/en"

/** The miniapp the page was opened for, and whether a workspace's assignment is one of the reasons it is installed. */
const mockApp = {packageName: "com.acme.notes", name: "Notes", version: "1.0.0", healthy: true, type: "standard"}
let mockManaged = false

jest.mock("expo-router", () => ({useLocalSearchParams: () => ({packageName: "com.acme.notes", appName: "Notes"})}))
jest.mock("react-native-view-shot", () => ({captureRef: jest.fn()}))
jest.mock("react-native-toast-message", () => ({__esModule: true, default: {show: jest.fn()}}))
jest.mock("@mentra/engine", () => ({
  engine: {miniapps: {uninstall: jest.fn(), stop: jest.fn(), saveScreenshot: jest.fn()}},
  useApps: () => [mockApp],
  useRefresh: () => jest.fn(async () => {}),
}))
jest.mock("@mentra/engine-host-internal", () => ({hasAssignmentReason: () => mockManaged}))
jest.mock("@/contexts/SaferAreaContext", () => ({useSaferAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({focusEffectPreventBack: jest.fn()}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => {
    const theme = {colors: {text: "#000", error: "#d00", errorBackground: "#fee"}, spacing: {}}
    return {theme, themed: () => ({})}
  },
}))
jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({goBack: jest.fn(), replaceAll: jest.fn()})},
}))
jest.mock("@/i18n", () => ({
  translate: (...args: unknown[]) => require("@/i18n/translate").translate(...args),
}))
jest.mock("@/constants/miniapps", () => ({SYSTEM_APPS: ["com.mentra.settings"]}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/utils/miniappUpdatingAlert", () => ({blockUpdatingMiniapp: () => false}))
jest.mock("@/components/home/AppIcon", () => ({__esModule: true, default: () => null}))
jest.mock("@/components/ui/LoadingOverlay", () => ({__esModule: true, default: () => null}))
jest.mock("@/components/ui/Divider", () => ({__esModule: true, default: () => null}))
jest.mock("@/components/ui/InfoCard", () => ({__esModule: true, default: () => null}))
jest.mock("@/components/ui/RouteButton", () => ({
  RouteButton: ({label}: {label: string}) => {
    const {Text} = require("react-native")
    return <Text>{label}</Text>
  },
}))
jest.mock("@/components/ignite", () => {
  const {Text, View} = require("react-native")
  return {
    Header: () => null,
    Icon: () => null,
    Screen: ({children}: {children: React.ReactNode}) => <View>{children}</View>,
    Text: ({children, text}: {children?: React.ReactNode; text?: string}) => <Text>{children ?? text}</Text>,
  }
})

describe("Miniapp info", () => {
  beforeAll(async () => {
    await i18n.init({lng: "en", resources: {en: en as never}, interpolation: {escapeValue: false}})
  })

  it("offers Uninstall for a miniapp that no workspace assigned", () => {
    mockManaged = false
    const screen = render(<AppSettings />)
    expect(screen.getByText("Uninstall")).toBeTruthy()
  })

  it("shows no Uninstall, and no explanation, for a managed miniapp", () => {
    mockManaged = true
    const screen = render(<AppSettings />)
    expect(screen.queryByText("Uninstall")).toBeNull()
    expect(screen.queryByText("Cannot Uninstall")).toBeNull()
    // The rest of the page is still there.
    expect(screen.getAllByText("Notes").length).toBeGreaterThan(0)
    expect(screen.getByText("App info")).toBeTruthy()
  })
})
