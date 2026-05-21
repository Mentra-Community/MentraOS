// Services
export {default as webviewBridge} from "./services/WebviewBridge"
export {miniappRunningRegistry} from "./services/MiniappRunningRegistry"
export {
  default as appRegistry,
  normalizeManifestPermissions,
  buildHardwareRequirements,
  saveLocalAppRunningState,
} from "./services/AppRegistry"
export {default as devServerBridge} from "./services/DevServerBridge"
export {default as displayProcessor} from "./services/DisplayProcessor"
export {default as localDisplayManager, type DisplayPayload} from "./services/LocalDisplayManager"
export {default as localMiniappRuntime, type InstalledMiniappManifest} from "./services/LocalMiniappRuntime"
export {default as localSttFallbackCoordinator} from "./services/LocalSttFallbackCoordinator"
export {default as micStateCoordinator} from "./services/MicStateCoordinator"

// Runtime config (host-injected adapters)
export {
  configureRuntime,
  getRuntimeHooks,
  ISLAND_SETTINGS_KEYS,
  type RuntimeHooks,
  type SocketCommsAdapter,
  type AudioPlaybackAdapter,
  type AudioPlayRequest,
  type SettingsAccessor,
  type StoreAccessor,
  type GlassesSnapshot,
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
  useRefresh,
  useStopAll,
  useInstall,
  useUninstall,
  useActiveApps,
  useActiveBackgroundApps,
  useBackgroundApps,
  useActiveForegroundApp,
  useActiveBackgroundAppsCount,
  useLocalMiniApps,
  useForegroundMiniApp,
  useSetForeground,
  useClearForeground,
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
