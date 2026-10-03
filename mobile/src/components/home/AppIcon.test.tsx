import {fireEvent, render} from "@testing-library/react-native"
import type {ClientApp} from "@mentra/engine"
import {View} from "react-native"

import AppIcon from "./AppIcon"

jest.mock("uniwind", () => ({withUniwind: (component: unknown) => component}))
jest.mock("expo-squircle-view", () => ({SquircleView: require("react-native").View}))
jest.mock("@/components/ignite", () => ({Icon: () => null}))
jest.mock("@/components/miniapps/DevIcons", () => ({DevIcon: () => null, DevMiniappBadge: () => null}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {spacing: {s3: 12, s4: 16}, colors: {palette: {white: "#fff"}}}}),
}))
jest.mock("@/hooks/useCachedRemoteImageSource", () => ({
  useCachedRemoteImageSource: () => null,
  isRemoteImageSourceFailed: () => false,
  markRemoteImageSourceFailed: jest.fn(),
}))

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
