// Most OTA integration tests model a released MentraOS host. Tests for an
// unpinned source build delete this value explicitly before exercising the
// fail-closed path.
process.env.EXPO_PUBLIC_ASG_OTA_VERSION_URL ??=
  "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-0.0.0-test-version.json"

// Mock react-native-permissions
jest.mock("react-native-permissions", () => require("react-native-permissions/mock"))
// Requires its native module at import time (island gallery sync uses it for the
// bluetooth-adapter pre-flight check).
jest.mock("react-native-ble-manager", () => ({
  __esModule: true,
  default: {
    start: jest.fn().mockResolvedValue(undefined),
    checkState: jest.fn().mockResolvedValue("on"),
  },
}))

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

jest.mock("@mentra/bluetooth-sdk/internal", () => {
  const {bluetoothSdkMock, mentraLocalNetworkMock} = require("./src/test-utils/mockBluetoothSdk")
  return {
    __esModule: true,
    default: bluetoothSdkMock,
    ...bluetoothSdkMock,
    MentraLocalNetwork: mentraLocalNetworkMock,
    BLUETOOTH_SDK_VERSION: "0.0.0-test",
    sdkPinnedOtaManifestUrl: () =>
      "https://github.com/Mentra-Community/MentraOS/releases/download/bluetooth-sdk-ota/bluetooth-sdk-0.0.0-test-version.json",
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

// Mock react-native-zip-archive — pulled in transitively by @mentra/engine
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

// LocalMiniappRuntime pulls heavy native modules (react-native-share, expo-*).
// requireActual'd island services that import it (e.g. GlassesStatusProjection)
// only need its forwardEvent side-effect, so stub it light here.
jest.mock("./modules/engine/src/services/LocalMiniappRuntime", () => ({
  __esModule: true,
  default: {forwardEvent: jest.fn()},
}))

// Mock the three @mentra/engine entry points (main, /internal, /devtools) —
// the package pulls in many native modules (react-native-share,
// expo-battery/clipboard/location, etc.). Tests that only need a handful of
// exports get stubs here; specific tests can override. The builder runs
// lazily on the first island require (so island sources only load for suites
// that use them) and is cached so all three entries share one underlying
// state (stores, appStatusState, engine). Key sets mirror the real
// src/index.ts / src/internal.ts / src/devtools.ts partition.
let mockIslandEntriesCache = null
const mockIslandEntries = () => {
  if (mockIslandEntriesCache) return mockIslandEntriesCache
  // The glasses store moved into island; tests + the @/stores/glasses shim need its
  // REAL behavior (setState/getState/subscribe), so pull the actual store in. It's
  // pure (zustand + type-only btsdk imports), so it loads cleanly under the mock.
  const realGlasses = jest.requireActual("./modules/engine/src/stores/glasses")
  const realDisplay = jest.requireActual("./modules/engine/src/stores/display")
  const realCore = jest.requireActual("./modules/engine/src/stores/core")
  const realConnection = jest.requireActual("./modules/engine/src/stores/connection")
  const realGallerySync = jest.requireActual("./modules/engine/src/stores/gallerySync")
  const realCloudStatus = jest.requireActual("./modules/engine/src/stores/cloudClientStatus")
  // Settings store moved into island; tests used the real host store before the
  // move, so requireActual preserves that exact behavior.
  const realSettings = jest.requireActual("./modules/engine/src/stores/settings")
  const realBtSettingKeys = jest.requireActual("./modules/engine/src/stores/bluetoothSettingKeys")
  // engine.start() starts the island-owned device-settings -> glasses BLE sync; use
  // the real one so its behavior is exercised where it now lives (not MantleManager).
  const realGlassesSettingsSync = jest.requireActual("./modules/engine/src/services/GlassesSettingsSync")
  const realGlassesStatusProjection = jest.requireActual("./modules/engine/src/services/GlassesStatusProjection")
  const realOtaService = jest.requireActual("./modules/engine/src/services/OtaService")
  const realAudioCloudUplink = jest.requireActual("./modules/engine/src/services/AudioCloudUplink")
  const realDeviceEventRouter = jest.requireActual("./modules/engine/src/services/DeviceEventRouter")
  // Pairing-identity lifecycle (projection + the JS-owned identity writes) — real
  // implementation (pure: settings store + types only) so host screens/tests
  // exercise the actual three-state read-model, not a parallel stub.
  const realPairingIdentity = jest.requireActual("./modules/engine/src/services/PairingIdentity")
  // Clock-skew utils moved into island; the host gallery sync + OTA checker import them
  // from @mentra/engine, so expose the real (pure) implementations through the mock.
  const realGlassesClockSync = jest.requireActual("./modules/engine/src/services/glassesClockSync")
  const realGallerySyncClock = jest.requireActual("./modules/engine/src/services/gallerySyncClock")
  const realOtaManifestUrl = jest.requireActual("./modules/engine/src/services/otaManifestUrl")
  const realOtaUpdateCheck = jest.requireActual("./modules/engine/src/services/OtaUpdateCheckService")
  // OTA install policy constants + display-state derivation + the install state
  // machine (WP 8B) — real implementations so the host shim
  // (@/app/ota/otaProgressTimeouts), the OTA screens and their tests exercise the
  // moved behavior where it now lives.
  const realOtaInstallPolicy = jest.requireActual("./modules/engine/src/services/otaInstallPolicy")
  const realOtaDisplayState = jest.requireActual("./modules/engine/src/services/otaDisplayState")
  const realOtaInstallCoordinator = jest.requireActual("./modules/engine/src/services/OtaInstallCoordinator")
  const realOtaAutoChain = jest.requireActual("./modules/engine/src/services/OtaAutoChain")
  const realOtaErrorMapping = jest.requireActual("./modules/engine/src/services/OtaErrorMapping")
  const realPhoneNotificationsSync = jest.requireActual("./modules/engine/src/services/PhoneNotificationsSync")
  // The on* event facades (button/touch/pair_failure/glasses_not_ready) are thin
  // addListener wrappers in the real engine, so the mock delegates to the shared
  // bluetoothSdkMock — emitBluetoothSdkEvent() + listener-leak counts keep working.
  const {bluetoothSdkMock} = require("./src/test-utils/mockBluetoothSdk")
  const subscribeVia = (eventName) =>
    jest.fn((cb) => {
      const sub = bluetoothSdkMock.addListener(eventName, cb)
      return () => sub.remove()
    })
  const appStatusState = {
    apps: [],
    refresh: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    stopAll: jest.fn(),
    setForeground: jest.fn(),
    clearForeground: jest.fn(),
    saveScreenshot: jest.fn(),
    setHiddenStatus: jest.fn(),
  }
  const useAppStatusStore = jest.fn((selector) =>
    typeof selector === "function" ? selector(appStatusState) : appStatusState,
  )
  useAppStatusStore.getState = jest.fn(() => appStatusState)
  useAppStatusStore.setState = jest.fn((partial) => Object.assign(appStatusState, partial))
  useAppStatusStore.subscribe = jest.fn(() => () => {})
  const otaSnapshot = () => {
    const state = realGlasses.useGlassesStore.getState()
    return {
      connected: realGlasses.isGlassesConnected(state.connection),
      buildNumber: state.buildNumber || null,
      mtkFirmwareVersion: state.mtkFirmwareVersion || null,
      besFirmwareVersion: state.besFirmwareVersion || null,
      wifiConnected: state.wifi.state === "connected",
      wifiStatusKnown: state.wifiStatusKnown,
      manifestUrl: realOtaManifestUrl.resolveOtaManifestUrl(state.otaVersionUrl, state.buildNumber),
      updateAvailable: state.otaUpdateAvailable,
      status: state.otaStatus,
      legacyProgress: state.otaProgress,
      inProgress: state.otaInProgress,
      mtkUpdatedThisSession: state.mtkUpdatedThisSession,
    }
  }

  // --- "@mentra/engine" (main): engine + the pure helper/constant surface ---
  const main = {
    __esModule: true,
    // OTA install policy (timings + failure copy) + deriveDisplayState — real (pure)
    // implementations, consumed by the host otaProgressTimeouts shim + OTA tests.
    ...realOtaInstallPolicy,
    ...realOtaAutoChain,
    ...realOtaErrorMapping,
    deriveDisplayState: realOtaDisplayState.deriveDisplayState,
    // Settings contract on the public entry (real store-backed): SETTINGS registry,
    // per-key hook, and the pure device-model key helpers.
    SETTINGS: realSettings.SETTINGS,
    useSetting: realSettings.useSetting,
    MENTRA_LIVE_SETTING_KEYS: realBtSettingKeys.MENTRA_LIVE_SETTING_KEYS,
    getBluetoothSettingKeysForDevice: realBtSettingKeys.getBluetoothSettingKeysForDevice,
    // The namespaced (A) host API. Mirrors the real `engine` object; members are
    // jest.fn()s so host/screen tests can assert delegation without native btsdk.
    engine: {
      configure: jest.fn(),
      start: jest.fn(() => {
        realGlassesStatusProjection.startGlassesStatusProjection()
        realOtaService.startOtaService()
        realAudioCloudUplink.startAudioCloudUplink()
        realDeviceEventRouter.startDeviceEventRouter()
        realGlassesSettingsSync.startGlassesSettingsSync()
        realPhoneNotificationsSync.startPhoneNotificationsSync()
        return Promise.resolve()
      }),
      stop: jest.fn(() => {
        realGlassesStatusProjection.stopGlassesStatusProjection()
        realOtaService.stopOtaService()
        realAudioCloudUplink.stopAudioCloudUplink()
        realDeviceEventRouter.stopDeviceEventRouter()
        realGlassesSettingsSync.stopGlassesSettingsSync()
        realPhoneNotificationsSync.stopPhoneNotificationsSync()
        return Promise.resolve()
      }),
      glasses: {
        connectDefault: jest.fn(() => Promise.resolve()),
        hasDefaultDevice: jest.fn(() => Promise.resolve(true)),
        disconnect: jest.fn(() => Promise.resolve()),
        forget: jest.fn(() => Promise.resolve()),
        connect: jest.fn(() => Promise.resolve()),
        connectSimulated: jest.fn(() => Promise.resolve()),
        setDefault: jest.fn(() => Promise.resolve()),
        reconnect: jest.fn(() => Promise.resolve(true)),
        isFirstPairing: jest.fn(() => false),
        controller: {
          connectDefault: jest.fn(() => Promise.resolve()),
          disconnect: jest.fn(() => Promise.resolve()),
          forget: jest.fn(() => Promise.resolve()),
        },
        // Thin passthroughs in the real facade — delegate to the shared
        // bluetoothSdkMock so volume-return mocks + btsdk-call assertions work.
        audio: {
          getMediaVolume: jest.fn((...a) => bluetoothSdkMock.getGlassesMediaVolume(...a)),
          setMediaVolume: jest.fn((...a) => bluetoothSdkMock.setGlassesMediaVolume(...a)),
          setOwnAppPlaying: jest.fn((...a) => bluetoothSdkMock.setOwnAppAudioPlaying(...a)),
        },
        status: jest.fn(() => ({state: "disconnected"})),
        onStatus: jest.fn(() => () => {}),
        info: jest.fn(() => ({})),
        capabilities: jest.fn(() => ({})),
        requestVersionInfo: jest.fn(() => Promise.resolve()),
        onButtonPress: subscribeVia("button_press"),
        onTouchGesture: subscribeVia("touch_event"),
        wifi: {
          scan: jest.fn(() => Promise.resolve([])),
          onScanResult: jest.fn(() => () => {}),
          connect: jest.fn(() => Promise.resolve()),
          forget: jest.fn(() => Promise.resolve()),
          status: jest.fn(() => ({state: "disconnected"})),
          onStatus: jest.fn(() => () => {}),
        },
        settings: {
          get: jest.fn(() => undefined),
          set: jest.fn(() => Promise.resolve({is_ok: () => true, is_error: () => false})),
          onChanged: jest.fn(() => () => {}),
          descriptor: jest.fn(() => undefined),
          available: jest.fn(() => []),
        },
      },
      speech: {
        restartTranscriber: jest.fn(() => Promise.resolve()),
        stt: {
          currentLanguage: jest.fn(() => "en"),
          languages: jest.fn(() => []),
          languageInfo: jest.fn(() => Promise.resolve([])),
          download: jest.fn(() => Promise.resolve()),
          activate: jest.fn(),
          cancelDownload: jest.fn(() => Promise.resolve()),
          deleteModel: jest.fn(() => Promise.resolve()),
          status: jest.fn(() => null),
          onStatusChanged: jest.fn(() => () => {}),
        },
        tts: {
          currentLanguage: jest.fn(() => "en"),
          languages: jest.fn(() => []),
          languageInfo: jest.fn(() => Promise.resolve([])),
          download: jest.fn(() => Promise.resolve()),
          activate: jest.fn(),
          cancelDownload: jest.fn(() => Promise.resolve()),
          deleteModel: jest.fn(() => Promise.resolve()),
        },
      },
      display: {
        // Real store-backed (mirrors the facade), same rationale as settings:
        // converted host services assert store-level behavior through engine.
        mirror: {
          current: jest.fn(() => ({...realDisplay.useDisplayStore.getState().currentEvent})),
          onMirror: jest.fn((cb) => realDisplay.useDisplayStore.subscribe((st) => st.currentEvent, cb)),
          view: jest.fn(() => realDisplay.useDisplayStore.getState().view),
          setView: jest.fn((view) => realDisplay.useDisplayStore.getState().setView(view)),
        },
        text: jest.fn(() => Promise.resolve()),
        clear: jest.fn(() => Promise.resolve()),
      },
      notifications: {
        onNotification: jest.fn(() => () => {}),
      },
      permissions: {
        check: jest.fn(() => Promise.resolve(false)),
        request: jest.fn(() => Promise.resolve(false)),
        openSettings: jest.fn(() => Promise.resolve()),
        requirementsForMiniapp: jest.fn(() => Promise.resolve([])),
      },
      phoneNotifications: {
        enabled: jest.fn(() => false),
        setEnabled: jest.fn(() => Promise.resolve({is_ok: () => true})),
        installedApps: jest.fn(() => Promise.resolve([])),
        blocklist: jest.fn(() => []),
        setBlocklist: jest.fn(() => Promise.resolve({is_ok: () => true})),
        hasListenerPermission: jest.fn(() => Promise.resolve(false)),
        requestListenerPermission: jest.fn(() => Promise.resolve()),
      },
      pairing: {
        readiness: jest.fn(() => {
          const glassesState = realGlasses.useGlassesStore.getState()
          return {
            state: glassesState.connection.state,
            connected: realGlasses.isGlassesConnected(glassesState.connection),
            fullyBooted: realGlasses.isGlassesReady(glassesState.connection),
            bluetoothClassicConnected: glassesState.bluetoothClassicConnected,
            nativeLinkBusy: realGlasses.isGlassesLinkLayerBusy(glassesState.connection),
          }
        }),
        onReadiness: jest.fn((cb) => {
          const projectReadiness = () => {
            const glassesState = realGlasses.useGlassesStore.getState()
            return {
              state: glassesState.connection.state,
              connected: realGlasses.isGlassesConnected(glassesState.connection),
              fullyBooted: realGlasses.isGlassesReady(glassesState.connection),
              bluetoothClassicConnected: glassesState.bluetoothClassicConnected,
              nativeLinkBusy: realGlasses.isGlassesLinkLayerBusy(glassesState.connection),
            }
          }
          // Baseline from the readiness projection (not the full store state) so
          // the first unrelated store update doesn't fire a phantom change.
          let last = JSON.stringify(projectReadiness())
          return realGlasses.useGlassesStore.subscribe(() => {
            const readiness = projectReadiness()
            const next = JSON.stringify(readiness)
            if (next === last) return
            last = next
            cb(readiness)
          })
        }),
        // Identity lifecycle: real projection/writes over the real settings store,
        // so tests observe the same none/pending/paired snapshots the app does.
        identity: jest.fn(() => realPairingIdentity.projectPairingIdentity()),
        onIdentity: jest.fn((cb) => realPairingIdentity.subscribePairingIdentity(cb)),
        markPendingSelection: jest.fn((model) => realPairingIdentity.markPendingSelection(model)),
        scan: jest.fn(),
        scanning: jest.fn(() => false),
        searchResults: jest.fn(() => []),
        onFound: jest.fn(() => () => {}),
        otherBtConnected: jest.fn(() => false),
        onOtherBtConnected: jest.fn(() => () => {}),
        pair: jest.fn(() => Promise.resolve()),
        setDefault: jest.fn(() => Promise.resolve()),
        setBluetoothClassicTarget: jest.fn(() => Promise.resolve()),
        abandonAttempt: jest.fn(() => Promise.resolve()),
        onPairFailure: subscribeVia("pair_failure"),
        onGlassesNotReady: subscribeVia("glasses_not_ready"),
        waitForReady: jest.fn(() => Promise.resolve(false)),
        waitForBluetoothClassic: jest.fn(({timeoutMs} = {}) => {
          // Mirror the real facade: resolve true as soon as Classic connects
          // during the wait window, false on timeout.
          if (realGlasses.useGlassesStore.getState().bluetoothClassicConnected) return Promise.resolve(true)
          return new Promise((resolve) => {
            const unsubscribe = realGlasses.useGlassesStore.subscribe(() => {
              if (realGlasses.useGlassesStore.getState().bluetoothClassicConnected) {
                clearTimeout(timer)
                unsubscribe()
                resolve(true)
              }
            })
            const timer = setTimeout(() => {
              unsubscribe()
              resolve(false)
            }, timeoutMs ?? 1000)
          })
        }),
      },
      miniapps: {
        // Delegates to the shared appStatusState fake (same as the useApps/
        // useStart hook mocks) so converted host code and tests assert against
        // one store double.
        list: jest.fn(() => [...appStatusState.apps]),
        onChanged: jest.fn(() => () => {}),
        buttonPressSubscribers: jest.fn(() => []),
        onButtonPressSubscribersChanged: jest.fn(() => () => {}),
        refresh: jest.fn((...a) => appStatusState.refresh(...a) ?? Promise.resolve()),
        start: jest.fn((...a) => appStatusState.start(...a) ?? Promise.resolve(true)),
        stop: jest.fn((...a) => appStatusState.stop(...a) ?? Promise.resolve()),
        setForeground: jest.fn((...a) => appStatusState.setForeground(...a) ?? Promise.resolve()),
        clearForeground: jest.fn(() => appStatusState.clearForeground()),
        stopAll: jest.fn((...a) => appStatusState.stopAll(...a) ?? Promise.resolve({is_ok: () => true})),
        install: jest.fn(() => Promise.resolve({is_ok: () => true})),
        uninstall: jest.fn(() => Promise.resolve({is_ok: () => true})),
        saveScreenshot: jest.fn((...a) => appStatusState.saveScreenshot(...a) ?? Promise.resolve()),
        setHiddenStatus: jest.fn((...a) => appStatusState.setHiddenStatus(...a)),
      },
      session: {
        status: jest.fn(() => ({status: "disconnected", audioTransport: "none"})),
        onStatus: jest.fn(() => () => {}),
        isConnected: jest.fn(() => false),
        account: {
          delete: jest.fn(() => Promise.resolve({is_ok: () => true, is_error: () => false})),
          confirmDelete: jest.fn(() => Promise.resolve({is_ok: () => true, is_error: () => false})),
        },
      },
      settings: {
        // Real store-backed (host services converted to engine.settings assert
        // settings-driven behavior, not just delegation) — jest.fn-wrapped so
        // call assertions still work.
        get: jest.fn((key) => {
          // Mirror the facade's shallow-copy contract so tests can't mutate
          // shared store state through returned values.
          const value = realSettings.useSettingsStore.getState().getSetting(key)
          if (Array.isArray(value)) return [...value]
          if (value && typeof value === "object") return {...value}
          return value
        }),
        set: jest.fn((key, value, syncToServer = true) =>
          realSettings.useSettingsStore.getState().setSetting(key, value, syncToServer),
        ),
        onChanged: jest.fn((key, cb) => realSettings.useSettingsStore.subscribe((st) => st.getSetting(key), cb)),
        descriptor: jest.fn((key) => realSettings.SETTINGS[key]),
        keys: jest.fn(() => Object.keys(realSettings.SETTINGS)),
        resetAllLocal: jest.fn(() => realSettings.useSettingsStore.getState().resetAllSettingsLocally()),
        loadAll: jest.fn(() => realSettings.useSettingsStore.getState().loadAllSettings()),
        getAll: jest.fn(() => ({...realSettings.useSettingsStore.getState().settings})),
        setManyLocal: jest.fn((values) => realSettings.useSettingsStore.getState().setManyLocally(values)),
      },
      dev: {
        minimumClientVersion: jest.fn(() =>
          Promise.resolve({is_ok: () => true, value: {required: "0", recommended: "0"}}),
        ),
        backendUrl: jest.fn(() => undefined),
        setBackendUrl: jest.fn(() => Promise.resolve({is_ok: () => true, is_error: () => false})),
        cloudUrls: jest.fn(() => ({})),
        setCloudUrls: jest.fn(),
        savedUrls: jest.fn(() => []),
        reconnectCloud: jest.fn(),
        getMemoryMB: jest.fn(() => 0),
        loadDevMiniapp: jest.fn(() => Promise.resolve({ok: false, error: "not available in tests"})),
        bluetoothStatus: jest.fn(() => {
          const {setCoreInfo: _s, reset: _r, ...state} = realCore.useCoreStore.getState()
          return {...state}
        }),
      },
      reports: {
        submit: jest.fn(() => Promise.resolve({status: "submitted", reportId: "test", reportStatus: "ready"})),
      },
      ota: {
        updateAvailable: jest.fn(() => realGlasses.useGlassesStore.getState().otaUpdateAvailable),
        status: jest.fn(() => realGlasses.useGlassesStore.getState().otaStatus),
        snapshot: jest.fn(() => otaSnapshot()),
        onUpdateAvailable: jest.fn(() => () => {}),
        onStatus: jest.fn(() => () => {}),
        onSnapshot: jest.fn((cb) => realGlasses.useGlassesStore.subscribe(() => cb(otaSnapshot()))),
        checkForUpdates: jest.fn((options) => realOtaUpdateCheck.checkCurrentGlassesForUpdate(options)),
        clearUpdateAvailable: jest.fn(() => realGlasses.useGlassesStore.getState().setOtaUpdateAvailable(null)),
        clearProgress: jest.fn(() => {
          const store = realGlasses.useGlassesStore.getState()
          store.setOtaProgress(null)
          store.setOtaStatus(null)
        }),
        markMtkUpdatedThisSession: jest.fn((updated) =>
          realGlasses.useGlassesStore.getState().setMtkUpdatedThisSession(updated),
        ),
        // Thin passthroughs — delegate to the shared bluetoothSdkMock so btsdk-call
        // assertions (e.g. ota/progress.test) keep working.
        install: jest.fn((...a) => bluetoothSdkMock.startOtaUpdate(...a)),
        ping: jest.fn((...a) => bluetoothSdkMock.ping(...a)),
        retry: jest.fn((...a) => bluetoothSdkMock.retryOtaVersionCheck(...a)),
        // The REAL install state machine (OtaInstallCoordinator) so the progress
        // screen tests exercise the moved watchdog/retry/reconnect behavior.
        installSession: {
          attach: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.attach()),
          detach: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.detach()),
          retry: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.retry()),
          finish: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.finish()),
          discard: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.discard()),
          snapshot: jest.fn(() => realOtaInstallCoordinator.otaInstallCoordinator.snapshot()),
          onSnapshot: jest.fn((cb) => realOtaInstallCoordinator.otaInstallCoordinator.onSnapshot(cb)),
        },
      },
      gallery: {
        status: jest.fn(() => ({})),
        onStatus: jest.fn(() => () => {}),
        onNotice: jest.fn(() => () => {}),
        sync: jest.fn(() => Promise.resolve()),
        cancel: jest.fn(() => Promise.resolve()),
      },
    },
    MediaLibraryPermissions: {
      checkPermission: jest.fn(() => Promise.resolve(true)),
      requestPermission: jest.fn(() => Promise.resolve(true)),
      saveToLibrary: jest.fn(() => Promise.resolve()),
    },
    BgTimer: {
      setInterval: jest.fn((callback, delay) => setInterval(callback, delay)),
      clearInterval: jest.fn((id) => clearInterval(id)),
      setTimeout: jest.fn((callback, delay) => setTimeout(callback, delay)),
      clearTimeout: jest.fn((id) => clearTimeout(id)),
    },
    // WebSocketStatus enum stays on the main entry (read-model type); the
    // connection store itself is internal-only.
    WebSocketStatus: realConnection.WebSocketStatus,
    // GlassesReadiness predicates (pure). Real-shaped impls so tests that
    // exercise readiness logic behave correctly.
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
    useApps: jest.fn(() => appStatusState.apps),
    useForegroundApp: jest.fn(() => null),
    useRefresh: jest.fn(() => appStatusState.refresh),
    useStopAll: jest.fn(() => appStatusState.stopAll),
    useStart: jest.fn(() => appStatusState.start),
    useStop: jest.fn(() => appStatusState.stop),
    sortAppsByLastOpenTime: jest.fn((apps) => apps),
    decideDevLaunchRoute: jest.fn(),
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
    throttle: jest.fn((callback) => callback),
    ISLAND_SETTINGS_KEYS: {},
  }

  // --- "@mentra/engine-host-internal": raw stores + service singletons ---
  const internal = {
    __esModule: true,
    // Real glasses store + its selectors/helpers (useGlassesStore, selectors,
    // waitForGlassesState, getGlasesInfoPartial, getGlassesSystemTimeMs, predicates)
    // — mock-side plumbing for the engine projections above; not part of the
    // real entry's export surface.
    ...realGlasses,
    // Real display/mirror store (useDisplayStore) — consumers need its real behavior.
    ...realDisplay,
    // Real core / connection / gallerySync stores (+ WebSocketStatus, selectors).
    ...realCore,
    ...realConnection,
    ...realGallerySync,
    // Real cloud-client runtime status store (useCloudClientStatusStore).
    ...realCloudStatus,
    // Real settings store (SETTINGS, useSettingsStore, useSetting, OFFLINE_APPLETS).
    ...realSettings,
    // Clock-skew utils (real, pure) — consumed by the host gallery sync + OTA checker.
    fixGlassesClockIfSkewed: realGlassesClockSync.fixGlassesClockIfSkewed,
    maybeFixGlassesClockFromVersionInfo: realGlassesClockSync.maybeFixGlassesClockFromVersionInfo,
    // OTA manifest-URL resolution (real, pure).
    resolveOtaManifestUrl: realOtaManifestUrl.resolveOtaManifestUrl,
    fetchVersionInfo: realOtaUpdateCheck.fetchVersionInfo,
    checkVersionUpdateAvailable: realOtaUpdateCheck.checkVersionUpdateAvailable,
    getLatestVersionInfo: realOtaUpdateCheck.getLatestVersionInfo,
    findMatchingMtkPatch: realOtaUpdateCheck.findMatchingMtkPatch,
    checkBesUpdate: realOtaUpdateCheck.checkBesUpdate,
    checkForOtaUpdate: realOtaUpdateCheck.checkForOtaUpdate,
    checkCurrentGlassesForUpdate: realOtaUpdateCheck.checkCurrentGlassesForUpdate,
    detectClockSkew: realGallerySyncClock.detectClockSkew,
    isSyncManifestEmpty: realGallerySyncClock.isSyncManifestEmpty,
    CLOCK_SKEW_TOLERANCE_MS: realGallerySyncClock.CLOCK_SKEW_TOLERANCE_MS,
    // Shared process-wide event bus (moved into island) — the REAL island
    // instance (not a fresh one) so the instance RestComms emits on is the same
    // one tests listen on across the boundary.
    GlobalEventEmitter: jest.requireActual("./modules/engine/src/utils/GlobalEventEmitter").default,
    // Gallery cluster moved into island; host consumers (GalleryScreen, gallery-settings,
    // NetworkMonitoring, MantleManager) import these from @mentra/engine-host-internal. Stub
    // them here so those screens/services load under the mock without native deps. The
    // gallery service's own jest test imports the REAL implementations by relative path.
    gallerySyncService: {
      initialize: jest.fn(),
      startSync: jest.fn(() => Promise.resolve()),
      cancelSync: jest.fn(() => Promise.resolve()),
      isSyncing: jest.fn(() => false),
      isSyncStarting: jest.fn(() => false),
      queryGlassesGalleryStatus: jest.fn(() => Promise.resolve()),
    },
    localStorageService: {
      getDownloadedFiles: jest.fn(() => Promise.resolve([])),
      convertToPhotoInfo: jest.fn((file) => file),
      convertToDownloadedFile: jest.fn((file) => file),
      saveDownloadedFile: jest.fn(() => Promise.resolve()),
      deleteDownloadedFile: jest.fn(() => Promise.resolve()),
      clearAllFiles: jest.fn(() => Promise.resolve()),
      getSyncState: jest.fn(() => Promise.resolve({total_downloaded: 0, total_size: 0})),
      updateSyncState: jest.fn(() => Promise.resolve()),
    },
    asgCameraApi: {
      setServer: jest.fn(),
      syncWithServer: jest.fn(() => Promise.resolve()),
      downloadCapture: jest.fn(() => Promise.resolve()),
      deleteFilesFromServer: jest.fn(() => Promise.resolve()),
    },
    gallerySettingsService: {
      getSettings: jest.fn(() => Promise.resolve({})),
      getAutoSaveToCameraRoll: jest.fn(() => Promise.resolve(false)),
      setAutoSaveToCameraRoll: jest.fn(() => Promise.resolve()),
    },
    emitGalleryNotice: jest.fn(),
    onGalleryNotice: jest.fn(() => () => {}),
    // island now owns the cloud client (keystone #5); the host wrapper delegates
    // to this. Mocked so host/service tests don't construct a real CloudClient.
    audioPlaybackService: {
      play: jest.fn(() => Promise.resolve()),
      stopForApp: jest.fn(),
    },
    cloudClientService: {
      init: jest.fn(),
      reconnect: jest.fn(),
      startManagedPhoto: jest.fn(() => Promise.resolve({})),
      awaitManagedPhotoReady: jest.fn(() => Promise.resolve({})),
      startManagedStream: jest.fn(() => Promise.resolve({})),
      getManagedStreamStatus: jest.fn(() => Promise.resolve({})),
      stopManagedStream: jest.fn(() => Promise.resolve()),
      isConnected: jest.fn(() => false),
      onConnectionChange: jest.fn(() => () => {}),
      getPreinstalledMiniappRegistry: jest.fn(() => Promise.resolve({entries: []})),
    },
    // Bluetooth SDK passthrough — the same mock singleton @mentra/bluetooth-sdk
    // is mocked with, so emitBluetoothSdkEvent/resetBluetoothSdkMock still drive
    // screens that import BluetoothSdk through island.
    BluetoothSdk: require("./src/test-utils/mockBluetoothSdk").bluetoothSdkMock,
    useAppStatusStore,
    installAppStoreHooks: jest.fn(),
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
    displayProcessor: {
      attachToRuntime: jest.fn(),
      processDisplayEvent: jest.fn((event) => ({...event, _processed: true})),
    },
    localDisplayManager: {
      attachToRuntime: jest.fn(),
      replayCurrent: jest.fn(),
      request: jest.fn(),
      dismiss: jest.fn(),
      onMount: jest.fn(),
      onUnmount: jest.fn(),
      onCoreAppChange: jest.fn(),
    },
    phonePhotoCoordinator: {
      owns: jest.fn(() => false),
      handlePhotoError: jest.fn(),
      takePhoto: jest.fn(() => Promise.resolve({photoUrl: "", mimeType: "image/jpeg", size: 0, requestId: "x"})),
    },
    phoneStreamCoordinator: {
      owns: jest.fn(() => false),
      handleGlassesStatus: jest.fn(),
      handleKeepAliveAck: jest.fn(),
      startUnmanaged: jest.fn(() => Promise.resolve({streamId: "x", status: "streaming"})),
      startManaged: jest.fn(() => Promise.resolve({streamId: "x", status: "streaming"})),
      stop: jest.fn(() => Promise.resolve()),
      setStatusSubscriber: jest.fn(),
    },
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
    configureRuntime: jest.fn(),
    configureLauncher: jest.fn(),
    miniappLauncher: {
      ensureConnected: jest.fn(() => Promise.resolve(true)),
      ensureRunning: jest.fn(() => Promise.resolve(true)),
      resolveBundle: jest.fn(() => Promise.resolve(null)),
      autostartLocalMiniapps: jest.fn(() => Promise.resolve()),
      stop: jest.fn(() => Promise.resolve()),
    },
    ensureMiniappEngine: jest.fn(() => ({
      router: {logRing: {snapshot: jest.fn(() => [])}},
      uiRouter: {bindWebView: jest.fn(), unbindWebView: jest.fn(), notifyReopen: jest.fn()},
      crashController: {},
    })),
    getMiniappEngine: jest.fn(() => null),
    sttModelManager: {
      isModelAvailable: jest.fn(() => Promise.resolve(false)),
    },
    getRuntimeHooks: jest.fn(() => ({})),
    normalizeManifestPermissions: jest.fn(),
    buildHardwareRequirements: jest.fn(() => []),
    saveLocalAppRunningState: jest.fn(),
  }

  // --- "@mentra/engine-host-internal/devtools": debug-only singletons ---
  const devtools = {
    __esModule: true,
    miniappRunningRegistry: {
      isRunning: jest.fn(() => false),
    },
    devServerBridge: {},
  }

  mockIslandEntriesCache = {main, internal, devtools}
  return mockIslandEntriesCache
}

