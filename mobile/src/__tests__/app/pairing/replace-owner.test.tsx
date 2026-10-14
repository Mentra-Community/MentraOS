import {act, fireEvent, render} from "@testing-library/react-native"
import type {ReactNode} from "react"

import {engine} from "@mentra/engine"
import {useLocalSearchParams} from "expo-router"
import ReplaceOwnerScreen from "@/app/pairing/replace-owner"
import en from "@/i18n/en"
import {useNavigationStore} from "@/stores/navigation"
// The glasses store is private to the local engine workspace and has no public test export.
// eslint-disable-next-line no-restricted-imports
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

jest.mock("expo-router", () => ({
  useLocalSearchParams: jest.fn(),
}))

jest.mock("@/contexts/NavigationHistoryContext", () => ({
  focusEffectPreventBack: jest.fn(),
}))

jest.mock("@/stores/navigation", () => ({
  useNavigationStore: {getState: jest.fn()},
}))

jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => key),
}))

jest.mock("@/components/ignite", () => {
  const {Text: RNText, TouchableOpacity, View} = require("react-native")
  const HEADER_BACK_LABEL = "header-back"
  return {
    Header: ({onLeftPress}: {onLeftPress?: () => void}) => (
      <TouchableOpacity onPress={onLeftPress}>
        <RNText>{HEADER_BACK_LABEL}</RNText>
      </TouchableOpacity>
    ),
    Screen: ({children}: {children: ReactNode}) => <View>{children}</View>,
    Text: ({tx, text}: {tx?: string; text?: string}) => <RNText>{tx ?? text}</RNText>,
    Button: ({tx, onPress, disabled}: {tx?: string; onPress?: () => void; disabled?: boolean}) => (
      <TouchableOpacity onPress={onPress} disabled={disabled}>
        <RNText>{tx}</RNText>
      </TouchableOpacity>
    ),
  }
})

