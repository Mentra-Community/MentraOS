import {act, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import PairingPrepScreen from "@/app/pairing/prep"
import {useNavigationStore} from "@/stores/navigation"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"

let mockGuideProps: any

jest.mock("@mentra/engine", () => ({DeviceTypes: {LIVE: "Mentra Live", SIMULATED: "Simulated"}, engine: {}}))
jest.mock("@react-navigation/native", () => ({useRoute: () => ({params: {deviceModel: "Mentra Live"}})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({themed: jest.fn()})}))
jest.mock("@/services/deployment", () => ({deploymentStore: {getActive: () => ({kind: "consumer"})}}))
jest.mock("@/services/deployment/glassesPolicy", () => ({isGlassesModelAllowedByDeployment: () => true}))
jest.mock("@/utils/pairing/preparePairingScan", () => ({preparePairingScan: jest.fn()}))
jest.mock("@/utils/getGlassesImage", () => ({getAr99DisplayName: jest.fn(), getAr99ImageSource: jest.fn()}))
jest.mock("@/constants/appConfig", () => ({CDN_BASE_URL: ""}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("@/components/mirror/GlassesDisplayMirror", () => () => null)
jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => () => null)
jest.mock("@/components/pairing/NimoPreparation", () => ({NimoPreparation: () => null}))
jest.mock("@/components/onboarding/OnboardingGuide", () => ({
  OnboardingGuide: (props: unknown) => {
    mockGuideProps = props
    return null
  },
}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => {
  const {View} = require("react-native")
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Header: () => null,
    Icon: () => null,
    Text: () => null,
    Button: () => null,
  }
})

describe("Mentra Live preparation", () => {
  const push = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    mockGuideProps = undefined
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push})
    ;(preparePairingScan as jest.Mock).mockResolvedValue(true)
  })

  it("has only the power-on step and no pairing-mode tutorial step (C1)", () => {
    render(<PairingPrepScreen />)

    const names = mockGuideProps.steps.map((step: {name: string}) => step.name)
    expect(names).toEqual(["power_on_tutorial"])
    expect(JSON.stringify(mockGuideProps.steps)).not.toContain("livePairingMode")
  })

  it("goes from the power-on step straight to the scan screen", async () => {
    render(<PairingPrepScreen />)

    await act(async () => mockGuideProps.endButtonFn())

    expect(preparePairingScan).toHaveBeenCalledWith("Mentra Live")
    expect(push).toHaveBeenCalledWith("/pairing/scan", {deviceModel: "Mentra Live", ar99ProjectName: undefined})
  })
})
