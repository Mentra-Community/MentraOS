import {useState} from "react"
import {fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp, OrderMap} from "@mentra/engine"

import {AppsGrid} from "./AppsGrid"

let mockApps: ClientApp[] = []
let mockOrder: OrderMap = {}
const mockStart = jest.fn()
const mockPush = jest.fn()
const mockPermissions = jest.fn()
const mockAskPermissions = jest.fn()
const mockAlert = jest.fn()

jest.mock("@mentra/engine", () => ({
  DUMMY_APPLET: {packageName: "@empty", name: ""},
  HardwareType: {EXIST: "EXIST"},
  SETTINGS: {},
  useSetting: () => [false],
  getAppsOrder: () => ({is_ok: () => true, value: {...mockOrder}}),
  saveAppsOrder: (order: OrderMap) => {
    mockOrder = {...order}
  },
  sortAppsByPackageNamePriority: (a: ClientApp, b: ClientApp) => a.packageName.localeCompare(b.packageName),
  useStart: () => mockStart,
  useStop: () => jest.fn(),
  useSetForeground: () => jest.fn(),
  engine: {
    miniapps: {
      list: () => mockApps,
      setHiddenStatus: (pkg: string, hidden: boolean) => {
        mockApps = mockApps.map((app) => (app.packageName === pkg ? {...app, hidden} : app))
        if (!hidden) delete mockOrder[pkg]
      },
    },
  },
}))
jest.mock("@/hooks/useAppsExtras", () => ({useForegroundApps: () => mockApps}))
jest.mock("@/hooks/useCachedRemoteImageSource", () => ({warmCachedRemoteImageSources: jest.fn()}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {primary_foreground: "white"}}, themed: (value: unknown) => value}),
}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: mockPush})}}))
jest.mock("@/stores/miniappLaunch", () => ({setMiniappOpeningAnimation: jest.fn()}))
jest.mock("@/utils/PermissionsUtils", () => ({
  checkPermissionsUI: (...args: unknown[]) => mockPermissions(...args),
  askPermissionsUI: (...args: unknown[]) => mockAskPermissions(...args),
}))
jest.mock("@/contexts/ModalContext", () => ({showAlert: (...args: unknown[]) => mockAlert(...args)}))
jest.mock("@/components/miniapp/offlineHostedPackages", () => ({isOfflineHosted: () => false}))
jest.mock("@/constants/miniapps", () => ({SYSTEM_APPS: ["com.mentra.settings"]}))
jest.mock("@/utils/uninstallAppUI", () => ({uninstallAppUI: jest.fn()}))
jest.mock("@/utils/storage", () => ({storage: {}}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/home/AppIcon", () => () => null)
jest.mock("@/components/home/DraggableList", () => ({DraggableList: () => null}))
jest.mock("@/components/ui/GlassView", () => require("react-native").View)
jest.mock("expo-blur", () => ({BlurView: require("react-native").View}))
jest.mock("@/components/ignite", () => ({
  Icon: () => null,
  Text: ({text}: {text: string}) => {
    const {Text} = require("react-native")
    return <Text>{text}</Text>
  },
}))
jest.mock("react-native-draggable-masonry", () => ({
  DraggableMasonryList: ({
    data,
    renderItem,
    onDragStart,
    sortEnabled,
  }: {
    onDragStart: (event: {key: string; fromIndex: number}) => void
    sortEnabled: boolean
    data: ClientApp[]
    renderItem: (input: {item: ClientApp}) => React.ReactNode
  }) => {
    const {View} = require("react-native")
    return (
      <View testID={sortEnabled ? "grid.home" : "grid.drawer"} onDragStart={onDragStart}>
        {data.map((item) => (
          <View key={item.packageName}>{renderItem({item})}</View>
        ))}
      </View>
    )
  },
}))

// Native geometry is irrelevant here; leaving the ref unset uses the menu's
// existing fallback position while preserving the actual long-press handler.
jest.mock("react-native/Libraries/Components/Pressable/Pressable", () => {
  const {View} = require("react-native")
  return {
    __esModule: true,
    default: function MockPressable({ref: _ref, ...props}: Record<string, unknown>) {
      return <View {...props} />
    },
  }
})

function HomeAndDrawer({searchQuery}: {searchQuery?: string}) {
  const [homePackageNames, setHomePackageNames] = useState<string[]>([])
  return (
    <>
      <AppsGrid onHomeAppsChange={setHomePackageNames} />
      <AppsGrid showAllApps homePackageNames={homePackageNames} searchQuery={searchQuery} />
    </>
  )
}

function app(index: number, hidden = false): ClientApp {
  const name = `App ${String(index).padStart(2, "0")}`
  return {packageName: `app.${index}`, name, hidden} as ClientApp
}

function openDrawerMenu(pkg: string) {
  fireEvent(screen.getByTestId(`allApps.miniapp.${pkg}`), "longPress")
  expect(screen.getByText("appInfo:start")).toBeTruthy()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockOrder = {}
  mockApps = [app(0), app(1, true)]
})

test("hides Add to Home for a visible miniapp without a saved position, including search", () => {
  render(<HomeAndDrawer searchQuery="App 00" />)
  expect(screen.getByTestId("home.miniapp.app.0")).toBeTruthy()
  openDrawerMenu("app.0")
  expect(screen.queryByText("appInfo:addToHome")).toBeNull()
})

test("offers Add to Home again after a miniapp is removed and hides it after re-adding", () => {
  const view = render(<HomeAndDrawer />)
  fireEvent(screen.getByTestId("grid.home"), "dragStart", {key: "app.0", fromIndex: 0})
  fireEvent.press(screen.getByText("appInfo:remove"))
  view.rerender(<HomeAndDrawer />)
  expect(screen.queryByTestId("home.miniapp.app.0")).toBeNull()
  openDrawerMenu("app.0")
  fireEvent.press(screen.getByText("appInfo:addToHome"))
  view.rerender(<HomeAndDrawer />)
  expect(screen.getByTestId("home.miniapp.app.0")).toBeTruthy()
  openDrawerMenu("app.0")
  expect(screen.queryByText("appInfo:addToHome")).toBeNull()
})

test("keeps overflow miniapps addable on a full 20-slot Home", () => {
  mockApps = Array.from({length: 21}, (_, index) => app(index))
  mockOrder = Object.fromEntries(mockApps.map((entry, index) => [entry.packageName, index]))
  render(<HomeAndDrawer />)
  expect(screen.getByTestId("home.miniapp.app.19")).toBeTruthy()
  expect(screen.queryByTestId("home.miniapp.app.20")).toBeNull()
  openDrawerMenu("app.20")
  expect(screen.getByText("appInfo:addToHome")).toBeTruthy()
})

test("uses actual Home slots when a saved layout has gaps and an overflow miniapp", () => {
  mockApps = [app(0), app(1)]
  mockOrder = {"app.0": 3, "app.1": 20}
  render(<HomeAndDrawer searchQuery="App 01" />)
  expect(screen.getByTestId("home.miniapp.app.0")).toBeTruthy()
  expect(screen.queryByTestId("home.miniapp.app.1")).toBeNull()
  openDrawerMenu("app.1")
  expect(screen.getByText("appInfo:addToHome")).toBeTruthy()
})
