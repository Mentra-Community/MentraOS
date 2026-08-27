/**
 * `@mentra/engine` — the OEM-facing main entry.
 *
 * The `engine` namespace (configure/start/stop + typed domain facades), the
 * public contract/read-model types, and the pure helpers host UI legitimately
 * renders with (decision functions, sort/order helpers, policy constants,
 * capability tables, timers). Judgment rule: read models, commands, pure
 * functions and types belong here; anything that mutates runtime state or
 * exposes a raw store/service remains private to the MentraOS host.
 * See cloud-v2/docs/issues/020-glasses-status-boundary/integration-review.md §D.
 */

// The namespaced OEM-facing engine API (the "(A) host API"). See ./engine.
export {engine} from "./engine"
export type {
  ReportAttachmentInput,
  ReportContext,
  ReportDetails,
  ReportStatus,
  ReportTrigger,
  ReportSubmitResult,
  EngineSubmitReportInput,
} from "./facades/reports"
export type {IslandNotification, IslandNotificationKind} from "./facades/notifications"
export type {WifiSearchResult} from "./facades/glassesWifi"
export type {IdentitySnapshot} from "./services/PairingIdentity"
export type {DisplayMirrorEvent} from "./facades/displayMirror"
export type {
  IslandConfigureOptions,
  IslandAuth,
  IslandConfigValues,
  IslandAnalytics,
  IslandUiSeams,
  ScanQrOptions,
  ScanQrResult,
  SubjectTokenType,
} from "./runtime/bootstrap"

// Settings contract: the typed key registry (schema descriptors — the same
// surface engine.settings.descriptor()/keys() reads), the per-key React hook
// (the hook layer, same precedent as the apps hooks below), and the pure
// device-model key helpers. The raw useSettingsStore stays internal;
// imperative access goes through engine.settings.
export {SETTINGS, useSetting} from "./stores/settings"
export {MENTRA_LIVE_SETTING_KEYS, getBluetoothSettingKeysForDevice} from "./stores/bluetoothSettingKeys"

// Runtime-shared constants and contract DTOs.
export {ISLAND_SETTINGS_KEYS} from "./runtime/config"
export type {CloudClientStatusSnapshot, MiniappAuthToken, InteropAuditEvent, TtsSynthesisResult} from "./runtime/config"

// Pure readiness predicates over glasses connection state.
export {
  isGlassesConnected,
  isGlassesReady,
  isGlassesLinkLayerBusy,
  waitForGlassesReady,
  type GlassesConnectionStatus,
  type WaitForGlassesReadyOptions,
} from "./services/GlassesReadiness"
// Pure connect/reconnect decision helpers (host UI renders the outcome).
export {
  decideReconnect,
  decideConnectButtonAction,
  type ReconnectDecision,
  type ReconnectDecisionInput,
  type ConnectButtonAction,
} from "./services/ConnectionCoordinator"

// OTA read-model types for host OTA UI (progress screen, error mapping,
// progress section) — the check/install machinery itself is internal.
export type {
  VersionInfo,
  MtkPatch,
  BesFirmware,
  VersionJson,
  OtaCheckResult,
  OtaCheckCurrentGlassesResult,
  OtaCheckCurrentGlassesOptions,
} from "./services/OtaUpdateCheckService"
// OTA install policy (watchdog timings + failure copy) + display-state
// derivation, consumed by the OTA screens and their tests.
export {
  MINIMUM_OTA_STATUS_BUILD,
  MAX_RETRIES,
  RETRY_INTERVAL_MS,
  PROGRESS_TIMEOUT_MS,
  DOWNLOAD_STUCK_TIMEOUT_MS,
  MTK_INSTALL_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  PING_INTERVAL_MS,
  QUERY_REPLY_TIMEOUT_MS,
  OtaProgressMessages,
} from "./services/otaInstallPolicy"
export {deriveDisplayState} from "./services/otaDisplayState"
export type {DisplayState} from "./services/otaDisplayState"
export type {
  OtaProgress,
  OtaProgressStatus,
  OtaStatus,
  OtaUpdateInfo,
  ReleaseChangelog,
  OtaSnapshot,
  OtaInstallSnapshot,
} from "./facades/ota"
export {
  beginOtaAutoChain,
  clearOtaAutoChainReconnectWait,
  isOtaAutoChainActive,
  otaAutoChainFingerprint,
  otaAutoChainReconnectWaitRemaining,
  stopOtaAutoChain,
  tryAdvanceOtaAutoChain,
  MAX_OTA_AUTO_CHAIN_PASSES,
  OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS,
} from "./services/OtaAutoChain"
export type {OtaAutoChainAdvanceResult} from "./services/OtaAutoChain"
export {
  BES_INSTALL_RESTART_MESSAGE,
  getOtaErrorMessage,
  shouldRequireGlassesRebootForBesFailure,
  shouldShowChangeWifiForOtaDownloadFailure,
} from "./services/OtaErrorMapping"

// Gallery read models: engine.gallery.onNotice payload types, the media
// permission helper + display-name derivation host gallery UI uses, and the
// glasses-camera DTO types (re-exported through the host @/types/asg shim).
export type {GalleryNotice, GalleryNoticeCode} from "./services/asg/galleryNotices"
export {MediaLibraryPermissions} from "./utils/permissions/MediaLibraryPermissions"
export {deriveGalleryDisplayName} from "./utils/permissions/galleryDisplayName"
export type {
  PhotoInfo,
  CaptureFile,
  CaptureGroup,
  GalleryResponse,
  ServerStatus,
  HealthResponse,
  GalleryEvent,
} from "./types/asg"

// Bluetooth SDK event types host UI subscribes to via engine facades (the
// BluetoothSdk singleton passthrough itself is internal).
export type {PairFailureEvent, GlassesNotReadyEvent} from "@mentra/bluetooth-sdk"

// Cloud connection status enum (read model; the connection store is internal).
export {WebSocketStatus} from "./stores/connection"

// App-list hook layer + pure list helpers (the raw useAppStatusStore and
// installAppStoreHooks wiring are internal).
export {
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
  type StartOptions,
  type OrderMap,
} from "./stores/apps"

// Pure dev-miniapp launch-route decision (registration itself is internal).
export {
  decideDevLaunchRoute,
  type DecideDevLaunchOptions,
  type DevLaunchResult,
  type DevManifest,
} from "./utils/devMiniappLaunch"
export {HardwareCompatibility, type CompatibilityResult} from "./utils/hardware"
// Build-owned miniapp identity is a pure host policy. Host UI uses the same
// predicate as AppRegistry so SYSTEM actions cannot drift from enforcement.
export {isSystemMiniappPackage} from "./services/SystemMiniappPolicy"
export {BgTimer, throttle, debounce} from "./utils/timers"

// Hardware types and capability profiles.
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
