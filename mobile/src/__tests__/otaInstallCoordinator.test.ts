/**
 * Characterization tests for the island OtaInstallCoordinator (WP 8B) — the OTA
 * install state machine moved verbatim out of mobile/src/app/ota/progress.tsx.
 *
 * Imports the real island sources by path (not via "@mentra/engine", which jest
 * mocks) so the actual watchdog/retry/arbitration logic runs under the mobile
 * jest runner; the bluetooth SDK stays the shared jest.setup mock. Inputs are
 * driven by mutating the real island glasses store and emitting on island's
 * GlobalEventEmitter (what OtaService does with the BLE events).
 */
import type {OtaStatus} from "@mentra/bluetooth-sdk-internal"

import {otaInstallCoordinator} from "../../modules/engine/src/services/OtaInstallCoordinator"
import type {OtaCheckCurrentGlassesResult} from "../../modules/engine/src/services/OtaUpdateCheckService"
import {
  BES_CONTINUE_LOCKOUT_MS,
  DOWNLOAD_STUCK_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  LEGACY_APK_COMPLETION_SETTLE_MS,
  LEGACY_EXTRA_TIMEOUT_MS,
  LEGACY_MTK_SIM_TICK_MS,
  LEGACY_MTK_STALL_DETECT_MS,
  LEGACY_RETRY_INTERVAL_MS,
  MAX_RETRIES,
  MTK_INSTALL_TIMEOUT_MS,
  OtaProgressMessages,
  PING_INTERVAL_MS,
  PROGRESS_TIMEOUT_MS,
  QUERY_REPLY_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
} from "../../modules/engine/src/services/otaInstallPolicy"
import {
  legacyOtaProgressFromOtaStatusEvent,
  normalizeOtaStatusEvent,
  otaStatusFromNormalized,
} from "../../modules/engine/src/services/otaLegacyMapping"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import GlobalEventEmitter from "../../modules/engine/src/utils/GlobalEventEmitter"

import {bluetoothSdkMock} from "../test-utils/mockBluetoothSdk"

jest.mock("../../modules/engine/src/services/HotspotOtaTransport", () => ({
  hotspotOtaTransport: {
    prepare: jest.fn(),
    teardown: jest.fn(),
  },
}))

const mockedHotspotTransport = jest.requireMock("../../modules/engine/src/services/HotspotOtaTransport")
  .hotspotOtaTransport as {prepare: jest.Mock; teardown: jest.Mock}
const mockHotspotPrepare = mockedHotspotTransport.prepare
const mockHotspotTeardown = mockedHotspotTransport.teardown

function setGlassesConnected() {
  useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}})
}

/** Connected old-build (< 37) glasses — the population that used /ota/progress-legacy. */
function setLegacyGlassesConnected(buildNumber = "33") {
  useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}, buildNumber})
}

/**
 * WP 8C: exactly what lands in the store when an old (< 37) ASG build sends a legacy
 * `ota_progress` BLE message. The SDK (Android MentraLive.kt / iOS MentraLive.swift) maps
 * it to a unified ota_status with sessionId "", totalSteps 1, and FAILED→failed /
 * FINISHED→complete (regardless of phase!) / else in_progress; OtaService then projects
 * that into BOTH store shapes. Runs the real island mapping code so the fixture cannot
 * drift from production.
 */
function emitLegacyOtaProgress(input: {
  stage: "download" | "install"
  status: "STARTED" | "PROGRESS" | "FINISHED" | "FAILED"
  progress: number
  currentUpdate: "apk" | "mtk" | "bes"
  errorMessage?: string
}) {
  const unified = input.status === "FAILED" ? "failed" : input.status === "FINISHED" ? "complete" : "in_progress"
  const normalized = normalizeOtaStatusEvent({
    session_id: "",
    total_steps: 1,
    current_step: 1,
    step_type: input.currentUpdate,
    phase: input.stage,
    step_percent: input.progress,
    overall_percent: input.progress,
    status: unified,
    error_message: input.errorMessage,
  })
  useGlassesStore.getState().setOtaStatus(otaStatusFromNormalized(normalized))
  useGlassesStore.getState().setOtaProgress(legacyOtaProgressFromOtaStatusEvent(normalized))
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

function checkResult(): OtaCheckCurrentGlassesResult {
  return {
    hasCheckCompleted: true,
    updateAvailable: true,
    latestVersionInfo: null,
    updates: ["apk"],
    mtkPatch: null,
    besVersion: null,
    isApkDowngrade: false,
    manifestBody: "{}",
    releaseVersion: null,
    updateInfo: null,
    isRequired: true,
  }
}

async function flushNativeStartPromise(): Promise<void> {
  await jest.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  jest.useFakeTimers()
  otaInstallCoordinator.detach()
  useGlassesStore.getState().reset()
  bluetoothSdkMock.startOtaUpdate.mockReset().mockResolvedValue(undefined)
  bluetoothSdkMock.queryOtaStatus.mockClear()
  bluetoothSdkMock.requestVersionInfo.mockClear()
  bluetoothSdkMock.ping.mockClear()
  mockHotspotPrepare.mockReset().mockResolvedValue("http://192.168.43.2:8791/version.json")
  mockHotspotTeardown.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  otaInstallCoordinator.detach()
  useGlassesStore.getState().setGlassesInfo({
    connection: {state: "connected", fullyBooted: true},
    wifi: {state: "connected", ssid: "test"},
  })
  otaInstallCoordinator.prepare(checkResult())
  jest.useRealTimers()
})

