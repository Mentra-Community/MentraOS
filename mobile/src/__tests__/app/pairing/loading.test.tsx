import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"
import {Platform} from "react-native"

import {engine} from "@mentra/engine"
import {useIsFocused, useRoute} from "@react-navigation/native"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"
import GlassesPairingLoadingScreen from "@/app/pairing/loading"
// The glasses store is private to the local engine workspace and has no public test export.
// eslint-disable-next-line no-restricted-imports
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "@mentra/engine-host-internal"
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"
import type {GlassesAudioSetupState} from "@mentra/bluetooth-sdk"

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
    // The shared mock resolves false (a timed-out wait), which the screen turns into a pairing
    // failure at once. Keep the wait pending unless a test drives it.
    ;(engine.pairing.waitForReady as jest.Mock).mockImplementation(() => new Promise<boolean>(() => {}))
  })

  afterEach(() => {
    restorePlatform?.()
    restorePlatform = undefined
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

  /**
   * The SDK marks the glasses ready and reports their audio setup in the same status update.
   * `not_applicable` is what every model reports when there is no audio step (Android, G1, G2).
   */
  const markReady = (audioSetup: GlassesAudioSetupState = {state: "not_applicable"}) => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}, audioSetup})
  }

  const expectStillOnSpinner = (screen: {getByText: (text: string) => unknown}) => {
    expect(screen.getByText("waiting")).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
  }

  const setIosPlatform = () => {
    restorePlatform?.()
    restorePlatform = jest.replaceProperty(Platform, "OS", "ios").restore
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

  it.each(["ios", "android"] as const)(
    "keeps a native authentication refusal for an idle secure unit on %s",
    async (platform) => {
      jest.replaceProperty(Platform, "OS", platform)
      const device = {
        ...makeDevice("Mentra Live", "MENTRA_LIVE_BLE_001"),
        pairingMode: false,
        securePairingCapable: true,
      }
      ;(useRoute as jest.Mock).mockReturnValue({
        params: makeRouteParams(device.model, device.name, {device: JSON.stringify(device)}),
      })
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      expect(engine.pairing.pair).toHaveBeenCalledWith(device)
      act(() => {
        emitBluetoothSdkEvent("pair_failure", {error: "errors:pairingCouldNotStart"})
      })

      await waitFor(() => {
        expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
        expect(replace).toHaveBeenCalledWith("/pairing/failure", {
          error: "errors:pairingCouldNotStart",
          deviceModel: "Mentra Live",
        })
      })
      expect(replace).not.toHaveBeenCalledWith("/pairing/success", expect.anything())
    },
  )

  it("navigates to success after boot and files a timeout report after 35 seconds", async () => {
    const first = render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      markReady()
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
    ["secure firmware", {securePairingCapable: true}],
    ["legacy firmware", {securePairingCapable: false}],
    ["legacy firmware as a route string", {securePairingCapable: "false"}],
    ["unknown capability", {}],
  ])("shows success on SDK readiness without pairing_info (%s)", async (_label, extra) => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", extra),
    })
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      markReady()
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
    markReady()

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
      markReady()
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
    markReady()

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

  it("finishes a recovered target with unknown capability even when pairing_info never arrives", async () => {
    render(<GlassesPairingLoadingScreen />)
    await startPairingKickoff()

    act(() => {
      promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
      markReady()
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    expect(replace).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
  })

  it("does not read pairing_info: another glasses' pairing code does not hold the spinner", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {securePairingCapable: true, pairingCode: "ABCD"}),
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
      markReady()
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
  })

  describe("forget the old iOS pairing (S8)", () => {
    const FORGET_ROUTE = "/pairing/forget-ios-pairing"

    it("routes ios_forget_pairing on iOS to the forget screen, never to failure", async () => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      await act(async () => {
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed", code: "ios_forget_pairing"})
      })
      expect(replace).toHaveBeenCalledTimes(1)
      expect(replace).toHaveBeenCalledWith(FORGET_ROUTE, {
        deviceModel: "Mentra Live",
        deviceName: "MENTRA_LIVE_BLE_001",
      })
      expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalledWith("/pairing/failure", expect.anything())
      expect(replace).not.toHaveBeenCalledWith("/pairing/unpair-even", expect.anything())
    })

    it("sends the same code to the generic failure screen on Android", async () => {
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      await act(async () => {
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed", code: "ios_forget_pairing"})
      })
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {error: "pairing:failed", deviceModel: "Mentra Live"})
      expect(replace).not.toHaveBeenCalledWith(FORGET_ROUTE, expect.anything())
    })

    it.each([
      ["another code", {error: "pairing:failed", code: "something_else"}],
      ["no code", {error: "pairing:failed"}],
      ["the retired error string without a code", {error: "errors:iosForgetGlassesBluetooth"}],
    ])("does not route %s to the forget screen on iOS", async (_label, failure) => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      await act(async () => {
        emitBluetoothSdkEvent("pair_failure", failure)
      })
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {error: failure.error, deviceModel: "Mentra Live"})
      expect(replace).not.toHaveBeenCalledWith(FORGET_ROUTE, expect.anything())
    })

    it("wins over a pending success when it arrives during the success delay", async () => {
      setIosPlatform()
      ;(useRoute as jest.Mock).mockReturnValue({
        params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_001", {securePairingCapable: false}),
      })
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      act(() => {
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
        markReady({state: "connected"})
      })
      act(() => {
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed", code: "ios_forget_pairing"})
        jest.advanceTimersByTime(5_000)
      })
      expect(replace).toHaveBeenCalledTimes(1)
      expect(replace).toHaveBeenCalledWith(FORGET_ROUTE, expect.objectContaining({deviceModel: "Mentra Live"}))
    })
  })

  describe("no ownership transfer routing", () => {
    it("never routes to a replace-owner screen, whatever pairing_info carries", async () => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      act(() => {
        emitBluetoothSdkEvent("pairing_info", {
          had_previous_bond: true,
          secure_pairing_capable: true,
          awaiting_confirm: true,
          retained_owner_link: true,
        })
      })
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      const routes = [...push.mock.calls, ...replace.mock.calls].map(([route]) => route)
      expect(routes).not.toContain("/pairing/replace-owner")
      expect(push).not.toHaveBeenCalled()
      expect(replace).not.toHaveBeenCalled()
    })
  })

  describe("audio setup from the SDK (S6)", () => {
    const btclassicParams = {
      device: JSON.stringify({id: "MENTRA_LIVE_BLE_001", model: "Mentra Live", name: "MENTRA_LIVE_BLE_001"}),
    }
    const successCalls = () => replace.mock.calls.filter(([route]) => route === "/pairing/success")

    const reachReady = (audioSetup: GlassesAudioSetupState) =>
      act(() => {
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_001")
        markReady(audioSetup)
      })

    const setAudioSetup = (audioSetup: GlassesAudioSetupState) =>
      act(() => {
        useGlassesStore.getState().setGlassesInfo({audioSetup})
      })

    it.each(["connected", "not_applicable"] as const)(
      "shows success without Pair Audio when audio setup is %s",
      async (state) => {
        setIosPlatform()
        render(<GlassesPairingLoadingScreen />)
        await startPairingKickoff()
        reachReady({state})
        act(() => {
          jest.advanceTimersByTime(1_000)
        })
        expect(push).not.toHaveBeenCalled()
        expect(successCalls()).toHaveLength(1)
        act(() => {
          jest.advanceTimersByTime(60_000)
        })
        expect(push).not.toHaveBeenCalled()
        expect(successCalls()).toHaveLength(1)
      },
    )

    it("keeps the spinner while the SDK reports audio connecting, and finishes when it connects", async () => {
      setIosPlatform()
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      reachReady({state: "connecting"})

      // The SDK owns the deadline; the screen never times audio out itself.
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      expectStillOnSpinner(screen)

      setAudioSetup({state: "connected"})
      act(() => {
        jest.advanceTimersByTime(1_000)
      })
      expect(push).not.toHaveBeenCalled()
      expect(successCalls()).toHaveLength(1)
    })

    it("opens Pair Audio once when the SDK says audio needs the user", async () => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      reachReady({state: "needs_user", action: "connect_in_settings"})

      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/pairing/btclassic", btclassicParams)
      expect(successCalls()).toHaveLength(0)
      act(() => {
        jest.advanceTimersByTime(60_000)
      })
      expect(push).toHaveBeenCalledTimes(1)
      expect(successCalls()).toHaveLength(0)
    })

    it("opens Pair Audio when connecting turns into needs_user", async () => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      reachReady({state: "connecting"})
      expect(push).not.toHaveBeenCalled()

      setAudioSetup({state: "needs_user", action: "connect_in_settings"})
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/pairing/btclassic", btclassicParams)
    })

    it("gives exactly one navigation when audio connects after Pair Audio opens", async () => {
      setIosPlatform()
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      reachReady({state: "needs_user", action: "connect_in_settings"})
      expect(push).toHaveBeenCalledTimes(1)

      // Pair Audio is on top now, so this screen loses focus.
      ;(useIsFocused as jest.Mock).mockReturnValue(false)
      screen.rerender(<GlassesPairingLoadingScreen />)
      setAudioSetup({state: "connected"})
      act(() => {
        jest.advanceTimersByTime(10_000)
      })
      expect(push).toHaveBeenCalledTimes(1)
      expect(successCalls()).toHaveLength(0)

      // Pair Audio advances on its own and hands the screen back; only then does success follow.
      ;(useIsFocused as jest.Mock).mockReturnValue(true)
      screen.rerender(<GlassesPairingLoadingScreen />)
      act(() => {
        jest.advanceTimersByTime(1_000)
      })
      expect(push).toHaveBeenCalledTimes(1)
      expect(successCalls()).toHaveLength(1)
    })

    it("does not navigate twice when audio connects while Pair Audio is open and focus never changes", async () => {
      setIosPlatform()
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      reachReady({state: "needs_user", action: "connect_in_settings"})
      setAudioSetup({state: "connected"})
      act(() => {
        jest.advanceTimersByTime(10_000)
      })

      expect(push).toHaveBeenCalledTimes(1)
      expect(successCalls()).toHaveLength(0)
    })
  })

  describe("loading guard", () => {
    it("a failure during the success delay wins and success never fires", async () => {
      ;(useRoute as jest.Mock).mockReturnValue({
        params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", {securePairingCapable: false}),
      })
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      act(() => {
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
        markReady()
      })
      // The success transition is pending (one second). The failure arrives inside that window.
      act(() => {
        jest.advanceTimersByTime(500)
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed_in_delay"})
      })
      act(() => {
        jest.advanceTimersByTime(10_000)
      })

      expect(engine.pairing.abandonAttempt).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledTimes(1)
      expect(replace).toHaveBeenCalledWith("/pairing/failure", {
        error: "pairing:failed_in_delay",
        deviceModel: "Mentra Live",
      })
    })

    it("ignores a failure that arrives after success has already navigated", async () => {
      ;(useRoute as jest.Mock).mockReturnValue({
        params: makeRouteParams("Mentra Live", "MENTRA_LIVE_BLE_EXISTING", {securePairingCapable: false}),
      })
      render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()
      act(() => {
        promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_EXISTING")
        markReady()
      })
      act(() => {
        jest.advanceTimersByTime(1_000)
      })
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
      ;(engine.pairing.abandonAttempt as jest.Mock).mockClear()

      act(() => {
        emitBluetoothSdkEvent("pair_failure", {error: "pairing:late_failure"})
      })

      expect(replace).toHaveBeenCalledTimes(1)
      expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    })
  })

  describe("existing loading strings (S4)", () => {
    it("keeps the loader and shows I need more help", async () => {
      const screen = render(<GlassesPairingLoadingScreen />)
      await startPairingKickoff()

      expect(screen.getByText("waiting")).toBeTruthy()
      expect(screen.getByText("pairing:needMoreHelp")).toBeTruthy()
      expect(en.pairing.needMoreHelp).toBe("I need more help")
      expect(en.pairing.pairing).toBe("Pairing")
    })
  })

  it("uses controller readiness without being blocked by already-connected glasses", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: makeRouteParams("Even Realities R1", "CEC5BA"),
    })
    promoteWearable("Mentra Live", "MENTRA_LIVE_BLE_OLD")
    markReady()

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
