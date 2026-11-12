import {fireEvent, render, waitFor} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import type {ReactNode} from "react"

import {ConnectDeviceButton} from "./ConnectDeviceButton"
import {useNavigationStore} from "@/stores/navigation"
import {cancelPairingModeConnect, connectInPairingMode} from "@/stores/pairingModeConnect"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"

jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/utils/PermissionsUtils", () => ({checkConnectivityRequirementsUI: jest.fn()}))
jest.mock("@/contexts/ThemeContext", () => ({
  useAppTheme: () => ({theme: {colors: {foreground: "#111"}, spacing: {s2: 8}}}),
}))
jest.mock("@/components/ignite", () => {
  const {Pressable} = require("react-native")
  return {
    Button: ({onPress, tx, children}: {onPress?: () => void; tx?: string; children?: ReactNode}) => (
      <Pressable accessibilityLabel={tx} onPress={onPress}>
        {children}
      </Pressable>
    ),
  }
})

describe("Settings' Connect glasses button during a pairing window", () => {
  const realReadiness = (engine.pairing.readiness as jest.Mock).getMockImplementation()
  const pairingMode = {state: "pairing_mode", windowId: 4, endsAtMs: Date.now() + 120_000}

  beforeEach(async () => {
    jest.clearAllMocks()
    cancelPairingModeConnect()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push: jest.fn()})
    engine.pairing.onScanning = jest.fn(() => () => {})
    ;(engine.pairing.scanning as jest.Mock).mockReturnValue(false)
    // The link is connecting and the glasses are still in pairing mode.
    ;(engine.pairing.readiness as jest.Mock).mockReturnValue({connected: false, nativeLinkBusy: true})
    ;(engine.glasses.status as jest.Mock).mockReturnValue({state: "disconnected", pairingState: pairingMode})
    ;(engine.glasses.connectInPairingMode as jest.Mock).mockResolvedValue(undefined)
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValue(true)
    ;(checkConnectivityRequirementsUI as jest.Mock).mockResolvedValue(true)
    await useSettingsStore.getState().resetAllSettingsLocally()
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "Mentra_Live_ABCD", false)
  })
  afterEach(() => {
    ;(engine.pairing.readiness as jest.Mock).mockImplementation(realReadiness)
  })

  it("offers Connect glasses until the person presses it, then shows the attempt until it ends", async () => {
    const screen = render(<ConnectDeviceButton />)
    expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()

    fireEvent.press(screen.getByLabelText("home:connectGlasses"))
    await waitFor(() => expect(engine.glasses.connectInPairingMode).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByLabelText("home:connectingGlasses")).toBeTruthy())
    expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
    expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
  })

  it("shows an attempt started on Home, and pressing it cancels that attempt", async () => {
    await connectInPairingMode(pairingMode.windowId)
    const screen = render(<ConnectDeviceButton />)
    expect(screen.getByLabelText("home:connectingGlasses")).toBeTruthy()

    fireEvent.press(screen.getByLabelText("home:connectingGlasses"))
    await waitFor(() => expect(engine.glasses.disconnect).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
  })
})
