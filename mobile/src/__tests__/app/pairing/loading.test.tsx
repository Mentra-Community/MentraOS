import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {engine} from "@mentra/engine"
import {useIsFocused, useRoute} from "@react-navigation/native"
import {useNavigationStore} from "@/stores/navigation"
import GlassesPairingLoadingScreen from "@/app/pairing/loading"
// The glasses store is private to the local engine workspace and has no public test export.
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "../../../../modules/engine/src/stores/settings"
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("@react-navigation/native", () => ({
  useIsFocused: jest.fn(() => true),
  useRoute: jest.fn(),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
}))

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
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  function MockHeader() {
    return <View />
  }
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  function MockButton({tx, onPress}: {tx?: string; onPress?: () => void}) {
    return (
      <TouchableOpacity onPress={onPress}>
        <RNText>{tx}</RNText>
      </TouchableOpacity>
    )
  }
  return {
    Header: MockHeader,
    Screen: MockScreen,
    Button: MockButton,
  }
})

jest.mock("@/components/ignite/Header", () => {
  const {View} = require("react-native")
  function MockHeader() {
    return <View />
  }
  return {
    Header: MockHeader,
  }
})

jest.mock("@/components/ignite/Screen", () => {
  const {View} = require("react-native")
  function MockScreen({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
  return {
    Screen: MockScreen,
  }
})

jest.mock("@/components/glasses/GlassesTroubleshootingModal", () => {
  function MockGlassesTroubleshootingModal() {
    return null
  }
  return MockGlassesTroubleshootingModal
})
jest.mock("@/components/glasses/GlassesPairingLoader", () => {
  const {Text, TouchableOpacity} = require("react-native")
  function MockGlassesPairingLoader({isBooting, onCancel}: {isBooting: boolean; onCancel: () => void}) {
    return (
      <>
        <Text>{isBooting ? "booting" : "waiting"}</Text>
        <TouchableOpacity onPress={onCancel}>
          <Text>cancel-pairing</Text>
        </TouchableOpacity>
      </>
    )
  }
  return MockGlassesPairingLoader
})

describe("pairing loading screen", () => {
  const replace = jest.fn()
  const goBack = jest.fn()
  const makeDevice = (model: string, name: string) => ({id: name, model, name})
  const makeRouteParams = (model: string, name: string, extra: Record<string, unknown> = {}) => ({
    device: JSON.stringify(makeDevice(model, name)),
    deviceModel: model,
    deviceName: name,
    ...extra,
  })

  const startPairingKickoff = async () => {
    act(() => {
      jest.advanceTimersByTime(2_000)
    })
    await act(async () => {})
  }

  beforeEach(() => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    ;(useIsFocused as jest.Mock).mockReturnValue(true)
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001"),
    })
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replace, goBack})
    ;(engine.pairing.waitForBluetoothClassic as jest.Mock)?.mockResolvedValue?.(true)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const promoteWearable = (model: string, name: string) => {
    void useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, model, false)
    void useSettingsStore.getState().setSetting(SETTINGS.device_name.key, name, false)
  }

  const promoteController = (model: string, name: string) => {
    void useSettingsStore.getState().setSetting(SETTINGS.default_controller.key, model, false)
    void useSettingsStore.getState().setSetting(SETTINGS.controller_device_name.key, name, false)
  }

  it("shows booting after glasses_not_ready and routes pair failures to the failure screen", async () => {
    const {getByText} = render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    expect(getByText("waiting")).toBeTruthy()

    act(() => {
      emitBluetoothSdkEvent("glasses_not_ready", {message: "booting"})
    })
    expect(getByText("booting")).toBeTruthy()

    act(() => {
      emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed"})
    })

    await waitFor(() => {
      // Attempt cleanup preserves a pre-existing pairing (re-pair) instead of
      // an unconditional forget.
      expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "pairing:failed",
        deviceModel: "Mentra Live",
      })
    })
  })

  it("routes a selected-device kickoff rejection instead of leaving loading stuck", async () => {
    ;(engine.pairing.pair as jest.Mock).mockRejectedValueOnce(new Error("bluetooth powered off"))
    render(<GlassesPairingLoadingScreen />)

    await startPairingKickoff()

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })
  })

  it("navigates to success after boot and files a timeout report after 35 seconds", async () => {
    const first = render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {had_previous_bond: false})
    })
    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
    expect(engine.pairing.waitForReady).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
        timeoutMs: 35_000,
        route: "/pairing/loading",
        signal: expect.any(AbortSignal),
      }),
    )

    first.unmount()
    resetBluetoothSdkMock()
    replace.mockClear()
    useGlassesStore.getState().reset()
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      jest.advanceTimersByTime(35_000)
    })

    expect(engine.pairing.waitForReady).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
        timeoutMs: 35_000,
        route: "/pairing/loading",
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("does not wait for pairing_info when the advertisement reports existing pairing behavior", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", {securePairingCapable: false}),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    // The only remaining delay is the existing one-second transition to the success screen.
    expect(replace).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("starts the selected-device kickoff before an already-ready target can navigate", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", {securePairingCapable: false}),
    })
    promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    render(<GlassesPairingLoadingScreen />)
    act(() => {
      jest.advanceTimersByTime(1_999)
    })
    expect(engine.pairing.pair).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())

    act(() => {
      jest.advanceTimersByTime(1)
    })
    await act(async () => {})
    expect(engine.pairing.pair).toHaveBeenCalledWith(makeDevice("Mentra Live", "MENTRA_LIVE_BLE_EXISTING"))
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())

    act(() => {
      jest.advanceTimersByTime(1_000)
    })
    expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
  })

  it("cancels a pending success transition when the selected attempt fails", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", {securePairingCapable: false}),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())

    act(() => {
      emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed_after_kickoff"})
      jest.advanceTimersByTime(1_000)
    })

    expect(replace).toHaveBeenCalledWith("/pairing/failure", {
      error: "pairing:failed_after_kickoff",
      deviceModel: "Mentra Live",
    })
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())
  })

  it("does not start the selected-device kickoff while loading is under Bluetooth Classic", async () => {
    ;(useIsFocused as jest.Mock).mockReturnValue(false)
    const screen = render(<GlassesPairingLoadingScreen />)

    act(() => {
      jest.advanceTimersByTime(10_000)
    })
    expect(engine.pairing.pair).not.toHaveBeenCalled()
    ;(useIsFocused as jest.Mock).mockReturnValue(true)
    screen.rerender(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()
    expect(engine.pairing.pair).toHaveBeenCalledWith(makeDevice("Mentra Live", "MENTRA_LIVE_BLE_001"))
  })

  it("ignores readiness from previously connected glasses until the selected attempt reconnects", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_NEW", {securePairingCapable: false}),
    })
    promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_OLD")
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    render(<GlassesPairingLoadingScreen />)

    // The scan screen does not start the selected connection until two seconds
    // after navigation. The previous glasses' ready state must not win first.
    await startPairingKickoff()
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())
    expect(engine.pairing.waitForReady).toHaveBeenCalled()

    // Native promotion identifies the selected glasses. No global disconnect
    // edge is required, so a same-link handoff cannot leave the UI spinning.
    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_NEW")
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("fails closed when recovered target capability is unknown instead of loading forever", async () => {
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(5_000)
    })

    await waitFor(() => {
      expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })
  })

  it("does not use pairing_info timeout when secure firmware already reported capable", async () => {
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: false,
        secure_pairing_capable: true,
      })
    })
    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("fails secure-capable firmware when pairing_info never arrives", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {securePairingCapable: true}),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    act(() => {
      jest.advanceTimersByTime(5_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {had_previous_bond: false, secure_pairing_capable: true})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).not.toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("ignores pairing_info carrying another glasses' pairing code", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {
        securePairingCapable: true,
        pairingCode: "ABCD",
      }),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: false,
        pairing_code: "1234",
        secure_pairing_capable: true,
      })
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(5_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "errors:pairingCouldNotStart",
        deviceModel: "Mentra Live",
      })
    })
  })

  it("accepts pairing_info with an omitted optional code after the exact target connects", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {
        securePairingCapable: true,
        pairingCode: "ABCD",
      }),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: false,
        secure_pairing_capable: true,
      })
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("ignores had_previous_bond and navigates to success under Design A open reclaim", async () => {
    const showAlert = require("@/utils/AlertUtils").default as jest.Mock

    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: true,
        secure_pairing_capable: true,
        classic_bond_ready: true,
      })
    })
    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("uses controller readiness without being blocked by already-connected glasses", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Even Realities R1", "CEC5BA"),
    })
    promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_OLD")
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()
    expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())

    act(() => {
      promoteController("Even Realities R1", "CEC5BA")
      useGlassesStore.getState().setGlassesInfo({controllerConnected: true, controllerFullyBooted: true})
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Even Realities R1"})
    })
  })

  it("cancels pairing with goBack", async () => {
    const {getByText} = render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: true,
        secure_pairing_capable: true,
        classic_bond_ready: true,
      })
    })

    fireEvent.press(getByText("cancel-pairing"))

    act(() => {
      jest.advanceTimersByTime(3_000)
    })

    expect(goBack).toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
    expect(engine.pairing.pair).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalledWith("/pairing/prep", {deviceModel: "Mentra Live"})
  })
})
