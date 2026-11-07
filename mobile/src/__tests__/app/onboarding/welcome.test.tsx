import {DeviceTypes} from "@mentra/engine"
import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import OnboardingWelcome from "@/app/onboarding/welcome"
import en from "@/i18n/en"
import {isGlassesModelAllowedByDeployment} from "@/services/deployment/glassesPolicy"
import {useNavigationStore} from "@/stores/navigation"

const mockSetOnboardingCompleted = jest.fn()
const mockBondedGlasses = jest.fn(() => Promise.resolve<unknown>(null))

jest.mock("@mentra/engine", () => ({
  DeviceTypes: {
    LIVE: "Mentra Live",
    SIMULATED: "Simulated Glasses",
  },
  engine: {pairing: {bondedGlasses: () => mockBondedGlasses()}},
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

jest.mock("@/utils/PermissionsUtils", () => ({
  PermissionFeatures: {BLUETOOTH: "bluetooth"},
  requestFeaturePermissions: jest.fn(() => Promise.resolve(true)),
}))

jest.mock("@/services/deployment/glassesPolicy", () => ({
  isGlassesModelAllowedByDeployment: jest.fn(),
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
  const goHomeAndPush = jest.fn()
  const push = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({goHomeAndPush, push})
    ;(isGlassesModelAllowedByDeployment as jest.Mock).mockReturnValue(true)
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

  it("starts glasses pairing with Home as the completed onboarding Back destination", async () => {
    const {getByTestId} = render(<OnboardingWelcome />)

    await act(async () => {
      fireEvent.press(getByTestId("onboarding-setup-with-glasses"))
    })

    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true)
    expect(goHomeAndPush).toHaveBeenCalledWith("/pairing/select-glasses-model", {onboarding: true})
    expect(push).not.toHaveBeenCalled()
  })

  it("starts simulated pairing from the phone-only card", () => {
    const {getByTestId} = render(<OnboardingWelcome />)

    fireEvent.press(getByTestId("onboarding-setup-without-glasses"))

    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true)
    expect(push).toHaveBeenCalledWith("/pairing/prep", {deviceModel: DeviceTypes.SIMULATED})
  })

  it.each(["with", "without"])("activates the %s-glasses card through native accessibility", async (kind) => {
    const {getByTestId} = render(<OnboardingWelcome />)
    const card = getByTestId(`onboarding-setup-${kind}-glasses`)

    expect(card.props.onAccessibilityTap).toEqual(expect.any(Function))
    await act(async () => {
      fireEvent(card, "accessibilityTap")
    })

    expect(mockSetOnboardingCompleted).toHaveBeenCalledTimes(1)
    expect(mockSetOnboardingCompleted).toHaveBeenCalledWith(true)
    if (kind === "with") {
      expect(goHomeAndPush).toHaveBeenCalledTimes(1)
      expect(goHomeAndPush).toHaveBeenCalledWith("/pairing/select-glasses-model", {onboarding: true})
      expect(push).not.toHaveBeenCalled()
    } else {
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/pairing/prep", {deviceModel: DeviceTypes.SIMULATED})
      expect(goHomeAndPush).not.toHaveBeenCalled()
    }
  })

  it("asks its question and goes to the model choice even when the phone is still bonded with Mentra Live", async () => {
    mockBondedGlasses.mockResolvedValue({id: "a", model: "Mentra Live", name: "Mentra_Live_000B", address: "a"})
    const os = Platform.OS
    Platform.OS = "android"
    try {
      const {getByTestId} = render(<OnboardingWelcome />)
      await act(async () => {})
      expect(goHomeAndPush).not.toHaveBeenCalled()
      await act(async () => {
        fireEvent.press(getByTestId("onboarding-setup-with-glasses"))
      })
    } finally {
      Platform.OS = os
      mockBondedGlasses.mockResolvedValue(null)
    }

    expect(mockBondedGlasses).not.toHaveBeenCalled()
    expect(goHomeAndPush).toHaveBeenCalledTimes(1)
    expect(goHomeAndPush).toHaveBeenCalledWith("/pairing/select-glasses-model", {onboarding: true})
  })

  it("hides phone-only setup when the deployment disallows simulated glasses", () => {
    ;(isGlassesModelAllowedByDeployment as jest.Mock).mockReturnValue(false)

    const {queryByTestId} = render(<OnboardingWelcome />)

    expect(queryByTestId("onboarding-setup-without-glasses")).toBeNull()
  })
})