jest.mock("@mentra/engine", () => mockIslandEntries().main)
jest.mock("@mentra/engine-host-internal", () => mockIslandEntries().internal)
jest.mock("@mentra/engine-host-internal/devtools", () => mockIslandEntries().devtools)

// Mock crust native module to avoid native bridge errors
jest.mock("@mentra/crust", () => ({
  default: {
    addListener: jest.fn(() => ({remove: jest.fn()})),
    showAVRoutePicker: jest.fn(),
    setNotificationConfig: jest.fn(() => Promise.resolve()),
    getInstalledApps: jest.fn(() => Promise.resolve([])),
    getInstalledAppsForNotifications: jest.fn(() => Promise.resolve([])),
    hasNotificationListenerPermission: jest.fn(() => Promise.resolve(false)),
    refreshNotificationListener: jest.fn(() => Promise.resolve(false)),
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

// The @mentra/engine mock above delegates engine.ota.installSession to the REAL
// OtaInstallCoordinator singleton. attach() is idempotent (`if (this.attached)
// return`), so a test that leaves it attached would leak its timers, store
// subscription, and session state into the next test in the same file. detach()
// after every test (a no-op when not attached) so each test starts clean.
afterEach(() => {
  jest.requireActual("./modules/engine/src/services/OtaInstallCoordinator").otaInstallCoordinator.detach()
  // The pairing mocks above delegate identity reads/writes to the REAL
  // PairingIdentity over the shared settings store; scrub the identity keys so
  // a test that marked a pending selection can't leak a stale identity into
  // the next test's identity()/onIdentity() reads.
  const {useSettingsStore: realSettingsStore, PAIRING_IDENTITY_KEYS: realIdentityKeys} = jest.requireActual(
    "./modules/engine/src/stores/settings",
  )
  const currentSettings = realSettingsStore.getState().settings
  if (realIdentityKeys.some((key) => currentSettings[key])) {
    const cleared = {...currentSettings}
    for (const key of realIdentityKeys) cleared[key] = ""
    realSettingsStore.setState({settings: cleared})
  }
})
