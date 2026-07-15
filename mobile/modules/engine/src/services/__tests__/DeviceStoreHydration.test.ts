/// <reference types="bun-types" />

import {beforeEach, describe, expect, mock, test} from "bun:test"

const mockGetDefaultDevice = mock((): Promise<Record<string, unknown> | null> => Promise.resolve(null))
mock.module("@mentra/bluetooth-sdk/internal", () => ({
  __esModule: true,
  default: {
    getDefaultDevice: mockGetDefaultDevice,
  },
}))

const okResult = {is_error: () => false} as const
const settingsValues: Record<string, unknown> = {}
const mockLoadAllSettings = mock(() => Promise.resolve(okResult as {is_error: () => boolean; error?: unknown}))
const mockSetSetting = mock((key: string, value: unknown) => {
  settingsValues[key] = value
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
      loadAllSettings: mockLoadAllSettings,
      getSetting: (key: string) => settingsValues[key],
      setSetting: mockSetSetting,
    }),
  },
}))

let connection: {state: string} = {state: "disconnected"}
mock.module("../../stores/glasses", () => ({
  useGlassesStore: {
    getState: () => ({connection}),
  },
}))

const mockPushAllBluetoothSettings = mock(() => Promise.resolve())
mock.module("../GlassesSettingsSync", () => ({
  pushAllBluetoothSettings: mockPushAllBluetoothSettings,
}))

// Import AFTER the mocks are registered
const {
  hydrateDeviceStore,
  hasDefaultDevice,
  demoteOrphanedDefaultWearable,
  resetDeviceStoreHydrationForTests,
} = require("../DeviceStoreHydration")

function resetSettings(values: Record<string, unknown>) {
  for (const key of Object.keys(settingsValues)) delete settingsValues[key]
  Object.assign(settingsValues, values)
}

describe("DeviceStoreHydration", () => {
  beforeEach(() => {
    resetDeviceStoreHydrationForTests()
    mockGetDefaultDevice.mockClear()
    mockLoadAllSettings.mockClear()
    mockSetSetting.mockClear()
    mockPushAllBluetoothSettings.mockClear()
    mockLoadAllSettings.mockImplementation(() => Promise.resolve(okResult))
    mockGetDefaultDevice.mockImplementation(() => Promise.resolve(null))
    connection = {state: "disconnected"}
    resetSettings({})
  })

  test("hydration retries after a failed settings load, then single-flights", async () => {
    mockLoadAllSettings.mockImplementation(() =>
      Promise.resolve({is_error: () => true, error: new Error("disk unavailable")}),
    )
    // The failure surfaces as a REJECTION (never a false "absent"), and
    // hasDefaultDevice propagates it so callers can fail open.
    await expect(hasDefaultDevice()).rejects.toThrow("settings load failed")
    expect(mockPushAllBluetoothSettings).not.toHaveBeenCalled()

    // The memo cleared on failure: a later call retries and heals.
    mockLoadAllSettings.mockImplementation(() => Promise.resolve(okResult))
    await hydrateDeviceStore()
    expect(mockPushAllBluetoothSettings).toHaveBeenCalledTimes(1)

    // Completed hydration is cached: further calls run nothing again.
    await hydrateDeviceStore()
    await hydrateDeviceStore()
    expect(mockPushAllBluetoothSettings).toHaveBeenCalledTimes(1)
  })

  test("hasDefaultDevice awaits hydration and reports the native two-state answer", async () => {
    mockGetDefaultDevice.mockImplementation(() => Promise.resolve(null))
    expect(await hasDefaultDevice()).toBe(false)

    mockGetDefaultDevice.mockImplementation(() =>
      Promise.resolve({model: "Even Realities G1", name: "G1_123"}),
    )
    expect(await hasDefaultDevice()).toBe(true)
  })

  test("demotes an orphaned default_wearable to pending and clears the identity", async () => {
    resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1", device_address: "aa:bb"})
    mockGetDefaultDevice.mockImplementation(() => Promise.resolve(null))

    await demoteOrphanedDefaultWearable()

    expect(settingsValues.pending_wearable).toBe("Mentra Live")
    expect(settingsValues.default_wearable).toBe("")
    expect(settingsValues.device_name).toBe("")
    expect(settingsValues.device_address).toBe("")
    // Two pushes: the hydration seed (pre-demotion values), then the re-push
    // so native mirrors the demoted identity.
    expect(mockPushAllBluetoothSettings).toHaveBeenCalledTimes(2)
  })

  test("demotion backfills pending only when empty — a fresher selection wins", async () => {
    resetSettings({default_wearable: "Mentra Live", pending_wearable: "Even Realities G1"})
    mockGetDefaultDevice.mockImplementation(() => Promise.resolve(null))

    await demoteOrphanedDefaultWearable()

    // The user's later selection (G1) survives; the stale orphan is only cleared.
    expect(settingsValues.pending_wearable).toBe("Even Realities G1")
    expect(settingsValues.default_wearable).toBe("")
  })

  test("does not demote when the native default device exists", async () => {
    resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1"})
    mockGetDefaultDevice.mockImplementation(() =>
      Promise.resolve({model: "Mentra Live", name: "LIVE_1"}),
    )

    await demoteOrphanedDefaultWearable()

    expect(mockSetSetting).not.toHaveBeenCalled()
  })

  test("does not demote the simulated wearable", async () => {
    resetSettings({default_wearable: "Simulated Glasses"})

    await demoteOrphanedDefaultWearable()

    expect(mockSetSetting).not.toHaveBeenCalled()
    // Hydration runs (the internal await), but the native default is never read.
    expect(mockGetDefaultDevice).not.toHaveBeenCalled()
  })

  test("demotion refuses to run against an unhydrated store", async () => {
    resetSettings({default_wearable: "Mentra Live", device_name: "LIVE_1"})
    mockLoadAllSettings.mockImplementation(() =>
      Promise.resolve({is_error: () => true, error: new Error("disk unavailable")}),
    )

    await expect(demoteOrphanedDefaultWearable()).rejects.toThrow("settings load failed")

    // Nothing was demoted on the unseeded store.
    expect(mockSetSetting).not.toHaveBeenCalled()
    expect(settingsValues.default_wearable).toBe("Mentra Live")
  })

  test("does not demote while the link layer is busy or connected (a pairing owns the identity)", async () => {
    resetSettings({default_wearable: "Mentra Live"})

    connection = {state: "connecting"}
    await demoteOrphanedDefaultWearable()
    expect(mockSetSetting).not.toHaveBeenCalled()

    connection = {state: "connected"}
    await demoteOrphanedDefaultWearable()
    expect(mockSetSetting).not.toHaveBeenCalled()
  })

  test("does nothing when no default_wearable is set", async () => {
    resetSettings({pending_wearable: "Mentra Live"})

    await demoteOrphanedDefaultWearable()

    expect(mockSetSetting).not.toHaveBeenCalled()
  })
})
