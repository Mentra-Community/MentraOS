import {render} from "@testing-library/react-native"

import {PairingModePopup} from "@/effects/PairingModePopup"
import en from "@/i18n/en"
import showAlert, {dismissAlert} from "@/utils/AlertUtils"

type MockStatus = {state: string; pairingState: {state: string; windowId?: number; endsAtMs?: number}}

let mockStatus: MockStatus
const mockBacking = new Map<string, unknown>()

jest.mock("@/hooks/useEngineSnapshot", () => ({useEngineSnapshot: () => mockStatus}))
jest.mock("@/utils/AlertUtils", () => ({
  __esModule: true,
  default: jest.fn(),
  dismissAlert: jest.fn(),
}))
jest.mock("@/i18n", () => ({
  translate: jest.fn((key: string) => {
    const [namespace, name] = key.split(":")
    return require("@/i18n/en").default[namespace][name]
  }),
}))
jest.mock("@/utils/storage", () => ({
  storage: {
    load: jest.fn((key: string) => ({
      is_ok: () => mockBacking.has(key),
      value: mockBacking.get(key),
    })),
    save: jest.fn(async (key: string, value: unknown) => {
      mockBacking.set(key, JSON.parse(JSON.stringify(value)))
    }),
  },
}))

const NOW = 1_800_000_000_000
const connectedNormal = (): MockStatus => ({state: "connected", pairingState: {state: "normal"}})
const inWindow = (windowId: number, endsAtMs = NOW + 60_000): MockStatus => ({
  state: "disconnected",
  pairingState: {state: "pairing_mode", windowId, endsAtMs},
})

describe("pairing-mode popup (S1)", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockBacking.clear()
    jest.spyOn(Date, "now").mockReturnValue(NOW)
    mockStatus = connectedNormal()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("uses the exact English copy with a single OK button", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)

    expect(showAlert).toHaveBeenCalledTimes(1)
    expect(showAlert).toHaveBeenCalledWith(
      "Your glasses are in pairing mode",
      "Press the power button 3 times to exit.",
      [{text: "OK"}],
    )
    expect(en.common.ok).toBe("OK")
  })

  it("does not repeat on a duplicate event", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)
    mockStatus = {state: "connected", pairingState: {state: "pairing_mode", windowId: 1, endsAtMs: NOW + 60_000}}
    screen.rerender(<PairingModePopup />)

    expect(showAlert).toHaveBeenCalledTimes(1)
  })

  it("does not repeat after a remount or a storage reload in the same window", () => {
    const first = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    first.rerender(<PairingModePopup />)
    first.unmount()
    expect(showAlert).toHaveBeenCalledTimes(1)

    // Remounted while still connected and in the same window.
    mockStatus = {state: "connected", pairingState: {state: "pairing_mode", windowId: 1, endsAtMs: NOW + 60_000}}
    const second = render(<PairingModePopup />)
    second.unmount()
    expect(showAlert).toHaveBeenCalledTimes(1)

    // Cold start: nothing is held in memory, the record comes back from storage alone.
    mockStatus = connectedNormal()
    const reloaded = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    reloaded.rerender(<PairingModePopup />)
    expect(showAlert).toHaveBeenCalledTimes(1)
  })

  it("shows again for a new windowId", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)
    mockStatus = connectedNormal()
    screen.rerender(<PairingModePopup />)
    mockStatus = inWindow(2)
    screen.rerender(<PairingModePopup />)

    expect(showAlert).toHaveBeenCalledTimes(2)
  })

  it("stays quiet when the glasses were not connected before the window opened", () => {
    mockStatus = {state: "disconnected", pairingState: {state: "normal"}}
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)

    expect(showAlert).not.toHaveBeenCalled()
  })

  it("stays quiet for a window that has already ended", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1, NOW - 1)
    screen.rerender(<PairingModePopup />)

    expect(showAlert).not.toHaveBeenCalled()
  })

  it("dismisses the popup when the glasses leave pairing mode", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = inWindow(1)
    screen.rerender(<PairingModePopup />)
    ;(dismissAlert as jest.Mock).mockClear()

    mockStatus = connectedNormal()
    screen.rerender(<PairingModePopup />)
    expect(dismissAlert).toHaveBeenCalledWith("Your glasses are in pairing mode")

    mockStatus = inWindow(2)
    screen.rerender(<PairingModePopup />)
    ;(dismissAlert as jest.Mock).mockClear()
    mockStatus = {state: "disconnected", pairingState: {state: "pairing_rejected"}}
    screen.rerender(<PairingModePopup />)
    expect(dismissAlert).toHaveBeenCalledWith("Your glasses are in pairing mode")
  })

  it("stays quiet for pairing_rejected and normal", () => {
    const screen = render(<PairingModePopup />)
    mockStatus = {state: "disconnected", pairingState: {state: "pairing_rejected"}}
    screen.rerender(<PairingModePopup />)
    mockStatus = connectedNormal()
    screen.rerender(<PairingModePopup />)

    expect(showAlert).not.toHaveBeenCalled()
  })
})
