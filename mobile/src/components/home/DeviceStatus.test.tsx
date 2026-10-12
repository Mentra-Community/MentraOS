import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import type {ReactNode} from "react"

import {GlassesStatus} from "./DeviceStatus"
import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/utils/AlertUtils"

jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
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
