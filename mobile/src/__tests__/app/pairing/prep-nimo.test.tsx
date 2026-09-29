import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import PairingPrepScreen from "@/app/pairing/prep"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"
import {preparePairingScan} from "@/utils/pairing/preparePairingScan"

jest.mock("@mentra/engine", () => ({DeviceTypes: {NIMO: "NIMO", SIMULATED: "Simulated"}, engine: {}}))
jest.mock("@react-navigation/native", () => ({useRoute: () => ({params: {deviceModel: "NIMO"}})}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/contexts/ThemeContext", () => ({useAppTheme: () => ({themed: jest.fn()})}))
jest.mock("@/services/deployment", () => ({deploymentStore: {getActive: () => ({kind: "consumer"})}}))
jest.mock("@/services/deployment/glassesPolicy", () => ({isGlassesModelAllowedByDeployment: () => true}))
jest.mock("@/utils/pairing/preparePairingScan", () => ({preparePairingScan: jest.fn()}))
jest.mock("@/utils/pairing/securePairingFeature", () => ({isMentraLiveSecurePairingEnabled: () => false}))
jest.mock("@/utils/getGlassesImage", () => ({getAr99DisplayName: jest.fn(), getAr99ImageSource: jest.fn()}))
jest.mock("@/constants/appConfig", () => ({CDN_BASE_URL: ""}))
jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))
jest.mock("@/components/mirror/GlassesDisplayMirror", () => () => null)
jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => () => null)
jest.mock("@/components/onboarding/OnboardingGuide", () => ({OnboardingGuide: () => null}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/components/ignite", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  const translate = (tx: string) => {
    const [namespace, name] = tx.split(":")
    return require("@/i18n/en").default[namespace][name]
  }
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Header: () => null,
    Text: ({text, tx}: {text?: string; tx?: string}) => <Text>{tx ? translate(tx) : text}</Text>,
    Button: ({tx, onPress}: {tx: string; onPress: () => void}) => (
      <TouchableOpacity onPress={onPress}>
        <Text>{translate(tx)}</Text>
      </TouchableOpacity>
    ),
  }
})

describe("NIMO preparation", () => {
  const originalPlatform = Platform.OS
  const push = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push})
    ;(preparePairingScan as jest.Mock).mockResolvedValue(true)
  })

  afterEach(() => {
    Platform.OS = originalPlatform
  })

  it("explains system pairing before continuing to iOS discovery", async () => {
    Platform.OS = "ios"
    const screen = render(<PairingPrepScreen />)
    expect(screen.getByText(en.pairing.nimoIosSettingsPairing)).toBeTruthy()
    await act(async () => fireEvent.press(screen.getByText(en.common.continue)))
    expect(preparePairingScan).toHaveBeenCalledWith("NIMO")
    expect(push).toHaveBeenCalledWith("/pairing/scan", {deviceModel: "NIMO", ar99ProjectName: undefined})
  })

  it("keeps Settings pairing instructions specific to iOS", () => {
    Platform.OS = "android"
    const screen = render(<PairingPrepScreen />)
    expect(screen.queryByText(en.pairing.nimoIosSettingsPairing)).toBeNull()
    expect(screen.getByText(en.common.continue)).toBeTruthy()
  })
})
