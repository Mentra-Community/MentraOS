import {act, fireEvent, render, waitFor} from "@testing-library/react-native"
import {engine, SETTINGS} from "@mentra/engine"
import {useSettingsStore} from "@mentra/engine-host-internal"
import type {ReactNode} from "react"

import {GlassesStatus} from "./DeviceStatus"
import {useNavigationStore} from "@/stores/navigation"
import {showAlert} from "@/utils/AlertUtils"
import {checkConnectivityRequirementsUI} from "@/utils/PermissionsUtils"
import en from "@/i18n/en"
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
    Button: ({
      onPress,
      tx,
      disabled,
      children,
    }: {
      onPress?: () => void
      tx?: string
      disabled?: boolean
      children?: ReactNode
    }) => (
      <Pressable accessibilityLabel={tx} onPress={onPress} disabled={disabled}>
        {children}
      </Pressable>
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

describe("Mentra Live pairing state on Home", () => {
  const push = jest.fn()
  const clearHistoryAndGoHome = jest.fn()

  const setStatus = (pairingState: unknown, overrides: Record<string, unknown> = {}) =>
    (engine.glasses.status as jest.Mock).mockReturnValue({
      state: "disconnected",
      fullyBooted: false,
      battery: 0,
      charging: false,
      case: {removed: true, battery: 0, open: false},
      pairingState,
      ...overrides,
    })

  beforeEach(async () => {
    jest.clearAllMocks()
    ;(useNavigationStore.getState as jest.Mock).mockReturnValue({push, clearHistoryAndGoHome})
    engine.pairing.onScanning = jest.fn(() => () => {})
    ;(engine.pairing.scanning as jest.Mock).mockReturnValue(false)
    setStatus({state: "pairing_rejected"})
    await useSettingsStore.getState().resetAllSettingsLocally()
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    await useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "Mentra_Live_ABCD", false)
  })

  it("uses the exact Pair Again label", () => {
    expect(en.home.pairAgain).toBe("Pair Again")
  })

  describe("pairing_rejected", () => {
    it("shows the glasses with one Pair Again button and nothing else", () => {
      const screen = render(<GlassesStatus />)
      expect(screen.getByText("Mentra Live")).toBeTruthy()
      expect(screen.getAllByLabelText("home:pairAgain")).toHaveLength(1)
      // No status text, no unpair or forget action, no Connect.
      expect(screen.queryByLabelText("settings:forgetGlasses")).toBeNull()
      expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
      expect(screen.queryByLabelText("pairing:cancelPairing")).toBeNull()
      expect(screen.queryByText(/unpaired|owner/i)).toBeNull()
    })

    it("opens Mentra Live pairing prep without a confirmation and never unpairs", async () => {
      const screen = render(<GlassesStatus />)
      fireEvent.press(screen.getByLabelText("home:pairAgain"))
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/pairing/prep", {deviceModel: "Mentra Live"})
      expect(showAlert).not.toHaveBeenCalled()
      expect(unpairSavedGlasses).not.toHaveBeenCalled()
      expect(engine.glasses.unpair).not.toHaveBeenCalled()
      expect(engine.glasses.forget).not.toHaveBeenCalled()
      expect(clearHistoryAndGoHome).not.toHaveBeenCalled()
    })

    it("opens glasses settings from the card and does not start pairing", () => {
      const screen = render(<GlassesStatus />)
      fireEvent.press(screen.getByText("Mentra Live"))
      expect(push).toHaveBeenCalledTimes(1)
      expect(push).toHaveBeenCalledWith("/miniapps/settings/main", {transition: "simple_push"})
      expect(unpairSavedGlasses).not.toHaveBeenCalled()
    })

    it("does not show Pair Again while the glasses are connected", () => {
      setStatus({state: "pairing_rejected"}, {state: "connected", fullyBooted: true, battery: 80})
      const screen = render(<GlassesStatus />)
      expect(screen.queryByLabelText("home:pairAgain")).toBeNull()
    })

    it("does not show Pair Again for another model", async () => {
      await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Even Realities G1", false)
      const screen = render(<GlassesStatus />)
      expect(screen.queryByLabelText("home:pairAgain")).toBeNull()
    })
  })

  describe("pairing_mode and generic disconnects", () => {
    it("shows the reconnecting card with Cancel, not Pair Again, while the glasses are in pairing mode", () => {
      setStatus({state: "pairing_mode", windowId: 4, endsAtMs: Date.now() + 120_000})
      const screen = render(<GlassesStatus />)
      expect(screen.getByText("common:cancel")).toBeTruthy()
      expect(screen.queryByLabelText("home:pairAgain")).toBeNull()
      expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
    })

    it("Cancel during pairing mode disconnects and drops the spinner", async () => {
      setStatus({state: "pairing_mode", windowId: 4, endsAtMs: Date.now() + 120_000})
      ;(engine.glasses.disconnect as jest.Mock).mockClear()
      ;(engine.glasses.connectDefault as jest.Mock).mockClear()
      const screen = render(<GlassesStatus />)
      fireEvent.press(screen.getByText("common:cancel"))
      await waitFor(() => expect(engine.glasses.disconnect).toHaveBeenCalledTimes(1))
      expect(engine.glasses.connectDefault).not.toHaveBeenCalled()
      expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
      expect(screen.queryByText("common:cancel")).toBeNull()
    })

    it("shows Cancel again when Connect is pressed after a Cancel during pairing mode", async () => {
      setStatus({state: "pairing_mode", windowId: 4, endsAtMs: Date.now() + 120_000})
      ;(checkConnectivityRequirementsUI as jest.Mock).mockResolvedValue(true)
      ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValue(true)
      ;(engine.glasses.connectDefault as jest.Mock).mockClear().mockResolvedValue(undefined)
      const screen = render(<GlassesStatus />)
      fireEvent.press(screen.getByText("common:cancel"))
      await waitFor(() => expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy())

      fireEvent.press(screen.getByLabelText("home:connectGlasses"))
      await waitFor(() => expect(engine.glasses.connectDefault).toHaveBeenCalledTimes(1))
      expect(screen.getByText("common:cancel")).toBeTruthy()
      expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
    })

    it("keeps the reconnecting card when pairing mode ends, until the reconnect has had time to start", () => {
      jest.useFakeTimers()
      try {
        setStatus({state: "pairing_mode", windowId: 4, endsAtMs: Date.now() + 120_000})
        let notify = () => {}
        ;(engine.glasses.onStatus as jest.Mock).mockImplementation((listener) => {
          notify = listener
          return () => {}
        })
        const screen = render(<GlassesStatus />)
        expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()

        act(() => {
          setStatus({state: "normal"})
          notify()
        })
        expect(screen.queryByLabelText("home:connectGlasses")).toBeNull()
        expect(screen.getByText("common:cancel")).toBeTruthy()

        act(() => {
          jest.advanceTimersByTime(3000)
        })
        expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
      } finally {
        jest.useRealTimers()
      }
    })

    it("shows the normal Connect card after a generic disconnect", () => {
      setStatus({state: "normal"})
      const screen = render(<GlassesStatus />)
      expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
      expect(screen.queryByLabelText("home:pairAgain")).toBeNull()
    })

    it("tolerates a status snapshot without a pairing state", () => {
      setStatus(undefined)
      const screen = render(<GlassesStatus />)
      expect(screen.getByLabelText("home:connectGlasses")).toBeTruthy()
    })
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