describe("OtaInstallCoordinator hotspot transport selection", () => {
  it("waits for an explicit glasses Wi-Fi status before choosing a transport", () => {
    useGlassesStore.getState().setGlassesInfo({hotspotOtaVersion: 1})

    expect(() => otaInstallCoordinator.prepare(checkResult())).toThrow("Wi-Fi status is not available")
  })

  it("selects hotspot when glasses have no Wi-Fi and advertise the capability", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })

    expect(otaInstallCoordinator.prepare(checkResult())).toBe("hotspot")
  })

  it("keeps unsupported glasses on the existing Wi-Fi requirement", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 0,
      wifi: {state: "disconnected"},
    })

    expect(() => otaInstallCoordinator.prepare(checkResult())).toThrow("require Wi-Fi")
  })

  it("rejects unknown future hotspot OTA protocol versions", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 2,
      wifi: {state: "disconnected"},
    })

    expect(() => otaInstallCoordinator.prepare(checkResult())).toThrow("require Wi-Fi")
  })

  it("uses the existing Wi-Fi transport when glasses Wi-Fi is connected", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "connected", ssid: "office"},
    })

    expect(otaInstallCoordinator.prepare(checkResult())).toBe("wifi")
  })

  it("sends one hotspot ota_start and only queries status across an ASG SID change", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    otaInstallCoordinator.prepare(checkResult())

    otaInstallCoordinator.attach()
    await flushNativeStartPromise()

    expect(mockHotspotPrepare).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledWith("http://192.168.43.2:8791/version.json")

    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({sessionId: "hotpot1", totalSteps: 3, stepPercent: 20, overallPercent: 4}))
    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "old", sid: "new"})

    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("fails a phone preflight once without entering ota_start retry logic", async () => {
    mockHotspotPrepare.mockRejectedValueOnce({code: "artifact_verify_failed"})
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    otaInstallCoordinator.prepare(checkResult())

    otaInstallCoordinator.attach()
    await flushNativeStartPromise()
    await flushNativeStartPromise()

    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.hotspotArtifactVerifyFailed)
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)
    expect(mockHotspotPrepare).toHaveBeenCalledTimes(1)
  })
})

describe("OtaInstallCoordinator initial-mount arbitration", () => {
  it("attach with connected + no session sends ota_start and arms the global timeout once", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
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
    // The acknowledged native request never re-sent.
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("attach while disconnected sends nothing", () => {
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("disconnected")
  })
})

describe("OtaInstallCoordinator ota_start request ownership", () => {
  it("keeps exactly one ota_start while the native request is pending", async () => {
    setGlassesConnected()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    rejectStart(new Error("native timeout"))
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
  })

  it("serializes rejected native attempts and fails only after MAX_RETRIES ended requests", async () => {
    setGlassesConnected()
    bluetoothSdkMock.startOtaUpdate.mockRejectedValue(new Error("native timeout"))
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(MAX_RETRIES)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.sendOtaStartFailed)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
  })

  it("does not retry or fail when ota_start times out after BES completion activity", async () => {
    setGlassesConnected()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()

    useGlassesStore.getState().setOtaStatus(
      inProgressStatus({
        stepType: "bes",
        phase: "install",
        status: "step_complete",
        stepPercent: 100,
        overallPercent: 100,
      }),
    )
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")

    rejectStart(new Error("OTA start command timed out waiting for glasses response."))
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
  })

  it("defers a rejected start while disconnected and retries only after reconnect reconciliation is silent", async () => {
    setGlassesConnected()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    rejectStart(new Error("native request failed during disconnect"))
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    setGlassesConnected()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS - 1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
  })

  it("preserves an active session reported while reconciling a disconnected rejected start", async () => {
    setGlassesConnected()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    rejectStart(new Error("native request failed during disconnect"))
    await flushNativeStartPromise()

    setGlassesConnected()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 1, overallPercent: 1}))
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS * 2)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")
  })

  it("cancels a scheduled start retry on disconnect so reconnect remains query-first", async () => {
    setGlassesConnected()
    bluetoothSdkMock.startOtaUpdate.mockRejectedValueOnce(new Error("native request failed"))
    otaInstallCoordinator.attach()
    await flushNativeStartPromise()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS - RETRY_INTERVAL_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
  })

  it("adopts a pending request on Retry and never queues a second ota_start after its ack", async () => {
    setGlassesConnected()
    let resolveFirst!: () => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve
        }),
    )
    otaInstallCoordinator.attach()

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")

    otaInstallCoordinator.retry()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")

    // Both public delivery surfaces refer to the same owned request. Neither
    // the listener event nor the correlated promise may create another start.
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    resolveFirst()
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * MAX_RETRIES)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("starts a fresh attempt after an authoritative failure and resets the 0%-stuck watchdog", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    await flushNativeStartPromise()

    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 40, overallPercent: 40}))
    useGlassesStore.getState().setOtaStatus(inProgressStatus({status: "failed", stepPercent: 40, overallPercent: 40}))
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")

    otaInstallCoordinator.retry()
    await flushNativeStartPromise()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
  })
})

