import type {ReleaseChangelog} from "../../facades/ota"

export type MentraLiveOtaFlowPage = "check" | "progress"

export type MentraLiveOtaScreen =
  | "initializing"
  | "checking"
  | "finishing"
  | "update_available"
  | "battery_required"
  | "wifi_required"
  | "up_to_date"
  | "dev_build"
  | "unofficial_client"
  | "check_failed"
  | "update_info_unavailable"
  | "starting"
  | "preparing_hotspot"
  | "updating"
  | "restarting"
  | "verifying"
  | "complete"
  | "failed"
  | "disconnected"

export type MentraLiveOtaErrorCode =
  | "check_failed"
  | "update_info_unavailable"
  | "install_failed"
  | "bes_restart_required"

export type MentraLiveOtaError = {
  code: MentraLiveOtaErrorCode
  /** English copy for hosts without localization. */
  message: string
  /**
   * Copy key for `message` when the failure maps to known copy, so localized hosts can
   * translate it. Null for phone-side watchdog and preflight messages, which are English-only.
   * Optional so host code that builds this type by hand keeps compiling; the hook always sets it.
   */
  copyKey?: string | null
  /**
   * Raw failure code reported by the glasses (`ota_status.error`), for support. Null when the
   * failure originated on the phone. Optional for the same source-compatibility reason.
   */
  glassesCode?: string | null
}

export type MentraLiveOtaTransport = "wifi" | "hotspot"
export type MentraLiveOtaHotspotPhase = "idle" | "downloading" | "starting_hotspot" | "joining_hotspot" | "serving"
export type MentraLiveOtaInstallPhase = "download" | "install"
export type MentraLiveOtaStep = "apk" | "mtk" | "bes"

export type MentraLiveOtaReleaseTransition = {
  /** Current glasses software label. Temporarily backed by the reported ASG app version. */
  fromVersion: string | null
  /** Exact coordinated release identity for the selected OTA pin. */
  toVersion: string
}

export type MentraLiveOtaState = {
  screen: MentraLiveOtaScreen
  connected: boolean
  batteryLevel: number | null
  transport: MentraLiveOtaTransport | null
  updateRequired: boolean
  versionChange: boolean
  versionChangeConverged: boolean
  versionChangePhase: "installing" | "restarting" | "verifying" | null
  wifiConnected: boolean
  wifiStatusKnown: boolean
  hotspotSupported: boolean
  hotspotPhase: MentraLiveOtaHotspotPhase
  hotspotArtifactPercent: number | null
  /**
   * Current phone download context. Index is zero-based; percent applies to this file only.
   * Optional for source compatibility; this hook returns null when no file is active.
   */
  hotspotArtifact?: {kind: MentraLiveOtaStep; index: number; totalCount: number} | null
  phase: MentraLiveOtaInstallPhase | null
  step: MentraLiveOtaStep | null
  currentStep: number | null
  totalSteps: number | null
  progress: number | null
  installingApkOnly: boolean
  firmwareRestarting: boolean
  error: MentraLiveOtaError | null
  canInstall: boolean
  canRetry: boolean
  canFinish: boolean
  canDismiss: boolean
  canDiscard: boolean
  canOpenWifiSetup: boolean
  continueDisabled: boolean
  /** True only after an approved update session reaches a final no-update check. */
  completedUpdate: boolean
  /** Release labels for the offered or just-completed coordinated update. */
  releaseTransition: MentraLiveOtaReleaseTransition | null
  /** Release notes crossed by this update, newest first. Populated on completion. */
  changelogs: ReleaseChangelog[]
  /** Sideloaded glasses client package, set only on the `unofficial_client` screen. */
  glassesPackageName: string | null
}

export type UseMentraLiveOtaOptions = {
  /** Entry page. `progress` exists for interrupted-session recovery. */
  initialPage?: MentraLiveOtaFlowPage
  /** Start Engine's OTA-only projections. Full Engine hosts should pass false. */
  initializeRuntime?: boolean
  /** Called after the final check or when an optional update is dismissed. */
  onFinished?: () => void
  /** Host-owned Wi-Fi setup for glasses without hotspot OTA support. */
  onOpenWifiSetup?: () => void
  /** Lets a host coordinate its connection overlay with OTA firmware restarts. */
  onFirmwareRestartingChange?: (restarting: boolean, progressActive: boolean) => void
}

export type MentraLiveOtaController = {
  state: MentraLiveOtaState
  check: () => void
  retryCheck: () => void
  install: () => void
  retryInstall: () => void
  finish: () => void
  discard: () => void
  openWifiSetup: () => void
}

export type CheckState = "checking" | "update_available" | "no_update" | "dev_build" | "unofficial_client" | "error"
