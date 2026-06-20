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
  getDevAppSourcePackage,
  getDevAppAttestation,
  DEV_APP_PACKAGE_NAME,
  type DevAppRecord,
} from "./services/AppRegistry"
export {default as devServerBridge} from "./services/DevServerBridge"
export {default as displayProcessor} from "./services/DisplayProcessor"
export {default as localDisplayManager, type DisplayPayload} from "./services/LocalDisplayManager"
export {default as localMiniappRuntime, type InstalledMiniappManifest} from "./services/LocalMiniappRuntime"
export {miniappLauncher, type LaunchHints, type LaunchResult, type ResolvedBundle} from "./services/MiniappLauncher"
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
export {ensureMiniappEngine, getMiniappEngine, type MiniappEngine} from "./services/MiniappEngine"
export {
  redactSecrets,
  MentraJSLogThrottle,
  MentraJSLogRingBuffer,
  type ThrottleOptions,
} from "./services/MentraJSLogPipeline"
export {default as localSttFallbackCoordinator} from "./services/LocalSttFallbackCoordinator"
export {default as micStateCoordinator} from "./services/MicStateCoordinator"
export {default as navigationService} from "./services/NavigationService"
export {default as audioPlaybackService} from "./services/AudioPlaybackService"
// Phone GPS — the background location task + tier control moved into island (was the
// host locationTier hook + a MantleManager defineTask). Exported so the barrel load
// registers the background task at @mentra/island import time.
export {phoneLocationService, stopPhoneLocation} from "./services/PhoneLocationService"
// Clock-skew utils (used by OTA + the host gallery sync) moved into island.
export {fixGlassesClockIfSkewed, maybeFixGlassesClockFromVersionInfo} from "./services/glassesClockSync"
export {detectClockSkew, isSyncManifestEmpty, CLOCK_SKEW_TOLERANCE_MS} from "./services/gallerySyncClock"
// Gallery cluster — the sync orchestrator + glasses-camera HTTP API + media/storage,
// moved into island. Host Gallery UI + tests import these from @mentra/island.
export {gallerySyncService} from "./services/asg/gallerySyncService"
export {asgCameraApi} from "./services/asg/asgCameraApi"
export {localStorageService} from "./services/asg/localStorageService"
export {mediaProcessingQueue} from "./services/asg/mediaProcessingQueue"
export {gallerySettingsService} from "./services/asg/gallerySettingsService"
export {
  INVALID_DOWNLOADED_MEDIA,
  validateCaptureMetadataForDownload,
  validateDownloadedMediaFile,
} from "./services/asg/galleryMediaValidation"
export {
  emitGalleryNotice,
  onGalleryNotice,
  type GalleryNotice,
  type GalleryNoticeCode,
} from "./services/asg/galleryNotices"
export {MediaLibraryPermissions} from "./utils/permissions/MediaLibraryPermissions"
export {deriveGalleryDisplayName} from "./utils/permissions/galleryDisplayName"
export type {CaptureFile, CaptureGroup, GalleryResponse, ServerStatus, HealthResponse, GalleryEvent} from "./types/asg"
export {phonePhotoCoordinator} from "./services/PhonePhotoCoordinator"
export {phoneStreamCoordinator} from "./services/PhoneStreamCoordinator"
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
export type {IslandNotification, IslandNotificationKind} from "./facades/notifications"
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
// The cloud-client singleton now lives in island (keystone #5). Construction and
// live runtime surfaces happen here; the host's @/services/cloudClient is a thin
// delegating wrapper that keeps endpoint resolution (dev/settings) host-side.
export {cloudClientService} from "./services/CloudClientService"
// Settings store + RestComms — the mutually-coupled v1-comms pair, moved into
// island together (settings needs RestComms for cloud-sync; RestComms needs
// settings for the backend URL). Re-exported via host shims (@/stores/settings,
// @/services/RestComms). v1-transitional: deleted in place when v1 retires.
export {SETTINGS, OFFLINE_APPLETS, useSettingsStore, useSetting} from "./stores/settings"
export {default as restComms} from "./services/RestComms"

// Bluetooth SDK internal compatibility passthrough. The island package uses the
// declared @mentra/bluetooth-sdk/internal subpath so it does not reach into SDK
// build output directly. Prefer an island facade when one exists; this remains
// an internal escape hatch for app-only compatibility needs.
export {default as BluetoothSdk} from "@mentra/bluetooth-sdk/internal"
export type {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk/internal"

// Runtime-shared constants and DTOs
export {
  ISLAND_SETTINGS_KEYS,
  configureRuntime,
  getRuntimeHooks,
  type CloudClientStatusSnapshot,
  type MiniappAuthToken,
  type InteropAuditEvent,
  type RuntimeHooks,
  type TtsSynthesisResult,
  type WifiSetupAdapter,
} from "./runtime/config"

// Stores
export {
  useAppStatusStore,
  installAppStoreHooks,
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
  type AppStoreHooks,
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
// Process-wide event bus — one shared instance for island services + host
// (re-exported via the @/utils/GlobalEventEmitter shim).
export {default as GlobalEventEmitter} from "./utils/GlobalEventEmitter"

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