describe("OtaInstallCoordinator query-status arbitration with an existing session", () => {
  it("sends ota_query_status; an idle reply does NOT cancel the fallback, so ota_start fires after QUERY_REPLY_TIMEOUT_MS", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 10, overallPercent: 10}))
    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
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
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    // The active session replies: still in progress.
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 12, overallPercent: 12}))
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS * 2)

    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })

  it("does not create a unified ota_start when reconciliation gets no authoritative reply", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 10, overallPercent: 10}))
    otaInstallCoordinator.attach()

    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS)

    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })
})

describe("OtaInstallCoordinator version-change detour retry gate", () => {
  it("retry during a latched detour re-enters the wait without sending ota_start", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaUpdateAvailable({
      updateAvailable: true,
      isDowngrade: true,
      versionCode: 49000000,
    } as never)
    otaInstallCoordinator.attach()
    expect(otaInstallCoordinator.snapshot().isVersionChange).toBe(true)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    // Ack + apk/install status latch the detour: recovery now owns the transaction.
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 100}))
    expect(otaInstallCoordinator.snapshot().versionChangePhase).not.toBeNull()

    // Retry must NOT re-drive the glasses (a second ota_start would start a
    // parallel install and a second handoff would REPLACE the live transaction);
    // it only clears the surfaced error and re-enters the reconcile wait.
    otaInstallCoordinator.retry()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 3)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it.each(["downgrade_handoff_refused", "downgrade_handoff_failed", "downgrade_transaction_stalled"])(
    "non-ownership error %s releases the latch so retry can re-drive",
    async (errorCode) => {
      setGlassesConnected()
      useGlassesStore.getState().setOtaUpdateAvailable({
        updateAvailable: true,
        isDowngrade: true,
        versionCode: 49000000,
      } as never)
      otaInstallCoordinator.attach()
      GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
      useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 100}))
      expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

      await flushNativeStartPromise()

      useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", status: "failed", error: errorCode}))
      expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
      otaInstallCoordinator.retry()
      expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
    },
  )

  it("a generic failure during a latched detour does NOT release the latch (accepted-but-slow)", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaUpdateAvailable({
      updateAvailable: true,
      isDowngrade: true,
      versionCode: 49000000,
    } as never)
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 100}))
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    // Some other failure (not a non-ownership code): the transaction may well be alive and
    // own the staged artifact — retry must stay in reconcile mode, not re-drive.
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({phase: "install", status: "failed", error: "install_failed"}))
    otaInstallCoordinator.retry()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("backstop: a direct (ungated) send during a latched detour is refused and logged", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaUpdateAvailable({
      updateAvailable: true,
      isDowngrade: true,
      versionCode: 49000000,
    } as never)
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 100}))
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    // Simulate a FUTURE entry point that forgot its site gate: call the sender directly.
    // The invariant backstop must refuse the send and log loudly (it firing in production
    // means a missed site gate exists — the failure degrades to cosmetic, not corrupting).
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    await (
      otaInstallCoordinator as unknown as {sendOtaStartWithWatchdogs: () => Promise<void>}
    ).sendOtaStartWithWatchdogs()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("BACKSTOP"))
    errorSpy.mockRestore()
  })

  it("retry outside a detour reconciles an acknowledged start without re-sending ota_start", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    await flushNativeStartPromise()
    otaInstallCoordinator.retry()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
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
    bluetoothSdkMock.queryOtaStatus.mockClear()

    GlobalEventEmitter.emit("mtk_update_complete", {message: "done", timestamp: Date.now()})

    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(useGlassesStore.getState().mtkUpdatedThisSession).toBe(true)
  })
})

describe("OtaInstallCoordinator finish()", () => {
  it("does not resolve until hotspot transport teardown finishes", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      hotspotOtaVersion: 1,
      wifi: {state: "disconnected"},
    })
    otaInstallCoordinator.prepare(checkResult())
    let resolveTeardown!: () => void
    mockHotspotTeardown.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveTeardown = resolve
        }),
    )

    let finished = false
    const finishPromise = otaInstallCoordinator.finish().then(() => {
      finished = true
    })
    await Promise.resolve()

    expect(mockHotspotTeardown).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)

    resolveTeardown()
    await finishPromise
    expect(finished).toBe(true)
  })

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

    expect(useGlassesStore.getState().buildNumber).toBe("40")
  })
})

