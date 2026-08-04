/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const settingsValues: Record<string, unknown> = {}
const listeners = new Set<() => void>()
const okResult = {is_error: () => false} as const
const mockSetSetting = mock((key: string, value: unknown) => {
  settingsValues[key] = value
  for (const listener of [...listeners]) listener()
  return Promise.resolve(okResult)
})

mock.module("../../stores/settings", () => ({
  SETTINGS: {
    default_wearable: {key: "default_wearable"},
    pending_wearable: {key: "pending_wearable"},
    device_name: {key: "device_name"},
    device_address: {key: "device_address"},
  },
  useSettingsStore: {
    getState: () => ({
      getSetting: (key: string) => settingsValues[key],
      setSetting: mockSetSetting,
    }),
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  },
}))

// Import AFTER the mocks are registered
const {
  projectPairingIdentity,
  subscribePairingIdentity,
  markPendingSelection,
  retirePendingSelectionOnPromotion,
  demoteDefaultToPending,
} = require("../PairingIdentity")
// Real enum: the simulated special case must track the actual model string.
const {DeviceTypes} = require("../../types")

function resetSettings(values: Record<string, unknown>) {
  for (const key of Object.keys(settingsValues)) delete settingsValues[key]
  Object.assign(settingsValues, values)
}

describe("PairingIdentity", () => {
  beforeEach(() => {
    mockSetSetting.mockClear()
    listeners.clear()
    resetSettings({})
  })

  describe("projectPairingIdentity", () => {
    test("no identity keys → none", () => {
      expect(projectPairingIdentity()).toEqual({kind: "none"})
    })

    test("a pending selection → pending", () => {
      resetSettings({pending_wearable: "Even Realities G1"})
      expect(projectPairingIdentity()).toEqual({kind: "pending", model: "Even Realities G1"})
    })

    test("paired requires default_wearable AND device_name (native currentDefaultDevice)", () => {
      resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1", device_address: "aa:bb"})
      expect(projectPairingIdentity()).toEqual({
        kind: "paired",
        model: "Mentra Live",
        name: "LIVE_1",
        address: "aa:bb",
      })
    })

    test("address is optional on a paired identity", () => {
      resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1"})
      expect(projectPairingIdentity()).toEqual({kind: "paired", model: "Mentra Live", name: "LIVE_1"})
    })

    test("an orphaned default (no device_name) reads as pending — the demotion's target state", () => {
      resetSettings({default_wearable: "Mentra Live"})
      expect(projectPairingIdentity()).toEqual({kind: "pending", model: "Mentra Live"})
    })

    test("a fresher pending selection wins over an orphaned default", () => {
      resetSettings({default_wearable: "Mentra Live", pending_wearable: "Even Realities G1"})
      expect(projectPairingIdentity()).toEqual({kind: "pending", model: "Even Realities G1"})
    })

    test("a completed pairing wins over a stale pending marker (retire echo still in flight)", () => {
      resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1", pending_wearable: "Mentra Live"})
      expect(projectPairingIdentity()).toEqual({kind: "paired", model: "Mentra Live", name: "LIVE_1"})
    })

    test("the simulated device is its own identity: paired from the model alone, name mirrors it", () => {
      resetSettings({default_wearable: DeviceTypes.SIMULATED})
      expect(projectPairingIdentity()).toEqual({
        kind: "paired",
        model: DeviceTypes.SIMULATED,
        name: DeviceTypes.SIMULATED,
      })
    })

    test("non-string identity values read as absent", () => {
      resetSettings({default_wearable: null, pending_wearable: undefined, device_name: 42})
      expect(projectPairingIdentity()).toEqual({kind: "none"})
    })
  })

  describe("subscribePairingIdentity", () => {
    test("fires with the new snapshot when the identity changes, dedupes when it does not", async () => {
      const seen: unknown[] = []
      const unsubscribe = subscribePairingIdentity((identity: unknown) => seen.push(identity))

      await markPendingSelection("Even Realities G1")
      expect(seen).toEqual([{kind: "pending", model: "Even Realities G1"}])

      // A settings-store update that leaves the projection unchanged must not fire.
      await mockSetSetting("brightness", 80)
      await markPendingSelection("Even Realities G1")
      expect(seen).toHaveLength(1)

      unsubscribe()
      await markPendingSelection("Mentra Live")
      expect(seen).toHaveLength(1)
    })
  })

  describe("identity writes", () => {
    test("markPendingSelection writes the pending marker", async () => {
      await markPendingSelection("Even Realities G1")
      expect(settingsValues.pending_wearable).toBe("Even Realities G1")
    })

    test("a promoted default retires the pending selection marker", async () => {
      resetSettings({pending_wearable: "Mentra Live"})
      await retirePendingSelectionOnPromotion("default_wearable", "Mentra Live")
      expect(settingsValues.pending_wearable).toBe("")
    })

    test("retire is a no-op for other keys, empty promotions, and an already-clear marker", async () => {
      resetSettings({pending_wearable: "Mentra Live"})
      await retirePendingSelectionOnPromotion("device_name", "LIVE_1")
      await retirePendingSelectionOnPromotion("default_wearable", "")
      expect(settingsValues.pending_wearable).toBe("Mentra Live")

      resetSettings({})
      await retirePendingSelectionOnPromotion("default_wearable", "Mentra Live")
      expect(mockSetSetting).not.toHaveBeenCalled()
    })

    test("demoteDefaultToPending backfills the marker and clears the identity triplet", async () => {
      resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1", device_address: "aa:bb"})
      await demoteDefaultToPending("Mentra Live")
      expect(settingsValues).toEqual({
        pending_wearable: "Mentra Live",
        default_wearable: "",
        device_name: "",
        device_address: "",
      })
    })

    test("demoteDefaultToPending never overwrites a fresher pending selection", async () => {
      resetSettings({default_wearable: "Mentra Live", pending_wearable: "Even Realities G1"})
      await demoteDefaultToPending("Mentra Live")
      expect(settingsValues.pending_wearable).toBe("Even Realities G1")
      expect(settingsValues.default_wearable).toBe("")
    })
  })
})
