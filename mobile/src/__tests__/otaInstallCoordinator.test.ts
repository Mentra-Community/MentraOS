/**
 * Characterization tests for the island OtaInstallCoordinator (WP 8B) — the OTA
 * install state machine moved verbatim out of mobile/src/app/ota/progress.tsx.
 *
 * Imports the real island sources by path (not via "@mentra/island", which jest
 * mocks) so the actual watchdog/retry/arbitration logic runs under the mobile
 * jest runner; the bluetooth SDK stays the shared jest.setup mock. Inputs are
 * driven by mutating the real island glasses store and emitting on island's
 * GlobalEventEmitter (what OtaService does with the BLE events).
 */
import type {OtaStatus} from "@mentra/bluetooth-sdk-internal"

import {otaInstallCoordinator} from "../../modules/island/src/services/OtaInstallCoordinator"
import {
  DOWNLOAD_STUCK_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  MAX_RETRIES,
  OtaProgressMessages,
  PROGRESS_TIMEOUT_MS,
  QUERY_REPLY_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
} from "../../modules/island/src/services/otaInstallPolicy"
import {useGlassesStore} from "../../modules/island/src/stores/glasses"
import GlobalEventEmitter from "../../modules/island/src/utils/GlobalEventEmitter"

import {bluetoothSdkMock} from "../test-utils/mockBluetoothSdk"

function setGlassesConnected() {
  useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
}

function inProgressStatus(overrides: Partial<OtaStatus> = {}): OtaStatus {
  return {
    sessionId: "s1",
    totalSteps: 1,
    currentStep: 1,
    stepType: "apk",
    phase: "download",
    stepPercent: 0,
    overallPercent: 0,
    status: "in_progress",
    ...overrides,
  }
}

function idleStatus(): OtaStatus {
  return {
    sessionId: "",
    totalSteps: 0,
    currentStep: 0,
    stepType: "apk",
    phase: "download",
    stepPercent: 0,
    overallPercent: 0,
    status: "idle",
  }
}

beforeEach(() => {
  jest.useFakeTimers()
  otaInstallCoordinator.detach()
  useGlassesStore.getState().reset()
  bluetoothSdkMock.startOtaUpdate.mockClear()
  bluetoothSdkMock.sendOtaQueryStatus.mockClear()
  bluetoothSdkMock.updateGlasses.mockClear()
  bluetoothSdkMock.ping.mockClear()
})

afterEach(() => {
  otaInstallCoordinator.detach()
  jest.useRealTimers()
})

describe("OtaInstallCoordinator initial-mount arbitration", () => {
  it("attach with connected + no session sends ota_start and arms the global timeout once", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.sendOtaQueryStatus).not.toHaveBeenCalled()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")

    // Ack + steadily-advancing progress keep every per-step watchdog quiet, so
    // only the global session cap (armed once at the first send) can fail it.
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    for (let minute = 1; minute * 60_000 <= GLOBAL_OTA_TIMEOUT_MS; minute++) {
      useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: minute, overallPercent: minute}))
      await jest.advanceTimersByTimeAsync(60_000)
    }

    const snap = otaInstallCoordinator.snapshot()
    expect(snap.errorMsg).toBe(OtaProgressMessages.globalTimeout)
    expect(snap.displayState).toBe("failed")
    // The no-ack retry watchdog never re-sent (ack + first activity cleared it).
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("attach while disconnected sends nothing", () => {
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.sendOtaQueryStatus).not.toHaveBeenCalled()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("disconnected")
  })
})

describe("OtaInstallCoordinator no-ack retry watchdog", () => {
  it("retries ota_start at RETRY_INTERVAL_MS up to MAX_RETRIES then fails with noAckResponse", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(3)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(MAX_RETRIES)
    const snap = otaInstallCoordinator.snapshot()
    expect(snap.errorMsg).toBe(OtaProgressMessages.noAckResponse)
    expect(snap.displayState).toBe("failed")
  })

  it("ota_start_ack clears the retry watchdog (no further retries)", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1000)
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 3)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
  })
})

describe("OtaInstallCoordinator query-status arbitration with an existing session", () => {
  it("sends ota_query_status; an idle reply does NOT cancel the fallback, so ota_start fires after QUERY_REPLY_TIMEOUT_MS", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 10, overallPercent: 10}))
    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.sendOtaQueryStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()

    // Glasses process restarted: the session is gone; explicit idle reply
    // (empty sessionId) must NOT satisfy the fallback.
    useGlassesStore.getState().setOtaStatus(idleStatus())
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("a non-idle ota_status reply cancels the fallback (no ota_start)", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 10, overallPercent: 10}))
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.sendOtaQueryStatus).toHaveBeenCalledTimes(1)

    // The active session replies: still in progress.
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 12, overallPercent: 12}))
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS * 2)

    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })
})