describe("OtaInstallCoordinator detach()", () => {
  it("keeps a native ota_start single-flight across detach and re-attach", async () => {
    setGlassesConnected()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    otaInstallCoordinator.detach()
    otaInstallCoordinator.attach()

    // The screen remounted while native still owns the first request. Joining
    // that request must not open a concurrent ota_start in the bridge.
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")

    rejectStart(new Error("native timeout"))
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(2)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
  })

  it("after a failure resets session state so a re-attach starts clean", async () => {
    setGlassesConnected()
    bluetoothSdkMock.startOtaUpdate.mockRejectedValue(new Error("native timeout"))
    otaInstallCoordinator.attach()
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * (MAX_RETRIES - 1))
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")

    otaInstallCoordinator.detach()
    otaInstallCoordinator.attach()

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
  })

  it("re-arms the 0%-stuck watchdog when a remount adopts the native request", async () => {
    setGlassesConnected()
    let resolveStart!: () => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve
        }),
    )
    otaInstallCoordinator.attach()

    otaInstallCoordinator.detach()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)

    resolveStart()
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
  })

  it("re-arms the global timeout when a remount adopts the native request", async () => {
    setGlassesConnected()
    let resolveStart!: () => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStart = resolve
        }),
    )
    otaInstallCoordinator.attach()

    otaInstallCoordinator.detach()
    otaInstallCoordinator.attach()
    resolveStart()
    await flushNativeStartPromise()

    // Steadily advancing progress keeps every per-step watchdog quiet; only the
    // re-armed session cap can fail this adopted request.
    for (let minute = 1; minute * 60_000 <= GLOBAL_OTA_TIMEOUT_MS; minute++) {
      useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: minute, overallPercent: minute}))
      await jest.advanceTimersByTimeAsync(60_000)
    }

    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.globalTimeout)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
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

// --- WP 8C: old-build (< 37) compatibility, ported from mobile/src/app/ota/progress-legacy.tsx ---

describe("OtaInstallCoordinator legacy ota_progress normalization (WP 8C-a)", () => {
  it("renders legacy download progress as updating from the unified snapshot", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: 40, currentUpdate: "apk"})

    const snap = otaInstallCoordinator.snapshot()
    expect(snap.displayState).toBe("updating")
    expect(snap.otaStatus?.sessionId).toBe("")
    expect(snap.otaProgress?.progress).toBe(40)
  })

  it("legacy apk download FINISHED (mapped to status complete) is NOT terminal", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: 80, currentUpdate: "apk"})

    emitLegacyOtaProgress({stage: "download", status: "FINISHED", progress: 100, currentUpdate: "apk"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")
  })

  it("legacy bes download FINISHED is not BES-terminal; bes install FINISHED is", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    emitLegacyOtaProgress({stage: "download", status: "FINISHED", progress: 100, currentUpdate: "bes"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 50, currentUpdate: "bes"})
    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "bes"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
  })

  it("glasses_session_changed queries status without restarting a silent unified session", async () => {
    // The BES keeps the BLE link alive across the asg restart, so no physical
    // connect edge fires; the sid change is the only restart signal.
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 0, overallPercent: 100}))
    bluetoothSdkMock.queryOtaStatus.mockClear()
    bluetoothSdkMock.startOtaUpdate.mockClear()

    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "", sid: "abcd1234"})
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    // No authoritative reply is ambiguous: preserve the accepted unified session.
    useGlassesStore.getState().setOtaStatus(null)
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })

  it("swallows a concurrent status-query rejection after an ASG session restart", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 0, overallPercent: 100}))
    bluetoothSdkMock.queryOtaStatus.mockClear().mockRejectedValueOnce(new Error("request_in_flight"))

    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "old", sid: "new"})
    await jest.advanceTimersByTimeAsync(0)

    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
  })

  it("glasses_session_changed after APK completion queries the ASG-owned session without sending ota_start", async () => {
    // The ASG persists and auto-resumes a unified multi-step session after its APK
    // process restart. The phone observes that session; it must not start a second
    // version-check pipeline in parallel.
    setGlassesConnected()
    useGlassesStore
      .getState()
      .setOtaStatus(
        inProgressStatus({stepType: "apk", status: "step_complete", totalSteps: 2, currentStep: 1, stepPercent: 100}),
      )
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    bluetoothSdkMock.startOtaUpdate.mockClear()

    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "old0", sid: "new1"})
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS + 1000)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })

  it("glasses_session_changed after APK completion restarts only when the ASG reports that its session was lost", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    // APK step finished as part of a 2-step session, but the restarted ASG replies
    // idle because its persisted session was lost. The normal query fallback may
    // then restart OTA from the manifest.
    useGlassesStore
      .getState()
      .setOtaStatus(
        inProgressStatus({stepType: "apk", status: "step_complete", totalSteps: 2, currentStep: 1, stepPercent: 100}),
      )
    bluetoothSdkMock.startOtaUpdate.mockClear()

    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "old0", sid: "new1"})
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
    useGlassesStore.getState().setOtaStatus(idleStatus())
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("legacy bes install FINISHED then disconnect/reconnect edge completes", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 50, currentUpdate: "bes"})
    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "bes"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    setLegacyGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("keeps the pre-37 BES install disconnect fallback when FINISHED is lost", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 50, currentUpdate: "bes"})

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    setLegacyGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("legacy mtk install FINISHED completes and marks MTK updated this session", () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 30, currentUpdate: "mtk"})
    expect(useGlassesStore.getState().mtkUpdatedThisSession).toBe(false)

    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "mtk"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(useGlassesStore.getState().mtkUpdatedThisSession).toBe(true)
  })
})

