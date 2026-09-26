import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import type {ReactNode} from "react"

import {GlassesBatteryReading, GlassesStatus} from "./DeviceStatus"
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
    Text: ({text}: {text?: string}) => <RNText>{text}</RNText>,
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

describe("glasses battery reading", () => {
  const report = engine.glasses.reportDiagnosticRender as jest.Mock

  beforeEach(() => report.mockClear())

  it("shows the value and reports the committed value with its native event id", () => {
    const screen = render(<GlassesBatteryReading level={57} charging={false} eventId="stream:5" />)
    expect(screen.getByText("57%")).toBeTruthy()
    expect(screen.queryByText(/stream:5/)).toBeNull()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith("glasses_battery", ["stream:5"], 57)

    // Re-rendering the same state is not a new observation.
    screen.rerender(<GlassesBatteryReading level={57} charging={false} eventId="stream:5" />)
    expect(report).toHaveBeenCalledTimes(1)

    // A fresh packet with an unchanged percentage is reported with its own id.
    screen.rerender(<GlassesBatteryReading level={57} charging={false} eventId="stream:8" />)
    expect(report).toHaveBeenLastCalledWith("glasses_battery", ["stream:8"], 57)
  })

  it("reports nothing for a value without native provenance", () => {
    const screen = render(<GlassesBatteryReading level={64} charging={true} />)
    expect(screen.getByText("64%")).toBeTruthy()
    expect(report).not.toHaveBeenCalled()
  })

  it("reports only when the connected card actually renders the reading", () => {
    engine.pairing.onScanning = jest.fn(() => () => {})
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({clearHistoryAndGoHome: jest.fn(), push: jest.fn()})
    ;(engine.glasses.status as jest.Mock).mockReturnValue({
      state: "disconnected",
      fullyBooted: false,
      battery: 57,
      batteryEventId: "stream:5",
      charging: false,
      case: {removed: false, battery: 0, open: false},
    })
    render(<GlassesStatus />)
    expect(report).not.toHaveBeenCalled()
  })
})
