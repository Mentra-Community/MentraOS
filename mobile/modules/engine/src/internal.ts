/**
 * MentraOS-only migration surface, re-exported by the private
 * `@mentra/engine-host-internal` workspace package.
 *
 * Raw zustand stores and service singletons that the Mentra app's host-side
 * services (and the `@/stores/*` / `@/utils/*` shims) still reach into while
 * the typed `engine` facades grow. Everything here either mutates runtime
 * state or exposes a store/service directly, so none of it belongs on the
 * OEM-facing `@mentra/engine` main entry: new host code should read/act
 * through `engine.*` instead.
 *
 * Every `/internal` import in mobile/src is counted (report-only) by
 * scripts/check-mobile-runtime-boundary.sh; the burn-down plan is
 * cloud-v2/docs/issues/020-glasses-status-boundary/integration-review.md §D.
 * Types that only describe these internal surfaces live here with them;
 * types host UI renders with stay on the main entry.
 */

// Miniapp runtime plumbing: WebView bridge, registry, launcher, engine.
export {default as webviewBridge} from "./services/WebviewBridge"
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
  type InstallBundleOptions,
  type MiniappReleaseIdentity,
} from "./services/AppRegistry"
export {sha256Hex} from "./utils/sha256"
export {
  isHostTrustedSystemMiniapp,
  isPreinstalledMiniappPackageAllowed,
  shouldActivateBundledVersion,
} from "./services/SystemMiniappPolicy"
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
// WebView-injection script builders (miniapp globals + mentra-ui shim).
export {
  buildMiniappGlobalsScript,
  getCapsuleMenuRect,
  type BuildMiniappGlobalsOptions,
  type CapsuleMenuRect,
  type MiniappColorScheme,
  type MiniappSafeArea,
} from "./utils/miniappGlobals"

// Speech/audio coordinators and model managers.
export {default as localSttFallbackCoordinator} from "./services/LocalSttFallbackCoordinator"
export {default as micStateCoordinator} from "./services/MicStateCoordinator"
export {default as audioPlaybackService} from "./services/AudioPlaybackService"
export {default as sttModelManager, STTModelManager} from "./services/STTModelManager"
export {default as ttsModelManager, TTSModelManager} from "./services/TTSModelManager"
export {default as offlineSpeechModelService} from "./services/OfflineSpeechModelService"

export {default as navigationService} from "./services/NavigationService"
// Phone GPS — the background location task + tier control. Importing this
// module registers the background task, so the entry that MantleManager loads
// must keep re-exporting it (was: the main barrel).
export {phoneLocationService, stopPhoneLocation} from "./services/PhoneLocationService"
// Clock-skew fix commands (BLE writes) used by OTA + gallery sync.
export {fixGlassesClockIfSkewed, maybeFixGlassesClockFromVersionInfo} from "./services/glassesClockSync"
// OTA manifest-URL resolution (dev-override/legacy-build/env/prod).
export {resolveOtaManifestUrl} from "./services/otaManifestUrl"
// Flat OTA check helpers (network + BLE state). Host usage is a tracked
// burn-down surface (§F); the sanctioned path is engine.ota.checkForUpdates().
export {
  fetchVersionInfo,
  checkVersionUpdateAvailable,
  getLatestVersionInfo,
  findMatchingMtkPatch,
  checkBesUpdate,
  checkForOtaUpdate,
  checkCurrentGlassesForUpdate,
} from "./services/OtaUpdateCheckService"

// Gallery cluster — sync orchestrator, glasses-camera HTTP API, media/storage,
// settings, validation and the service-to-service notice bus. Host gallery UI
// renders engine.gallery; these are the underlying services.
export {detectClockSkew, isSyncManifestEmpty, CLOCK_SKEW_TOLERANCE_MS} from "./services/gallerySyncClock"
export {gallerySyncService} from "./services/asg/gallerySyncService"
export {asgCameraApi} from "./services/asg/asgCameraApi"
export {localStorageService} from "./services/asg/localStorageService"
export {mediaProcessingQueue} from "./services/asg/mediaProcessingQueue"
export {gallerySettingsService} from "./services/asg/gallerySettingsService"
export {cameraRollExportCoordinator, type CameraRollExportSummary} from "./services/asg/cameraRollExportCoordinator"
export {
  INVALID_DOWNLOADED_MEDIA,
  validateCaptureMetadataForDownload,
  validateDownloadedMediaFile,
} from "./services/asg/galleryMediaValidation"
export {emitGalleryNotice, onGalleryNotice} from "./services/asg/galleryNotices"

// Phone-side capture coordinators.
export {phonePhotoCoordinator} from "./services/PhonePhotoCoordinator"
export {phoneStreamCoordinator} from "./services/PhoneStreamCoordinator"

// Raw runtime stores (re-exported via the host @/stores/* shims). Read models
// live on the engine facades; these are the migration escape hatch.
export {useDisplayStore, flushDisplayCoalesceForTests} from "./stores/display"
export {useCoreStore} from "./stores/core"
export {useConnectionStore} from "./stores/connection"
export {useCloudClientStatusStore} from "./stores/cloudClientStatus"
export type {RuntimeAudioTransport, RuntimeSnapshot, RuntimeStatus} from "./stores/cloudClientStatus"
export {SETTINGS, OFFLINE_APPLETS, useSettingsStore, useSetting} from "./stores/settings"
export {MENTRA_LIVE_SETTING_KEYS, getBluetoothSettingKeysForDevice} from "./stores/bluetoothSettingKeys"
export {useAppStatusStore, installAppStoreHooks, type AppStoreHooks} from "./stores/apps"

// Cloud client + credentials + v1 comms.
export {cloudSecureStore} from "./utils/cloudClient/cloudSecureStore"
export {cloudClientService} from "./services/CloudClientService"
export {createCloudUdpSocket} from "./utils/cloudClient/RnUdpAdapter"

// Log ring buffer + console interception (bug-report attachments).
export {logBuffer, type LogEntry} from "./utils/devLogging"

// Bluetooth SDK internal compatibility passthrough. Prefer an engine facade
// when one exists; this remains an escape hatch for app-only compatibility
// needs (its event TYPES stay on the main entry).
export {default as BluetoothSdk} from "@mentra/bluetooth-sdk/internal"

// Engine-owned MMKV instance + debug helper.
export {storage, printDirectory} from "./utils/storage"
// Process-wide event bus — one shared instance for engine services + host
// (re-exported via the @/utils/GlobalEventEmitter shim).
export {default as GlobalEventEmitter} from "./utils/GlobalEventEmitter"
