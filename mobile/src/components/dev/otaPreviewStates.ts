import type {MentraLiveOtaState} from "@mentra/engine/ota"

const base: MentraLiveOtaState = {
  screen: "update_available",
  connected: true,
  batteryLevel: 80,
  transport: "hotspot",
  updateRequired: false,
  versionChange: false,
  versionChangeConverged: false,
  versionChangePhase: null,
  wifiConnected: true,
  wifiStatusKnown: true,
  hotspotSupported: true,
  hotspotPhase: "idle",
  hotspotArtifactPercent: null,
  phase: null,
  step: null,
  currentStep: null,
  totalSteps: null,
  progress: null,
  installingApkOnly: false,
  firmwareRestarting: false,
  error: null,
  canInstall: true,
  canRetry: false,
  canFinish: true,
  canDismiss: true,
  canDiscard: false,
  canOpenWifiSetup: false,
  continueDisabled: false,
  completedUpdate: false,
  releaseTransition: null,
  changelogs: [],
  glassesPackageName: null,
}

const release = {fromVersion: "3.1.0", toVersion: "3.2.0"}
const changelogs = [
  {version: "3.2.0", markdown: "Sample release notes for preview.\n\n- Example improvement.\n- Example bug fix."},
]
const progress: Partial<MentraLiveOtaState> = {
  screen: "updating",
  phase: "download",
  step: "mtk",
  currentStep: 2,
  totalSteps: 3,
  progress: 42,
}

function page(label: string, state: Partial<MentraLiveOtaState>) {
  return {label, state: {...base, ...state}}
}

/** Developer scenario names; page copy comes from the real OTA renderer and translations. */
export const OTA_PREVIEW_PAGES = [
  page("Update available", {releaseTransition: release}),
  page("Required update", {releaseTransition: release, updateRequired: true, canDismiss: false}),
  page("Current version unknown", {releaseTransition: {...release, fromVersion: null}}),
  page("Initializing", {screen: "initializing"}),
  page("Checking for updates", {screen: "checking"}),
  page("Charge to update", {screen: "battery_required", batteryLevel: 18}),
  page("Version change required", {versionChange: true, releaseTransition: {fromVersion: "3.2.0", toVersion: "3.1.0"}}),
  page("WiFi required", {screen: "wifi_required", wifiConnected: false, releaseTransition: release}),
  page("Starting update", {screen: "starting"}),
  page("Downloading to phone", {
    screen: "preparing_hotspot",
    hotspotPhase: "downloading",
    hotspotArtifactPercent: 42,
    hotspotArtifact: {kind: "mtk", index: 1, totalCount: 3},
  }),
  page("Starting hotspot", {screen: "preparing_hotspot", hotspotPhase: "starting_hotspot"}),
  page("Joining hotspot", {screen: "preparing_hotspot", hotspotPhase: "joining_hotspot"}),
  page("Transferring to glasses", progress),
  page("Installing firmware", {...progress, phase: "install"}),
  page("Installing glasses software", {
    ...progress,
    phase: "install",
    step: "apk",
    currentStep: 1,
    installingApkOnly: true,
  }),
  page("Installing Bluetooth firmware", {...progress, phase: "install", step: "bes", currentStep: 3}),
  page("Downloading over WiFi", {...progress, transport: "wifi"}),
  page("Installing over WiFi", {...progress, transport: "wifi", phase: "install"}),
  page("Installing version change", {...progress, phase: "install", versionChange: true}),
  page("Version change restarting", {screen: "restarting", versionChange: true, versionChangePhase: "restarting"}),
  page("Version change verifying", {screen: "verifying", versionChange: true, versionChangePhase: "verifying"}),
  page("Restarting glasses", {screen: "restarting"}),
  page("Finishing update", {screen: "finishing"}),
  page("Update complete", {screen: "complete"}),
  page("Complete with release notes", {screen: "complete", releaseTransition: release, changelogs}),
  page("Version change complete", {screen: "complete", versionChange: true, versionChangeConverged: true}),
  page("Firmware pass complete", {screen: "complete", versionChange: true}),
  page("Up to date", {screen: "up_to_date"}),
  page("Final check complete", {screen: "up_to_date", completedUpdate: true, releaseTransition: release, changelogs}),
  page("Development build", {screen: "dev_build"}),
  page("Sideloaded client", {screen: "unofficial_client", glassesPackageName: "com.example.glasses"}),
  page("Update info unavailable", {screen: "update_info_unavailable"}),
  page("Check failed", {screen: "check_failed"}),
  page("Disconnected", {screen: "disconnected", connected: false}),
  page("Update failed", {
    screen: "failed",
    canRetry: true,
    canOpenWifiSetup: true,
    error: {code: "install_failed", copyKey: "ota:errorDownloadFailed", message: "", glassesCode: "download_failed"},
  }),
  page("Restart required after failure", {
    screen: "failed",
    error: {code: "bes_restart_required", copyKey: "ota:errorBesRestartRequired", message: ""},
  }),
]
