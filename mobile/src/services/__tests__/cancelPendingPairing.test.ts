/* eslint-disable no-restricted-imports -- Exercise the real engine implementation, not the mocked public facade. */
import {result as Res} from "typesafe-ts"

import {bluetoothSdkMock, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

import {pairing} from "../../../modules/engine/src/facades/pairing"
import {hasDefaultDevice} from "../../../modules/engine/src/services/DeviceStoreHydration"
import {pushAllBluetoothSettings} from "../../../modules/engine/src/services/GlassesSettingsSync"
import {retirePendingSelectionOnPromotion} from "../../../modules/engine/src/services/PairingIdentity"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "../../../modules/engine/src/stores/settings"
import {storage} from "../../../modules/engine/src/utils/storage"

jest.mock("../../../modules/engine/src/services/DeviceStoreHydration", () => ({
  hasDefaultDevice: jest.fn(),
}))

jest.mock("../../../modules/engine/src/services/GlassesSettingsSync", () => ({
  pushAllBluetoothSettings: jest.fn(),
}))

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
}))

const MODEL = "Mentra Live"
const NEXT_MODEL = "Even Realities G1"
const NAME = "Mentra_Live_ABCD"
const ADDRESS = "02:00:00:00:AB:CD"
const cancelOptions = {clearPendingSelection: true}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return {promise, resolve}
}

function holdCleanup(method: "forget" | "stopScan" | "disconnect" = "forget") {
  const started = deferred()
  const finished = deferred()
  bluetoothSdkMock[method].mockImplementationOnce(() => {
    started.resolve()
    return finished.promise
  })
  return {started: started.promise, finish: finished.resolve}
}

function pendingModel() {
  return useSettingsStore.getState().getSetting(SETTINGS.pending_wearable.key)
}

async function promotePairing() {
  const settings = useSettingsStore.getState()
  await settings.setSetting(SETTINGS.default_wearable.key, MODEL)
  await settings.setSetting(SETTINGS.device_name.key, NAME)
  await settings.setSetting(SETTINGS.device_address.key, ADDRESS)
}

