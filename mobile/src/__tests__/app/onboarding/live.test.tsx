import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import MentraLiveOnboarding from "@/app/onboarding/live"
import {useNavigationStore} from "@/stores/navigation"
import showAlertMock from "@/utils/AlertUtils"

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
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
  function MockOnboardingGuide({endButtonFn, skipFn}: {endButtonFn: () => void; skipFn: () => void}) {
    return (
      <View>
        <TouchableOpacity testID="skip-live-onboarding" onPress={skipFn}>
          <Text>Skip</Text>
        </TouchableOpacity>
        <TouchableOpacity testID="finish-live-onboarding" onPress={endButtonFn}>
          <Text>Finish</Text>
        </TouchableOpacity>
      </View>
    )
  }
  return {OnboardingGuide: MockOnboardingGuide}
})

describe("Mentra Live onboarding", () => {
  const clearHistoryAndGoHome = jest.fn()
  const replace = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    useSettingsStore.getState().resetAllSettingsLocally()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({clearHistoryAndGoHome, replace})
  })

  it("marks Live complete and continues to MentraOS when skipped", () => {
    const {getByTestId} = render(<MentraLiveOnboarding />)

    fireEvent.press(getByTestId("skip-live-onboarding"))
    expect(showAlertMock).toHaveBeenCalledWith(
      "onboarding:liveEndOnboardingTitle",
      "onboarding:liveEndOnboardingMessage",
      expect.any(Array),
    )

    const confirmSkip = (showAlertMock as jest.Mock).mock.calls[0][2][1]
    act(() => confirmSkip.onPress())

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_live_completed.key)).toBe(true)
    expect(replace).toHaveBeenCalledWith("/onboarding/os")
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
  })

  it("describes and performs the home transition when MentraOS is already complete", async () => {
    await useSettingsStore.getState().setSetting(SETTINGS.onboarding_os_completed.key, true, false)
    const {getByTestId} = render(<MentraLiveOnboarding />)

    fireEvent.press(getByTestId("skip-live-onboarding"))
    expect(showAlertMock).toHaveBeenCalledWith(
      "onboarding:liveEndOnboardingTitle",
      "onboarding:liveEndOnboardingHomeMessage",
      expect.any(Array),
    )

    const confirmSkip = (showAlertMock as jest.Mock).mock.calls[0][2][1]
    act(() => confirmSkip.onPress())

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_live_completed.key)).toBe(true)
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1)
    expect(replace).not.toHaveBeenCalled()
  })
})
