import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Linking} from "react-native"

import MentraOSOnboarding from "@/app/onboarding/os"
import {MentraLogoStandalone} from "@/components/brands/MentraLogoStandalone"
import showAlertMock from "@/utils/AlertUtils"

const mockPushPrevious = jest.fn()
const mockScreen = jest.fn()
const mockOnboardingGuide = jest.fn()

jest.mock("@/components/ignite", () => {
  const {Text: RNText, View} = require("react-native")
  function MockScreen({children, ...props}: {children: ReactNode}) {
    mockScreen(props)
    return <View>{children}</View>
  }
  function MockText({text}: {text: string}) {
    return <RNText>{text}</RNText>
  }
  function MockIcon() {
    return <View />
  }
  return {Icon: MockIcon, Screen: MockScreen, Text: MockText}
})

jest.mock("@/components/onboarding/OnboardingGuide", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  function MockOnboardingGuide(props: {endButtonFn: () => void; skipFn: () => void}) {
    mockOnboardingGuide(props)
    return (
      <View>
        <TouchableOpacity testID="skip-os-onboarding" onPress={props.skipFn}>
          <Text>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="finish-os-onboarding" onPress={props.endButtonFn}>
          <Text>Finish</Text>
        </TouchableOpacity>
      </View>
    )
  }
  return {OnboardingGuide: MockOnboardingGuide}
})

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  usePushPrevious: () => mockPushPrevious,
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {primary: "#00b869"}}}),
}))

jest.mock("@/i18n", () => ({
  translate: (key: string) => key,
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
}))

describe("MentraOS onboarding", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useSettingsStore.getState().resetAllSettingsLocally()
  })

  it("uses the shared Mentra Live onboarding preset for the full tutorial", () => {
    render(<MentraOSOnboarding />)

    expect(mockScreen).toHaveBeenCalledWith(
      expect.objectContaining({
        extraAndroidInsets: true,
        safeAreaEdges: ["bottom"],
      }),
    )
    expect(mockOnboardingGuide).toHaveBeenCalledWith(
      expect.objectContaining({
        autoStart: false,
        endButtonText: "common:continue",
        preventBack: true,
        showCloseButton: true,
        startButtonText: "onboarding:continueOnboarding",
      }),
    )

    const {steps} = mockOnboardingGuide.mock.calls[0][0]
    expect(steps).toHaveLength(6)
    expect(steps.map((step: {title: string}) => step.title)).toEqual([
      "onboarding:osWelcomeTitle",
      "onboarding:osStartMiniappTitle",
      "onboarding:osMinimizeCloseTitle",
      "onboarding:osSwitchMiniappsTitle",
      "onboarding:osMiniappDrawerTitle",
      "onboarding:osMovedMiniappsTitle",
    ])
    expect(steps[0]).toEqual(
      expect.objectContaining({
        type: "image",
        transition: true,
        title: "onboarding:osWelcomeTitle",
        subtitle: "onboarding:osWelcomeSubtitle",
        titleCentered: true,
        subtitleCentered: true,
        content: expect.anything(),
      }),
    )
    expect(steps[0].source).toBeUndefined()
    expect(steps[0].compactHeader).toBeUndefined()
    expect(steps.slice(1).every((step: {compactHeader?: boolean}) => step.compactHeader)).toBe(true)
    expect(steps.slice(1).every((step: {compactBody?: boolean}) => step.compactBody)).toBe(true)
    expect(steps.every((step: {fadeOut?: boolean}) => !step.fadeOut)).toBe(true)
    expect(steps[1]).toEqual(
      expect.objectContaining({
        type: "image",
        testID: "mentraos-onboarding-hero-1",
        details: [
          {
            title: "onboarding:osTapToLaunchTitle",
            description: "onboarding:osTapToLaunchDescription",
          },
        ],
      }),
    )
    expect(steps[5]).toEqual(
      expect.objectContaining({
        type: "image",
        testID: "mentraos-onboarding-hero-5",
        details: expect.arrayContaining([
          expect.objectContaining({title: "onboarding:osMissingMiniappTitle"}),
          expect.objectContaining({title: "onboarding:osMentraOsLegacyTitle"}),
        ]),
      }),
    )
  })

  it("confirms before persisting completion when the user skips", () => {
    const {getByTestId} = render(<MentraOSOnboarding />)

    fireEvent.press(getByTestId("skip-os-onboarding"))
    expect(showAlertMock).toHaveBeenCalledWith(
      "onboarding:osEndOnboardingTitle",
      "onboarding:osEndOnboardingMessage",
      expect.any(Array),
    )

    const confirmSkip = (showAlertMock as jest.Mock).mock.calls[0][2][1]
    act(() => confirmSkip.onPress())

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_os_completed.key)).toBe(true)
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
  })

  it("persists completion after the final page", () => {
    const {getByTestId} = render(<MentraOSOnboarding />)

    fireEvent.press(getByTestId("finish-os-onboarding"))

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_os_completed.key)).toBe(true)
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
  })

  it("opens the MentraOS Legacy page from the moved miniapps step", () => {
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValueOnce(undefined)
    render(<MentraOSOnboarding />)

    const {steps} = mockOnboardingGuide.mock.calls[0][0]
    expect(steps[5].action).toBeUndefined()

    const {getByTestId, UNSAFE_getByType} = render(steps[5].content)
    expect(UNSAFE_getByType(MentraLogoStandalone).props.colorOverride).toBe("#00B869")
    fireEvent.press(getByTestId("mentraos-onboarding-open-legacy"))

    expect(openUrl).toHaveBeenCalledWith("https://mentraglass.com/legacy")
  })
})
