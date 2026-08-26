import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import SelectGlassesModelScreen from "@/app/pairing/select-glasses-model"
import {useNavigationStore} from "@/stores/navigation"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"

jest.mock("@/../../cloud/packages/types/src", () => ({
  DeviceTypes: {
    LIVE: "Mentra Live",
    G1: "Even Realities G1",
    G2: "Even Realities G2",
    AR99: "AR99",
    MACH1: "Mentra Mach1",
    Z100: "Vuzix Z100",
    NEX: "Mentra Nex",
    NIMO: "Nimo",
  },
}))

jest.mock("@mentra/engine", () => ({
  SETTINGS: {super_mode: {key: "super_mode"}},
  useSetting: () => [false],
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/utils/pairing/preparePairingScan", () => ({
  preparePairingScan: jest.fn(),
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {text: "#000"}, spacing: {s4: 16}}}),
}))

jest.mock("@/utils/getGlassesImage", () => ({
  AR99_MODEL_OPTIONS: [],
  getGlassesImage: jest.fn(() => 1),
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, View} = require("react-native")
  return {
    Header: () => <View />,
    Text: ({text}: {text?: string}) => <RNText>{text}</RNText>,
  }
})

jest.mock("@/components/ignite/Screen", () => {
  const {View} = require("react-native")
  return {Screen: ({children}: {children: ReactNode}) => <View>{children}</View>}
})

jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return MockGlassView
})

jest.mock("@/components/ui/Spacer", () => ({
  Spacer: () => null,
}))

jest.mock("@/components/brands/EvenRealitiesLogo", () => ({EvenRealitiesLogo: () => null}))
jest.mock("@/components/brands/MentraLogo", () => ({MentraLogo: () => null}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("@/components/brands/NimoLogo", () => ({NimoLogo: () => null}))
jest.mock("@/components/brands/VuzixLogo", () => ({VuzixLogo: () => null}))
jest.mock("@/components/brands/XingyiLogo", () => ({XingyiLogo: () => null}))

describe("glasses model selection", () => {
  const push = jest.fn()
  const goBack = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push, goBack})
    ;(preparePairingScan as jest.Mock).mockResolvedValue(true)
  })

  it("prepares permissions and opens the scan directly for Mentra Live", async () => {
    const {getByTestId} = render(<SelectGlassesModelScreen />)

    await act(async () => {
      fireEvent.press(getByTestId("pairing-model-mentra_live"))
    })

    expect(preparePairingScan).toHaveBeenCalledWith("Mentra Live")
    expect(push).toHaveBeenCalledWith("/pairing/scan", {deviceModel: "Mentra Live"})
  })

  it("keeps the existing prep flow for other glasses", () => {
    const {getByTestId} = render(<SelectGlassesModelScreen />)

    fireEvent.press(getByTestId("pairing-model-evenrealities_g1"))

    expect(preparePairingScan).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith("/pairing/prep", {
      deviceModel: "Even Realities G1",
      ar99ProjectName: undefined,
    })
  })

  it("stays on model selection when pairing prerequisites are denied", async () => {
    ;(preparePairingScan as jest.Mock).mockResolvedValue(false)
    const {getByTestId} = render(<SelectGlassesModelScreen />)

    await act(async () => {
      fireEvent.press(getByTestId("pairing-model-mentra_live"))
    })

    expect(push).not.toHaveBeenCalled()
  })
})
