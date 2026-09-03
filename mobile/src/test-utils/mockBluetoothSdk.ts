// The pure predicates come from the side-effect-free types subpath so the mock
// can never drift from the real SDK's connection semantics.
import {
  isBusyGlassesConnectionStatus,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
} from "@mentra/bluetooth-sdk/types"

type Listener = (payload: any) => void

const listeners = new Map<string, Set<Listener>>()

const addListener = jest.fn((eventName: string, listener: Listener) => {
  if (!listeners.has(eventName)) {
    listeners.set(eventName, new Set())
  }
  listeners.get(eventName)!.add(listener)

  return {
    remove: () => {
      listeners.get(eventName)?.delete(listener)
    },
  }
})

const localNetworkListeners = new Map<string, Set<Listener>>()

export const emitLocalNetworkEvent = (eventName: string, payload: any) => {
  localNetworkListeners.get(eventName)?.forEach((listener) => listener(payload))
}

export const mentraLocalNetworkMock = {
  addListener: jest.fn((eventName: string, listener: Listener) => {
    if (!localNetworkListeners.has(eventName)) localNetworkListeners.set(eventName, new Set())
    localNetworkListeners.get(eventName)!.add(listener)
    return {remove: () => localNetworkListeners.get(eventName)?.delete(listener)}
  }),
  cancel: jest.fn(() => Promise.resolve()),
  connect: jest.fn((ssid: string) => Promise.resolve({connected: true, ssid})),
  disconnect: jest.fn(() => Promise.resolve()),
  download: jest.fn(() => Promise.resolve({statusCode: 200, bytesWritten: 3, headers: {}})),
  request: jest.fn(() =>
    Promise.resolve({
      status: 200,
      headers: {"content-type": "application/json"},
      bodyBase64: Buffer.from('{"ok":true}').toString("base64"),
    }),
  ),
}

