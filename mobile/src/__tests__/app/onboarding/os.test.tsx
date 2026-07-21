import {fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import MentraOSOnboarding from "@/app/onboarding/os"
import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine/internal"

const mockPushPrevious = jest.fn()

jest.mock("expo-image", () => {
  const {View} = require("react-native")
  return {
    Image: ({testID}: {testID?: string}) => <View testID={testID} />,
  }
})

jest.mock("@/components/ignite", () => {
  const {Text: RNText, View} = require("react-native")
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  function MockText({text}: {text: string}) {
    return <RNText>{text}</RNText>
  }
  return {Screen: MockScreen, Text: MockText}
})

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushPrevious: () => mockPushPrevious,
}))

jest.mock("@/i18n", () => ({
  translate: (key: string) => key,
}))

describe("MentraOS onboarding", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    useSettingsStore.getState().resetAllSettingsLocally()
  })

  it("renders the full-screen Figma flow and supports back navigation", () => {
    const {getByText, getByTestId, queryByTestId} = render(<MentraOSOnboarding />)

    expect(getByText("onboarding:osStartMiniappTitle")).toBeTruthy()
    expect(getByTestId("mentraos-onboarding-hero-1")).toBeTruthy()
    expect(queryByTestId("mentraos-onboarding-back")).toBeNull()

    fireEvent.press(getByTestId("mentraos-onboarding-next"))
    expect(getByText("onboarding:osMinimizeCloseTitle")).toBeTruthy()
    expect(getByTestId("mentraos-onboarding-back")).toBeTruthy()

    fireEvent.press(getByTestId("mentraos-onboarding-back"))
    expect(getByText("onboarding:osStartMiniappTitle")).toBeTruthy()
  })

  it("persists completion when the user skips", () => {
    const {getByTestId} = render(<MentraOSOnboarding />)

    fireEvent.press(getByTestId("mentraos-onboarding-skip"))

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_os_completed.key)).toBe(true)
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
  })

  it("persists completion after the final page", () => {
    const {getByTestId} = render(<MentraOSOnboarding />)

    fireEvent.press(getByTestId("mentraos-onboarding-next"))
    fireEvent.press(getByTestId("mentraos-onboarding-next"))
    fireEvent.press(getByTestId("mentraos-onboarding-next"))
    fireEvent.press(getByTestId("mentraos-onboarding-done"))

    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_os_completed.key)).toBe(true)
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
  })
})
