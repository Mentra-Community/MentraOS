import {act, waitFor} from "@testing-library/react-native"

import {pairing, submitPairingBootTimeoutReport} from "../../../modules/engine/src/facades/pairing"
import {submitAutomaticReport} from "../../../modules/engine/src/facades/reports"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import {SETTINGS, useSettingsStore} from "../../../modules/engine/src/stores/settings"
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("@/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("../../../modules/engine/src/facades/reports", () => ({
  submitAutomaticReport: jest.fn(),
}))

describe("pairing ready timeout reports", () => {
  let logSpy: jest.SpyInstance
  let errorSpy: jest.SpyInstance

  beforeEach(() => {
    jest.useFakeTimers()
    resetBluetoothSdkMock()
    useGlassesStore.getState().reset()
    useSettingsStore.getState().resetAllSettingsLocally()
    ;(submitAutomaticReport as jest.Mock).mockClear()
    ;(submitAutomaticReport as jest.Mock).mockResolvedValue({
      status: "submitted",
      reportId: "report-1",
      reportStatus: "ready",
    })
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {})
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it("files the boot timeout report from the island pairing facade", async () => {
    const result = await submitPairingBootTimeoutReport({
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_001",
      showGlassesBooting: true,
      elapsedMs: 35_000,
      route: "/pairing/loading",
    })

    expect(submitAutomaticReport).toHaveBeenCalledWith({
      kind: "automatic",
      trigger: {
        type: "automatic",
        source: "pairing_loading",
        reason: "glasses_connect_timeout",
      },
      report: {
        expectedBehavior: "Glasses should connect successfully within 35 seconds.",
        actualBehavior: JSON.stringify(
          {
            deviceModel: "Mentra Live",
            deviceName: "MENTRA_LIVE_BLE_001",
            showGlassesBooting: true,
            elapsedMs: 35_000,
            route: "/pairing/loading",
          },
          null,
          2,
        ),
        systemPriority: "medium",
      },
      throttleKey: "pairing_timeout|Mentra Live|MENTRA_LIVE_BLE_001",
    })
    expect(result).toEqual({status: "filed", reportId: "report-1"})
    expect(logSpy).toHaveBeenCalledWith("[PairingTimeoutReport] Report filed:", "report-1")
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it("waits for readiness and files on timeout without delaying the caller", async () => {
    const readyPromise = pairing.waitForReady({
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_001",
      timeoutMs: 1000,
      route: "/pairing/loading",
    })

    act(() => {
      emitBluetoothSdkEvent("glasses_not_ready", {message: "booting"})
      jest.advanceTimersByTime(1000)
    })

    await expect(readyPromise).resolves.toBe(false)
    await waitFor(() => {
      expect(submitAutomaticReport).toHaveBeenCalledWith(
        expect.objectContaining({
          throttleKey: "pairing_timeout|Mentra Live|MENTRA_LIVE_BLE_001",
          report: expect.objectContaining({
            actualBehavior: expect.stringContaining('"showGlassesBooting": true'),
          }),
        }),
      )
    })
  })

  it("does not file when the glasses become ready before the boot budget expires", async () => {
    const readyPromise = pairing.waitForReady({
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_001",
      timeoutMs: 1000,
      route: "/pairing/loading",
    })

    act(() => {
      void useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
      void useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "MENTRA_LIVE_BLE_001", false)
      useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    })

    await expect(readyPromise).resolves.toBe(true)
    expect(submitAutomaticReport).not.toHaveBeenCalled()
  })

  it("does not accept readiness from a different paired wearable", async () => {
    void useSettingsStore.getState().setSetting(SETTINGS.default_wearable.key, "Mentra Live", false)
    void useSettingsStore.getState().setSetting(SETTINGS.device_name.key, "MENTRA_LIVE_BLE_OLD", false)
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})

    const readyPromise = pairing.waitForReady({
      deviceModel: "Mentra Live",
      deviceName: "MENTRA_LIVE_BLE_NEW",
      timeoutMs: 1000,
    })
    act(() => {
      jest.advanceTimersByTime(1000)
    })

    await expect(readyPromise).resolves.toBe(false)
  })

  it("waits for the selected controller instead of wearable readiness", async () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
    const readyPromise = pairing.waitForReady({
      deviceModel: "Even Realities R1",
      deviceName: "CEC5BA",
      timeoutMs: 1000,
    })

    act(() => {
      void useSettingsStore.getState().setSetting(SETTINGS.default_controller.key, "Even Realities R1", false)
      void useSettingsStore.getState().setSetting(SETTINGS.controller_device_name.key, "CEC5BA", false)
      useGlassesStore.getState().setGlassesInfo({controllerConnected: true, controllerFullyBooted: true})
    })

    await expect(readyPromise).resolves.toBe(true)
  })

  it("readiness() projects pairing state without exposing the raw glasses store", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      bluetoothClassicConnected: true,
    })

    expect(pairing.readiness()).toEqual({
      state: "connected",
      connected: true,
      fullyBooted: true,
      bluetoothClassicConnected: true,
      nativeLinkBusy: false,
    })
  })

  it("waitForBluetoothClassic resolves when classic connects before timeout", async () => {
    const waitPromise = pairing.waitForBluetoothClassic({timeoutMs: 1000})

    act(() => {
      useGlassesStore.getState().setGlassesInfo({bluetoothClassicConnected: true})
    })

    await expect(waitPromise).resolves.toBe(true)
  })

  it("waitForBluetoothClassic resolves false on timeout", async () => {
    const waitPromise = pairing.waitForBluetoothClassic({timeoutMs: 1000})

    act(() => {
      jest.advanceTimersByTime(1000)
    })

    await expect(waitPromise).resolves.toBe(false)
  })
})
