// Exercises the real island OtaService by path (not via "@mentra/engine", which jest
// mocks): emitted OTA BLE events must project into the island glasses store, which is
// the engine.ota read surface.
import {startOtaService, stopOtaService} from "../../modules/engine/src/services/OtaService"
import {ota} from "../../modules/engine/src/facades/ota"
import {useGlassesStore} from "../../modules/engine/src/stores/glasses"
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("OtaService projection", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
    useGlassesStore.getState().reset()
    useGlassesStore.setState({connection: {state: "connected", fullyBooted: true}} as never)
    startOtaService()
  })

  afterEach(() => {
    stopOtaService()
  })

  it("projects ota_status into the store and clears the available flag on completion", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 1,
      versionName: "x",
      updates: [],
      totalSize: 0,
    })
    emitBluetoothSdkEvent("ota_status", {
      session_id: "s1",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "install",
      step_percent: 100,
      overall_percent: 100,
      status: "complete",
    })
    expect(useGlassesStore.getState().otaStatus?.status).toBe("complete")
    // complete/failed clears the available flag (matches the prior MantleManager handler).
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })

  it("stops projecting after stopOtaService()", () => {
    stopOtaService()
    emitBluetoothSdkEvent("ota_status", {
      session_id: "s1",
      total_steps: 1,
      current_step: 1,
      step_type: "apk",
      phase: "install",
      step_percent: 50,
      overall_percent: 50,
      status: "in_progress",
    })
    expect(useGlassesStore.getState().otaStatus).toBeNull()
  })

  it("snapshot() projects the OTA read model", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 1,
      versionName: "x",
      updates: ["apk"],
      totalSize: 123,
    })
    useGlassesStore.getState().setOtaInProgress(true)

    expect(ota.snapshot()).toEqual(
      expect.objectContaining({
        updateAvailable: expect.objectContaining({versionName: "x"}),
        status: null,
        legacyProgress: null,
        inProgress: true,
        mtkUpdatedThisSession: false,
      }),
    )
  })
})
