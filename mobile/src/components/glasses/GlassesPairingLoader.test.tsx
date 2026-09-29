import {act, render} from "@testing-library/react-native"
import {engine} from "@mentra/engine"
import type {ReactNode} from "react"

import GlassesPairingLoader from "./GlassesPairingLoader"

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {isDark: false, colors: {primary: "#111"}, spacing: {s2: 8}}}),
}))
jest.mock("@/components/ignite", () => {
  const {Text: RNText} = require("react-native")
  return {
    Text: ({tx, children}: {tx?: string; children?: ReactNode}) => <RNText>{tx ?? children}</RNText>,
    Button: () => null,
  }
})
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
})
jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => ({
  getModelSpecificTips: () => [{body: "tip"}],
}))
jest.mock("@/utils/getGlassesImage", () => ({getGlassesImage: () => 1}))

describe("G2 pairing progress", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("starts quiet, shows delayed native progress and clears it when the other arm connects", () => {
    let missingArm: "left" | "right" | null = null
    let notify = () => {}
    ;(engine.glasses.status as jest.Mock).mockImplementation(() => ({g2MissingArm: missingArm}))
    ;(engine.glasses.onStatus as jest.Mock).mockImplementation((listener) => {
      notify = listener
      return () => {}
    })
    const screen = render(<GlassesPairingLoader deviceModel="Even Realities G2" />)
    expect(screen.queryByText("pairing:g2WaitingForLeft")).toBeNull()
    act(() => {
      missingArm = "left"
      notify()
    })
    expect(screen.getByText("pairing:g2WaitingForLeft")).toBeTruthy()
    act(() => {
      missingArm = null
      notify()
    })
    expect(screen.queryByText("pairing:g2WaitingForLeft")).toBeNull()
    screen.unmount()
  })
})