describe("OtaInstallCoordinator legacy query-status fallback (WP 8C-b)", () => {
  it("attach with a stale legacy-shaped session sends ota_start immediately (legacy screens never queried)", () => {
    setLegacyGlassesConnected()
    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: 50, currentUpdate: "apk"})

    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
  })

  it("reconnect query ignored by old glasses: stale legacy events do NOT suppress the ota_start fallback", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: 50, currentUpdate: "apk"})
    bluetoothSdkMock.startOtaUpdate.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setLegacyGlassesConnected()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    // Old builds ignore ota_query_status: nothing new arrives. The pre-query
    // legacy-shaped otaStatus/otaProgress must not count as a reply.
    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS)
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
  })

  it("reconnect query with a stale unified-session status keeps the fallback suppressed (>= 37 unchanged)", async () => {
    setGlassesConnected()
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 10, overallPercent: 10}))
    otaInstallCoordinator.attach()
    bluetoothSdkMock.startOtaUpdate.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(2)

    await jest.advanceTimersByTimeAsync(QUERY_REPLY_TIMEOUT_MS * 2)
    expect(bluetoothSdkMock.startOtaUpdate).not.toHaveBeenCalled()
  })
})

describe("OtaInstallCoordinator BES reboot recovery", () => {
  function seedBesUpdate(besVersion?: string) {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 39,
      versionName: "39.0",
      updates: ["apk", "bes"],
      totalSize: 0,
      ...(besVersion ? {besVersion} : {}),
    })
  }

  function emitUnifiedBesSuccess() {
    useGlassesStore.getState().setOtaStatus(
      inProgressStatus({
        sessionId: "modern-after-apk",
        totalSteps: 2,
        currentStep: 2,
        stepType: "bes",
        phase: "install",
        stepPercent: 100,
        overallPercent: 100,
        status: "step_complete",
      }),
    )
  }

  it("keeps the day-one legacy policy sticky after ASG upgrades and completes the BES reboot edge", () => {
    setLegacyGlassesConnected("27")
    seedBesUpdate()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    // The same mounted flow has now upgraded ASG and receives unified-shaped
    // events. The old split route would still be progress-legacy.tsx.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "39"})
    emitUnifiedBesSuccess()
    bluetoothSdkMock.queryOtaStatus.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()
  })

  it("does not reuse the APK reconnect edge to complete BES before its own reboot", () => {
    setGlassesConnected()
    seedBesUpdate()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore
      .getState()
      .setOtaStatus(
        inProgressStatus({stepType: "apk", phase: "install", status: "step_complete", totalSteps: 2, currentStep: 1}),
      )

    // APK restarts the ASG process without a physical BLE disconnect. This is
    // a session reconnect, but it is not the later BES power-cycle edge.
    GlobalEventEmitter.emit("glasses_session_changed", {previousSid: "apk-old", sid: "apk-new"})
    emitUnifiedBesSuccess()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(true)

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("completes immediately on the reboot edge without gating on BES version metadata", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
      besFirmwareVersion: "17.26.1.1",
    })
    seedBesUpdate("17.26.07.09")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitUnifiedBesSuccess()
    bluetoothSdkMock.queryOtaStatus.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    // Old ASG builds either retain the stale pre-update value or publish an
    // empty BES version after reboot. Neither is a reliable completion gate.
    useGlassesStore.getState().setGlassesInfo({besFirmwareVersion: ""})
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(true)
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(BES_CONTINUE_LOCKOUT_MS)
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(false)
  })

  it("does not fail a completed reboot edge when a stale non-empty BES version remains", async () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
      besFirmwareVersion: "17.26.1.1",
    })
    seedBesUpdate("17.26.07.09")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitUnifiedBesSuccess()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(PROGRESS_TIMEOUT_MS * 2)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("retry clears stale BES reboot latches before a new install attempt", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
      besFirmwareVersion: "17.26.1.1",
    })
    seedBesUpdate("17.26.07.09")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitUnifiedBesSuccess()

    // An explicit failure supersedes the terminal event before the expected
    // reboot edge. Retrying must clear the success/reboot latch.
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({stepType: "bes", phase: "install", status: "failed", error: "apply_failed"}))
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
    otaInstallCoordinator.retry()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")

    bluetoothSdkMock.queryOtaStatus.mockClear()
    bluetoothSdkMock.requestVersionInfo.mockClear()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()

    // This link edge happened before the retried attempt received BES success,
    // so it follows ordinary reconnect arbitration.
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()
  })

  it("keeps completed reboot recovery complete across later link noise", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
      besFirmwareVersion: "17.26.1.1",
    })
    seedBesUpdate("17.26.7.9")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitUnifiedBesSuccess()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    useGlassesStore.getState().setGlassesInfo({besFirmwareVersion: "17.26.7.9"})
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")

    // Later link noise on the completed screen cannot reopen recovery or issue
    // another version request.
    bluetoothSdkMock.requestVersionInfo.mockClear()
    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()
  })

  it("does not treat rounded or raw 100% in-progress as the expected reboot", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
      besFirmwareVersion: "17.26.1.1",
    })
    seedBesUpdate("17.26.7.9")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(
      inProgressStatus({
        sessionId: "bes-before-reboot",
        stepType: "bes",
        phase: "install",
        // Native used to round raw 98-99 to this shape; raw update:100 has the
        // same nonterminal protocol meaning because CRC/apply happen afterward.
        stepPercent: 100,
        overallPercent: 100,
      }),
    )
    bluetoothSdkMock.queryOtaStatus.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    expect(bluetoothSdkMock.requestVersionInfo).not.toHaveBeenCalled()
  })

  it("does not authorize a modern BES reboot from stale legacy FINISHED progress", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "39",
    })
    seedBesUpdate("17.26.7.9")
    useGlassesStore.getState().setOtaStatus(
      inProgressStatus({
        sessionId: "modern-bes-in-progress",
        stepType: "bes",
        phase: "install",
        stepPercent: 95,
        overallPercent: 97,
      }),
    )
    // otaProgress is only a compatibility projection in a unified session. A
    // stale terminal value must not outrank the current nonterminal ota_status.
    useGlassesStore.getState().setOtaProgress({
      stage: "install",
      status: "FINISHED",
      progress: 100,
      bytesDownloaded: 0,
      totalBytes: 0,
      currentUpdate: "bes",
    })
    otaInstallCoordinator.attach()
    bluetoothSdkMock.queryOtaStatus.mockClear()

    useGlassesStore.getState().setGlassesInfo({connection: {state: "disconnected"}})
    setGlassesConnected()

    expect(otaInstallCoordinator.snapshot().displayState).not.toBe("complete")
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
  })
})