export const bluetoothSdkMock = {
  addListener,
  isConnectedGlassesConnectionStatus,
  isReadyGlassesConnectionStatus,
  isBusyGlassesConnectionStatus,
  requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
  getBluetoothStatus: jest.fn(() =>
    Promise.resolve({
      searching: false,
      micRanking: ["glasses", "phone", "bluetooth"],
      systemMicUnavailable: false,
      currentMic: null,
      searchResults: [],
      wifiScanResults: [],
      lastLog: [],
      otherBtConnected: false,
      galleryModeEnabled: true,
    }),
  ),
  getGlassesStatus: jest.fn(() =>
    Promise.resolve({
      connection: {state: "disconnected"},
      micEnabled: false,
      bluetoothClassicConnected: false,
      signalStrength: -1,
      deviceModel: "",
      androidVersion: "",
      firmwareVersion: "",
      bluetoothMacAddress: "",
      buildNumber: "",
      otaVersionUrl: "",
      appVersion: "",
      bluetoothName: "",
      serialNumber: "",
      style: "",
      color: "",
      mtkFirmwareVersion: "",
      besFirmwareVersion: "",
      wifi: {state: "disconnected"},
      batteryLevel: -1,
      charging: false,
      caseBatteryLevel: -1,
      caseCharging: false,
      caseOpen: false,
      caseRemoved: true,
      hotspot: {state: "disabled"},
      controllerConnected: false,
      controllerFullyBooted: false,
      controllerMacAddress: "",
      controllerBatteryLevel: -1,
      controllerSignalStrength: -1,
    }),
  ),
  update: jest.fn(() => Promise.resolve()),
  updateBluetoothSettings: jest.fn(() => Promise.resolve()),
  setCalendarEvents: jest.fn(() => Promise.resolve()),
  updateGlasses: jest.fn(() => Promise.resolve()),
  onBluetoothStatus: jest.fn((listener: Listener) => addListener("bluetooth_status", listener).remove),
  onGlassesStatus: jest.fn((listener: Listener) => addListener("glasses_status", listener).remove),
  subscribeBluetoothStatus: jest.fn((listener: Listener) => addListener("bluetooth_status", listener).remove),
  subscribeGlassesStatus: jest.fn((listener: Listener) => addListener("glasses_status", listener).remove),
  displayEvent: jest.fn(() => Promise.resolve()),
  displayText: jest.fn(() => Promise.resolve()),
  clearDisplay: jest.fn(() => Promise.resolve()),
  requestStatus: jest.fn(() => Promise.resolve()),
  getDefaultDevice: jest.fn(() => null),
  setDefaultDevice: jest.fn(() => Promise.resolve()),
  clearDefaultDevice: jest.fn(() => Promise.resolve()),
  startScan: jest.fn(() => Promise.resolve()),
  stopScan: jest.fn(() => Promise.resolve()),
  connect: jest.fn(() => Promise.resolve()),
  connectDefault: jest.fn(() => Promise.resolve()),
  connectDefaultController: jest.fn(() => Promise.resolve()),
  disconnectController: jest.fn(() => Promise.resolve()),
  connectSimulated: jest.fn(() => Promise.resolve()),
  disconnect: jest.fn(() => Promise.resolve()),
  forget: jest.fn(() => Promise.resolve()),
  forgetController: jest.fn(() => Promise.resolve()),
  showDashboard: jest.fn(() => Promise.resolve()),
  ping: jest.fn(() => Promise.resolve()),
  sendIncidentId: jest.fn(() => Promise.resolve()),
  requestWifiScan: jest.fn(() => Promise.resolve([])),
  getSavedWifiNetworks: jest.fn(() => Promise.resolve([])),
  sendWifiCredentials: jest.fn((ssid: string) =>
    Promise.resolve({type: "wifi_status_change", state: "connected", ssid}),
  ),
  forgetWifiNetwork: jest.fn(() => Promise.resolve({type: "wifi_status_change", state: "disconnected"})),
  setHotspotState: jest.fn((enabled: boolean) =>
    Promise.resolve(
      enabled
        ? {
            type: "hotspot_status_change",
            state: "enabled",
            ssid: "Mentra",
            password: "password",
            localIp: "192.168.43.1",
          }
        : {type: "hotspot_status_change", state: "disabled"},
    ),
  ),
  setWifiAdbState: jest.fn(() => Promise.resolve()),
  setSystemTime: jest.fn(() => Promise.resolve()),
  logCurrentWifiFrequency: jest.fn(() => Promise.resolve()),
  queryGalleryStatus: jest.fn(() => Promise.resolve()),
  requestPhoto: jest.fn(() => Promise.resolve()),
  startOtaUpdate: jest.fn(() => Promise.resolve()),
  sendOtaQueryStatus: jest.fn(() =>
    Promise.resolve({
      type: "ota_status",
      session_id: "",
      total_steps: 0,
      current_step: 0,
      step_type: "apk",
      phase: "download",
      step_percent: 0,
      overall_percent: 0,
      status: "idle",
    }),
  ),
  queryOtaStatus: jest.fn(() =>
    Promise.resolve({
      type: "ota_status",
      session_id: "",
      total_steps: 0,
      current_step: 0,
      step_type: "apk",
      phase: "download",
      step_percent: 0,
      overall_percent: 0,
      status: "idle",
    }),
  ),
  requestVersionInfo: jest.fn(() =>
    Promise.resolve({
      androidVersion: "",
      firmwareVersion: "",
      besFirmwareVersion: "",
      mtkFirmwareVersion: "",
      buildNumber: "",
      otaVersionUrl: "",
      appVersion: "",
    }),
  ),
  startVideoRecording: jest.fn(() =>
    Promise.resolve({
      type: "video_recording_status",
      requestId: "mock-video",
      success: true,
      status: "recording_started",
      timestamp: Date.now(),
    }),
  ),
  stopVideoRecording: jest.fn(() =>
    Promise.resolve({
      type: "video_recording_status",
      requestId: "mock-video",
      success: true,
      status: "recording_stopped",
      timestamp: Date.now(),
    }),
  ),
  startStream: jest.fn(() => Promise.resolve()),
  startExternallyManagedStream: jest.fn(() => Promise.resolve()),
  stopStream: jest.fn(() => Promise.resolve()),
  sendExternallyManagedStreamKeepAlive: jest.fn(() => Promise.resolve()),
  setMicState: jest.fn(() => Promise.resolve()),
  restartTranscriber: jest.fn(() => Promise.resolve()),
  setOwnAppAudioPlaying: jest.fn(() => Promise.resolve()),
  getGlassesMediaVolume: jest.fn(() => Promise.resolve({level: 5, statusCode: 0})),
  setGlassesMediaVolume: jest.fn(() => Promise.resolve({statusCode: 0})),
  rgbLedControl: jest.fn(() => Promise.resolve()),
  setSttModelDetails: jest.fn(() => Promise.resolve()),
  getSttModelPath: jest.fn(() => Promise.resolve("")),
  checkSttModelAvailable: jest.fn(() => Promise.resolve(false)),
  validateSttModel: jest.fn(() => Promise.resolve(true)),
  extractTarBz2: jest.fn(() => Promise.resolve(true)),
  setTtsModelDetails: jest.fn(() => Promise.resolve()),
  getTtsModelPath: jest.fn(() => Promise.resolve("")),
  getTtsModelLanguage: jest.fn(() => Promise.resolve("")),
  checkTtsModelAvailable: jest.fn(() => Promise.resolve(false)),
  validateTtsModel: jest.fn(() => Promise.resolve(true)),
  generateTtsAudio: jest.fn(() => Promise.resolve(true)),
  onExtractionProgress: jest.fn((listener: Listener) => addListener("extraction_progress", listener).remove),
}

export const emitBluetoothSdkEvent = (eventName: string, payload: any) => {
  listeners.get(eventName)?.forEach((listener) => listener(payload))
}

export const getBluetoothSdkListenerCount = (eventName: string) => listeners.get(eventName)?.size ?? 0

export const resetBluetoothSdkMock = () => {
  listeners.clear()
  Object.values(bluetoothSdkMock).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) {
      value.mockClear()
    }
  })
}
