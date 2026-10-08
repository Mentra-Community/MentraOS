import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import type {ReactNode} from "react"

import {GlassesStatus} from "./DeviceStatus"
import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/utils/AlertUtils"
import {unpairSavedGlasses} from "@/utils/pairing/unpairSavedGlasses"

jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/utils/pairing/unpairSavedGlasses", () => ({unpairSavedGlasses: jest.fn(() => Promise.resolve())}))
jest.mock("@/utils/PermissionsUtils", () => ({checkConnectivityRequirementsUI: jest.fn()}))
jest.mock("@/i18n", () => ({translate: (key: string) => key}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {foreground: "#111", background: "#fff"}}}),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable, Text: RNText} = require("react-native")
  return {
    Button: ({onPress, tx, disabled}: {onPress?: () => void; tx: string; disabled?: boolean}) => (
      <Pressable accessibilityLabel={tx} onPress={onPress} disabled={disabled} />
    ),
    Text: ({text, tx}: {text?: string; tx?: string}) => <RNText>{text ?? tx}</RNText>,
    Icon: () => null,
  }
})
jest.mock("@/components/ui/GlassView", () => {
  const {View} = require("react-native")
  return function MockGlassView({children}: {children: ReactNode}) {
    return <View>{children}</View>
  }
})
jest.mock("@/components/mirror/GlassesDisplayMirror", () => () => null)
jest.mock("assets/icons/component/MicIcon", () => () => null)

describe("unfinished pairing on Home", () => {
  const clearHistoryAndGoHome = jest.fn()
  const push = jest.fn()

  beforeEach(async () => {
    jest.clearAllMocks()
    engine.pairing.onScanning = jest.fn(() => () => {})
    ;(engine.glasses.status as jest.Mock).mockReturnValue({
      state: "disconnected",
      fullyBooted: false,
      battery: 0,
      charging: false,
      case: {removed: false, battery: 0, open: false},
    })
    ;(engine.pairing.abandonAttempt as jest.Mock).mockReset().mockResolvedValue(undefined)
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({clearHistoryAndGoHome, push})
    await useSettingsStore.getState().resetAllSettingsLocally()
    await engine.pairing.markPendingSelection("Mentra Live")
  })

  it("offers explicit cancellation alongside finish and pair-different actions", async () => {
    const screen = render(<GlassesStatus />)
    expect(screen.getByLabelText("home:finishPairingGlasses")).toBeTruthy()
    expect(screen.getByLabelText("home:pairDifferentGlasses")).toBeTruthy()

    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))
    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1))
    expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
    expect(push).not.toHaveBeenCalled()
  })

  it("keeps the pending card available for retry when cleanup fails", async () => {
    ;(engine.pairing.abandonAttempt as jest.Mock).mockRejectedValueOnce(new Error("cleanup failed"))
    const screen = render(<GlassesStatus />)
    fireEvent.press(screen.getByLabelText("pairing:cancelPairing"))

    await waitFor(() => expect(showAlert).toHaveBeenCalledWith("pairing:errorTitle", "pairing:cancelFailed"))
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
    expect(screen.getByLabelText("home:finishPairingGlasses")).toBeTruthy()
    expect(engine.pairing.identity()).toEqual({kind: "pending", model: "Mentra Live"})
  })

  it("does not offer cancellation after the selection becomes a completed pairing", async () => {
    const screen = render(<GlassesStatus />)
    await act(async () => {
      await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
      await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "Mentra_Live_ABCD", false)
    })
    expect(screen.queryByLabelText("pairing:cancelPairing")).toBeNull()
  })
})

describe("Mentra Live paired to another phone", () => {
  const push = jest.fn()
  const clearHistoryAndGoHome = jest.fn()

  beforeEach(async () => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push, clearHistoryAndGoHome})
    engine.pairing.onScanning = jest.fn(() => () => {})
    ;(engine.glasses.status as jest.Mock).mockReturnValue({
      state: "disconnected",
      fullyBooted: false,
      battery: 0,
      charging: false,
      case: {removed: true, battery: 0, open: false},
    })
    await useSettingsStore.getState().resetAllSettingsLocally()
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "Mentra_Live_ABCD", false)
    await useSettingsStore.getState().setSetting(SETTINGS.mentra_live_owner_lost.key, true, false)
  })

  const pressConfirm = () => {
    const [title, message, buttons] = (showAlert as jest.Mock).mock.calls.at(-1)
    expect(title).toBe("home:liveOwnerLostTitle")
    expect(message).toContain("home:liveOwnerLostMessage")
    buttons[1].onPress()
    return message as string
  }

  it("keeps the glasses listed with pair-again and unpair instead of Connect", () => {
    const screen = render(<GlassesStatus />)
    expect(screen.getByText("home:liveOwnerLostStatus")).toBeTruthy()
    expect(screen.getByLabelText("home:pairAgain")).toBeTruthy()
    expect(screen.getByLabelText("settings:forgetGlasses")).toBeTruthy()
    expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
  })

  it("pair again confirms, unpairs, and opens Mentra Live pairing prep", async () => {
    const screen = render(<GlassesStatus />)
    fireEvent.press(screen.getByLabelText("home:pairAgain"))
    const message = pressConfirm()
    expect(message).toContain("home:liveOwnerLostIosBluetooth")
    await waitFor(() => expect(push).toHaveBeenCalledWith("/pairing/prep", {deviceModel: "Mentra Live"}))
    expect(unpairSavedGlasses).toHaveBeenCalledTimes(1)
    expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
  })

  it("unpair confirms, unpairs, and returns Home", async () => {
    const screen = render(<GlassesStatus />)
    fireEvent.press(screen.getByLabelText("settings:forgetGlasses"))
    pressConfirm()
    await waitFor(() => expect(clearHistoryAndGoHome).toHaveBeenCalledTimes(1))
    expect(unpairSavedGlasses).toHaveBeenCalledTimes(1)
    expect(push).not.toHaveBeenCalled()
  })

  it("shows the normal Connect card when ownership was not lost", async () => {
    await useSettingsStore.getState().setSetting(SETTINGS.mentra_live_owner_lost.key, false, false)
    const screen = render(<GlassesStatus />)
    expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
    expect(screen.queryByText("home:liveOwnerLostStatus")).toBeNull()
  })
})

describe("G2 arm progress on Home", () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push: jest.fn()})
    engine.pairing.onScanning = jest.fn(() => () => {})
    await useSettingsStore.getState().resetAllSettingsLocally()
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Even Realities G2", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "test-selected-pair", false)
  })

  it.each(["left", "right"] as const)(
    "shows the native delayed %s-arm notice and clears it on the next status",
    (missingArm) => {
      const status = {state: "disconnected", fullyBooted: false, case: {}, g2MissingArm: missingArm as string | null}
      ;(engine.glasses.status as jest.Mock).mockImplementation(() => status)
      let notify = () => {}
      ;(engine.glasses.onStatus as jest.Mock).mockImplementation((listener) => {
        notify = listener
        return () => {}
      })
      const screen = render(<GlassesStatus />)
      const key = missingArm === "left" ? "pairing:g2WaitingForLeft" : "pairing:g2WaitingForRight"
      expect(screen.getByText(key)).toBeTruthy()
      act(() => {
        // Snapshot updates use a new object, as the real engine projection does.
        ;(engine.glasses.status as jest.Mock).mockReturnValue({...status, g2MissingArm: null})
        notify()
      })
      expect(screen.queryByText(key)).toBeNull()
    },
  )
})
