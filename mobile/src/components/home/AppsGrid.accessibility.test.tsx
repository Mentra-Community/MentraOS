import {act, fireEvent, render, screen} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"

import {AppsGrid} from "./AppsGrid"

let mockApps: ClientApp[] = []
let mockPendingPackages = new Set<string>()
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
  getAppsOrder: () => ({is_ok: () => true, value: {}}),
  saveAppsOrder: jest.fn(),
  sortAppsByPackageNamePriority: (a: ClientApp, b: ClientApp) => a.packageName.localeCompare(b.packageName),
  useStart: () => mockStart,
  useStop: () => jest.fn(),
  useSetForeground: () => jest.fn(),
  engine: {miniapps: {list: () => mockApps}},
}))
jest.mock("@/hooks/useAppsExtras", () => ({
  useForegroundApps: () => mockApps,
  usePendingDefaultPackages: () => mockPendingPackages,
  isPendingDefaultApp: (packageName: string) => mockPendingPackages.has(packageName),
}))
jest.mock("@/hooks/useCachedRemoteImageSource", () => ({warmCachedRemoteImageSources: jest.fn()}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {primary_foreground: "white"}}, themed: (value: unknown) => value}),
}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: () => ({push: mockPush})}}))
jest.mock("@/stores/miniappLaunch", () => ({setMiniappOpeningAnimation: jest.fn()}))
const mockStartWait = jest.fn()
jest.mock("@/stores/miniappOpenWait", () => ({
  startMiniappOpenWait: (...args: unknown[]) => mockStartWait(...args),
}))
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
  }: {
    data: ClientApp[]
    renderItem: (input: {item: ClientApp}) => React.ReactNode
  }) => {
    const {View} = require("react-native")
    return (
      <View>
        {data.map((item) => (
          <View key={item.packageName}>{renderItem({item})}</View>
        ))}
      </View>
    )
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  mockPendingPackages = new Set()
  mockApps = [
    {packageName: "com.mentra.settings", name: "Settings", offlineRoute: "/miniapps/settings/main"} as ClientApp,
  ]
  mockStart.mockResolvedValue(true)
  mockPermissions.mockResolvedValue([])
  mockAskPermissions.mockResolvedValue(1)
})

type Activation = "press" | "accessibilityTap" | "accessibilityAction"
async function activate(event: Activation, showAllApps = false) {
  render(<AppsGrid showAllApps={showAllApps} />)
  await act(async () => {})
  const target = screen.getByTestId(`${showAllApps ? "allApps" : "home"}.miniapp.com.mentra.settings`)
  await act(async () => {
    if (event === "press") fireEvent.press(target)
    else if (event === "accessibilityTap") {
      // fireEvent walks composite parents and can hide a wrapper that drops
      // this prop. Fabric activation needs the handler on the host view.
      expect(target.props.onAccessibilityTap).toEqual(expect.any(Function))
      target.props.onAccessibilityTap()
    } else {
      expect(target.props.onAccessibilityAction).toEqual(expect.any(Function))
      target.props.onAccessibilityAction({nativeEvent: {actionName: "activate"}})
    }
  })
}

describe.each([false, true])("miniapp activation, allApps=%s", (showAllApps) => {
  test.each(["press", "accessibilityTap", "accessibilityAction"] as const)(
    "%s launches Settings through its normal route",
    async (event) => {
      await activate(event, showAllApps)
      expect(mockStart).toHaveBeenCalledTimes(1)
      expect(mockStart).toHaveBeenCalledWith(
        expect.objectContaining({packageName: "com.mentra.settings"}),
        expect.any(Object),
      )
      expect(mockPush).toHaveBeenCalledWith("/miniapps/settings/main", {transition: "fade"})
    },
  )
})

test.each(["accessibilityTap", "accessibilityAction"] as const)("%s preserves the permission gate", async (event) => {
  mockPermissions.mockResolvedValue(["microphone"])
  mockAskPermissions.mockResolvedValue(0)
  await activate(event)
  expect(mockAskPermissions).toHaveBeenCalledTimes(1)
  expect(mockStart).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
})

test.each(["accessibilityTap", "accessibilityAction"] as const)(
  "%s preserves hardware compatibility",
  async (event) => {
    mockApps[0] = {
      ...mockApps[0],
      compatibility: {isCompatible: false, missingRequired: [{type: "EXIST"}]},
    } as ClientApp
    await activate(event)
    expect(mockAlert).toHaveBeenCalledTimes(1)
    expect(mockPermissions).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
  },
)

test("unrecognized accessibility actions do not launch a miniapp", async () => {
  render(<AppsGrid />)
  await act(async () => {})
  screen.getByRole("button", {name: "Settings"}).props.onAccessibilityAction({
    nativeEvent: {actionName: "escape"},
  })
  expect(mockStart).not.toHaveBeenCalled()
  expect(mockPush).not.toHaveBeenCalled()
})

test.each(["press", "accessibilityTap"] as const)(
  "%s on an updating miniapp waits behind its splash, then opens it in place",
  async (event) => {
    mockApps[0] = {...mockApps[0], updating: true} as ClientApp
    await activate(event)
    expect(mockAlert).not.toHaveBeenCalled()
    expect(mockPermissions).not.toHaveBeenCalled()
    expect(mockStart).not.toHaveBeenCalled()
    expect(mockStartWait).toHaveBeenCalledWith(
      expect.objectContaining({packageName: "com.mentra.settings"}),
      expect.any(Function),
    )
    const target = screen.getByTestId("home.miniapp.com.mentra.settings")
    expect(target.props.accessibilityLabel).toBe("home:miniappUpdatingLabel")
    expect(target.props.accessibilityState).toEqual({busy: true})

    // The update installed: the wait opens it through the same gates as a tap.
    mockApps[0] = {...mockApps[0], updating: false} as ClientApp
    const open = mockStartWait.mock.calls[0][1] as (app: ClientApp) => Promise<void>
    await act(async () => open(mockApps[0]))
    expect(mockPermissions).toHaveBeenCalledTimes(1)
    expect(mockStart).toHaveBeenCalledTimes(1)
  },
)

test("a default miniapp still installing shows as installed, says so to a screen reader, and waits behind its splash", async () => {
  mockApps = [
    ...mockApps,
    {packageName: "com.mentra.ai", name: "Mentra AI", compatibility: {isCompatible: true}} as ClientApp,
  ]
  mockPendingPackages = new Set(["com.mentra.ai"])
  const onOpenApp = jest.fn()
  render(<AppsGrid showAllApps={true} onOpenApp={onOpenApp} />)
  await act(async () => {})
  const target = screen.getByTestId("allApps.miniapp.com.mentra.ai")
  expect(target.props.accessibilityLabel).toBe("home:miniappInstallingLabel")
  expect(target.props.accessibilityState).toEqual({busy: true})

  await act(async () => fireEvent.press(target))
  expect(mockStartWait).toHaveBeenCalledWith(
    expect.objectContaining({packageName: "com.mentra.ai"}),
    expect.any(Function),
  )
  // All Apps closes, and its keyboard with it, as the splash slides in.
  expect(onOpenApp).toHaveBeenCalledWith(expect.objectContaining({packageName: "com.mentra.ai"}))
  expect(mockPermissions).not.toHaveBeenCalled()
  expect(mockStart).not.toHaveBeenCalled()
})
