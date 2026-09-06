import {fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {PairGlassesCard} from "./PairGlassesCard"
import {isGlassesModelAllowedByDeployment} from "@/services/deployment/glassesPolicy"

jest.mock("@mentra/engine", () => ({
  DeviceTypes: {SIMULATED: "Simulated Glasses"},
  engine: {glasses: {connectSimulated: jest.fn()}},
}))

jest.mock("@/services/deployment/glassesPolicy", () => ({
  isGlassesModelAllowedByDeployment: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: () => ({push: jest.fn()})},
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {background: "#fff"}}}),
}))

jest.mock("@/components/ignite", () => {
  const {Pressable, View} = require("react-native")
  return {
    Button: ({onPress, tx}: {onPress?: () => void; tx: string}) => (
      <Pressable accessibilityLabel={tx} accessibilityRole="button" onPress={onPress} />
    ),
    Text: ({tx}: {tx: string}) => <View accessibilityLabel={tx} />,
  }
})

jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return MockGlassView
})

describe("PairGlassesCard", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(isGlassesModelAllowedByDeployment as jest.Mock).mockReturnValue(true)
  })

  it("offers Phone Mode when simulated glasses are allowed", () => {
    const {getByLabelText} = render(<PairGlassesCard />)

    fireEvent.press(getByLabelText("home:setupWithoutGlasses"))

    expect(getByLabelText("onboarding:phoneMode")).toBeTruthy()
  })

  it("hides Phone Mode when simulated glasses are not allowed", () => {
    ;(isGlassesModelAllowedByDeployment as jest.Mock).mockReturnValue(false)

    const {queryByLabelText} = render(<PairGlassesCard />)

    expect(queryByLabelText("home:setupWithoutGlasses")).toBeNull()
  })
})
