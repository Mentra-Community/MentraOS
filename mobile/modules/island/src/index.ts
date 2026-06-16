// Services
export {default as webviewBridge} from "./services/WebviewBridge"
export {miniappRunningRegistry} from "./services/MiniappRunningRegistry"
export {
  default as appRegistry,
  normalizeManifestPermissions,
  normalizeManifestActions,
  buildHardwareRequirements,
  saveLocalAppRunningState,
  registerDevApp,
  unregisterDevApp,
  getDevAppRecords,
  DEV_APP_PACKAGE_NAME,
  type DevAppRecord,
} from "./services/AppRegistry"
export {default as devServerBridge} from "./services/DevServerBridge"
export {default as displayProcessor} from "./services/DisplayProcessor"
export {default as localDisplayManager, type DisplayPayload} from "./services/LocalDisplayManager"
export {default as localMiniappRuntime, type InstalledMiniappManifest} from "./services/LocalMiniappRuntime"
export {
  miniappLauncher,
  configureLauncher,
  type LauncherDeps,
  type LaunchHints,
  type LaunchResult,
  type ResolvedBundle,
} from "./services/MiniappLauncher"
export {
  MentraJSRouter,
  type MentraJSCrustBinding,
  type OutboundMessagePayload as MentraJSOutboundMessage,
  type RouterLogger as MentraJSRouterLogger,
} from "./services/MentraJSRouter"
export {buildMentraUiShim, type MentraUiShimOptions} from "./services/mentraUiShim"
export {MentraUIRouter, type MentraUICrustBinding} from "./services/MentraUIRouter"
export {
  MentraJSCrashController,
  type CrashState,
  type CrashOutcome,
  type CrashControllerOptions,
} from "./services/MentraJSCrashController"
export {
  redactSecrets,
  MentraJSLogThrottle,
  MentraJSLogRingBuffer,
  type ThrottleOptions,
} from "./services/MentraJSLogPipeline"
export {default as localSttFallbackCoordinator} from "./services/LocalSttFallbackCoordinator"
export {default as micStateCoordinator} from "./services/MicStateCoordinator"
export {
  default as sttModelManager,
  STTModelManager,
  type LanguageInfo as SttLanguageInfo,
  type LanguageConfig as SttLanguageConfig,
  type DownloadProgress as SttDownloadProgress,
  type ExtractionProgress as SttExtractionProgress,
} from "./services/STTModelManager"
export {default as ttsModelManager, TTSModelManager} from "./services/TTSModelManager"
export {
  default as offlineSpeechModelService,
  type DownloadStatus as OfflineModelDownloadStatus,
  type DownloadStage as OfflineModelDownloadStage,
} from "./services/OfflineSpeechModelService"
export {
  isGlassesConnected,
  isGlassesReady,
  isGlassesLinkLayerBusy,
  waitForGlassesReady,
  type GlassesConnectionStatus,
  type WaitForGlassesReadyOptions,
} from "./services/GlassesReadiness"
export {
  decideReconnect,
  decideConnectButtonAction,
  type ReconnectDecision,
  type ReconnectDecisionInput,
  type ConnectButtonAction,
} from "./services/ConnectionCoordinator"

// The namespaced OEM-facing toolkit API (the "(A) host API"). Additive — grows one
// facade at a time alongside the flat exports below. See ./island.
export {toolkit} from "./island"
export type {WifiSearchResult} from "./facades/glassesWifi"
export type {DisplayMirrorEvent} from "./facades/displayMirror"
export type {
  IslandConfigureOptions,
  IslandAuth,
  IslandConfigValues,
  IslandAnalytics,
  SubjectTokenType,
} from "./runtime/bootstrap"

// Glasses device-state store — moved into island so island owns device state.
// Re-exported through the host's @/stores/glasses shim so the app keeps its
// imports. Also surfaced as toolkit.glassesStore (the escape hatch). Predicates
// (isGlassesConnected/…) come from GlassesReadiness above, not re-exported here.
export {
  useGlassesStore,
  selectGlassesConnected,
  selectGlassesReady,
  getGlasesInfoPartial,
  getGlassesSystemTimeMs,
  waitForGlassesState,
} from "./stores/glasses"
// Display/mirror store — also moved into island; re-exported through the host's
// @/stores/display shim (and toolkit.displayStore). Read it via toolkit.display.mirror.
export {useDisplayStore} from "./stores/display"
// More device/runtime stores moved into island (re-exported via host shims +
// toolkit.stores.*). WebSocketStatus + PhotoInfo were relocated off host modules.
export {useCoreStore} from "./stores/core"
export {useConnectionStore, WebSocketStatus} from "./stores/connection"
export {
  useGallerySyncStore,
  selectSyncProgress,
  selectIssyncing,
  selectGlassesGalleryStatus,
} from "./stores/gallerySync"
export type {PhotoInfo, SyncState, HotspotInfo, SyncQueue, GallerySyncInfo} from "./stores/gallerySync"
// Cloud-client runtime status store + secure credential store — moved into
// island as part of owning the cloud-v2 client. Re-exported via host shims
// (@/stores/cloudClientStatus, @/utils/cloudClient/MmkvSecureStore).
export {useCloudClientStatusStore} from "./stores/cloudClientStatus"
export type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus} from "./stores/cloudClientStatus"
export {cloudSecureStore} from "./utils/cloudClient/cloudSecureStore"
// The cloud-client singleton now lives in island (keystone #5). Construction +
// runtime-hook wiring happen here; the host's @/services/cloudClient is a thin
// delegating wrapper that keeps endpoint resolution (dev/settings) host-side.
export {cloudClientService} from "./services/CloudClientService"

