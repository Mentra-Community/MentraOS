import {engine} from "@mentra/engine"

import {cancelLeftoverPairing} from "@/utils/PairingUtils"

jest.mock("@/stores/navigation", () => ({useNavigationStore: {getState: jest.fn()}}))
jest.mock("@/utils/AlertUtils", () => ({showAlert: jest.fn()}))
jest.mock("@/utils/pairing/unpairSavedGlasses", () => ({unpairSavedGlasses: jest.fn()}))

describe("cancelLeftoverPairing", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(engine.pairing.abandonAttempt as jest.Mock).mockReset().mockResolvedValue(undefined)
  })

  it("cancels a selection that never paired, retiring the pending marker", async () => {
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValueOnce(false)

    await cancelLeftoverPairing()

    expect(engine.pairing.abandonAttempt).toHaveBeenCalledWith({clearPendingSelection: true})
  })

  it.each(["connecting", "bonding", "scanning"])("leaves a %s link alone, since it may still pair", async (state) => {
    ;(engine.glasses.status as jest.Mock).mockReturnValueOnce({state})

    await cancelLeftoverPairing()

    expect(engine.glasses.hasDefaultDevice).not.toHaveBeenCalled()
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
  })

  it("leaves glasses alone once they paired natively", async () => {
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValueOnce(true)

    await cancelLeftoverPairing()

    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
  })

  it("does nothing when the native pairing cannot be read", async () => {
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockRejectedValueOnce(new Error("native read failed"))

    await expect(cancelLeftoverPairing()).resolves.toBeUndefined()
    expect(engine.pairing.abandonAttempt).not.toHaveBeenCalled()
  })

  it("swallows a failed cancel so Home keeps working", async () => {
    ;(engine.glasses.hasDefaultDevice as jest.Mock).mockResolvedValueOnce(false)
    ;(engine.pairing.abandonAttempt as jest.Mock).mockRejectedValueOnce(new Error("cleanup failed"))

    await expect(cancelLeftoverPairing()).resolves.toBeUndefined()
  })
})