describe("replace owner confirm screen", () => {
  const push = jest.fn()
  const replace = jest.fn()
  const goBack = jest.fn()
  let currentRoute = "/pairing/replace-owner"
  const confirmReplaceOwner = jest.fn()

  const pressConfirm = (getByText: ReturnType<typeof render>["getByText"]) => {
    fireEvent.press(getByText("pairing:replaceOwnerConfirm"))
  }

  beforeEach(() => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    jest.clearAllMocks()
    currentRoute = "/pairing/replace-owner"
    useGlassesStore.getState().reset()
    // A live link during pairing, so the link-lost watcher stays quiet unless a test drops it.
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: false}})
    ;(useLocalSearchParams as jest.Mock).mockReturnValue({
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_001",
    })
    ;(useNavigationStore.getState as jest.Mock).mockImplementation(() => ({
      push,
      replace,
      goBack,
      getCurrentRoute: () => currentRoute,
    }))
    confirmReplaceOwner.mockResolvedValue(undefined)
    // The shared engine mock predates confirmReplaceOwner; attach it here.
    ;(engine.pairing as unknown as {confirmReplaceOwner: jest.Mock}).confirmReplaceOwner = confirmReplaceOwner
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("shows the title, body, and the Replace owner / Cancel actions", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)

    expect(getByText("pairing:replaceOwnerTitle")).toBeTruthy()
    expect(getByText("pairing:replaceOwnerBody")).toBeTruthy()
    expect(getByText("pairing:replaceOwnerConfirm")).toBeTruthy()
    expect(getByText("common:cancel")).toBeTruthy()
    expect(confirmReplaceOwner).not.toHaveBeenCalled()
  })

  it("keeps the pairing-matrix confirm label unambiguous", () => {
    // asg_client/tools/pairing-matrix taps the first text matching /replace|confirm/i.
    expect(en.pairing.replaceOwnerConfirm).toBe("Replace owner")
    expect(en.pairing.replaceOwnerTitle).not.toMatch(/replace|confirm/i)
    expect(en.pairing.replaceOwnerBody).not.toMatch(/replace|confirm/i)
    expect(en.pairing.replaceOwnerWaiting).not.toMatch(/replace|confirm/i)
  })

  it("sends the confirm once and shows a busy state until the result arrives", () => {
    const {getByText, queryByText} = render(<ReplaceOwnerScreen />)

    pressConfirm(getByText)
    pressConfirm(getByText)

    expect(confirmReplaceOwner).toHaveBeenCalledTimes(1)
    expect(queryByText("pairing:replaceOwnerWaiting")).toBeTruthy()
    expect(goBack).not.toHaveBeenCalled()
  })

  it("pops back to the loading flow when the confirm succeeds", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)
    pressConfirm(getByText)

    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: true})
    })

    expect(goBack).toHaveBeenCalledTimes(1)
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
    expect(replace).not.toHaveBeenCalled()
  })

  it("treats no_owner as success and continues", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)
    pressConfirm(getByText)

    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: false, reason: "no_owner"})
    })

    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["not_pairing", "pairing:replaceOwnerNotPairing"],
    ["wipe_failed", "pairing:replaceOwnerWipeFailed"],
    ["something_new", "pairing:replaceOwnerFailed"],
  ])("shows a reason-specific message for %s and lets the user retry", (reason, messageKey) => {
    const {getByText, queryByText} = render(<ReplaceOwnerScreen />)
    pressConfirm(getByText)

    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: false, reason})
    })

    expect(getByText(messageKey)).toBeTruthy()
    expect(queryByText("pairing:replaceOwnerWaiting")).toBeNull()
    expect(goBack).not.toHaveBeenCalled()

    fireEvent.press(getByText("common:tryAgain"))
    expect(confirmReplaceOwner).toHaveBeenCalledTimes(2)
    expect(queryByText(messageKey)).toBeNull()

    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: true})
    })
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("times out after 10 seconds with a retry, and a late success still continues", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)
    pressConfirm(getByText)

    act(() => {
      jest.advanceTimersByTime(9_999)
    })
    expect(() => getByText("pairing:replaceOwnerTimeout")).toThrow()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(getByText("pairing:replaceOwnerTimeout")).toBeTruthy()

    fireEvent.press(getByText("common:tryAgain"))
    expect(confirmReplaceOwner).toHaveBeenCalledTimes(2)

    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: true})
    })
    expect(goBack).toHaveBeenCalledTimes(1)
  })

  it("does not time out once a result has arrived", () => {
    const {getByText, queryByText} = render(<ReplaceOwnerScreen />)
    pressConfirm(getByText)
    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: false, reason: "wipe_failed"})
    })
    act(() => {
      jest.advanceTimersByTime(20_000)
    })

    expect(getByText("pairing:replaceOwnerWipeFailed")).toBeTruthy()
    expect(queryByText("pairing:replaceOwnerTimeout")).toBeNull()
  })

  it("shows a generic error when the confirm cannot be sent", async () => {
    confirmReplaceOwner.mockRejectedValueOnce(new Error("not connected"))
    const {getByText} = render(<ReplaceOwnerScreen />)

    pressConfirm(getByText)
    await act(async () => {})

    expect(getByText("pairing:replaceOwnerFailed")).toBeTruthy()
    expect(getByText("common:tryAgain")).toBeTruthy()
  })

  it("cancels like the loading screen: abandon the attempt and pop both screens", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)

    fireEvent.press(getByText("common:cancel"))

    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(goBack).toHaveBeenCalledTimes(2)
    expect(confirmReplaceOwner).not.toHaveBeenCalled()
  })

  it("does not cancel twice from the header back and a late result", () => {
    const {getByText} = render(<ReplaceOwnerScreen />)

    fireEvent.press(getByText("header-back"))
    act(() => {
      emitBluetoothSdkEvent("confirm_replace_owner_result", {ok: true})
    })

    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(goBack).toHaveBeenCalledTimes(2)
  })

  it("leaves to the failure screen when pairing fails while it is shown", () => {
    render(<ReplaceOwnerScreen />)

    act(() => {
      emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed"})
    })

    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
    expect(replace).toHaveBeenCalledWith("/pairing/failure", {
      error: "errors:pairingCouldNotStart",
      deviceModel: "Mentra Live",
    })
  })

  it("does not navigate again when the loading screen already left for the failure screen", () => {
    render(<ReplaceOwnerScreen />)
    currentRoute = "/pairing/failure"

    act(() => {
      emitBluetoothSdkEvent("pair_failure", {error: "pairing:failed"})
    })

    expect(replace).not.toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
  })

  it("leaves to the failure screen when the link stays down", () => {
    render(<ReplaceOwnerScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    })
    act(() => {
      jest.advanceTimersByTime(2_999)
    })
    expect(replace).not.toHaveBeenCalled()

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(replace).toHaveBeenCalledWith("/pairing/failure", {
      error: "errors:pairingCouldNotStart",
      deviceModel: "Mentra Live",
    })
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledTimes(1)
  })

  it("stays put when the link drops and returns within the grace period", () => {
    render(<ReplaceOwnerScreen />)

    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    })
    act(() => {
      jest.advanceTimersByTime(1_500)
    })
    act(() => {
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: false}})
    })
    act(() => {
      jest.advanceTimersByTime(10_000)
    })

    expect(replace).not.toHaveBeenCalled()
  })
})
