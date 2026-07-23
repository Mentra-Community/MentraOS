import {deriveDisplayState, type DisplayState, type OtaProgress, type OtaStatus} from "@mentra/engine"

type DeriveArgs = Parameters<typeof deriveDisplayState>[0]

const base: DeriveArgs = {
  otaStatus: null,
  otaProgress: null,
  connected: true,
  errorMsg: "",
  sawReconnectEdge: false,
}

const apkInProgress: OtaStatus = {
  sessionId: "s1",
  totalSteps: 1,
  currentStep: 1,
  stepType: "apk",
  phase: "download",
  stepPercent: 30,
  overallPercent: 30,
  status: "in_progress",
}

const apkFailed: OtaStatus = {
  sessionId: "s1",
  totalSteps: 1,
  currentStep: 1,
  stepType: "apk",
  phase: "download",
  stepPercent: 0,
  overallPercent: 0,
  status: "failed",
  error: "no_internet",
}

const apkComplete: OtaStatus = {
  sessionId: "s1",
  totalSteps: 1,
  currentStep: 1,
  stepType: "apk",
  phase: "install",
  stepPercent: 100,
  overallPercent: 100,
  status: "complete",
}

const apkStepComplete2: OtaStatus = {
  sessionId: "s1",
  totalSteps: 2,
  currentStep: 1,
  stepType: "apk",
  phase: "install",
  stepPercent: 100,
  overallPercent: 50,
  status: "step_complete",
}

const besInProgress: OtaStatus = {
  sessionId: "s1",
  totalSteps: 2,
  currentStep: 2,
  stepType: "bes",
  phase: "install",
  stepPercent: 40,
  overallPercent: 70,
  status: "in_progress",
}

const besStepComplete: OtaStatus = {
  sessionId: "s1",
  totalSteps: 2,
  currentStep: 2,
  stepType: "bes",
  phase: "install",
  stepPercent: 100,
  overallPercent: 100,
  status: "step_complete",
}

const besComplete: OtaStatus = {
  sessionId: "s1",
  totalSteps: 1,
  currentStep: 1,
  stepType: "bes",
  phase: "install",
  stepPercent: 100,
  overallPercent: 100,
  status: "complete",
}

const besFinishedLegacy: OtaProgress = {
  stage: "install",
  status: "FINISHED",
  progress: 100,
  bytesDownloaded: 0,
  totalBytes: 0,
  currentUpdate: "bes",
}

const besProgressLegacy: OtaProgress = {
  stage: "install",
  status: "PROGRESS",
  progress: 50,
  bytesDownloaded: 0,
  totalBytes: 0,
  currentUpdate: "bes",
}

// Legacy-shaped statuses (WP 8C): old (< 37) ASG builds send ota_progress, which the
// SDK maps to ota_status with sessionId "" / totalSteps 1 / FINISHED→"complete" at ANY
// phase. sessionId "" is the legacy-shape marker deriveDisplayState keys on.
const legacyShaped = (overrides: Partial<OtaStatus>): OtaStatus => ({
  sessionId: "",
  totalSteps: 1,
  currentStep: 1,
  stepType: "apk",
  phase: "download",
  stepPercent: 0,
  overallPercent: 0,
  status: "in_progress",
  ...overrides,
})

const legacyApkDownloadComplete = legacyShaped({stepType: "apk", phase: "download", status: "complete", stepPercent: 100, overallPercent: 100})
const legacyBesDownloadComplete = legacyShaped({stepType: "bes", phase: "download", status: "complete", stepPercent: 100, overallPercent: 100})
const legacyBesInstallComplete = legacyShaped({stepType: "bes", phase: "install", status: "complete", stepPercent: 100, overallPercent: 100})
const legacyApkInstallComplete = legacyShaped({stepType: "apk", phase: "install", status: "complete", stepPercent: 100, overallPercent: 100})
const legacyApkInstallInProgress = legacyShaped({stepType: "apk", phase: "install", status: "in_progress", stepPercent: 80, overallPercent: 80})

