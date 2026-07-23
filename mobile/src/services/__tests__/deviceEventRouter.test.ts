// Exercises the real island DeviceEventRouter by path (not via "@mentra/engine",
// which jest mocks): inbound device BLE events must route into island stores, the
// process event bus (which island's own gallerySyncService listens on), the photo
// coordinator, and local miniapps — so a bare OEM gets device data, not just the
// Mentra app.
import {startDeviceEventRouter, stopDeviceEventRouter} from "../../../modules/engine/src/services/DeviceEventRouter"
import {useGlassesStore} from "../../../modules/engine/src/stores/glasses"
import {useSettingsStore} from "../../../modules/engine/src/stores/settings"
import GlobalEventEmitter from "../../../modules/engine/src/utils/GlobalEventEmitter"
import {phonePhotoCoordinator} from "../../../modules/engine/src/services/PhonePhotoCoordinator"
import localMiniappRuntime from "../../../modules/engine/src/services/LocalMiniappRuntime"
import localSttFallbackCoordinator from "../../../modules/engine/src/services/LocalSttFallbackCoordinator"
import {asgCameraApi} from "../../../modules/engine/src/services/asg/asgCameraApi"
import {emitBluetoothSdkEvent, resetBluetoothSdkMock} from "@/test-utils/mockBluetoothSdk"

describe("DeviceEventRouter", () => {
  beforeEach(() => {
    resetBluetoothSdkMock()
    useGlassesStore.getState().reset()
    jest.restoreAllMocks()
    startDeviceEventRouter()
  })

  afterEach(() => {
    stopDeviceEventRouter()
  })

  it("projects hotspot_status_change into the store AND onto the event bus (the gallery-sync feed)", () => {
    const emitSpy = jest.spyOn(GlobalEventEmitter, "emit")
    const setServerSpy = jest.spyOn(asgCameraApi, "setServer")
    emitBluetoothSdkEvent("hotspot_status_change", {
      type: "hotspot_status_change",
      state: "enabled",
      ssid: "MentraHotspot",
      password: "pw",
      localIp: "192.168.1.1",
    })
    expect(useGlassesStore.getState().hotspot).toMatchObject({state: "enabled", ssid: "MentraHotspot"})
    expect(setServerSpy).toHaveBeenCalledWith("192.168.1.1", 8089)
    expect(emitSpy).toHaveBeenCalledWith(
      "hotspot_status_change",
      expect.objectContaining({enabled: true, ssid: "MentraHotspot", local_ip: "192.168.1.1"}),
    )
  })

  it("projects standalone wifi_status_change into the glasses store", () => {
    emitBluetoothSdkEvent("wifi_status_change", {type: "wifi_status_change", state: "connected", ssid: "Net"})
    expect(useGlassesStore.getState().wifi).toMatchObject({state: "connected", ssid: "Net"})
  })

  it("projects battery_status into the store and local miniapp stream", () => {
    const fwdSpy = jest.spyOn(localMiniappRuntime, "forwardEvent")
    emitBluetoothSdkEvent("battery_status", {
      type: "battery_status",
      level: 88,
      charging: true,
      timestamp: 123456,
    })

    expect(useGlassesStore.getState()).toEqual(
      expect.objectContaining({
        batteryLevel: 88,
        charging: true,
      }),
    )
    expect(fwdSpy).toHaveBeenCalledWith(
      "glasses_battery_update",
      expect.objectContaining({level: 88, charging: true, timestamp: 123456}),
    )
  })

  it("bridges gallery_status onto the event bus", () => {
    const emitSpy = jest.spyOn(GlobalEventEmitter, "emit")
    emitBluetoothSdkEvent("gallery_status", {
      type: "gallery_status",
      photos: 3,
      videos: 1,
      total: 4,
      hasContent: true,
      cameraBusy: false,
    })
    expect(emitSpy).toHaveBeenCalledWith(
      "gallery_status",
      expect.objectContaining({photos: 3, videos: 1, total: 4, has_content: true}),
    )
  })

  it("persists hardware-originated save_setting into the settings store", async () => {
    const setSpy = jest.spyOn(useSettingsStore.getState(), "setSetting")
    emitBluetoothSdkEvent("save_setting", {type: "save_setting", key: "brightness", value: 42})
    expect(setSpy).toHaveBeenCalledWith("brightness", 42)
  })

  it("routes an owned photo_response error to the photo coordinator and drops non-owned ones", () => {
    const errorSpy = jest.spyOn(phonePhotoCoordinator, "handlePhotoError").mockImplementation(() => {})
    jest.spyOn(phonePhotoCoordinator, "owns").mockImplementation((requestId: string) => requestId === "owned")

    // Non-owned responses used to relay to the Cloud V1 photo pipeline; they now drop.
    emitBluetoothSdkEvent("photo_response", {
      type: "photo_response",
      state: "success",
      requestId: "not-owned",
      uploadUrl: "https://example.com/p.jpg",
      timestamp: 1,
    })
    expect(errorSpy).not.toHaveBeenCalled()

    emitBluetoothSdkEvent("photo_response", {
      type: "photo_response",
      state: "error",
      requestId: "owned",
      errorCode: "GLASSES_ERROR",
      errorMessage: "boom",
      timestamp: 2,
    })
    expect(errorSpy).toHaveBeenCalledWith("owned", "GLASSES_ERROR", "boom")
  })

  it("forwards button_press to local miniapps", () => {
    const fwdSpy = jest.spyOn(localMiniappRuntime, "forwardEvent")
    emitBluetoothSdkEvent("button_press", {type: "button_press", buttonId: "main", pressType: "short"})
    expect(fwdSpy).toHaveBeenCalledWith("button_press", expect.objectContaining({buttonId: "main"}))
  })

  it("forwards local_transcription to local miniapps (transcription:<lang>) when STT fallback is active", () => {
    jest.spyOn(localSttFallbackCoordinator, "isActive").mockReturnValue(true)
    const fwdSpy = jest.spyOn(localMiniappRuntime, "forwardEvent")
    fwdSpy.mockClear()
    emitBluetoothSdkEvent("local_transcription", {
      type: "local_transcription",
      text: "hello",
      isFinal: true,
      transcribeLanguage: "fr-FR",
    })
    expect(fwdSpy).toHaveBeenCalledWith("transcription:fr-FR", expect.objectContaining({text: "hello"}), "local")
  })

  it("drops local_transcription when STT fallback is inactive (cloud STT owns delivery)", () => {
    jest.spyOn(localSttFallbackCoordinator, "isActive").mockReturnValue(false)
    const fwdSpy = jest.spyOn(localMiniappRuntime, "forwardEvent")
    fwdSpy.mockClear()
    emitBluetoothSdkEvent("local_transcription", {
      type: "local_transcription",
      text: "hi",
      isFinal: true,
      transcribeLanguage: "en-US",
    })
    expect(fwdSpy).not.toHaveBeenCalledWith(expect.stringContaining("transcription:"), expect.anything())
  })
})
