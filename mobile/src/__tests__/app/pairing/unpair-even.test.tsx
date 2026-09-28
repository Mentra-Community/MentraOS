import {fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"

import UnpairEvenScreen from "@/app/pairing/unpair-even"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"
import {SettingsNavigationUtils} from "@/utils/SettingsNavigationUtils"

jest.mock("@react-navigation/native", () => ({useRoute: jest.fn()}))
jest.mock("@/contexts/NavigationHistoryContext", () => ({focusEffectPreventBack: jest.fn()}))
jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/SettingsNavigationUtils", () => ({
  SettingsNavigationUtils: {openBluetoothSettings: jest.fn(async () => true)},
}))
jest.mock("@/i18n", () => ({
  translate: (key: string) => {
    const source = require("@/i18n/en").default
    const [namespace, name] = key.split(":")
    return source[namespace][name]
  },
}))
jest.mock("@/components/ignite", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  return {
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Button: ({text, onPress}: {text: string; onPress: () => void}) => (
      <TouchableOpacity onPress={onPress}>
        <Text>{text}</Text>
      </TouchableOpacity>
    ),
  }
})
jest.mock("@/components/onboarding/OnboardingGuide", () => {
  const {Text, TouchableOpacity, View} = require("react-native")
  return {
    OnboardingGuide: ({
      steps,
      endButtonText,
      endButtonFn,
    }: {
      steps: {title: string; subtitle: string}[]
      endButtonText: string
      endButtonFn: () => void
    }) => (
      <View>
        <Text>{steps[0].title}</Text>
        <Text>{steps[0].subtitle}</Text>
        <TouchableOpacity accessibilityLabel="guide-primary-action" onPress={endButtonFn}>
          <Text>{endButtonText}</Text>
        </TouchableOpacity>
      </View>
    ),
  }
})

describe("Even pairing recovery", () => {
  const clearHistory = jest.fn()
  const replace = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(engine.pairing.abandonAttempt as jest.Mock).mockResolvedValue(undefined)
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({clearHistory, replace})
  })

  it.each(["g2LeftArmUnavailable", "g2RightArmUnavailable", "g2ConnectionTimedOut"] as const)(
    "shows the G2 explanation and retries the selected model: %s",
    (error) => {
      ;(useRoute as jest.Mock).mockReturnValue({params: {deviceModel: "Even Realities G2", error: `errors:${error}`}})
      const screen = render(<UnpairEvenScreen />)
      expect(screen.getByText(en.pairing.g2ReconnectTitle)).toBeTruthy()
      expect(screen.getByText(en.errors[error])).toBeTruthy()
      expect(screen.queryByText(en.onboarding.unpairEvenSubtitle)).toBeNull()
      expect(screen.queryByText(en.pairing.pairingFailed)).toBeNull()
      fireEvent.press(screen.getByLabelText("guide-primary-action"))
      expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
      expect(clearHistory).toHaveBeenCalledTimes(1)
      expect(replace).toHaveBeenCalledWith("/pairing/prep", {deviceModel: "Even Realities G2"})
      expect(SettingsNavigationUtils.openBluetoothSettings).not.toHaveBeenCalled()
    },
  )

  it("keeps Bluetooth settings available without restarting a G2 attempt", () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: {deviceModel: "Even Realities G2", error: "errors:g2LeftArmUnavailable"},
    })
    const screen = render(<UnpairEvenScreen />)
    fireEvent.press(screen.getByText(en.onboarding.openSettings))
    expect(SettingsNavigationUtils.openBluetoothSettings).toHaveBeenCalledTimes(1)
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    {deviceModel: "Even Realities G1"},
    {deviceModel: "Even Realities G2", error: "errors:pairNeedDisconnect"},
    {deviceModel: "Even Realities G2", error: "errors:unknown"},
    {deviceModel: "Even Realities G1", error: "errors:g2LeftArmUnavailable"},
  ])("preserves the existing unpair instructions and actions for %j", (params) => {
    ;(useRoute as jest.Mock).mockReturnValue({params})
    const screen = render(<UnpairEvenScreen />)
    expect(screen.getByText(en.onboarding.unpairEvenTitle)).toBeTruthy()
    expect(screen.getByText(en.onboarding.unpairEvenSubtitle)).toBeTruthy()
    fireEvent.press(screen.getByLabelText("guide-primary-action"))
    expect(SettingsNavigationUtils.openBluetoothSettings).toHaveBeenCalledTimes(1)
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    fireEvent.press(screen.getByText(en.onboarding.unpairEvenTryAgain))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(clearHistory).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith("/pairing/prep", {deviceModel: params.deviceModel})
  })
})
