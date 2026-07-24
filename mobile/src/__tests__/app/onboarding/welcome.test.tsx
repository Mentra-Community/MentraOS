import {DeviceTypes} from "@/../../cloud/packages/types/src"
import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import OnboardingWelcome from "@/app/onboarding/welcome"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"

const mockSetOnboardingCompleted = jest.fn()

jest.mock("@mentra/engine", () => ({
  SETTINGS: {
    onboarding_completed: {
      key: "onboarding_completed",
    },
  },
  useSetting: () => [false, mockSetOnboardingCompleted],
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/components/brands/MentraLogoStandalone", () => {
  const {View} = require("react-native")
  return {
    MentraLogoStandalone: () => <View testID="mentra-logo" />,
  }
})

jest.mock("@/components/ignite", () => {
  const {Text: RNText, View} = require("react-native")

  function MockScreen({children, preset}: {children: ReactNode; preset: string}) {
    return (
      <View accessibilityLabel={preset} testID="welcome-screen">
        {children}
      </View>
    )
  }

  function MockText({tx}: {tx: string}) {
    return <RNText>{tx}</RNText>
  }

  return {Screen: MockScreen, Text: MockText}
})

jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
})

describe("onboarding welcome", () => {
  const push = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push})
  })

  it("uses the updated MentraOS welcome copy", () => {
    const {getByLabelText, getByText} = render(<OnboardingWelcome />)

    expect(en.onboarding.welcome).toBe("Welcome to MentraOS")
    expect(en.onboarding.setupWithGlasses).toBe("Set up\nwith glasses")
    expect(en.onboarding.setupWithoutGlasses).toBe("Set up\nwithout glasses")
    expect(getByText("onboarding:welcome")).toBeTruthy()
    expect(getByText("onboarding:setupWithGlasses")).toBeTruthy()
    expect(getByText("onboarding:setupWithoutGlasses")).toBeTruthy()
    expect(getByLabelText("auto")).toBeTruthy()
  })

  it("starts glasses pairing from the glasses card", async () => {
    const {getByTestId} = render(<OnboardingWelcome />)

    await act(async () => {
      fireEvent.press(getByTestId("onboarding-setup-with-glasses"))
    })

    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true)
    expect(push).toHaveBeenCalledWith("/pairing/select-glasses-model", {onboarding: true})
  })

  it("starts simulated pairing from the phone-only card", () => {
    const {getByTestId} = render(<OnboardingWelcome />)

    fireEvent.press(getByTestId("onboarding-setup-without-glasses"))

    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true)
    expect(push).toHaveBeenCalledWith("/pairing/prep", {deviceModel: DeviceTypes.SIMULATED})
  })
})
