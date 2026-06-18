// Exercises the real island OtaService by path (not via "@mentra/island", which jest
// mocks): emitted OTA BLE events must project into the island glasses store, which is
// the toolkit.ota read surface.
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

  it("projects ota_update_available into the store", () => {
    emitBluetoothSdkEvent("ota_update_available", {
      version_code: 42,
      version_name: "1.2.3",
      updates: ["apk"],
      total_size: 1000,
      cache_ready: true,
    })
    const info = useGlassesStore.getState().otaUpdateAvailable
    expect(info).toMatchObject({available: true, versionCode: 42, versionName: "1.2.3", cacheReady: true})
  })

  it("ignores ota_update_available when glasses are disconnected", () => {
    useGlassesStore.setState({connection: {state: "disconnected"}} as never)
    emitBluetoothSdkEvent("ota_update_available", {version_code: 1, version_name: "x", updates: [], total_size: 0})
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })

  it("projects ota_status into the store and clears the available flag on completion", () => {
    useGlassesStore.getState().setOtaUpdateAvailable({
      available: true,
      versionCode: 1,
      versionName: "x",
      updates: [],
      totalSize: 0,
      cacheReady: false,
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
    emitBluetoothSdkEvent("ota_update_available", {version_code: 9, version_name: "y", updates: [], total_size: 0})
    expect(useGlassesStore.getState().otaUpdateAvailable).toBeNull()
  })
})
