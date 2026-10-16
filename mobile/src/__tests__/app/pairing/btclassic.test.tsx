jest.mock("@react-navigation/native", () => ({
  useRoute: jest.fn(),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
  usePushPrevious: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/utils/SettingsNavigationUtils", () => ({
  SettingsNavigationUtils: {
    openBluetoothSettings: jest.fn(async () => true),
  },
}))

jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))

// Onboarding copy resolves to the real English string so the rendered steps are asserted exactly.
// Every other namespace stays a key.
jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string, options?: Record<string, string>) => {
    if (!key.startsWith("onboarding:")) return key
    const value = require("@/i18n/en").default.onboarding[key.slice("onboarding:".length)]
    return String(value).replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => options?.[name] ?? "")
  }),
}))

jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({
    theme: {
      colors: {
        text: "#111",
      },
    },
  }),
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  function MockButton({
    text,
    tx,
    onPress,
    disabled,
  }: {
    text?: string
    tx?: string
    onPress?: () => void
    disabled?: boolean
  }) {
    return (
      <TouchableOpacity onPress={onPress} disabled={disabled}>
        <RNText>{text || tx}</RNText>
      </TouchableOpacity>
    )
  }
  function MockHeader({
    onLeftPress,
    leftIconAccessibilityLabel,
  }: {
    onLeftPress: () => void
    leftIconAccessibilityLabel: string
  }) {
    return <TouchableOpacity accessibilityLabel={leftIconAccessibilityLabel} onPress={onLeftPress} />
  }
  return {Screen: MockScreen, Button: MockButton, Header: MockHeader}
})

jest.mock("@/components/brands/MentraLogoStandalone", () => ({MentraLogoStandalone: () => null}))

jest.mock("@/components/onboarding/OnboardingGuide", () => {
  const {Text, View} = require("react-native")
  function MockOnboardingGuide({steps}: {steps: {title?: string; subtitle?: string; numberedBullets?: string[]}[]}) {
    return (
      <View>
        {steps.map((step) => (
          <View key={step.title}>
            <Text>{step.title}</Text>
            <Text>{step.subtitle}</Text>
            {step.numberedBullets?.map((bullet) => (
              <Text key={bullet}>{bullet}</Text>
            ))}
          </View>
        ))}
      </View>
    )
  }
  return {OnboardingGuide: MockOnboardingGuide}
})

import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import BtClassicPairingScreen from "@/app/pairing/btclassic"
import {usePushPrevious} from "@/contexts/NavigationHistoryContext"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {translate} from "@/i18n"
import {showAlert} from "@/utils/AlertUtils"