describe("explicit cancellation of unfinished pairing", () => {
  beforeEach(async () => {
    resetBluetoothSdkMock()
    bluetoothSdkMock.forget.mockReset().mockResolvedValue(undefined)
    bluetoothSdkMock.disconnect.mockReset().mockResolvedValue(undefined)
    bluetoothSdkMock.stopScan.mockReset().mockResolvedValue(undefined)
    jest.mocked(hasDefaultDevice).mockReset().mockResolvedValue(false)
    jest.mocked(pushAllBluetoothSettings).mockReset().mockResolvedValue(undefined)
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    jest.spyOn(console, "log").mockImplementation(() => {})
    await pairing.markPendingSelection(MODEL)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it("persists the pending clear when native forget does not echo it, as on iOS", async () => {
    const save = jest.spyOn(storage, "save")

    await pairing.abandonAttempt(cancelOptions)

    expect(bluetoothSdkMock.forget).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.disconnect).not.toHaveBeenCalled()
    expect(pushAllBluetoothSettings).not.toHaveBeenCalled()
    expect(save).toHaveBeenCalledWith(SETTINGS.pending_wearable.key, "")
    expect(pairing.identity()).toEqual({kind: "none"})
  })

  it("keeps the pending selection when an ordinary attempt is abandoned", async () => {
    await pairing.abandonAttempt()

    expect(bluetoothSdkMock.forget).toHaveBeenCalledTimes(1)
    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it.each(["connected", "disconnected", "native-default-missing"] as const)(
    "clears a second-device selection while preserving a completed pairing (%s)",
    async (state) => {
      await promotePairing()
      await pairing.markPendingSelection(NEXT_MODEL)
      const save = jest.spyOn(storage, "save")
      jest.mocked(hasDefaultDevice).mockResolvedValue(state !== "native-default-missing")
      useGlassesStore.getState().setGlassesInfo({
        connection: state === "connected" ? {state, fullyBooted: true} : {state: "disconnected"},
      })

      await pairing.abandonAttempt(cancelOptions)

      expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
      expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
      expect(pendingModel()).toBe("")
      expect(save).toHaveBeenCalledWith(SETTINGS.pending_wearable.key, "")
      if (state === "connected") {
        expect(bluetoothSdkMock.stopScan).toHaveBeenCalledTimes(1)
        expect(bluetoothSdkMock.disconnect).not.toHaveBeenCalled()
        expect(pushAllBluetoothSettings).not.toHaveBeenCalled()
      } else {
        expect(bluetoothSdkMock.disconnect).toHaveBeenCalledTimes(1)
        expect(pushAllBluetoothSettings).toHaveBeenCalledTimes(1)
      }
    },
  )

  it("keeps the second-device selection on ordinary back-out while preserving the default", async () => {
    await promotePairing()
    await pairing.markPendingSelection(NEXT_MODEL)
    jest.mocked(hasDefaultDevice).mockResolvedValue(true)

    await pairing.abandonAttempt()

    expect(pendingModel()).toBe(NEXT_MODEL)
    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
  })

  it("preserves native promotion while the complete identity has not reached JS", async () => {
    jest.mocked(hasDefaultDevice).mockResolvedValue(true)
    await useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, MODEL)

    await pairing.abandonAttempt(cancelOptions)

    expect(bluetoothSdkMock.disconnect).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
    expect(pushAllBluetoothSettings).not.toHaveBeenCalled()
    expect(pendingModel()).toBe("")
    expect(useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)).toBe(MODEL)
  })

  it("rejects explicit cancellation and preserves the selection when the native default read fails", async () => {
    jest.mocked(hasDefaultDevice).mockRejectedValue(new Error("native read unavailable"))

    await expect(pairing.abandonAttempt(cancelOptions)).rejects.toThrow("native read unavailable")

    expect(bluetoothSdkMock.disconnect).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
    expect(pushAllBluetoothSettings).not.toHaveBeenCalled()
    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it("keeps ordinary back-out's preservation behavior when the native default read fails", async () => {
    jest.mocked(hasDefaultDevice).mockRejectedValue(new Error("native read unavailable"))

    await pairing.abandonAttempt()

    expect(bluetoothSdkMock.disconnect).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it("rechecks completed pairing after awaiting the native default read", async () => {
    const nativeRead = deferred()
    jest.mocked(hasDefaultDevice).mockImplementationOnce(async () => {
      await nativeRead.promise
      return false
    })
    const cancellation = pairing.abandonAttempt(cancelOptions)
    await promotePairing()
    nativeRead.resolve()

    await cancellation

    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
    expect(pushAllBluetoothSettings).toHaveBeenCalledTimes(1)
    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
    expect(pendingModel()).toBe("")
  })

  it("rejects failed native cleanup without clearing the unfinished selection", async () => {
    const error = new Error("native forget failed")
    bluetoothSdkMock.forget.mockRejectedValueOnce(error)

    await expect(pairing.abandonAttempt(cancelOptions)).rejects.toBe(error)

    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it("keeps the marker until native cleanup completes", async () => {
    const cleanup = holdCleanup()
    const cancellation = pairing.abandonAttempt(cancelOptions)
    await cleanup.started

    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
    cleanup.finish()
    await cancellation

    expect(pairing.identity()).toEqual({kind: "none"})
  })

  it("preserves a newer selection made while native cleanup is pending", async () => {
    const cleanup = holdCleanup()
    const cancellation = pairing.abandonAttempt(cancelOptions)
    await cleanup.started
    await pairing.markPendingSelection(NEXT_MODEL)
    cleanup.finish()

    await cancellation

    expect(pairing.identity()).toEqual({kind: "pending", model: NEXT_MODEL})
  })

  it.each(["stopScan", "disconnect"] as const)(
    "preserves a newer selection of the same model while %s is pending",
    async (method) => {
      await promotePairing()
      await pairing.markPendingSelection(NEXT_MODEL)
      jest.mocked(hasDefaultDevice).mockResolvedValue(true)
      if (method === "stopScan") {
        useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
      }
      const cleanup = holdCleanup(method)
      const cancellation = pairing.abandonAttempt(cancelOptions)
      await cleanup.started
      await pairing.markPendingSelection(NEXT_MODEL)
      cleanup.finish()

      await cancellation

      expect(pendingModel()).toBe(NEXT_MODEL)
      expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
      expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
    },
  )

  it("preserves a newer selection of the same model while forgetting an unfinished attempt", async () => {
    const cleanup = holdCleanup()
    const cancellation = pairing.abandonAttempt(cancelOptions)
    await cleanup.started
    await pairing.markPendingSelection(MODEL)
    cleanup.finish()

    await cancellation

    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it("preserves a completed promotion received while native cleanup is pending", async () => {
    const cleanup = holdCleanup()
    const cancellation = pairing.abandonAttempt(cancelOptions)
    await cleanup.started
    await promotePairing()
    cleanup.finish()

    await cancellation

    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
    expect(pendingModel()).toBe("")
    expect(pushAllBluetoothSettings).not.toHaveBeenCalled()
  })

  it("surfaces a persistence Result error instead of reporting cancellation success", async () => {
    jest.spyOn(storage, "save").mockReturnValueOnce(Res.error(new Error("storage unavailable")))

    await expect(pairing.abandonAttempt(cancelOptions)).rejects.toThrow("storage unavailable")

    expect(bluetoothSdkMock.forget).toHaveBeenCalledTimes(1)
    expect(pairing.identity()).toEqual({kind: "pending", model: MODEL})
  })

  it("keeps a failed pending clear retryable while preserving an existing pairing", async () => {
    await promotePairing()
    await pairing.markPendingSelection(NEXT_MODEL)
    jest.mocked(hasDefaultDevice).mockResolvedValue(true)
    jest.spyOn(storage, "save").mockReturnValueOnce(Res.error(new Error("storage unavailable")))

    await expect(pairing.abandonAttempt(cancelOptions)).rejects.toThrow("storage unavailable")

    expect(pendingModel()).toBe(NEXT_MODEL)
    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()

    await pairing.abandonAttempt(cancelOptions)

    expect(pendingModel()).toBe("")
    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
  })

  it("does not restore a failed clear after native promotion retires the selection", async () => {
    await promotePairing()
    jest.mocked(hasDefaultDevice).mockResolvedValue(true)
    jest.spyOn(storage, "save").mockImplementationOnce(() => {
      expect(pendingModel()).toBe("")
      void retirePendingSelectionOnPromotion(SETTINGS.default_wearable.key, MODEL)
      return Res.error(new Error("storage unavailable"))
    })

    await expect(pairing.abandonAttempt(cancelOptions)).rejects.toThrow("storage unavailable")

    expect(pendingModel()).toBe("")
    expect(pairing.identity()).toEqual({kind: "paired", model: MODEL, name: NAME, address: ADDRESS})
    expect(bluetoothSdkMock.forget).not.toHaveBeenCalled()
  })
})
