import {useGlassesStore} from "@/stores/glasses"
import {
  legacyOtaProgressFromOtaStatusEvent,
  normalizeOtaStatusEvent,
  otaStatusFromNormalized,
} from "@/utils/otaLegacyMapping"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"

/**
 * These tests verify the ota_status handler logic that MantleManager registers.
 * Since MantleManager.init() has heavy side effects (API calls, migrations),
 * we test the handler logic directly — the same mapping as MantleManager's ota_status listener.
 */
function handleOtaStatusEvent(event: any) {
  const normalized = normalizeOtaStatusEvent(event as Record<string, unknown>)
  const status = otaStatusFromNormalized(normalized)
  useGlassesStore.getState().setOtaStatus(status)
  GlobalEventEmitter.emit("ota_status", status)
  useGlassesStore.getState().setOtaProgress(legacyOtaProgressFromOtaStatusEvent(normalized))

  if (status.status === "complete" || status.status === "failed") {
    useGlassesStore.getState().setOtaUpdateAvailable(null)
  }
}

beforeEach(() => {
  useGlassesStore.getState().reset()
  GlobalEventEmitter.removeAllListeners()
})

describe("MantleManager ota_status handler", () => {
  it("maps camelCase-only native event to OtaStatus", () => {
    const emitted: any[] = []
    GlobalEventEmitter.on("ota_status", (s: any) => emitted.push(s))

    handleOtaStatusEvent({
      sessionId: "cam-1",
      totalSteps: 1,
      currentStep: 1,
      stepType: "apk",
      phase: "download",
      stepPercent: 40,
      overallPercent: 40,
      status: "in_progress",
    })

    const stored = useGlassesStore.getState().otaStatus
    expect(stored?.sessionId).toBe("cam-1")
    expect(stored?.overallPercent).toBe(40)
  })

  it("maps snake_case event to camelCase OtaStatus", () => {
    const emitted: any[] = []
    GlobalEventEmitter.on("ota_status", (s: any) => emitted.push(s))

    handleOtaStatusEvent({
      session_id: "sess-001",
      total_steps: 3,
      current_step: 2,
      step_type: "mtk",
      phase: "install",
      step_percent: 45,
      overall_percent: 60,
      status: "in_progress",
      error_message: undefined,
    })

    const stored = useGlassesStore.getState().otaStatus
    expect(stored).not.toBeNull()
    expect(stored?.sessionId).toBe("sess-001")
    expect(stored?.totalSteps).toBe(3)
    expect(stored?.currentStep).toBe(2)
    expect(stored?.stepType).toBe("mtk")
    expect(stored?.phase).toBe("install")
    expect(stored?.stepPercent).toBe(45)
    expect(stored?.overallPercent).toBe(60)
    expect(stored?.status).toBe("in_progress")
    expect(stored?.error).toBeUndefined()
  })

  it("maps error_message to error field", () => {
    handleOtaStatusEvent({
      session_id: "sess-fail",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 0,
      overall_percent: 0,
      status: "failed",
      error_message: "no_internet",
    })

    const stored = useGlassesStore.getState().otaStatus
    expect(stored?.error).toBe("no_internet")
    expect(stored?.status).toBe("failed")
  })

  it("emits via GlobalEventEmitter", () => {
    const emitted: any[] = []
    GlobalEventEmitter.on("ota_status", (s: any) => emitted.push(s))

    handleOtaStatusEvent({
      session_id: "sess-emit",
      total_steps: 1,
      current_step: 1,
      step_type: "bes",
      phase: "install",
      step_percent: 100,
      overall_percent: 100,
      status: "complete",
      error_message: undefined,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0].sessionId).toBe("sess-emit")
    expect(emitted[0].status).toBe("complete")
  })

  it("clears otaUpdateAvailable on complete", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 100,
      versionName: "1.0",
      updates: ["apk"],
      totalSize: 5000000,
    })
    expect(useGlassesStore.getState().otaUpdateAvailable).not.toBeNull()

    handleOtaStatusEvent({
      session_id: "sess-done",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "install",
      step_percent: 100,
      overall_percent: 100,
      status: "complete",
      error_message: undefined,
    })

    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })

  it("clears otaUpdateAvailable on failed", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 100,
      versionName: "1.0",
      updates: ["apk"],
      totalSize: 5000000,
    })

    handleOtaStatusEvent({
      session_id: "sess-fail2",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 30,
      overall_percent: 30,
      status: "failed",
      error_message: "download_failed",
    })

    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })

  it("does NOT clear otaUpdateAvailable on in_progress", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 100,
      versionName: "1.0",
      updates: ["apk"],
      totalSize: 5000000,
    })

    handleOtaStatusEvent({
      session_id: "sess-prog",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 25,
      overall_percent: 25,
      status: "in_progress",
      error_message: undefined,
    })

    expect(useGlassesStore.getState().otaUpdateAvailable).not.toBeNull()
  })
})

describe("legacy otaProgress derived from ota_status", () => {
  it("sets otaProgress percent from overall_percent", () => {
    handleOtaStatusEvent({
      session_id: "sess-p",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "download",
      step_percent: 50,
      overall_percent: 50,
      status: "in_progress",
      error_message: undefined,
    })

    expect(useGlassesStore.getState().otaProgress?.progress).toBe(50)
    expect(useGlassesStore.getState().otaProgress?.stage).toBe("download")
  })

  it("maps step_complete (K900 sr_adota BES success) to legacy FINISHED", () => {
    handleOtaStatusEvent({
      session_id: "bes-1",
      total_steps: 1,
      current_step: 1,
      step_type: "bes",
      phase: "install",
      step_percent: 100,
      overall_percent: 100,
      status: "step_complete",
      error_message: undefined,
    })

    const p = useGlassesStore.getState().otaProgress
    expect(p?.status).toBe("FINISHED")
    expect(p?.stage).toBe("install")
    expect(p?.currentUpdate).toBe("bes")
    expect(p?.progress).toBe(100)
  })
})