// Bluetooth SDK passthrough — the full @mentra/bluetooth-sdk surface re-exported
// so the app reaches the SDK through island instead of importing it directly.
// This is the escape hatch for what no island facade models yet (OTA, raw device
// control); prefer a facade when one exists. The curated public
// @mentra/bluetooth-sdk entry is for external enterprise SDK consumers — inside
// the app we use the complete (internal) surface.
// Resolved by relative path to bluetooth-sdk's built output (postinstall builds
// bluetooth-sdk before island). "@mentra/bluetooth-sdk-internal" is only a
// mobile-app tsconfig alias — it does not resolve in island's own standalone
// build (whose tsconfig is regenerated by expo-module). The path resolves
// identically from island's src (typecheck) and build (runtime), since both sit
// one level under modules/island.
export {default as BluetoothSdk} from "../../bluetooth-sdk/build/_internal"
export type {PairFailureEvent, GlassesNotReadyEvent} from "../../bluetooth-sdk/build/_internal"

// Runtime config (host-injected adapters)
export {
  configureRuntime,
  getRuntimeHooks,
  ISLAND_SETTINGS_KEYS,
  type RuntimeHooks,
  type SocketCommsAdapter,
  type CloudClientStatusSnapshot,
  type CloudRuntimeAdapter,
  type AudioPlaybackAdapter,
  type AudioPlayRequest,
  type SettingsAccessor,
  type StoreAccessor,
  type GlassesSnapshot,
  type StreamingAdapter,
  type PhotoAdapter,
  type InteropAdapter,
  type InteropAuditEvent,
} from "./runtime/config"

// Stores
export {
  useAppStatusStore,
  configureIsland,
  DUMMY_APPLET,
  saveAppsOrder,
  getAppsOrder,
  sortAppsByPackageNamePriority,
  saveLastOpenTime,
  getLastOpenTime,
  sortAppsByLastOpenTime,
  useApps,
  useStart,
  useStop,
  useSetForeground,
  useClearForeground,
  useRefresh,
  useStopAll,
  useInstall,
  useUninstall,
  useActiveApps,
  useActiveBackgroundApps,
  useBackgroundApps,
  useActiveForegroundApp,
  useForegroundApp,
  useActiveBackgroundAppsCount,
  useLocalMiniApps,
  type IslandHostHooks,
  type StartOptions,
  type OrderMap,
} from "./stores/apps"

// Utils
export {
  buildMiniappGlobalsScript,
  getCapsuleMenuRect,
  type BuildMiniappGlobalsOptions,
  type CapsuleMenuRect,
  type MiniappColorScheme,
  type MiniappSafeArea,
} from "./utils/miniappGlobals"
export {decideDevLaunchRoute, type DevLaunchResult, type DevManifest} from "./utils/devMiniappLaunch"
export {createCloudUdpSocket} from "./utils/cloudClient/RnUdpAdapter"
export {HardwareCompatibility, type CompatibilityResult} from "./utils/hardware"
export {BgTimer, throttle, debounce} from "./utils/timers"
export {storage, printDirectory} from "./utils/storage"

// Types (copied from @mentra/types — keep in sync with cloud/packages/types/src)
export {
  HardwareType,
  HardwareRequirementLevel,
  DeviceTypes,
  ControllerTypes,
  HARDWARE_CAPABILITIES,
  getModelCapabilities,
  simulatedGlasses,
  evenRealitiesG1,
  evenRealitiesG2,
  mentraLive,
  vuzixZ100,
  mentraDisplay,
} from "./types"
export type {
  HardwareRequirement,
  CameraCapabilities,
  DisplayCapabilities,
  MicrophoneCapabilities,
  SpeakerCapabilities,
  IMUCapabilities,
  ButtonCapabilities,
  LightCapabilities,
  PowerCapabilities,
  Capabilities,
  AppletType,
  AppPermissionType,
  AppletPermission,
  AppletInterface,
  ClientApp,
} from "./types"
