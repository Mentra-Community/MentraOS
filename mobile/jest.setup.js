// Mock react-native-permissions
jest.mock("react-native-permissions", () => require("react-native-permissions/mock"))

jest.mock("@mentra/bluetooth-sdk", () => {
  const {bluetoothSdkMock} = require("./src/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("@mentra/bluetooth-sdk-internal", () => {
  const {bluetoothSdkMock} = require("./src/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
  }
})

jest.mock("@/utils/auth/authClient", () => ({
  __esModule: true,
  default: {
    getSession: jest.fn(() => Promise.resolve({is_ok: () => false, is_error: () => true})),
    getUser: jest.fn(() => Promise.resolve({is_ok: () => false, is_error: () => true})),
    onAuthStateChange: jest.fn(() => ({is_ok: () => true, value: {unsubscribe: jest.fn()}})),
    signOut: jest.fn(() => Promise.resolve({is_ok: () => true})),
    startAutoRefresh: jest.fn(() => Promise.resolve({is_ok: () => true})),
    stopAutoRefresh: jest.fn(() => Promise.resolve({is_ok: () => true})),
  },
}))

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

// Mock native WebView for Jest runs. Several service tests import screens
// transitively; they only need the module to load, not a native webview.
jest.mock("react-native-webview", () => {
  const React = require("react")
  const {View} = require("react-native")

  const WebView = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      goBack: jest.fn(),
      injectJavaScript: jest.fn(),
      reload: jest.fn(),
    }))

    return React.createElement(View, props, props.children)
  })
  WebView.displayName = "MockWebView"

  return {
    __esModule: true,
    default: WebView,
    WebView,
  }
})

// Mock native keyboard controller wrappers for non-native Jest runs.
jest.mock("react-native-keyboard-controller", () => {
  const React = require("react")
  const {ScrollView} = require("react-native")

  const KeyboardAwareScrollView = React.forwardRef((props, ref) =>
    React.createElement(ScrollView, {...props, ref}, props.children),
  )
  KeyboardAwareScrollView.displayName = "MockKeyboardAwareScrollView"

  return {
    __esModule: true,
    KeyboardAwareScrollView,
    KeyboardProvider: ({children}) => React.createElement(React.Fragment, null, children),
  }
})

// Mock Reanimated/Worklets native runtime for import-only service tests.
jest.mock("react-native-reanimated", () => {
  const ReactNative = require("react-native")

  const passthroughAnimation = (toValue, _config, callback) => {
    if (typeof callback === "function") callback(true)
    return toValue
  }
  const Animated = {
    ...ReactNative.Animated,
    View: ReactNative.View,
    Text: ReactNative.Text,
    Image: ReactNative.Image,
    ScrollView: ReactNative.ScrollView,
    createAnimatedComponent: (component) => component,
    call: () => {},
  }

  return {
    __esModule: true,
    default: Animated,
    runOnJS: (fn) => fn,
    useAnimatedStyle: (updater) => (typeof updater === "function" ? updater() : updater),
    useDerivedValue: (updater) => ({value: typeof updater === "function" ? updater() : updater}),
    useSharedValue: (value) => ({value}),
    withDelay: (_delay, animation) => animation,
    withRepeat: (animation) => animation,
    withSequence: (...animations) => animations[animations.length - 1],
    withSpring: passthroughAnimation,
    withTiming: passthroughAnimation,
    cancelAnimation: jest.fn(),
    interpolate: jest.fn((value) => value),
    Extrapolation: {
      CLAMP: "clamp",
      EXTEND: "extend",
      IDENTITY: "identity",
    },
    Easing: {
      linear: jest.fn((value) => value),
      in: jest.fn(() => (value) => value),
      out: jest.fn(() => (value) => value),
      inOut: jest.fn(() => (value) => value),
      exp: jest.fn((value) => value),
    },
    configureReanimatedLogger: jest.fn(),
    ReanimatedLogLevel: {
      warn: 1,
      error: 2,
    },
  }
})

