// Exercises the real island OtaService by path (not via "@mentra/island", which jest
// mocks): emitted OTA BLE events must project into the island glasses store, which is
// the toolkit.ota read surface.
//
// NOTE: the push-based `ota_update_available` BLE event was removed in the OTA-simplify
// pass — availability is now resolved by the host OTA check flow (checkForOtaUpdate +
// setOtaUpdateAvailable), so OtaService only projects status/progress here.
import {startOtaService, stopOtaService} from "../../modules/island/src/services/OtaService"
import {useGlassesStore} from "../../modules/island/src/stores/glasses"
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
      status: "downloading",
    })
    expect(useGlassesStore.getState().otaStatus).toBeNull()
  })
})
