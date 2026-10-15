import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {engine} from "@mentra/engine"
import {useIsFocused, useRoute} from "@react-navigation/native"
import {useNavigationStore} from "@/stores/navigation"
import GlassesPairingLoadingScreen from "@/app/pairing/loading"
// The glasses store is private to the local engine workspace and has no public test export.
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "@mentra/engine-host-internal"
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
  function MockText({tx}: {tx?: string}) {
    return <RNText>{tx}</RNText>
  }
  return {
    Header: MockHeader,
    Screen: MockScreen,
    Button: MockButton,
    Text: MockText,
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
  const push = jest.fn()
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

  let restorePlatform: (() => void) | undefined

  beforeEach(() => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "true"
    restorePlatform = jest.replaceProperty(Platform, "OS", "android").restore
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    ;(useIsFocused as jest.Mock).mockReturnValue(true)
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001"),
    })
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replace, goBack, push})
    ;(engine.pairing.waitForBluetoothClassic as jest.Mock)?.mockResolvedValue?.(true)
  })

  afterEach(() => {
    restorePlatform?.()
    restorePlatform = undefined
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING
    delete process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER
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

  it.each(["errors:g2LeftArmUnavailable", "errors:g2RightArmUnavailable", "errors:g2ConnectionTimedOut"])(
    "routes G2 recovery through the existing Even guide: %s",
    async (error) => {
      ;(useRoute as jest.Mock).mockReturnValue({params: makeRouteParams("Even Realities G2", "test-pair")})
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      await act(async () => {
        emitBluetoothSdkEvent("pair_failure", {error})
      })
      expect(replace).toHaveBeenCalledWith("/pairing/unpair-even", {deviceModel: "Even Realities G2", error})
      expect(replace).not.toHaveBeenCalledWith("/pairing/failure", expect.anything())
    },
  )

  it.each(["Even Realities G1", "Even Realities G2"])(
    "keeps the Bluetooth-unpair error on the existing Even guide for %s",
    async (deviceModel) => {
      ;(useRoute as jest.Mock).mockReturnValue({params: makeRouteParams(deviceModel, "test-pair")})
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      await act(async () => {
        emitBluetoothSdkEvent("pair_failure", {error: "errors:pairNeedDisconnect"})
      })
      expect(replace).toHaveBeenCalledWith("/pairing/unpair-even", {
        deviceModel,
        error: "errors:pairNeedDisconnect",
      })
    },
  )

  it("routes an iOS stale Bluetooth bond to the forget-glasses prompt", async () => {
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()
    await act(async () => {
      emitBluetoothSdkEvent("pair_failure", {error: "errors:iosForgetGlassesBluetooth"})
    })
    expect(replace).toHaveBeenCalledWith("/pairing/failure", {
      error: "errors:iosForgetGlassesBluetooth",
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_001",
    })
    expect(replace).not.toHaveBeenCalledWith("/pairing/unpair-even", expect.anything())
  })

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

  it.each([
    ["route string false", {securePairingCapable: "false"}],
    [
      "device payload false",
      {
        device: JSON.stringify({
          id: "MENTRA_LIVE_BLE_EXISTING",
          model: "Mentra Live",
          name: "MENTRA_LIVE_BLE_EXISTING",
          securePairingCapable: false,
        }),
      },
    ],
  ])("does not wait for pairing_info on legacy firmware (%s)", async (_label, extra) => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", extra),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    expect(replace).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
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

  it("does not require pairing_info when the secure pairing feature is disabled", async () => {
    process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_SECURE_PAIRING = "false"
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {securePairingCapable: true}),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
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

  describe("ownership transfer routing", () => {
    let restorePlatform: (() => void) | undefined

    const useTransferFlow = (os: "android" | "ios" = "android") => {
      process.env.EXPO_PUBLIC_ENABLE_MENTRA_LIVE_OWNERSHIP_TRANSFER = "true"
      restorePlatform = jest.replaceProperty(Platform, "OS", os).restore
    }

    afterEach(() => {
      restorePlatform?.()
      restorePlatform = undefined
    })

    const finishBonding = async () => {
      act(() => {
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
        useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      })
      act(() => {
        jest.advanceTimersByTime(1_000)
      })
    }

    it("had_previous_bond alone neither routes to the confirm screen nor marks owner-lost", async () => {
      const showAlert = require("@/utils/AlertUtils").default as jest.Mock
      useTransferFlow()

      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          classic_bond_ready: true,
        })
      })
      await finishBonding()

      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
      })
      expect(push).not.toHaveBeenCalled()
      expect(showAlert).not.toHaveBeenCalled()
      expect(useSettingsStore.getState().getSetting(SETTINGS.mentra_live_owner_lost.key)).toBeFalsy()
    })

    it("routes to the replace-owner screen when pairing_info says awaiting_confirm", async () => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          ownership_transfer: true,
          awaiting_confirm: true,
        })
      })

      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/pairing/replace-owner", {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
      expect(replace).not.toHaveBeenCalled()
    })

    it("does not block the retained owner pairing again: no failure page, no replace prompt", async () => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          ownership_transfer: true,
          awaiting_confirm: false,
          retained_owner_link: true,
        })
      })

      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalledWith("/pairing/failure", expect.anything())
    })

    it("routes on awaiting_confirm even when had_previous_bond is false", async () => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: false,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })

      expect(push).toHaveBeenCalledWith("/pairing/replace-owner", expect.anything())
    })

    it("does not push twice for a replayed awaiting_confirm, but treats a later episode as new", async () => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      const awaiting = {had_previous_bond: true, secure_pairing_capable: true, awaiting_confirm: true}
      act(() => {
        emitBluetoothSdkEvent("pairing_info", awaiting)
        emitBluetoothSdkEvent("pairing_info", awaiting)
      })
      expect(push).toHaveBeenCalledTimes(1)

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {...awaiting, awaiting_confirm: false})
        emitBluetoothSdkEvent("pairing_info", awaiting)
      })
      expect(push).toHaveBeenCalledTimes(2)
    })

    it("routes iOS to the replace-owner screen when awaiting_confirm arrives", async () => {
      useTransferFlow("ios")
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })
      expect(push).toHaveBeenCalledWith("/pairing/replace-owner", {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
    })

    it("opens iOS Settings for Classic audio only after the automatic bond does not appear", async () => {
      useTransferFlow("ios")
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: false,
          secure_pairing_capable: true,
          owner_committed: true,
        })
      })
      await finishBonding()

      expect(push).not.toHaveBeenCalled()
      act(() => {
        jest.advanceTimersByTime(30_000)
      })

      expect(push).toHaveBeenCalledWith("/pairing/btclassic", {
        device: JSON.stringify({id: "MENTRA_LIVE_BLE_001", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001"}),
      })
      expect(replace).not.toHaveBeenCalled()
    })

    it("skips Settings when iOS Classic connects during the settle window", async () => {
      useTransferFlow("ios")
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: false,
          secure_pairing_capable: true,
          owner_committed: true,
        })
      })
      await finishBonding()

      act(() => {
        useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true})
      })
      act(() => {
        jest.advanceTimersByTime(1_000)
      })

      expect(push).not.toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/success", {
        deviceModel: "Mentra Live",
        ar99ProjectName: undefined,
      })
    })

    const reachIosClassicWait = async () => {
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: false,
          secure_pairing_capable: true,
          owner_committed: true,
        })
      })
      await finishBonding()
      return screen
    }

    it("waits for iOS audio without a Connecting audio line, then opens Settings", async () => {
      useTransferFlow("ios")
      const screen = await reachIosClassicWait()

      expect(screen.queryByText("pairing:connectingAudio")).toBeNull()
      expect(push).not.toHaveBeenCalled()

      act(() => {
        jest.advanceTimersByTime(30_000)
      })

      expect(push).toHaveBeenCalledWith("/pairing/btclassic", expect.anything())
    })

    it.each([["bluetoothClassicProfilesConnected"], ["bluetoothAudioRouted"]] as const)(
      "exits to success without Settings when %s turns true during the wait",
      async (signal) => {
        useTransferFlow("ios")
        const screen = await reachIosClassicWait()
        expect(screen.queryByText("pairing:connectingAudio")).toBeNull()

        act(() => {
          useGlassesStore.getState().setGlassesInfo({[signal]: true})
        })
        act(() => {
          jest.advanceTimersByTime(30_000)
        })

        expect(push).not.toHaveBeenCalled()
        expect(replace).toHaveBeenCalledWith("/pairing/success", {
          deviceModel: "Mentra Live",
          ar99ProjectName: undefined,
        })
      },
    )

    it("does not show Connecting audio on Android", async () => {
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      expect(screen.queryByText("pairing:connectingAudio")).toBeNull()
    })

    it("keeps today's flow when the ownership transfer flag is off", async () => {
      restorePlatform = jest.replaceProperty(Platform, "OS", "android").restore
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })
      expect(push).not.toHaveBeenCalled()
    })

    it.each([
      ["false", {had_previous_bond: true, secure_pairing_capable: true, awaiting_confirm: false}],
      ["absent", {had_previous_bond: true, secure_pairing_capable: true}],
    ])("does not route when awaiting_confirm is %s", async (_label, info) => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", info)
      })
      expect(push).not.toHaveBeenCalled()
    })

    it("does not route for glasses that are not in secure pairing", async () => {
      useTransferFlow()
      ;(useRoute as jest.Mock).mockReturnValue({
        params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {securePairingCapable: false}),
      })
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {had_previous_bond: true, awaiting_confirm: true})
      })
      expect(push).not.toHaveBeenCalled()
    })

    it("does not route after the user cancelled pairing", async () => {
      useTransferFlow()
      const {getByText} = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      fireEvent.press(getByText("cancel-pairing"))
      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })
      expect(push).not.toHaveBeenCalled()
    })

    it("still routes a pair failure to the failure screen while the confirm screen is on top", async () => {
      useTransferFlow()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })
      ;(useIsFocused as jest.Mock).mockReturnValue(false)

      act(() => {
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed"})
      })

      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith("/pairing/failure", {error: "pairing:failed", deviceModel: "Mentra Live"})
      })
    })

    it("continues to success once the confirm screen pops back and the bond commits", async () => {
      useTransferFlow()
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
        })
      })
      // The confirm screen takes focus; the glasses finish bonding before the user is back.
      ;(useIsFocused as jest.Mock).mockReturnValue(false)
      screen.rerender(<GlassesPairingLoadingScreen />)
      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: false,
          owner_committed: true,
        })
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
        useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      })
      expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())
      ;(useIsFocused as jest.Mock).mockReturnValue(true)
      screen.rerender(<GlassesPairingLoadingScreen />)
      act(() => {
        jest.advanceTimersByTime(1_000)
      })

      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
      })
      expect(push).toHaveBeenCalledTimes(1)
    })
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
