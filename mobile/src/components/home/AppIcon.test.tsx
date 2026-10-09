import {View} from "react-native"
import {fireEvent, render} from "@testing-library/react-native"
import {engine, type ClientApp} from "@mentra/engine"

import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"

import AppIcon from "./AppIcon"

jest.mock("expo-image", () => ({Image: require("react-native").View}))
jest.mock("expo-squircle-view", () => ({SquircleView: require("react-native").View}))
jest.mock("uniwind", () => ({withUniwind: (component: unknown) => component}))
jest.mock("@/components/ignite", () => ({Icon: require("react-native").View}))
jest.mock("@/components/miniapps/DevIcons", () => ({
  DevIcon: require("react-native").View,
  DevMiniappBadge: require("react-native").View,
}))
jest.mock("@/contexts/ModalContext", () => ({showAlert: jest.fn(async () => {})}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {spacing: {s3: 12, s4: 16}, colors: {palette: {white: "#fff", neutral200: "#ddd"}, textDim: "#777"}},
  }),
}))
jest.mock("@/hooks/useCachedRemoteImageSource", () => ({
  isRemoteImageSourceFailed: () => false,
  markRemoteImageSourceFailed: jest.fn(),
  useCachedRemoteImageSource: () => ({uri: "file:///icon.png"}),
}))

const app: ClientApp = {
  packageName: "com.test.notes",
  name: "Notes",
  webviewUrl: "",
  logoUrl: "file:///icon.png",
  type: "background",
  permissions: [],
  running: false,
  healthy: true,
  hardwareRequirements: [],
  offline: false,
  offlineRoute: "",
  loading: false,
  local: true,
  hidden: false,
  compatibility: {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []},
}

describe("miniapp update indicator", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(engine.miniapps.list as jest.Mock).mockReturnValue([app])
  })

  it("shows update progress and a popup on tap, without opening or queueing", () => {
    const updating = {...app, updating: true}
    ;(engine.miniapps.list as jest.Mock).mockReturnValue([updating])
    const open = jest.fn()
    const {getByRole, getByLabelText, queryByLabelText, rerender} = render(
      <AppIcon app={updating} onClick={open} disableLoader />,
    )
    expect(getByLabelText(translate("home:miniappUpdating"))).toBeTruthy()
    expect(getByRole("button").props.accessibilityState.busy).toBe(true)
    fireEvent.press(getByRole("button"))
    expect(open).not.toHaveBeenCalled()
    expect(showAlert).toHaveBeenCalledWith({
      title: translate("home:miniappUpdatingTitle"),
      message: translate("home:miniappUpdatingMessage"),
      buttons: [{text: translate("common:ok")}],
    })
    ;(engine.miniapps.list as jest.Mock).mockReturnValue([app])
    rerender(<AppIcon app={app} onClick={open} disableLoader />)
    expect(queryByLabelText(translate("home:miniappUpdating"))).toBeNull()
    expect(open).not.toHaveBeenCalled()
    fireEvent.press(getByRole("button"))
    expect(open).toHaveBeenCalledTimes(1)
  })

  it("uses live update state even before the icon has rerendered", () => {
    const open = jest.fn()
    const {getByRole} = render(<AppIcon app={app} onClick={open} />)
    ;(engine.miniapps.list as jest.Mock).mockReturnValue([{...app, updating: true}])
    fireEvent.press(getByRole("button"))
    expect(open).not.toHaveBeenCalled()
    expect(showAlert).toHaveBeenCalledTimes(1)
  })
})

describe("AppIcon compatibility changes", () => {
  it("keeps one native opacity owner and the same icon across unpair and reconnect", () => {
    const onClick = jest.fn()
    const app = {
      packageName: "com.mentra.test",
      name: "Test miniapp",
      logoUrl: "",
      healthy: true,
      iconComponent: <View testID="retained-icon" />,
      compatibility: {isCompatible: true},
    } as ClientApp
    const screen = render(<AppIcon app={app} onClick={onClick} />)
    const owner = screen.UNSAFE_getAllByType(View)[0]
    const icon = screen.getByTestId("retained-icon")

    // A layout-only owner would be flattened while compatible, then newly
    // inserted around an existing native icon when Unpair adds opacity.
    expect(owner.props.collapsable).toBe(false)
    expect(owner.props.className).not.toContain("opacity-15")

    screen.rerender(<AppIcon app={{...app, compatibility: {isCompatible: false}} as ClientApp} onClick={onClick} />)
    expect(screen.UNSAFE_getAllByType(View)[0]).toBe(owner)
    expect(owner.props.collapsable).toBe(false)
    expect(owner.props.className).toContain("opacity-15")
    expect(screen.getByTestId("retained-icon")).toBe(icon)

    screen.rerender(<AppIcon app={app} onClick={onClick} />)
    expect(screen.UNSAFE_getAllByType(View)[0]).toBe(owner)
    expect(owner.props.collapsable).toBe(false)
    expect(owner.props.className).not.toContain("opacity-15")
    fireEvent.press(screen.getByLabelText("Launch Test miniapp"))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