const device = {id: "a", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001", address: "a"}

describe("btclassic pairing screen", () => {
  const replace = jest.fn()
  const goBack = jest.fn()
  const pushPrevious = jest.fn()
  const clearHistoryAndGoHome = jest.fn()

  beforeEach(() => {
    jest.clearAllMocks()
    ;(engine.pairing.abandonAttempt as jest.Mock).mockReset().mockResolvedValue(undefined)
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    ;(useRoute as jest.Mock).mockReturnValue({params: {device: JSON.stringify(device)}})
    // history models the stack at rejection time — after handleSuccess()'s
    // pushPrevious() reveals the loading screen pushed under this one. Only
    // the kickoff-failure guard reads it; it suppresses the failure route
    // when loading is no longer on top (e.g. paired recovery contexts).
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({
      goBack,
      replace,
      clearHistoryAndGoHome,
      history: ["/pairing/scan", "/pairing/loading"],
    })
    ;(usePushPrevious as jest.Mock).mockReturnValue(pushPrevious)
  })

  it("shows Pair Audio with the four exact steps", () => {
    const screen = render(<BtClassicPairingScreen />)

    expect(screen.getByText("Pair Audio")).toBeTruthy()
    expect(
      screen.getByText(
        `${device.name} is already listed under My Devices in your iPhone Bluetooth settings. It only needs a tap to connect audio.`,
      ),
    ).toBeTruthy()
    expect(screen.getByText("Tap Open Settings")).toBeTruthy()
    expect(screen.getByText("Tap Bluetooth")).toBeTruthy()
    expect(screen.getByText(`Tap "${device.name}" under My Devices or Other Devices`)).toBeTruthy()
    expect(screen.getByText('Return to the app once it says "Connected"')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith("onboarding:btClassicStep3", {name: device.name})
  })

  it("advances at once when audio is already up on mount", async () => {
    act(() => {
      useGlassesStore.getState().setGlassesInfo({bluetoothAudioRouted: true})
    })
    render(<BtClassicPairingScreen />)

    await waitFor(() => expect(pushPrevious).toHaveBeenCalledTimes(1))
    expect(replace).not.toHaveBeenCalled()
  })

  it.each([
    ["the Classic bond", {bluetoothClassicConnected: true}],
    ["the connected profiles", {bluetoothClassicProfilesConnected: true}],
    ["the audio route", {bluetoothAudioRouted: true}],
  ])("advances exactly once when %s reports audio up", async (_label, signal) => {
    render(<BtClassicPairingScreen />)
    expect(pushPrevious).not.toHaveBeenCalled()

    act(() => {
      useGlassesStore.getState().setGlassesInfo(signal)
    })
    // The other signals follow in the same pairing. They must not navigate again.
    act(() => {
      useGlassesStore.getState().setGlassesInfo({
        bluetoothClassicConnected: true,
        bluetoothClassicProfilesConnected: true,
        bluetoothAudioRouted: true,
      })
    })

    await waitFor(() => expect(pushPrevious).toHaveBeenCalledTimes(1))
  })

  it("stays on Pair Audio while no audio signal is up", () => {
    render(<BtClassicPairingScreen />)
    expect(pushPrevious).not.toHaveBeenCalled()
  })

  it("reveals loading once Bluetooth Classic links and lets loading own the connect", async () => {
    render(<BtClassicPairingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true})
    })

    await waitFor(() => {
      expect(pushPrevious).toHaveBeenCalled()
    })
    expect(engine.glasses.connect).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("cancels the unfinished selection before returning Home and ignores late Classic readiness", async () => {
    let finishCleanup!: () => void
    ;(engine.pairing.abandonAttempt as jest.Mock).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCleanup = resolve
      }),
    )
    const screen = render(<BtClassicPairingScreen />)

    expect(screen.queryByText("pairing:cancelPairing")).toBeNull()
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
    act(() => useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true}))
    expect(pushPrevious).not.toHaveBeenCalled()
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)

    await act(async () => finishCleanup())
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1)
    expect(engine.glasses.connect).not.toHaveBeenCalled()
    expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
  })

  it("retains the screen and permits retry when cancellation fails", async () => {
    ;(engine.pairing.abandonAttempt as jest.Mock).mockRejectedValueOnce(new Error("cleanup failed"))
    const screen = render(<BtClassicPairingScreen />)
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    await waitFor(() => expect(showAlert).toHaveBeenCalledWith("pairing:errorTitle", "pairing:cancelFailed"))
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()

    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(2)
  })

  it("does not offer unfinished-pairing cancellation in a paired audio recovery flow", () => {
    ;(useRoute as jest.Mock).mockReturnValue({params: {}})
    const screen = render(<BtClassicPairingScreen />)
    expect(screen.queryByLabelText("pairing:cancelPairing")).toBeNull()
  })

  it("routes a connectDefault rejection to the failure screen while loading is on top", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({params: {}})
    // A paired context carries the full promoted identity (default_wearable
    // AND device_name) — the failure copy reads the model off the identity
    // read-model (engine.pairing.identity()), not raw settings keys.
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "MENTRA_LIVE_BLE_001", false)
    ;(engine.glasses.connectDefault as jest.Mock).mockRejectedValueOnce(new Error("no default device"))

    render(<BtClassicPairingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true})
    })

    await waitFor(() => {
      expect(engine.glasses.connectDefault).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })
  })
})