describe("OtaInstallCoordinator stuck-at-zero watchdog", () => {
  it("fails after DOWNLOAD_STUCK_TIMEOUT_MS at 0%", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)

    const snap = otaInstallCoordinator.snapshot()
    expect(snap.errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
    expect(snap.displayState).toBe("failed")
  })

  it("zero-percent activity does NOT clear it (still fails)", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    // First activity, but no real progress: stepPercent stays 0.
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 0, overallPercent: 0}))

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
  })

  it("is cleared by the first NON-ZERO progress", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 5, overallPercent: 5}))

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")
  })
})

describe("OtaInstallCoordinator MTK completion", () => {
  it("mtk_update_complete queries status and marks MTK updated this session", () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    bluetoothSdkMock.sendOtaQueryStatus.mockClear()

    GlobalEventEmitter.emit("mtk_update_complete", {message: "done", timestamp: Date.now()})

    expect(bluetoothSdkMock.sendOtaQueryStatus).toHaveBeenCalledTimes(1)
    expect(useGlassesStore.getState().mtkUpdatedThisSession).toBe(true)
  })
})

describe("OtaInstallCoordinator finish()", () => {
  it("after an APK step clears the update prompt and the stale build number", () => {
    setGlassesConnected()
    useGlassesStore.getState().setGlassesInfo({buildNumber: "40"})
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 41,
      versionName: "41.0",
      updates: ["apk"],
      totalSize: 0,
    })
    otaInstallCoordinator.attach()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepType: "apk", stepPercent: 30, overallPercent: 30}))

    otaInstallCoordinator.finish()

    expect(bluetoothSdkMock.updateGlasses).toHaveBeenCalledWith({buildNumber: ""})
    expect(useGlassesStore.getState().buildNumber).toBe("")
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })

  it("without an APK step leaves the build number alone", () => {
    setGlassesConnected()
    useGlassesStore.getState().setGlassesInfo({buildNumber: "40"})
    otaInstallCoordinator.attach()
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({stepType: "bes", phase: "install", stepPercent: 30, overallPercent: 30}))

    otaInstallCoordinator.finish()

    expect(bluetoothSdkMock.updateGlasses).not.toHaveBeenCalled()
    expect(useGlassesStore.getState().buildNumber).toBe("40")
  })
})

describe("OtaInstallCoordinator detach()", () => {
  it("clears pending watchdogs; re-attach is a fresh session with fresh retry bookkeeping", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(1000)
    otaInstallCoordinator.detach()

    // No pending watchdog outlives detach: nothing re-fires, nothing fails.
    await jest.advanceTimersByTimeAsync(GLOBAL_OTA_TIMEOUT_MS * 2)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    // Re-attach: fresh initial-mount arbitration + a full fresh retry cycle.
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.noAckResponse)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1 + MAX_RETRIES)
  })

  it("after a failure resets session state so a re-attach starts clean", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")

    otaInstallCoordinator.detach()
    otaInstallCoordinator.attach()

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
  })
})

describe("OtaInstallCoordinator snapshot subscription", () => {
  it("fires on store changes AND internal state changes, deduped on the projection", async () => {
    setGlassesConnected()
    const seen: string[] = []
    const unsubscribe = otaInstallCoordinator.onSnapshot((s) => seen.push(`${s.displayState}|${s.errorMsg}`))

    otaInstallCoordinator.attach()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 5, overallPercent: 5}))
    expect(seen).toContain("updating|")

    // Unrelated store change does not change the projection: no emission.
    const emissions = seen.length
    useGlassesStore.getState().setBatteryInfo(50, false, 50, false)
    expect(seen.length).toBe(emissions)

    // Progress stall sets internal errorMsg — subscribers must hear about it.
    await jest.advanceTimersByTimeAsync(PROGRESS_TIMEOUT_MS)
    expect(seen[seen.length - 1]).toBe(`failed|${OtaProgressMessages.stalledOrStuck}`)

    unsubscribe()
    useGlassesStore.getState().setOtaStatus(null)
    expect(seen[seen.length - 1]).toBe(`failed|${OtaProgressMessages.stalledOrStuck}`)
  })
})
