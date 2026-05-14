import {fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {useRoute} from "@react-navigation/native"

import PairingSuccessScreen from "@/app/pairing/success"
import {usePushUnder} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {waitForGlassesState} from "@/stores/glasses"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

jest.mock("@/../../cloud/packages/types/src", () => ({
  DeviceTypes: {
    LIVE: "Mentra Live",
    G1: "Even Realities G1",
    G2: "Even Realities G2",
    Z100: "Vuzix Z100",
    MACH1: "Mach1",
    NEX: "Mentra Nex",
  },
}))

jest.mock("@react-navigation/native", () => ({
  useRoute: jest.fn(),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushUnder: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/stores/glasses", () => ({
  waitForGlassesState: jest.fn(),
}))

jest.mock("@/utils/getGlassesImage", () => ({
  getGlassesImage: jest.fn(() => 1),
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

jest.mock("@/components/ignite", () => {
  const {View} = require("react-native")
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return {Screen: MockScreen}
})

jest.mock("@/components/onboarding/OnboardingGuide", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  function MockOnboardingGuide({
    endButtonFn,
    endButtonText,
    startButtonText,
  }: {
    endButtonFn: () => void
    endButtonText: string
    startButtonText: string
  }) {
    return (
      <View>
        <Text>{startButtonText}</Text>
        <TouchableOpacity onPress={endButtonFn}>
          <Text>{endButtonText}</Text>
        </TouchableOpacity>
      </View>
    )
  }
  return {OnboardingGuide: MockOnboardingGuide}
})

const originalPlatformOS = Platform.OS

function setPlatformOS(os: typeof Platform.OS) {
  Object.defineProperty(Platform, "OS", {value: os, configurable: true, writable: true})
}

describe("pairing success screen", () => {
  const clearHistoryAndGoHome = jest.fn()
  const push = jest.fn()
  const pushUnder = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    useSettingsStore.getState().resetAllSettingsLocally()
    setPlatformOS("ios")
    ;(useRoute as jest.Mock).mockReturnValue({params: {deviceModel: "Mentra Live"}})
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({clearHistoryAndGoHome, push})
    ;(usePushUnder as jest.Mock).mockReturnValue(pushUnder)
  })

  afterEach(() => {
    setPlatformOS(originalPlatformOS)
  })

  it("stacks missing Mentra Live setup steps in the expected order", async () => {
    ;(waitForGlassesState as jest.Mock).mockResolvedValueOnce(false)

    const {getAllByText} = render(<PairingSuccessScreen />)

    await waitFor(() => expect(getAllByText("onboarding:continueSetup").length).toBeGreaterThan(0))
    fireEvent.press(getAllByText("onboarding:continueSetup")[1])

    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalled())
    expect(push).toHaveBeenCalledWith("/pairing/btclassic")
    expect(pushUnder).toHaveBeenCalledTimes(1)
    expect(pushUnder).toHaveBeenCalledWith("/ota/check-for-updates")
    expect(waitForGlassesState).toHaveBeenCalledTimes(1)
  })

  it("uses connected Mentra Live state to skip btclassic setup", async () => {
    ;(waitForGlassesState as jest.Mock).mockResolvedValueOnce(true)

    const {getAllByText} = render(<PairingSuccessScreen />)

    await waitFor(() => expect(getAllByText("onboarding:continueSetup").length).toBeGreaterThan(0))
    fireEvent.press(getAllByText("onboarding:continueSetup")[1])

    await waitFor(() => expect(push).toHaveBeenCalledWith("/ota/check-for-updates"))
    expect(pushUnder).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalledWith("/pairing/btclassic")
    expect(waitForGlassesState).toHaveBeenCalledTimes(1)
  })

  it("finishes non-Live pairing without adding setup routes", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({params: {deviceModel: "Even Realities G1"}})
    await useSettingsStore.getState().setSetting(SETTINGS.onboarding_os_completed.key, true, false)

    const {getAllByText} = render(<PairingSuccessScreen />)

    await waitFor(() => expect(getAllByText("common:continue").length).toBeGreaterThan(0))
    fireEvent.press(getAllByText("common:continue")[1])

    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalled()
    expect(pushUnder).not.toHaveBeenCalled()
  })
})
