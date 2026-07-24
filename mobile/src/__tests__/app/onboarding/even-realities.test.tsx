import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine/internal"
import {act, cleanup, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import EvenRealitiesOnboarding from "@/app/onboarding/even-realities"
import {emitBluetoothSdkEvent, getBluetoothSdkListenerCount, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"
import showAlertMock from "@/utils/AlertUtils"

const mockPushPrevious = jest.fn()

jest.mock("expo-image", () => {
  const {View} = require("react-native")
  return {
    Image: ({testID}: {testID?: string}) => <View testID={testID} />,
  }
})

jest.mock("react-native-svg", () => {
  const {Text, View} = require("react-native")
  const MockSvg = ({children}: {children: ReactNode}) => <View>{children}</View>
  const MockElement = () => <View />
  const MockText = ({children}: {children: ReactNode}) => <Text>{children}</Text>
  return {
    __esModule: true,
    default: MockSvg,
    Circle: MockElement,
    Line: MockElement,
    Path: MockElement,
    Text: MockText,
  }
})

jest.mock("@/components/brands/MentraLogoStandalone", () => {
  const {View} = require("react-native")
  return {MentraLogoStandalone: () => <View />}
})

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  const MockScreen = ({children}: {children: ReactNode}) => <View>{children}</View>
  const MockText = ({text, children}: {text?: string; children?: ReactNode}) => <RNText>{text ?? children}</RNText>
  const MockButton = ({tx, onPress}: {tx: string; onPress: () => void}) => (
    <TouchableOpacity onPress={onPress}>
      <RNText>{tx}</RNText>
    </TouchableOpacity>
  )
  const MockHeader = ({
    onLeftPress,
    RightActionComponent,
  }: {
    onLeftPress: () => void
    RightActionComponent: ReactNode
  }) => (
    <View>
      <TouchableOpacity testID="close-even-onboarding" onPress={onLeftPress}>
        <MockText text="Close" />
      </TouchableOpacity>
      {RightActionComponent}
    </View>
  )
  return {Button: MockButton, Header: MockHeader, Screen: MockScreen, Text: MockText}
})

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushPrevious: () => mockPushPrevious,
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {
        background: "#ffffff",
        border: "#dddddd",
        primary: "#00b869",
        secondary_foreground: "#0a0a0a",
      },
    },
  }),
}))

jest.mock("@/i18n", () => ({
  translate: (key: string, options?: {model?: string}) => (options?.model ? `${key}:${options.model}` : key),
}))

jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
}))

describe("Even Realities onboarding", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    await act(async () => {
      useSettingsStore.getState().resetAllSettingsLocally()
      await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Even Realities G2", false)
    })
  })

  afterEach(() => {
    cleanup()
    jest.useRealTimers()
  })

  it("runs the G2 intro, head-up check, angle control, and apps page", async () => {
    const {getByText, getByTestId} = render(<EvenRealitiesOnboarding />)

    expect(getByText("onboarding:evenExploreDescription:G2")).toBeTruthy()
    fireEvent.press(getByText("common:continue"))

    expect(getByTestId("even-realities-head-up-image")).toBeTruthy()
    expect(getBluetoothSdkListenerCount("head_up")).toBe(1)

    await act(async () => {
      emitBluetoothSdkEvent("head_up", {up: true})
      await Promise.resolve()
    })
    expect(getByText("✓")).toBeTruthy()

    act(() => {
      jest.advanceTimersByTime(1_500)
    })
    expect(getByTestId("even-realities-angle-control")).toBeTruthy()

    fireEvent.press(getByText("common:continue"))
    expect(getByTestId("even-realities-apps-image")).toBeTruthy()

    fireEvent.press(getByText("common:continue"))
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_even_realities_completed.key)).toBe(true)
  })

  it("confirms the home transition before skipping", async () => {
    await act(async () => {
      await useSettingsStore.getState().setSetting(SETTINGS.onboarding_os_completed.key, true, false)
    })
    const {getByTestId} = render(<EvenRealitiesOnboarding />)

    fireEvent.press(getByTestId("close-even-onboarding"))

    expect(showAlertMock).toHaveBeenCalledWith(
      "onboarding:evenEndOnboardingTitle",
      "onboarding:evenEndOnboardingHomeMessage",
      expect.any(Array),
    )

    const confirmSkip = (showAlertMock as jest.Mock).mock.calls[0][2][1]
    act(() => confirmSkip.onPress())
    expect(mockPushPrevious).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().getSetting(SETTINGS.onboarding_even_realities_completed.key)).toBe(true)
  })
})
