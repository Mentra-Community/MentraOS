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
    expect(screen.getByText(`Connect ${device.name} as a Bluetooth audio device`)).toBeTruthy()
    expect(screen.getByText("Tap Open Settings")).toBeTruthy()
    expect(screen.getByText("Tap Bluetooth")).toBeTruthy()
    expect(screen.getByText(`Tap "${device.name}" under My Devices or Other Devices`)).toBeTruthy()
    expect(screen.getByText('Return to the app once it says "Connected"')).toBeTruthy()
    expect(translate).toHaveBeenCalledWith("onboarding:btClassicStep3", {name: device.name})
  })

  it("advances at once when audio is already up on mount", async () => {
    act(() => {
      useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "connected"}})
    })
    render(<BtClassicPairingScreen />)

    await waitFor(() => expect(pushPrevious).toHaveBeenCalledTimes(1))
    expect(replace).not.toHaveBeenCalled()
  })

  it.each(["connected", "not_applicable"] as const)(
    "advances exactly once when the SDK reports audio setup %s",
    async (state) => {
      act(() => {
        useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "needs_user", action: "connect_in_settings"}})
      })
      render(<BtClassicPairingScreen />)
      expect(pushPrevious).not.toHaveBeenCalled()

      act(() => {
        useGlassesStore.getState().setGlassesInfo({audioSetup: {state}})
      })
      // Later status updates in the same pairing must not navigate again.
      act(() => {
        useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "connected"}, bluetoothAudioRouted: true})
      })

      await waitFor(() => expect(pushPrevious).toHaveBeenCalledTimes(1))
    },
  )

  it.each([{state: "idle"}, {state: "connecting"}, {state: "needs_user", action: "connect_in_settings"}] as const)(
    "stays on Pair Audio while audio setup is $state",
    (audioSetup) => {
      act(() => {
        useGlassesStore.getState().setGlassesInfo({audioSetup, bluetoothAudioRouted: true})
      })
      render(<BtClassicPairingScreen />)
      expect(pushPrevious).not.toHaveBeenCalled()
    },
  )

  it("reveals loading once Bluetooth Classic links and lets loading own the connect", async () => {
    render(<BtClassicPairingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "connected"}})
    })

    await waitFor(() => {
      expect(pushPrevious).toHaveBeenCalled()
    })
    expect(engine.glasses.connect).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  /** Presses the back arrow and returns the confirmation's buttons. */
  const pressCancelArrow = (screen: ReturnType<typeof render>) => {
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    const call = (showAlert as jest.Mock).mock.calls.find(([title]) => title === "pairing:cancelPairingConfirmTitle")
    expect(call).toBeTruthy()
    return call![2] as {text: string; style?: string; onPress?: () => void}[]
  }
  const confirmCancel = async (screen: ReturnType<typeof render>) => {
    const buttons = pressCancelArrow(screen)
    const cancel = buttons.find((button) => button.style === "destructive")
    expect(cancel?.text).toBe("pairing:cancelPairing")
    await act(async () => cancel!.onPress!())
  }
  const pairSelectedGlasses = async (name = device.name) => {
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, name, false)
  }

  it("asks before cancelling, and Keep pairing changes nothing", () => {
    const screen = render(<BtClassicPairingScreen />)
    expect(screen.queryByText("pairing:cancelPairing")).toBeNull()

    const buttons = pressCancelArrow(screen)
    const keep = buttons.find((button) => button.style === "cancel")
    expect(keep?.text).toBe("pairing:keepPairing")
    keep?.onPress?.()

    expect(engine.glasses.unpair).not.toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
  })

  it("unpairs the selected glasses when the attempt already paired them, then returns Home", async () => {
    await pairSelectedGlasses()
    const screen = render(<BtClassicPairingScreen />)

    await confirmCancel(screen)

    expect(engine.glasses.unpair).toHaveBeenCalledTimes(1)
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1)
    expect(pushPrevious).not.toHaveBeenCalled()
  })

  it("never unpairs a different, earlier pairing", async () => {
    await pairSelectedGlasses("MENTRA_LIVE_BLE_OLD")
    const screen = render(<BtClassicPairingScreen />)

    await confirmCancel(screen)

    expect(engine.glasses.unpair).not.toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1)
  })

  it("abandons an attempt that never paired, and ignores late audio readiness while cancelling", async () => {
    let finishCleanup!: () => void
    ;(engine.pairing.abandonAttempt as jest.Mock).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCleanup = resolve
      }),
    )
    const screen = render(<BtClassicPairingScreen />)

    const buttons = pressCancelArrow(screen)
    act(() => buttons.find((button) => button.style === "destructive")!.onPress!())
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
    act(() => useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "connected"}}))
    expect(pushPrevious).not.toHaveBeenCalled()
    // A second press while cancelling does nothing.
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)

    await act(async () => finishCleanup())
    expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1)
    expect(engine.glasses.unpair).not.toHaveBeenCalled()
    expect(engine.glasses.connect).not.toHaveBeenCalled()
    expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
  })

  it("retains the screen and permits retry when cancellation fails", async () => {
    await pairSelectedGlasses()
    ;(engine.glasses.unpair as jest.Mock).mockRejectedValueOnce(new Error("unpair failed"))
    const screen = render(<BtClassicPairingScreen />)

    await confirmCancel(screen)
    await waitFor(() => expect(showAlert).toHaveBeenCalledWith("pairing:errorTitle", "pairing:cancelFailed"))
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()

    await confirmCancel(screen)
    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1))
    expect(engine.glasses.unpair).toHaveBeenCalledTimes(2)
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
      useGlassesStore.getState().setGlassesInfo({audioSetup: {state: "connected"}})
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
