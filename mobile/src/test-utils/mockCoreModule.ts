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

export const coreModuleMock = {
  addListener,
  requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
  getCoreStatus: jest.fn(() =>
    Promise.resolve({
      searching: false,
      micRanking: ["glasses", "phone", "bluetooth"],
      systemMicUnavailable: false,
      currentMic: null,
      searchResults: [],
      wifiScanResults: [],
      lastLog: [],
      otherBtConnected: false,
    }),
  ),
  getGlassesStatus: jest.fn(() =>
    Promise.resolve({
      fullyBooted: false,
      connected: false,
      micEnabled: false,
      connectionState: "disconnected",
      btcConnected: false,
      signalStrength: -1,
      deviceModel: "",
      androidVersion: "",
      fwVersion: "",
      btMacAddress: "",
      buildNumber: "",
      otaVersionUrl: "",
      appVersion: "",
      bluetoothName: "",
      serialNumber: "",
      style: "",
      color: "",
      mtkFwVersion: "",
      besFwVersion: "",
      wifi: {state: "disconnected"},
      batteryLevel: -1,
      charging: false,
      caseBatteryLevel: -1,
      caseCharging: false,
      caseOpen: false,
      caseRemoved: true,
      hotspotEnabled: false,
      hotspotSsid: "",
      hotspotPassword: "",
      hotspotGatewayIp: "",
      controllerConnected: false,
      controllerFullyBooted: false,
      controllerMacAddress: "",
      controllerBatteryLevel: -1,
      controllerSignalStrength: -1,
    }),
  ),
  update: jest.fn(() => Promise.resolve()),
  updateCore: jest.fn(() => Promise.resolve()),
  updateGlasses: jest.fn(() => Promise.resolve()),
  onCoreStatus: jest.fn((listener: Listener) => addListener("core_status", listener).remove),
  onGlassesStatus: jest.fn((listener: Listener) => addListener("glasses_status", listener).remove),
  displayEvent: jest.fn(() => Promise.resolve()),
  displayText: jest.fn(() => Promise.resolve()),
  clearDisplay: jest.fn(() => Promise.resolve()),
  requestStatus: jest.fn(() => Promise.resolve()),
  getDefaultDevice: jest.fn(() => null),
  setDefaultDevice: jest.fn(() => Promise.resolve()),
  clearDefaultDevice: jest.fn(() => Promise.resolve()),
  startScan: jest.fn(() => Promise.resolve()),
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
  requestWifiScan: jest.fn(() => Promise.resolve()),
  sendWifiCredentials: jest.fn(() => Promise.resolve()),
  forgetWifiNetwork: jest.fn(() => Promise.resolve()),
  setHotspotState: jest.fn(() => Promise.resolve()),
  logCurrentWifiFrequency: jest.fn(() => Promise.resolve()),
  queryGalleryStatus: jest.fn(() => Promise.resolve()),
  photoRequest: jest.fn(() => Promise.resolve()),
  sendOtaStart: jest.fn(() => Promise.resolve()),
  requestVersionInfo: jest.fn(() => Promise.resolve()),
  startVideoRecording: jest.fn(() => Promise.resolve()),
  stopVideoRecording: jest.fn(() => Promise.resolve()),
  startStream: jest.fn(() => Promise.resolve()),
  stopStream: jest.fn(() => Promise.resolve()),
  keepStreamAlive: jest.fn(() => Promise.resolve()),
  setMicState: jest.fn(() => Promise.resolve()),
  restartTranscriber: jest.fn(() => Promise.resolve()),
  setOwnAppAudioPlaying: jest.fn(() => Promise.resolve()),
  getGlassesMediaVolume: jest.fn(() => Promise.resolve({vol: 5, statusCode: 0})),
  setGlassesMediaVolume: jest.fn(() => Promise.resolve({statusCode: 0})),
  rgbLedControl: jest.fn(() => Promise.resolve()),
  setSttModelDetails: jest.fn(() => Promise.resolve()),
  getSttModelPath: jest.fn(() => Promise.resolve("")),
  checkSttModelAvailable: jest.fn(() => Promise.resolve(false)),
  validateSttModel: jest.fn(() => Promise.resolve(true)),
  extractTarBz2: jest.fn(() => Promise.resolve(true)),
}

export const emitCoreModuleEvent = (eventName: string, payload: any) => {
  listeners.get(eventName)?.forEach((listener) => listener(payload))
}

export const resetCoreModuleMock = () => {
  listeners.clear()
  Object.values(coreModuleMock).forEach((value) => {
    if (typeof value === "function" && "mockClear" in value) {
      value.mockClear()
    }
  })
}
