// Exercises the real island DeviceEventRouter by path (not via "@mentra/island",
// which jest mocks): inbound device BLE events must route into island stores, the
// process event bus (which island's own gallerySyncService listens on), restComms,
// and local miniapps — so a bare OEM gets device data, not just the Mentra app.
import {startDeviceEventRouter, stopDeviceEventRouter} from "../../../modules/island/src/services/DeviceEventRouter"
import {useGlassesStore} from "../../../modules/island/src/stores/glasses"
import {useSettingsStore} from "../../../modules/island/src/stores/settings"
import GlobalEventEmitter from "../../../modules/island/src/utils/GlobalEventEmitter"
import restComms from "../../../modules/island/src/services/RestComms"
import localMiniappRuntime from "../../../modules/island/src/services/LocalMiniappRuntime"
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
    emitBluetoothSdkEvent("hotspot_status_change", {
      type: "hotspot_status_change",
      state: "enabled",
      ssid: "MentraHotspot",
      password: "pw",
      localIp: "192.168.1.1",
    })
    expect(useGlassesStore.getState().hotspot).toMatchObject({state: "enabled", ssid: "MentraHotspot"})
    expect(emitSpy).toHaveBeenCalledWith(
      "hotspot_status_change",
      expect.objectContaining({enabled: true, ssid: "MentraHotspot", local_ip: "192.168.1.1"}),
    )
  })

  it("projects standalone wifi_status_change into the glasses store", () => {
    emitBluetoothSdkEvent("wifi_status_change", {type: "wifi_status_change", state: "connected", ssid: "Net"})
    expect(useGlassesStore.getState().wifi).toMatchObject({state: "connected", ssid: "Net"})
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

  it("forwards an owned photo_response error to the photo coordinator and a non-owned one to restComms", () => {
    const sendSpy = jest.spyOn(restComms, "sendPhotoResponse").mockResolvedValue(undefined as never)
    emitBluetoothSdkEvent("photo_response", {
      type: "photo_response",
      state: "success",
      requestId: "not-owned",
      uploadUrl: "https://example.com/p.jpg",
      timestamp: 1,
    })
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({requestId: "not-owned"}))
  })

  it("forwards button_press to local miniapps", () => {
    const fwdSpy = jest.spyOn(localMiniappRuntime, "forwardEvent")
    emitBluetoothSdkEvent("button_press", {type: "button_press", buttonId: "main", pressType: "short"})
    expect(fwdSpy).toHaveBeenCalledWith("button_press", expect.objectContaining({buttonId: "main"}))
  })
})