jest.mock("react-native-worklets", () => ({
  __esModule: true,
  runOnJS: (fn) => fn,
  scheduleOnRN: (fn, ...args) => fn(...args),
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
  BackgroundTimer: {
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

// Mock native filesystem package for tests that import storage-heavy services transitively.
jest.mock("@dr.pogodin/react-native-fs", () => ({
  __esModule: true,
  CachesDirectoryPath: "/tmp/cache",
  DocumentDirectoryPath: "/tmp/documents",
  ExternalDirectoryPath: "/tmp/external",
  TemporaryDirectoryPath: "/tmp",
  copyFile: jest.fn(() => Promise.resolve()),
  downloadFile: jest.fn(() => ({
    jobId: 1,
    promise: Promise.resolve({statusCode: 200, bytesWritten: 0}),
  })),
  exists: jest.fn(() => Promise.resolve(false)),
  getFSInfo: jest.fn(() => Promise.resolve({freeSpace: 1024 * 1024 * 1024, totalSpace: 1024 * 1024 * 1024})),
  mkdir: jest.fn(() => Promise.resolve()),
  moveFile: jest.fn(() => Promise.resolve()),
  read: jest.fn(() => Promise.resolve("")),
  readDir: jest.fn(() => Promise.resolve([])),
  readFile: jest.fn(() => Promise.resolve("")),
  stat: jest.fn(() => Promise.resolve({size: 0})),
  stopDownload: jest.fn(() => Promise.resolve()),
  unlink: jest.fn(() => Promise.resolve()),
  writeFile: jest.fn(() => Promise.resolve()),
}))

// Mock @mentra/island — its barrel pulls in many native modules
// (react-native-share, expo-battery/clipboard/location, etc.). Tests that
// only need a handful of exports get stubs here; specific tests can override.
jest.mock("@mentra/island", () => {
  const appStatusState = {
    apps: [],
    refresh: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    stopAll: jest.fn(),
  }
  const useAppStatusStore = jest.fn((selector) =>
    typeof selector === "function" ? selector(appStatusState) : appStatusState,
  )
  useAppStatusStore.getState = jest.fn(() => appStatusState)
  useAppStatusStore.setState = jest.fn((partial) => Object.assign(appStatusState, partial))
  useAppStatusStore.subscribe = jest.fn(() => () => {})

  return {
    __esModule: true,
    BgTimer: {
      setInterval: jest.fn((callback, delay) => setInterval(callback, delay)),
      clearInterval: jest.fn((id) => clearInterval(id)),
      setTimeout: jest.fn((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: jest.fn((id) => clearTimeout(id)),
    },
    // GlassesReadiness predicates (re-exported by @/stores/glasses). Real impls
    // so tests that exercise readiness logic behave correctly.
    isGlassesConnected: (c) => c?.state === "connected",
    isGlassesReady: (c) => c?.state === "connected" && !!c?.fullyBooted,
    isGlassesLinkLayerBusy: (c) => c?.state === "scanning" || c?.state === "connecting" || c?.state === "bonding",
    waitForGlassesReady: jest.fn((opts) => {
      const {getConnection, subscribe, timeoutMs = 35_000, signal} = opts || {}
      const ready = (c) => c?.state === "connected" && !!c?.fullyBooted
      return new Promise((resolve) => {
        if (signal?.aborted) return resolve(false)
        if (getConnection && ready(getConnection())) return resolve(true)
        let settled = false
        let unsub
        let timer
        const finish = (v) => {
          if (settled) return
          settled = true
          if (unsub) unsub()
          if (timer) clearTimeout(timer)
          resolve(v)
        }
        if (signal) signal.addEventListener("abort", () => finish(false))
        unsub = subscribe ? subscribe((c) => (ready(c) ? finish(true) : undefined)) : undefined
        if (!settled) timer = setTimeout(() => finish(getConnection ? ready(getConnection()) : false), timeoutMs)
        return undefined
      })
    }),
    // ConnectionCoordinator decisions (consumed by the reconnect effect + connect buttons).
    decideReconnect: (input) => {
      if (!input?.reconnectOnForeground) return {kind: "skip", result: true}
      if (!input?.defaultWearable || input?.isSimulated) return {kind: "skip", result: false}
      if (input?.connection?.state === "connected" || input?.searching) return {kind: "skip", result: true}
      return {kind: "connect"}
    },
    decideConnectButtonAction: (input) => (input?.busy ? "cancel" : !input?.hasDefaultWearable ? "pair" : "connect"),
    // PairingCoordinator decisions (consumed by the pairing loading + success screens).
    classifyPairFailure: (error) => (error === "errors:pairNeedDisconnect" ? "unpair-even" : "failure"),
    buildPairingRouteStack: (input) => {
      if (!input?.hasOta) return []
      const order = ["/pairing/btclassic", "/wifi/scan", "/ota/check-for-updates", "/onboarding/live", "/onboarding/os"]
      const stack = []
      if (!(input.isAndroid || input.bluetoothClassicConnected)) stack.push("/pairing/btclassic")
      stack.push("/ota/check-for-updates")
      stack.sort((a, b) => order.indexOf(a) - order.indexOf(b))
      return stack
    },
    // AppGrid computation (consumed by AppsGrid). Passthrough stub — render tests
    // don't assert on grid layout; the real algorithm is unit-tested directly.
    computeAppGrid: (input) => ({orderedApps: input?.apps ?? [], nextOrderMap: input?.orderMap ?? {}}),
    // Bluetooth SDK passthrough — the same mock singleton @mentra/bluetooth-sdk
    // is mocked with, so emitBluetoothSdkEvent/resetBluetoothSdkMock still drive
    // screens that now import BluetoothSdk from island.
    BluetoothSdk: require("./src/test-utils/mockBluetoothSdk").bluetoothSdkMock,
    useApps: jest.fn(() => appStatusState.apps),
    useForegroundApp: jest.fn(() => null),
    useAppStatusStore,
    useRefresh: jest.fn(() => appStatusState.refresh),
    useStopAll: jest.fn(() => appStatusState.stopAll),
    useStart: jest.fn(() => appStatusState.start),
    useStop: jest.fn(() => appStatusState.stop),
    sortAppsByLastOpenTime: jest.fn((apps) => apps),
    decideDevLaunchRoute: jest.fn(),
    buildMiniappGlobalsScript: jest.fn(() => ""),
    appRegistry: {
      subscribe: jest.fn(() => () => {}),
      getApps: jest.fn(() => []),
      getInstalledMiniapps: jest.fn(() => Promise.resolve([])),
      installOfflineApp: jest.fn((app) => {
        appStatusState.apps = [...appStatusState.apps.filter((item) => item.packageName !== app.packageName), app]
        return {is_ok: () => true, is_error: () => false, value: app}
      }),
    },
    configureIsland: jest.fn(),
    webviewBridge: {
      handleMessage: jest.fn(),
    },
    miniappRunningRegistry: {
      isRunning: jest.fn(() => false),
    },
    devServerBridge: {},
    displayProcessor: {
      attachToRuntime: jest.fn(),
      processDisplayEvent: jest.fn((event) => ({...event, _processed: true})),
    },
    HardwareCompatibility: {
      checkCompatibility: jest.fn(() => ({
        isCompatible: true,
        missingRequired: [],
        missingOptional: [],
        warnings: [],
      })),
    },
    HardwareRequirementLevel: {
      OPTIONAL: "optional",
      REQUIRED: "required",
    },
    HardwareType: {
      BUTTON: "button",
      CAMERA: "camera",
      DISPLAY: "display",
      EXIST: "exist",
      IMU: "imu",
      LIGHT: "light",
      MICROPHONE: "microphone",
      SPEAKER: "speaker",
      WIFI: "wifi",
    },
    localDisplayManager: {},
    localMiniappRuntime: {
      cleanup: jest.fn(),
      forwardEvent: jest.fn(),
      getAppStatus: jest.fn(() => null),
      handleRawMessage: jest.fn(),
      initialize: jest.fn(),
      wireStreamingStatusFanout: jest.fn(),
    },
    localSttFallbackCoordinator: {
      getActiveLanguage: jest.fn(() => null),
      isActive: jest.fn(() => false),
    },
    offlineSpeechModelService: {
      getStatus: jest.fn(() => null),
      startBackgroundDownloads: jest.fn(),
      subscribe: jest.fn(() => () => {}),
    },
    micStateCoordinator: {
      cleanup: jest.fn(),
    },
    throttle: jest.fn((callback) => callback),
    configureRuntime: jest.fn(),
    getRuntimeHooks: jest.fn(() => ({})),
    ISLAND_SETTINGS_KEYS: {},
    normalizeManifestPermissions: jest.fn(),
    buildHardwareRequirements: jest.fn(() => []),
    saveLocalAppRunningState: jest.fn(),
  }
})

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
