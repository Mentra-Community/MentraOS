import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {engine} from "@mentra/engine"
import {useRoute} from "@react-navigation/native"
import {useNavigationStore} from "@/stores/navigation"
import GlassesPairingLoadingScreen from "@/app/pairing/loading"
import {useGlassesStore} from "../../../../modules/engine/src/stores/glasses"
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

  beforeEach(() => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    jest.clearAllMocks()
    useGlassesStore.getState().reset()
    ;(useRoute as jest.Mock).mockReturnValue({
      params: {deviceModel: "Mentra Live", deviceName: "MENTRA_LIVE_BLE_001"},
    })
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({replace, goBack})
    const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
    bluetoothSdkMock.wipeMediaForPairing = jest.fn(() => Promise.resolve({success: true}))
    bluetoothSdkMock.finalizePairingTransfer = jest.fn(() =>
      Promise.resolve({success: true, transfer_id: "ABCDEF0123456789", operation: "finalize"}),
    )
    bluetoothSdkMock.abortPairingTransfer = jest.fn(() =>
      Promise.resolve({success: true, transfer_id: "ABCDEF0123456789", operation: "abort"}),
    )
    bluetoothSdkMock.getPairingTransferStatus = jest.fn(() =>
      Promise.resolve({
        transfer_id: "ABCDEF0123456789",
        state: "active",
        terminal_operation: null,
      }),
    )
    ;(engine.pairing.waitForBluetoothClassic as jest.Mock)?.mockResolvedValue?.(true)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("shows booting after glasses_not_ready and routes pair failures to the failure screen", async () => {
    const {getByText} = render(<GlassesPairingLoadingScreen />)

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

  it("navigates to success after boot and files a timeout report after 35 seconds", async () => {
    const first = render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {had_previous_bond: false})
    })
    act(() => {
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

  it("navigates to success when firmware never emits pairing_info (legacy fallback)", async () => {
    render(<GlassesPairingLoadingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    // No pairing_info event arrives (field firmware). Without the fallback, pairing hangs forever.
    expect(replace).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(5_000)
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("does not use pairing_info timeout when secure firmware already reported capable", async () => {
    render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: false,
        secure_pairing_capable: true,
        transfer_id: "ABCDEF0123456789",
      })
    })
    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("does not fall through to success on the legacy timeout when the scan result already reported secure-capable firmware", async () => {
    ;(useRoute as jest.Mock).mockReturnValue({
      params: {deviceModel: "Mentra Live", deviceName: "MENTRA_LIVE_BLE_001", securePairingCapable: true},
    })
    render(<GlassesPairingLoadingScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    // pairing_info is merely delayed, not absent — known-secure firmware must keep waiting for
    // it rather than let the legacy timeout mark pairing successful underneath it.
    act(() => {
      jest.advanceTimersByTime(60_000)
    })
    expect(replace).not.toHaveBeenCalled()

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {had_previous_bond: false, secure_pairing_capable: true})
    })
    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })

  it("finalizes ownership without wipe when media wipe is disabled", async () => {
    const showAlert = require("@/utils/AlertUtils").default as jest.Mock
    const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
    bluetoothSdkMock.wipeMediaForPairing = jest.fn(() => Promise.resolve({success: true}))
    bluetoothSdkMock.finalizePairingTransfer = jest.fn(() =>
      Promise.resolve({success: true, transfer_id: "T1", operation: "finalize"}),
    )

    render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: true,
        secure_pairing_capable: true,
        transfer_id: "ABCDEF0123456789",
        classic_bond_ready: true,
      })
    })
    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    await waitFor(() => {
      expect(bluetoothSdkMock.finalizePairingTransfer).toHaveBeenCalled()
    })
    expect(bluetoothSdkMock.wipeMediaForPairing).not.toHaveBeenCalled()
    expect(showAlert).not.toHaveBeenCalled()
  })

  it("aborts an unresolved ownership transfer when the user cancels", async () => {
    const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
    bluetoothSdkMock.finalizePairingTransfer = jest.fn(() => new Promise(() => undefined))

    const {getByText} = render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: true,
        secure_pairing_capable: true,
        transfer_id: "ABCDEF0123456789",
        classic_bond_ready: true,
      })
    })

    await waitFor(() => {
      expect(bluetoothSdkMock.finalizePairingTransfer).toHaveBeenCalled()
    })

    fireEvent.press(getByText("cancel-pairing"))

    await waitFor(() => {
      expect(bluetoothSdkMock.abortPairingTransfer).toHaveBeenCalled()
      expect(replace).toHaveBeenCalledWith("/pairing/prep", {deviceModel: "Mentra Live"})
    })
    expect(goBack).not.toHaveBeenCalled()
  })

  it("recovers when finalize times out after the transfer was committed", async () => {
    const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
    bluetoothSdkMock.finalizePairingTransfer = jest.fn(() => Promise.reject(new Error("finalize_timeout")))
    bluetoothSdkMock.getPairingTransferStatus = jest.fn(() =>
      Promise.resolve({
        transfer_id: "ABCDEF0123456789",
        state: "committed",
        terminal_operation: "finalize",
      }),
    )

    render(<GlassesPairingLoadingScreen />)

    act(() => {
      emitBluetoothSdkEvent("pairing_info", {
        had_previous_bond: true,
        secure_pairing_capable: true,
        transfer_id: "ABCDEF0123456789",
        classic_bond_ready: true,
      })
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    await waitFor(() => {
      expect(bluetoothSdkMock.getPairingTransferStatus).toHaveBeenCalledWith("ABCDEF0123456789")
    })
    expect(bluetoothSdkMock.abortPairingTransfer).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1_000)
    })

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/pairing/success", {deviceModel: "Mentra Live"})
    })
  })
})
