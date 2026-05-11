// Mock react-native-permissions
jest.mock("react-native-permissions", () => require("react-native-permissions/mock"))

// Mock react-native-mmkv
jest.mock("react-native-mmkv", () => {
  const mockStorage = new Map([
    ["string", '"string"'],
    ["object", '{"x":1}'],
  ])

  return {
    createMMKV: jest.fn(() => ({
      getString: jest.fn((key) => mockStorage.get(key)),
      set: jest.fn((key, value) => mockStorage.set(key, value)),
      remove: jest.fn((key) => {
        mockStorage.delete(key)
        return true
      }),
      clearAll: jest.fn(() => mockStorage.clear()),
      getAllKeys: jest.fn(() => Array.from(mockStorage.keys())),
    })),
  }
})

// Mock react-native-localize
jest.mock("react-native-localize", () => ({
  getLocales: jest.fn(() => [
    {
      countryCode: "US",
      languageTag: "en-US",
      languageCode: "en",
      isRTL: false,
    },
  ]),
  getNumberFormatSettings: jest.fn(() => ({
    decimalSeparator: ".",
    groupingSeparator: ",",
  })),
  getCalendar: jest.fn(() => "gregorian"),
  getCountry: jest.fn(() => "US"),
  getCurrencies: jest.fn(() => ["USD", "EUR"]),
  getTemperatureUnit: jest.fn(() => "celsius"),
  getTimeZone: jest.fn(() => "America/New_York"),
  uses24HourClock: jest.fn(() => false),
  usesMetricSystem: jest.fn(() => false),
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
}))

// Mock expo-audio
jest.mock("expo-audio", () => ({
  createAudioPlayer: jest.fn(() => ({
    src: null,
    play: jest.fn(),
    pause: jest.fn(),
    stop: jest.fn(),
    remove: jest.fn(),
  })),
}))

// Mock react-native-nitro-bg-timer for non-native Jest runs
jest.mock("react-native-nitro-bg-timer", () => ({
  BgTimer: {
    setInterval: jest.fn((callback, delay) => setInterval(callback, delay)),
    clearInterval: jest.fn((id) => clearInterval(id)),
    setTimeout: jest.fn((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: jest.fn((id) => clearTimeout(id)),
  },
}))

// Mock react-native-zip-archive — pulled in transitively by @mentra/island
jest.mock("react-native-zip-archive", () => ({
  unzip: jest.fn(() => Promise.resolve("")),
  zip: jest.fn(() => Promise.resolve("")),
  subscribe: jest.fn(() => ({remove: jest.fn()})),
}))

// Mock @mentra/island — its barrel pulls in many native modules
// (react-native-share, expo-battery/clipboard/location, etc.). Tests that
// only need a handful of exports get stubs here; specific tests can override.
jest.mock("@mentra/island", () => ({
  __esModule: true,
  BgTimer: {
    setInterval: jest.fn((callback, delay) => setInterval(callback, delay)),
    clearInterval: jest.fn((id) => clearInterval(id)),
    setTimeout: jest.fn((callback, delay) => setTimeout(callback, delay)),
    clearTimeout: jest.fn((id) => clearTimeout(id)),
  },
  useApps: jest.fn(() => []),
  useAppStatusStore: jest.fn(() => ({})),
  useRefresh: jest.fn(() => ({refresh: jest.fn(), isRefreshing: false})),
  useStopAll: jest.fn(() => jest.fn()),
  sortAppsByLastOpenTime: jest.fn((apps) => apps),
  decideDevLaunchRoute: jest.fn(),
  buildMiniappGlobalsScript: jest.fn(() => ""),
  appRegistry: {
    subscribe: jest.fn(() => () => {}),
    getApps: jest.fn(() => []),
  },
  webviewBridge: {
    handleMessage: jest.fn(),
  },
  miniappRunningRegistry: {
    isRunning: jest.fn(() => false),
  },
  devServerBridge: {},
  displayProcessor: {},
  localDisplayManager: {},
  localMiniappRuntime: {},
  localSttFallbackCoordinator: {},
  micStateCoordinator: {},
  configureRuntime: jest.fn(),
  getRuntimeHooks: jest.fn(() => ({})),
  ISLAND_SETTINGS_KEYS: {},
  normalizeManifestPermissions: jest.fn(),
  buildHardwareRequirements: jest.fn(() => []),
  saveLocalAppRunningState: jest.fn(),
}))

// Mock SocketComms to avoid complex dependency chains
jest.mock("@/services/SocketComms", () => ({
  default: {
    getInstance: jest.fn(() => ({
      connect: jest.fn(),
      disconnect: jest.fn(),
      send_socket_message: jest.fn(),
      cleanup: jest.fn(),
    })),
  },
}))

// Mock WebSocketManager to avoid circular dependency issues
jest.mock("@/services/WebSocketManager", () => {
  const {EventEmitter} = require("events")

  const WebSocketStatus = {
    DISCONNECTED: "disconnected",
    CONNECTING: "connecting",
    CONNECTED: "connected",
    ERROR: "error",
  }

  class MockWebSocketManager extends EventEmitter {
    connect = jest.fn()
    disconnect = jest.fn()
    isConnected = jest.fn(() => false)
    sendText = jest.fn()
    sendBinary = jest.fn()
    cleanup = jest.fn()
  }

  return {
    WebSocketStatus,
    default: new MockWebSocketManager(),
  }
})

// Mock core native module to avoid native bridge errors
jest.mock("@mentra/bluetooth-sdk", () => {
  const CoreModuleMock = {
    getCoreStatus: jest.fn(() => Promise.resolve("disabled")),
    requestBluetoothPermissions: jest.fn(() => Promise.resolve(true)),
    onGlassesStatus: jest.fn(() => () => {}),
    restartTranscriber: jest.fn(() => Promise.resolve()),
    displayEvent: jest.fn(),
    rgbLedControl: jest.fn(),
    update: jest.fn(),
    addListener: jest.fn(() => ({remove: jest.fn()})),
  }
  return {
    __esModule: true,
    default: CoreModuleMock,
    GlassesStatus: {},
  }
})

// Mock crust native module to avoid native bridge errors
jest.mock("crust", () => ({
  default: {
    addListener: jest.fn(() => ({remove: jest.fn()})),
    showAVRoutePicker: jest.fn(),
    setNotificationConfig: jest.fn(() => Promise.resolve()),
    getInstalledApps: jest.fn(() => Promise.resolve([])),
    getInstalledAppsForNotifications: jest.fn(() => Promise.resolve([])),
    hasNotificationListenerPermission: jest.fn(() => Promise.resolve(false)),
    openNotificationListenerSettings: jest.fn(() => Promise.resolve(false)),
    isBetaBuild: jest.fn(() => Promise.resolve(false)),
    processGalleryImage: jest.fn(() => Promise.resolve({success: true})),
    mergeHdrBrackets: jest.fn(() => Promise.resolve({success: true})),
    stabilizeVideo: jest.fn(() => Promise.resolve({success: true})),
    saveToGalleryWithDate: jest.fn(() => Promise.resolve({success: true})),
  },
}))

// Silence the warning: Animated: `useNativeDriver` is not supported
global.__reanimatedWorkletInit = jest.fn()
