import {markPairingModePopupShown, wasPairingModePopupShown} from "@/utils/pairing/pairingModePopup"

const mockBacking = new Map<string, unknown>()

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

describe("pairing-mode popup record", () => {
  beforeEach(() => {
    mockBacking.clear()
  })

  it("starts empty", () => {
    expect(wasPairingModePopupShown("AA:BB", 1, 1_000)).toBe(false)
  })

  it("remembers a (deviceId, windowId) pair until the window ends", () => {
    markPairingModePopupShown("AA:BB", 7, 5_000, 1_000)

    expect(wasPairingModePopupShown("AA:BB", 7, 2_000)).toBe(true)
    expect(wasPairingModePopupShown("AA:BB", 7, 4_999)).toBe(true)
    expect(wasPairingModePopupShown("AA:BB", 7, 5_000)).toBe(false)
  })

  it("treats a new windowId or another device as a new window", () => {
    markPairingModePopupShown("AA:BB", 7, 5_000, 1_000)

    expect(wasPairingModePopupShown("AA:BB", 8, 2_000)).toBe(false)
    expect(wasPairingModePopupShown("CC:DD", 7, 2_000)).toBe(false)
  })

  it("keeps earlier live windows and drops expired ones when saving", () => {
    markPairingModePopupShown("AA:BB", 1, 2_000, 1_000)
    markPairingModePopupShown("AA:BB", 2, 9_000, 3_000)

    const stored = mockBacking.get("mentra_live_pairing_mode_popup_shown") as Record<string, number>
    expect(stored).toEqual({"AA:BB:2": 9_000})
  })

  it("survives a reload because it reads from storage each time", () => {
    markPairingModePopupShown("AA:BB", 3, 5_000, 1_000)

    jest.isolateModules(() => {
      const fresh = require("@/utils/pairing/pairingModePopup")
      expect(fresh.wasPairingModePopupShown("AA:BB", 3, 2_000)).toBe(true)
    })
  })
})