describe("OtaInstallCoordinator APK completion by build-number increase (WP 8C-c)", () => {
  function seedLegacyApkUpdateAvailable() {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 45,
      versionName: "45.0",
      updates: ["apk"],
      totalSize: 0,
    })
  }

  it("legacy apk session completes on build-number increase when no explicit status arrives", () => {
    setLegacyGlassesConnected("33")
    seedLegacyApkUpdateAvailable()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 80, currentUpdate: "apk"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    // Glasses reboot into the new build; the only signal is version_info.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})

    const snap = otaInstallCoordinator.snapshot()
    expect(snap.displayState).toBe("complete")
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()

    // finish() must clear the stale build number exactly like an explicit APK step.
    otaInstallCoordinator.finish()
    expect(useGlassesStore.getState().buildNumber).toBe("")
  })

  it("build-number increase recovers a legacy session even from a watchdog failure", async () => {
    setLegacyGlassesConnected("33")
    seedLegacyApkUpdateAvailable()
    bluetoothSdkMock.startOtaUpdate.mockRejectedValue(new Error("native timeout"))
    otaInstallCoordinator.attach()

    // Old-build request failures retry serially on the padded legacy interval.
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(LEGACY_RETRY_INTERVAL_MS * (MAX_RETRIES - 1))
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.sendOtaStartFailed)

    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})

    const snap = otaInstallCoordinator.snapshot()
    expect(snap.displayState).toBe("complete")
    expect(snap.errorMsg).toBe("")
  })

  it("does not retry when a late native rejection follows exact build-number completion", async () => {
    setLegacyGlassesConnected("33")
    seedLegacyApkUpdateAvailable()
    let rejectStart!: (reason: Error) => void
    bluetoothSdkMock.startOtaUpdate.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectStart = reject
        }),
    )
    otaInstallCoordinator.attach()

    // Legacy version_info is the only completion signal; no ota_start_ack or
    // ota_status/progress event arrives before the native promise rejects.
    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")

    rejectStart(new Error("late native timeout"))
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(LEGACY_RETRY_INTERVAL_MS * MAX_RETRIES)

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")
  })

  it("does not carry build-number completion proof into a fresh rejected attempt", async () => {
    setLegacyGlassesConnected("33")
    seedLegacyApkUpdateAvailable()
    otaInstallCoordinator.attach()
    await flushNativeStartPromise()

    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
    otaInstallCoordinator.finish()

    bluetoothSdkMock.startOtaUpdate.mockRejectedValue(new Error("fresh native rejection"))
    otaInstallCoordinator.retry()
    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
    await flushNativeStartPromise()
    await jest.advanceTimersByTimeAsync(LEGACY_RETRY_INTERVAL_MS)

    // One completed request plus the fresh request and its first serialized retry.
    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledTimes(3)
  })

  it("does not fire without an apk step in the selected update", () => {
    setLegacyGlassesConnected("33")
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 45,
      versionName: "45.0",
      updates: ["bes"],
      totalSize: 0,
    })
    otaInstallCoordinator.attach()

    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("starting")
  })

  it("unified multi-step session ignores build-number increase (>= 37 unchanged)", () => {
    useGlassesStore.getState().setGlassesInfo({connection: {state: "connected", fullyBooted: true}, buildNumber: "40"})
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 45,
      versionName: "45.0",
      updates: ["apk", "bes"],
      totalSize: 0,
    })
    otaInstallCoordinator.attach()
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({totalSteps: 2, stepType: "apk", phase: "install", status: "step_complete"}))

    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})

    // The unified session still has a BES step to run: not complete.
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")
  })
})