describe("deriveDisplayState", () => {
  const cases: Array<[string, Partial<DeriveArgs>, DisplayState]> = [
    ["Rule 1: errorMsg wins over in_progress", {errorMsg: "boom", otaStatus: apkInProgress}, "failed"],
    [
      "Rule 1: errorMsg wins even over BES complete + edge",
      {errorMsg: "boom", otaStatus: besComplete, connected: true, sawReconnectEdge: true},
      "failed",
    ],
    ["Rule 2: BES step_complete + edge -> complete", {otaStatus: besStepComplete, sawReconnectEdge: true}, "complete"],
    ["Rule 2: BES complete (1-step) + edge -> complete", {otaStatus: besComplete, sawReconnectEdge: true}, "complete"],
    ["Rule 3: BES terminal, no edge -> restarting", {otaStatus: besStepComplete}, "restarting"],
    ["Rule 3: BES terminal, disconnected -> restarting", {otaStatus: besStepComplete, connected: false}, "restarting"],
    ["Rule 3: legacy BES FINISHED -> restarting", {otaProgress: besFinishedLegacy}, "restarting"],
    [
      "Rule 3: legacy BES FINISHED + edge -> complete",
      {otaProgress: besFinishedLegacy, sawReconnectEdge: true},
      "complete",
    ],
    ["Rule 4: glasses failed -> failed", {otaStatus: apkFailed}, "failed"],
    ["Rule 5: non-BES complete -> complete", {otaStatus: apkComplete}, "complete"],
    [
      "Rule 6: APK step_complete multi-step disconnected -> starting (expected reboot)",
      {otaStatus: apkStepComplete2, connected: false},
      "starting",
    ],
    [
      "Rule 7: BES in_progress disconnected -> restarting (defensive)",
      {otaStatus: besInProgress, connected: false},
      "restarting",
    ],
    [
      "Rule 7: legacy BES PROGRESS disconnected -> restarting",
      {otaProgress: besProgressLegacy, connected: false},
      "restarting",
    ],
    ["Rule 8: disconnected, nothing -> disconnected", {connected: false}, "disconnected"],
    [
      "Rule 8: APK in_progress disconnected (1-step) -> disconnected",
      {otaStatus: apkInProgress, connected: false},
      "disconnected",
    ],
    ["Rule 9: in_progress connected -> updating", {otaStatus: apkInProgress}, "updating"],
    ["Rule 9: step_complete non-BES connected -> updating", {otaStatus: apkStepComplete2}, "updating"],
    ["Rule 10: fallback, idle connected -> starting", {}, "starting"],
    ["Edge: errorMsg + disconnected -> failed", {errorMsg: "err", connected: false}, "failed"],
    ["Edge: errorMsg + BES terminal -> failed", {errorMsg: "err", otaStatus: besComplete}, "failed"],
    ["Edge: sawReconnectEdge but not BES -> updating", {otaStatus: apkInProgress, sawReconnectEdge: true}, "updating"],
    [
      "Edge: BES step_complete, no edge, connected -> restarting",
      {otaStatus: besStepComplete, sawReconnectEdge: false, connected: true},
      "restarting",
    ],
    // WP 8C legacy-shape rules (sessionId "" from the SDK's ota_progress mapping):
    [
      "Legacy: apk download FINISHED (mapped complete) is not terminal -> updating",
      {otaStatus: legacyApkDownloadComplete},
      "updating",
    ],
    [
      "Legacy: bes download FINISHED (mapped complete) is not BES-terminal -> updating",
      {otaStatus: legacyBesDownloadComplete},
      "updating",
    ],
    [
      "Legacy: bes install FINISHED is BES-terminal -> restarting",
      {otaStatus: legacyBesInstallComplete},
      "restarting",
    ],
    [
      "Legacy: apk download complete + disconnected -> disconnected (matches legacy screen)",
      {otaStatus: legacyApkDownloadComplete, connected: false},
      "disconnected",
    ],
    [
      "Legacy: bes download complete + disconnected -> disconnected (flash not started)",
      {otaStatus: legacyBesDownloadComplete, connected: false},
      "disconnected",
    ],
    [
      "Legacy: apk install complete held by the settle window -> updating",
      {otaStatus: legacyApkInstallComplete, legacyApkSettleHold: true},
      "updating",
    ],
    [
      "Legacy: apk install complete held + disconnected (restarting glasses) -> updating",
      {otaStatus: legacyApkInstallComplete, legacyApkSettleHold: true, connected: false},
      "updating",
    ],
    [
      "Legacy: apk install complete without hold -> complete",
      {otaStatus: legacyApkInstallComplete},
      "complete",
    ],
    [
      "Legacy: build-number completion flag -> complete despite stale in-flight status",
      {otaStatus: legacyApkInstallInProgress, apkCompletedViaBuildIncrease: true},
      "complete",
    ],
    [
      "Legacy: build-number completion flag + disconnected -> complete",
      {apkCompletedViaBuildIncrease: true, connected: false},
      "complete",
    ],
    [
      "Unified: complete during download phase stays complete for real (>= 37) sessions",
      {otaStatus: {...apkComplete, phase: "download" as const}},
      "complete",
    ],
    [
      "Version-change: convergence completes despite a stale in-flight install status",
      {otaStatus: apkInProgress, versionChangeConverged: true},
      "complete",
    ],
    [
      "Version-change: convergence completes even while disconnected",
      {versionChangeConverged: true, connected: false},
      "complete",
    ],
    [
      "Version-change: convergence outranks a stale failed status (wipe cleared the session)",
      {otaStatus: apkFailed, versionChangeConverged: true, errorMsg: ""},
      "complete",
    ],
    [
      "Version-change: a bare complete before convergence is NOT success (refusal/stale)",
      {otaStatus: apkComplete, versionChangeSession: true, versionChangeConverged: false},
      "updating",
    ],
    [
      "Version-change: bare complete before convergence while disconnected -> disconnected",
      {otaStatus: apkComplete, versionChangeSession: true, versionChangeConverged: false, connected: false},
      "disconnected",
    ],
    [
      "Non-version-change complete is unaffected by the guard",
      {otaStatus: apkComplete},
      "complete",
    ],
  ]

  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(deriveDisplayState({...base, ...overrides})).toBe(expected)
  })
})