describe("OtaInstallCoordinator legacy manifest URL fallback (WP 8C-d)", () => {
  it("legacy build sends ota_start with the glasses-reported manifest URL (dev override ignored)", () => {
    useGlassesStore.getState().setGlassesInfo({
      connection: {state: "connected", fullyBooted: true},
      buildNumber: "33",
      otaVersionUrl: "https://glasses.example/version.json",
    })

    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledWith("https://glasses.example/version.json")
  })

  it("legacy build with no reported URL falls back to the prod manifest", () => {
    setLegacyGlassesConnected("33")

    otaInstallCoordinator.attach()

    expect(bluetoothSdkMock.startOtaUpdate).toHaveBeenCalledWith("https://ota.mentraglass.com/prod_live_version.json")
  })
})

describe("OtaInstallCoordinator legacy MTK install stall simulation (WP 8C-e)", () => {
  it("simulates display-only progress after a stall in the 45-55% zone, capped at 60, cleared by real progress", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 49, currentUpdate: "mtk"})
    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBeNull()

    await jest.advanceTimersByTimeAsync(LEGACY_MTK_STALL_DETECT_MS)
    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBe(51)

    await jest.advanceTimersByTimeAsync(LEGACY_MTK_SIM_TICK_MS)
    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBe(52)

    // Cap at 60 and stop ticking.
    await jest.advanceTimersByTimeAsync(LEGACY_MTK_SIM_TICK_MS * 20)
    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBe(60)

    // Real progress beyond the simulated value clears the simulation.
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 70, currentUpdate: "mtk"})
    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBeNull()
  })

  it("never simulates for unified (>= 37) MTK install sessions", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({stepType: "mtk", phase: "install", stepPercent: 49, overallPercent: 49}))

    await jest.advanceTimersByTimeAsync(LEGACY_MTK_STALL_DETECT_MS + LEGACY_MTK_SIM_TICK_MS)

    expect(otaInstallCoordinator.snapshot().mtkInstallStallSimulatedPercent).toBeNull()
  })

  it("simulation does not silence the padded MTK install stall watchdog", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 49, currentUpdate: "mtk"})

    await jest.advanceTimersByTimeAsync(MTK_INSTALL_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    const snap = otaInstallCoordinator.snapshot()
    expect(snap.errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
    expect(snap.displayState).toBe("failed")
  })
})

describe("OtaInstallCoordinator BES restart continue lockout (WP 8C-f)", () => {
  it("legacy BES restart holds the Continue button for the padded 35s", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 50, currentUpdate: "bes"})
    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "bes"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(true)

    await jest.advanceTimersByTimeAsync(BES_CONTINUE_LOCKOUT_MS)
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(true)

    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(false)
  })

  it("unified BES restart keeps the 15s lockout (>= 37 unchanged)", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({stepType: "bes", phase: "install", status: "step_complete", stepPercent: 100}))
    expect(otaInstallCoordinator.snapshot().displayState).toBe("restarting")
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(true)

    await jest.advanceTimersByTimeAsync(BES_CONTINUE_LOCKOUT_MS)
    expect(otaInstallCoordinator.snapshot().continueButtonDisabled).toBe(false)
  })
})

describe("OtaInstallCoordinator legacy padded watchdogs (WP 8C-g)", () => {
  it("legacy stuck-at-zero watchdog uses the padded duration", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    await jest.advanceTimersByTimeAsync(DOWNLOAD_STUCK_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
  })

  it("legacy progress-stall watchdog uses the padded duration", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: 10, currentUpdate: "apk"})

    await jest.advanceTimersByTimeAsync(PROGRESS_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.stalledOrStuck)
  })

  it("legacy global timeout uses the padded cap", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})

    // Steadily-advancing legacy progress keeps the per-step watchdogs quiet.
    let pct = 1
    for (let elapsed = 60_000; elapsed <= GLOBAL_OTA_TIMEOUT_MS; elapsed += 60_000) {
      emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: pct++, currentUpdate: "apk"})
      await jest.advanceTimersByTimeAsync(60_000)
    }
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe("")

    emitLegacyOtaProgress({stage: "download", status: "PROGRESS", progress: pct, currentUpdate: "apk"})
    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().errorMsg).toBe(OtaProgressMessages.globalTimeout)
  })

  it("legacy ping keepalive uses the padded interval", async () => {
    setLegacyGlassesConnected()
    otaInstallCoordinator.attach()
    expect(bluetoothSdkMock.ping).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.ping).toHaveBeenCalledTimes(1)

    await jest.advanceTimersByTimeAsync(LEGACY_EXTRA_TIMEOUT_MS)
    expect(bluetoothSdkMock.ping).toHaveBeenCalledTimes(2)
  })
})

describe("OtaInstallCoordinator apk install-phase status poll", () => {
  it("polls ota_query_status on each keepalive tick while an apk step is installing", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 0, overallPercent: 100}))
    bluetoothSdkMock.queryOtaStatus.mockClear()

    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(2)
  })

  it("keeps one poll in flight and swallows its rejection", async () => {
    // The native query pends up to 15s (longer than the 10s tick) and rejects a
    // concurrent call with request_in_flight; a slow glasses restart must not
    // stack queries or surface an unhandled rejection.
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 0, overallPercent: 100}))
    bluetoothSdkMock.queryOtaStatus.mockClear()
    let rejectPending!: (err: Error) => void
    bluetoothSdkMock.queryOtaStatus.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectPending = reject
        }),
    )

    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    // First query still pending: the next tick must not fire a concurrent one.
    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(1)

    // Rejection (e.g. request_timeout) is swallowed and polling resumes.
    rejectPending(new Error("request_timeout"))
    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalledTimes(2)
  })

  it("does not poll during the download phase", async () => {
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({stepPercent: 40, overallPercent: 40}))
    bluetoothSdkMock.queryOtaStatus.mockClear()

    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS * 3)
    expect(bluetoothSdkMock.queryOtaStatus).not.toHaveBeenCalled()
  })

  it("a polled complete reply lands the session on complete instead of the stall failure", async () => {
    // The incident shape (rep_01KY31HEMTSBSMK8DVMNXJ5XGG): the apk install starts,
    // the glasses process restarts, and no further push arrives. The poll's reply
    // must complete the session before the PROGRESS_TIMEOUT_MS stall watchdog fails it.
    setGlassesConnected()
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    useGlassesStore.getState().setOtaStatus(inProgressStatus({phase: "install", stepPercent: 0, overallPercent: 100}))

    await jest.advanceTimersByTimeAsync(PING_INTERVAL_MS)
    expect(bluetoothSdkMock.queryOtaStatus).toHaveBeenCalled()

    // Glasses answer the query from their persisted session: install complete.
    useGlassesStore
      .getState()
      .setOtaStatus(inProgressStatus({phase: "install", status: "complete", stepPercent: 100, overallPercent: 100}))

    await jest.advanceTimersByTimeAsync(PROGRESS_TIMEOUT_MS)
    const snap = otaInstallCoordinator.snapshot()
    expect(snap.errorMsg).toBe("")
    expect(snap.displayState).toBe("complete")
  })
})

describe("OtaInstallCoordinator legacy APK completion settle hold (WP 8C-g)", () => {
  it("holds the complete state for the 32s settle window after an in-flight apk install FINISHED", async () => {
    setLegacyGlassesConnected("33")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 90, currentUpdate: "apk"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "apk"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    await jest.advanceTimersByTimeAsync(LEGACY_APK_COMPLETION_SETTLE_MS - 1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    await jest.advanceTimersByTimeAsync(1)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("build-number increase during the settle hold completes immediately", async () => {
    setLegacyGlassesConnected("33")
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 45,
      versionName: "45.0",
      updates: ["apk"],
      totalSize: 0,
    })
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 90, currentUpdate: "apk"})
    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "apk"})
    expect(otaInstallCoordinator.snapshot().displayState).toBe("updating")

    useGlassesStore.getState().setGlassesInfo({buildNumber: "45"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("apk install FINISHED arriving without an observed in-flight install completes immediately (post-reboot signal)", () => {
    setLegacyGlassesConnected("33")
    otaInstallCoordinator.attach()

    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "apk"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })

  it("legacy install FINISHED after a watchdog failure overrides the failure (legacy last-write-wins)", async () => {
    setLegacyGlassesConnected("33")
    otaInstallCoordinator.attach()
    GlobalEventEmitter.emit("ota_start_ack", {timestamp: Date.now()})
    emitLegacyOtaProgress({stage: "install", status: "PROGRESS", progress: 40, currentUpdate: "apk"})
    await jest.advanceTimersByTimeAsync(PROGRESS_TIMEOUT_MS + LEGACY_EXTRA_TIMEOUT_MS)
    expect(otaInstallCoordinator.snapshot().displayState).toBe("failed")

    emitLegacyOtaProgress({stage: "install", status: "FINISHED", progress: 100, currentUpdate: "apk"})

    expect(otaInstallCoordinator.snapshot().displayState).toBe("complete")
  })
})
