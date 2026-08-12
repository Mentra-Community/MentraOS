/**
 * OtaInstallCoordinator — engine-owned OTA install state machine (WP 8B).
 *
 * Owns every timer/retry/sequencing rule that used to live in the host screen
 * `mobile/src/app/ota/progress.tsx`: the global session timeout, serialized
 * ota_start retries, the stuck-at-zero watchdog, the progress-stall watchdog keyed
 * on a staleness signature, connect-edge arbitration (initial mount vs
 * reconnect vs post-APK reboot), the ota_query_status reply fallback, the ping
 * keepalive, the ota_start_ack / mtk_update_complete listeners, and terminal
 * cleanup. The host progress screen is a pure renderer over
 * `snapshot()`/`onSnapshot()` plus the `attach()/detach()/retry()/finish()`
 * commands (exposed as `engine.ota.installSession`).
 *
 * The reaction pass mirrors the old component's effect ordering: a
 * pass diffs the store-derived inputs (connected / otaStatus / otaProgress /
 * displayState / stall signature) exactly like the old effect dep arrays, and
 * state written mid-pass queues a follow-up pass — the same way a setState
 * during React effects scheduled a re-render after the current effect batch.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk/internal"
import GlobalEventEmitter from "../utils/GlobalEventEmitter"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {resolveOtaManifestUrl} from "./otaManifestUrl"
import {deriveDisplayState, type DisplayState} from "./otaDisplayState"
import {
  BES_CONTINUE_LOCKOUT_MS,
  DOWNLOAD_STUCK_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  LEGACY_APK_COMPLETION_SETTLE_MS,
  LEGACY_BES_CONTINUE_LOCKOUT_MS,
  LEGACY_DOWNLOAD_STUCK_TIMEOUT_MS,
  LEGACY_GLOBAL_OTA_TIMEOUT_MS,
  LEGACY_MTK_INSTALL_TIMEOUT_MS,
  LEGACY_MTK_SIM_CAP_PERCENT,
  LEGACY_MTK_SIM_FLOOR_PERCENT,
  LEGACY_MTK_SIM_TICK_MS,
  LEGACY_MTK_STALL_DETECT_MS,
  LEGACY_MTK_STALL_ZONE_MAX_PERCENT,
  LEGACY_MTK_STALL_ZONE_MIN_PERCENT,
  LEGACY_PING_INTERVAL_MS,
  LEGACY_PROGRESS_TIMEOUT_MS,
  LEGACY_RETRY_INTERVAL_MS,
  MAX_RETRIES,
  MTK_INSTALL_TIMEOUT_MS,
  OtaProgressMessages,
  PING_INTERVAL_MS,
  PROGRESS_TIMEOUT_MS,
  QUERY_REPLY_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
  isLegacyShapedOtaSession,
  isLegacyShapedOtaStatus,
  selectOtaProtocolProfile,
  type OtaProtocolProfile,
} from "./otaInstallPolicy"

function isTerminalForWatchdog(d: DisplayState): boolean {
  return d === "complete" || d === "failed" || d === "restarting"
}

/** Non-empty when glasses are actively reporting work — drives stall timeout reset. */
function buildProgressStalenessSignature(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  displayState: DisplayState,
): string {
  if (displayState !== "starting" && displayState !== "updating") return ""
  if (otaStatus && (otaStatus.status === "in_progress" || otaStatus.status === "step_complete")) {
    return `s:${otaStatus.sessionId}|${otaStatus.status}|${otaStatus.phase}|${otaStatus.stepType}|${otaStatus.stepPercent}|${otaStatus.overallPercent}`
  }
  // Legacy-shaped BES download FINISHED (WP 8C): the legacy screen kept a progress
  // watchdog armed while waiting for the BES install events to start; keep the stall
  // watchdog armed here too so a wedged flash still fails instead of hanging.
  if (
    isLegacyShapedOtaStatus(otaStatus) &&
    otaStatus?.stepType === "bes" &&
    otaStatus.phase === "download" &&
    otaStatus.status === "complete"
  ) {
    return "s:legacy-bes-download-complete-await-install"
  }
  if (otaProgress && (otaProgress.status === "PROGRESS" || otaProgress.status === "STARTED")) {
    return `p:${otaProgress.currentUpdate}|${otaProgress.stage}|${otaProgress.status}|${otaProgress.progress}`
  }
  return ""
}

function progressTimeoutDurationMs(
  otaStatus: OtaStatus | null,
  otaProgress: OtaProgress | null,
  legacySession: boolean,
): number {
  if (otaStatus?.stepType === "mtk" && otaStatus.phase === "install") {
    return legacySession ? LEGACY_MTK_INSTALL_TIMEOUT_MS : MTK_INSTALL_TIMEOUT_MS
  }
  if (otaProgress?.currentUpdate === "mtk" && otaProgress.stage === "install") {
    return legacySession ? LEGACY_MTK_INSTALL_TIMEOUT_MS : MTK_INSTALL_TIMEOUT_MS
  }
  return legacySession ? LEGACY_PROGRESS_TIMEOUT_MS : PROGRESS_TIMEOUT_MS
}

function latestPercentForStuck(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): number {
  if (otaProgress?.progress != null) return otaProgress.progress
  if (otaStatus?.status === "in_progress" || otaStatus?.status === "step_complete") {
    return Math.max(otaStatus.overallPercent ?? 0, otaStatus.stepPercent ?? 0)
  }
  return 0
}

/**
 * "idle" ota_status means the glasses have no active session — that is NOT a
 * recovery signal, so the query-reply fallback must keep firing and retry
 * ota_start. Only treat real progress or a non-idle ota_status as a useful
 * reply that cancels the fallback.
 */
function hasRecoveringOtaReply(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): boolean {
  if (otaProgress) return true
  return !!otaStatus && otaStatus.status !== "idle"
}

/** Read model the host progress screen renders from. */
export interface OtaInstallSnapshot {
  displayState: DisplayState
  errorMsg: string
  continueButtonDisabled: boolean
  connected: boolean
  otaStatus: OtaStatus | null
  otaProgress: OtaProgress | null
  /**
   * Display-only simulated percent for legacy (< 37) MTK install stalls (WP 8C-e), or
   * null. The MTK system install goes quiet around 49-50%; the legacy screen simulated
   * +1% ticks up to 60% purely to reassure the user. Render max(real, simulated).
   */
  mtkInstallStallSimulatedPercent: number | null
  /** True for a downgrade (version-change) session — the UI narrates it differently. */
  isVersionChange: boolean
  /** True once the glasses reported the exact pinned target (the downgrade truly completed). */
  versionChangeConverged: boolean
  /**
   * Sub-phase of the downgrade detour for the progress narrative, or null when not
   * in one: "installing" before the handoff, "restarting" while the glasses are dark
   * (uninstall / factory flicker / target install), "verifying" once reconnected and
   * checking the version. Completion is the "complete" displayState.
   */
  versionChangePhase: "installing" | "restarting" | "verifying" | null
}

type OtaStartOutcome = "pending" | "acknowledged" | "rejected"

interface OtaStartOwnership {
  outcome: OtaStartOutcome
  promise: Promise<void>
}

class OtaInstallCoordinator {
  private attached = false

  // Genuinely session-local state (was component state/refs).
  private errorMsg = ""
  private sawReconnectEdge = false
  private continueButtonDisabled = false
  // True once this session reported an APK step. After an APK install the ASG
  // process restarts with a new build number, so finish() must clear the stale
  // one before check-for-updates re-checks (mirrors the legacy screen).
  private apkStepSeen = false
  private prevConnected = false

  // Legacy (< 37) compatibility state, ported from progress-legacy.tsx (WP 8C).
  // Build number at session start — legacy APK completion is detected by the build
  // number increasing past it when the explicit reconnect status never arrives.
  private initialBuildNumber: string | null = null
  // Captured with initialBuildNumber: whether the selected update includes an APK step.
  private apkExpectedInSession = false
  // Latched when the legacy build-number completion fires; projected as "complete".
  private apkCompletedViaBuildIncrease = false
  // The split routes selected legacy/unified behavior before navigation. Keep
  // that choice sticky while an APK step upgrades ASG mid-flow.
  private protocolProfile: OtaProtocolProfile | null = null

  // BES reboot recovery. Native bridges normalize explicit BES success to a
  // terminal status; pre-37 flows additionally retain the legacy screen's
  // lost-FINISHED fallback. Completion still requires a BES-specific observed
  // disconnect -> reconnect lifecycle, never the generic session reconnect flag.
  private besRestartExpected = false
  private besRestartDisconnectObserved = false
  private besRestartRecovery: "awaiting" | "complete" | null = null

  // Downgrade detour (version-change mode). Captured at attach from the selected
  // update: the pinned target is a LOWER build, executed by the recovery worker via
  // uninstall->reinstall, so the phone must NOT drive ota_start on the intermediate
  // reconnect (the passive factory build) and completion is exact-version
  // convergence, not a build-number increase.
  private versionChangeSession = false
  private versionChangeTarget: number | null = null
  // Set once ASG reports the apk install has started (the handoff point after which
  // ASG dies and the recovery worker owns the transaction).
  private versionChangeInstallStarted = false
  // Latched when a reconnect reports buildNumber === versionChangeTarget.
  private versionChangeConverged = false
  // Holds a legacy apk install FINISHED out of "complete" for the settle window.
  private legacyApkSettleHold = false
  // Display-only legacy MTK install stall simulation.
  private mtkSimulatedPercent: number | null = null
  private lastRealMtkProgress = 0

  // Timer handles
  private globalTimeout: ReturnType<typeof setTimeout> | null = null
  private globalTimeoutStarted = false
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private stuckTimeout: ReturnType<typeof setTimeout> | null = null
  private progressTimeout: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private queryReplyTimeout: ReturnType<typeof setTimeout> | null = null
  private continueLockoutTimer: ReturnType<typeof setTimeout> | null = null
  private legacyApkSettleTimer: ReturnType<typeof setTimeout> | null = null
  private mtkStallDetectTimer: ReturnType<typeof setTimeout> | null = null
  private mtkSimTickTimer: ReturnType<typeof setInterval> | null = null

  // Request / retry bookkeeping (no glasses source)
  // At most one apk-install status poll in flight (native rejects concurrent queries).
  private apkInstallPollInFlight = false
  // The native SDK owns one ota_start request until its application-level ack or
  // timeout. Keep pending ownership across attach/detach, and retain the settled
  // outcome while attached so Retry/query fallback cannot reinterpret an accepted
  // command as permission to start a second OTA transaction.
  private otaStartOwnership: OtaStartOwnership | null = null
  private hasFirstActivity = false
  // Stuck-at-zero watchdog clears only on first NON-ZERO progress; "first activity"
  // alone (e.g. ota_status with stepPercent=0) used to clear it too eagerly.
  private hasFirstNonZeroProgress = false
  private retryCount = 0

  // Log displayState transitions only (not every pass).
  private prevDisplayState: DisplayState | null = null

  // Last-handled reaction inputs — the equivalents of the old effect dep arrays.
  private lastConnected = false
  private lastOtaStatus: OtaStatus | null = null
  private lastOtaProgress: OtaProgress | null = null
  private lastBuildNumber = ""
  private lastDisplayState: DisplayState | null = null
  private lastStallSig = ""

  // Reaction pass re-entrancy guard (mirrors React deferring a setState-during-
  // effects re-render until the current effect batch finished).
  private reacting = false
  private reactQueued = false

  private storeUnsubscribe: (() => void) | null = null
  private snapshotCheckers = new Set<() => void>()

  // --- public surface (engine.ota.installSession) ---

  /**
   * Bind the state machine to a mounted progress screen. Idempotent per
   * attach/detach cycle. Runs the initial-mount arbitration (send ota_start
   * when connected with no session; otherwise ota_query_status + reply
   * fallback) and starts reacting to store changes + BLE OTA events.
   */
  attach(): void {
    if (this.attached) return
    this.attached = true
    this.resetSessionState()
    const initialState = useGlassesStore.getState()
    this.protocolProfile = selectOtaProtocolProfile(
      initialState.otaStatus,
      initialState.otaProgress,
      initialState.buildNumber,
    )
    const selected = initialState.otaUpdateAvailable
    if (selected?.isDowngrade && typeof selected.versionCode === "number" && selected.versionCode > 0) {
      this.versionChangeSession = true
      this.versionChangeTarget = selected.versionCode
      console.log(`[OTA_PROGRESS] version-change (downgrade) session, target=${selected.versionCode}`)
    }
    this.prevConnected = isGlassesConnected(useGlassesStore.getState().connection)
    this.storeUnsubscribe = useGlassesStore.subscribe(() => this.react())
    // Mount pass: every reaction block runs once (like all effects on mount),
    // then any passes queued by state written during the blocks.
    this.reacting = true
    try {
      this.runPass(true)
      while (this.reactQueued) {
        this.reactQueued = false
        this.runPass(false)
      }
    } finally {
      this.reacting = false
    }
  }

  /**
   * Unbind on screen unmount: clears ALL timers/subscriptions/listeners and
   * resets the session-local state (the old component state died with the
   * component) so a re-attach is a fresh session.
   */
  detach(): void {
    if (!this.attached) return
    this.attached = false
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe()
      this.storeUnsubscribe = null
    }
    GlobalEventEmitter.off("ota_start_ack", this.handleAck)
    GlobalEventEmitter.off("mtk_update_complete", this.handleMtkComplete)
    GlobalEventEmitter.off("glasses_session_changed", this.handleGlassesSessionChanged)
    this.clearAllOtaTimers()
    this.clearContinueLockoutTimer()
    // Only native command ownership survives a remount. Once the command has
    // settled, the glasses store/durable ota_status is the session authority.
    if (this.otaStartOwnership?.outcome !== "pending") {
      this.otaStartOwnership = null
    }
    this.resetSessionState()
  }

  /** Retry after a failure: clear state and re-send ota_start (if connected). */
  retry(): void {
    // While the recovery worker owns the detour (apk install latched, not yet
    // converged), the phone must not drive: an ota_start now would push the
    // factory/surviving build into a parallel download-install, and a second
    // handoff would begin()/REPLACE the live transaction under the running
    // worker. Retry just re-enters the reconcile wait — convergence or the
    // session timeout decides the real outcome.
    if (this.isInVersionChangeDetour()) {
      console.log("[OTA_PROGRESS] retry during version-change detour — re-entering wait (no ota_start)")
      this.setErrorMsg("")
      this.emitInternalChange()
      return
    }
    const store = useGlassesStore.getState()
    const otaStatus = store.otaStatus
    const otaProgress = store.otaProgress
    const authoritativeFailure = otaStatus?.status === "failed" || otaProgress?.status === "FAILED"
    const hasUnfinishedSession =
      (!!otaStatus &&
        otaStatus.status !== "idle" &&
        otaStatus.status !== "failed" &&
        otaStatus.status !== "complete") ||
      (!!otaProgress && otaProgress.status !== "FAILED" && otaProgress.status !== "FINISHED")
    const shouldReconcile =
      this.otaStartOwnership?.outcome === "pending" ||
      (!authoritativeFailure &&
        (this.otaStartOwnership?.outcome === "acknowledged" || this.hasFirstActivity || hasUnfinishedSession))

    if (shouldReconcile) {
      console.log("[OTA_PROGRESS] retry pressed for an existing OTA session — reconciling without ota_start")
      this.clearPerStepTimers()
      this.clearLegacyApkSettleTimer()
      this.clearMtkSimulationTimers()
      this.clearContinueLockoutTimer()
      this.setErrorMsg("")
      this.maybeStartGlobalTimeout()
      this.maybeArmStuckWatchdog()
      if (isGlassesConnected(store.connection)) {
        if (this.otaStartOwnership?.outcome === "pending") {
          void this.sendOtaStartWithWatchdogs()
        } else {
          void BluetoothSdk.sendOtaQueryStatus().catch(() => {})
          this.armQueryReplyFallback("retry")
        }
      }
      return
    }

    console.log("[OTA_PROGRESS] retry pressed after a rejected or terminal attempt — starting a fresh ota_start")
    // Batch like the old event handler: React ran the whole handler (including
    // the ota_start send) before re-rendering + re-running effects.
    const wasReacting = this.reacting
    this.reacting = true
    try {
      this.clearPerStepTimers()
      this.clearLegacyApkSettleTimer()
      this.clearMtkSimulationTimers()
      this.clearContinueLockoutTimer()
      this.retryCount = 0
      if (!this.prepareFreshOtaStartAttempt()) return
      this.resetBesRestartAttempt()
      this.setSawReconnectEdge(false)
      this.setErrorMsg("")
      this.setContinueButtonDisabled(false)
      this.setLegacyApkSettleHold(false)
      this.setMtkSimulatedPercent(null)
      this.lastRealMtkProgress = 0
      store.setOtaProgress(null)
      store.setOtaStatus(null)
      if (isGlassesConnected(useGlassesStore.getState().connection)) {
        void this.sendOtaStartWithWatchdogs()
      }
    } finally {
      this.reacting = wasReacting
    }
    if (!wasReacting) this.react()
  }

  /**
   * Terminal-state cleanup half of the old Continue/Done handlers (navigation
   * stays in the screen): clear the selected update, and after an APK step
   * clear the stale build number so the next check re-reads version_info.
   */
  finish(): void {
    if (this.otaStartOwnership?.outcome !== "pending") {
      this.otaStartOwnership = null
    }
    useGlassesStore.getState().setOtaUpdateAvailable(null)
    if (this.apkStepSeen) {
      BluetoothSdk.updateGlasses({buildNumber: ""})
      useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
    }
  }

  /**
   * Abandon an interrupted session (the super-mode skip): terminal cleanup
   * plus dropping the session's status/progress read-state, so
   * deriveDisplayState doesn't resurrect the stale install when the host
   * navigates away and back through /ota routes.
   */
  discard(): void {
    this.finish()
    const store = useGlassesStore.getState()
    store.setOtaStatus(null)
    store.setOtaProgress(null)
  }

  snapshot(): OtaInstallSnapshot {
    const state = useGlassesStore.getState()
    const connected = isGlassesConnected(state.connection)
    const otaStatus = state.otaStatus
    const otaProgress = state.otaProgress
    return {
      displayState: deriveDisplayState({
        otaStatus,
        otaProgress,
        connected,
        errorMsg: this.errorMsg,
        sawReconnectEdge: this.sawReconnectEdge,
        legacyApkSettleHold: this.legacyApkSettleHold,
        apkCompletedViaBuildIncrease: this.apkCompletedViaBuildIncrease,
        besRestartRecovery: this.besRestartRecovery,
        versionChangeConverged: this.versionChangeConverged,
        versionChangeSession: this.versionChangeSession,
      }),
      errorMsg: this.errorMsg,
      // Keep Continue disabled while the expected BES reboot is still in flight.
      continueButtonDisabled: this.continueButtonDisabled || this.besRestartRecovery === "awaiting",
      connected,
      // Copies: the snapshot must not hand callers mutable references into the store.
      otaStatus: otaStatus ? {...otaStatus} : null,
      otaProgress: otaProgress ? {...otaProgress} : null,
      mtkInstallStallSimulatedPercent: this.mtkSimulatedPercent,
      isVersionChange: this.versionChangeSession,
      versionChangeConverged: this.versionChangeConverged,
      versionChangePhase: this.deriveVersionChangePhase(connected),
    }
  }

  /**
   * True while the recovery worker owns the downgrade transaction (after the apk install
   * started, before convergence). During this window ASG is being uninstalled/reinstalled and
   * cannot answer the phone, so the coordinator must not ping, poll ota_query_status, or arm the
   * progress-stall watchdog — doing so drives the passive factory build and fails the session
   * before the target reconnects. Completion is exact-version convergence, detected separately.
   */
  private isInVersionChangeDetour(): boolean {
    return this.versionChangeSession && this.versionChangeInstallStarted && !this.versionChangeConverged
  }

  /** Downgrade-detour sub-phase for the progress narrative (see OtaInstallSnapshot). */
  private deriveVersionChangePhase(connected: boolean): "installing" | "restarting" | "verifying" | null {
    if (!this.versionChangeSession || this.versionChangeConverged) return null
    if (!this.versionChangeInstallStarted) return "installing"
    return connected ? "verifying" : "restarting"
  }

  /**
   * Subscribe to install snapshot changes, deduped on the projected JSON.
   * Fires on glasses-store changes AND coordinator-internal state changes
   * (errorMsg / reconnect edge / continue lockout). Returns an unsubscribe.
   */
  onSnapshot(cb: (snapshot: OtaInstallSnapshot) => void): () => void {
    let last = JSON.stringify(this.snapshot())
    const check = () => {
      const snap = this.snapshot()
      const key = JSON.stringify(snap)
      if (key === last) return
      last = key
      cb(snap)
    }
    this.snapshotCheckers.add(check)
    const unsubscribeStore = useGlassesStore.subscribe(check)
    return () => {
      this.snapshotCheckers.delete(check)
      unsubscribeStore()
    }
  }

  // --- internal state plumbing ---

  private resetSessionState(): void {
    this.errorMsg = ""
    this.sawReconnectEdge = false
    this.continueButtonDisabled = false
    this.apkStepSeen = false
    this.prevConnected = false
    this.initialBuildNumber = null
    this.apkExpectedInSession = false
    this.apkCompletedViaBuildIncrease = false
    this.protocolProfile = null
    this.resetBesRestartAttempt()
    this.versionChangeSession = false
    this.versionChangeTarget = null
    this.versionChangeInstallStarted = false
    this.versionChangeConverged = false
    this.legacyApkSettleHold = false
    this.mtkSimulatedPercent = null
    this.lastRealMtkProgress = 0
    this.apkInstallPollInFlight = false
    this.hasFirstActivity = false
    this.hasFirstNonZeroProgress = false
    this.retryCount = 0
    this.globalTimeoutStarted = false
    this.prevDisplayState = null
    this.lastConnected = false
    this.lastOtaStatus = null
    this.lastOtaProgress = null
    this.lastBuildNumber = ""
    this.lastDisplayState = null
    this.lastStallSig = ""
    this.reactQueued = false
  }

  /** Begin a genuinely new command attempt only after native ownership has settled. */
  private prepareFreshOtaStartAttempt(): boolean {
    if (this.otaStartOwnership?.outcome === "pending") {
      console.error("[OTA_PROGRESS] refused fresh ota_start while native still owns the previous request")
      return false
    }
    this.otaStartOwnership = null
    this.hasFirstActivity = false
    this.hasFirstNonZeroProgress = false
    this.apkCompletedViaBuildIncrease = false
    return true
  }

  /** Reset only the reboot lifecycle that belongs to one install attempt. */
  private resetBesRestartAttempt(): void {
    this.besRestartExpected = false
    this.besRestartDisconnectObserved = false
    this.besRestartRecovery = null
  }

  /** Notify snapshot subscribers of a coordinator-internal state change. */
  private emitInternalChange(): void {
    for (const check of Array.from(this.snapshotCheckers)) check()
  }

  // Setters mirror the old setState calls: bail on identical values (React's
  // setState bailout), notify snapshot subscribers, and queue a reaction pass.
  private setErrorMsg(next: string): void {
    if (this.errorMsg === next) return
    this.errorMsg = next
    this.emitInternalChange()
    this.react()
  }

  private setSawReconnectEdge(next: boolean): void {
    if (this.sawReconnectEdge === next) return
    this.sawReconnectEdge = next
    this.emitInternalChange()
    this.react()
  }

  private setContinueButtonDisabled(next: boolean): void {
    if (this.continueButtonDisabled === next) return
    this.continueButtonDisabled = next
    this.emitInternalChange()
    this.react()
  }

  private setApkCompletedViaBuildIncrease(next: boolean): void {
    if (this.apkCompletedViaBuildIncrease === next) return
    this.apkCompletedViaBuildIncrease = next
    this.emitInternalChange()
    this.react()
  }

  private setLegacyApkSettleHold(next: boolean): void {
    if (this.legacyApkSettleHold === next) return
    this.legacyApkSettleHold = next
    this.emitInternalChange()
    this.react()
  }

  /** Display-only (WP 8C-e): notifies snapshot subscribers but never queues a reaction pass. */
  private setMtkSimulatedPercent(next: number | null): void {
    if (this.mtkSimulatedPercent === next) return
    this.mtkSimulatedPercent = next
    this.emitInternalChange()
  }

  /** Legacy/unified policy is selected once, matching the old sticky route choice. */
  private isLegacySessionShapeNow(): boolean {
    if (this.protocolProfile) return this.protocolProfile === "legacy"
    const state = useGlassesStore.getState()
    const selected = selectOtaProtocolProfile(
      state.otaStatus,
      state.otaProgress,
      this.initialBuildNumber || state.buildNumber,
    )
    if (selected) {
      this.protocolProfile = selected
      console.log(`[OTA_PROGRESS] protocol profile selected: ${selected}`)
      return selected === "legacy"
    }
    return isLegacyShapedOtaSession(state.otaStatus, state.otaProgress, state.buildNumber)
  }

  private react(): void {
    if (!this.attached) return
    if (this.reacting) {
      this.reactQueued = true
      return
    }
    this.reacting = true
    try {
      do {
        this.reactQueued = false
        this.runPass(false)
      } while (this.reactQueued)
    } finally {
      this.reacting = false
    }
  }

  /**
   * One reaction pass = one render + its changed-dep effects of the old
   * component, in the old declaration order.
   */
  private runPass(isMount: boolean): void {
    const state = useGlassesStore.getState()
    const connected = isGlassesConnected(state.connection)
    const otaStatus = state.otaStatus
    const otaProgress = state.otaProgress
    const buildNumber = state.buildNumber

    const connectedChanged = isMount || connected !== this.lastConnected
    const otaStatusChanged = isMount || otaStatus !== this.lastOtaStatus
    const otaProgressChanged = isMount || otaProgress !== this.lastOtaProgress
    const buildNumberChanged = isMount || buildNumber !== this.lastBuildNumber

    // Session-start build capture (legacy build-number APK completion, WP 8C-c) —
    // mirrors the legacy screen capturing initialBuildNumber on its first truthy value,
    // marked for APK only when the selected update sequence includes an apk step.
    if (!this.initialBuildNumber && buildNumber) {
      this.initialBuildNumber = buildNumber
      this.apkExpectedInSession = !!state.otaUpdateAvailable?.updates?.includes("apk")
    }

    // Legacy pre-derivation compat (WP 8C): must run BEFORE deriveDisplayState so a
    // legacy apk install "complete" is held by the settle window in the same pass it
    // lands (never leaking a premature terminal pass to the watchdog blocks below).
    if (otaStatusChanged) {
      this.handleLegacyInstallCompleteEdge(otaStatus)
    }

    const legacySession = this.isLegacySessionShapeNow()

    if (this.isBesRestartExpected(otaStatus, otaProgress, legacySession)) {
      this.besRestartExpected = true
    }

    // Port the legacy route's actual reboot invariant before deriving display
    // state, so reconnecting with stale BES in_progress@100 never renders updating.
    if (connectedChanged && !connected && this.besRestartExpected && this.besRestartRecovery === null) {
      this.besRestartDisconnectObserved = true
      this.besRestartRecovery = "awaiting"
      console.log("[OTA_PROGRESS] BES restart disconnect observed — awaiting reconnect verification")
    }
    if (this.besRestartRecovery === "awaiting" && connected) this.completeBesRestartRecovery()

    // Derived UI state — the glasses data IS the source of truth.
    const displayState = deriveDisplayState({
      otaStatus,
      otaProgress,
      connected,
      errorMsg: this.errorMsg,
      sawReconnectEdge: this.sawReconnectEdge,
      legacyApkSettleHold: this.legacyApkSettleHold,
      apkCompletedViaBuildIncrease: this.apkCompletedViaBuildIncrease,
      besRestartRecovery: this.besRestartRecovery,
      versionChangeConverged: this.versionChangeConverged,
      versionChangeSession: this.versionChangeSession,
    })
    const stallSig = buildProgressStalenessSignature(otaStatus, otaProgress, displayState)
    const stallDuration = progressTimeoutDurationMs(otaStatus, otaProgress, legacySession)

    const displayStateChanged = isMount || displayState !== this.lastDisplayState
    const stallSigChanged = isMount || stallSig !== this.lastStallSig

    // Commit this pass's inputs BEFORE running the blocks so state written
    // mid-pass (which queues a follow-up pass) diffs against what this pass
    // already handled — like React committing the render before its effects.
    this.lastConnected = connected
    this.lastOtaStatus = otaStatus
    this.lastOtaProgress = otaProgress
    this.lastBuildNumber = buildNumber
    this.lastDisplayState = displayState
    this.lastStallSig = stallSig

    if (this.prevDisplayState !== displayState) {
      console.log(
        `[OTA_PROGRESS] displayState ${this.prevDisplayState ?? "<init>"} -> ${displayState}`,
        JSON.stringify({
          connected,
          sawReconnectEdge: this.sawReconnectEdge,
          errorMsg: this.errorMsg || null,
          otaStatus: otaStatus
            ? {
                stepType: otaStatus.stepType,
                phase: otaStatus.phase,
                status: otaStatus.status,
                step: `${otaStatus.currentStep}/${otaStatus.totalSteps}`,
                pct: otaStatus.overallPercent,
              }
            : null,
          otaProgress: otaProgress
            ? {
                currentUpdate: otaProgress.currentUpdate,
                stage: otaProgress.stage,
                status: otaProgress.status,
                progress: otaProgress.progress,
              }
            : null,
        }),
      )
      this.prevDisplayState = displayState
    }

    // APK-step latch (was the [otaStatus] effect above the timers).
    if (otaStatusChanged && otaStatus?.stepType === "apk") {
      this.apkStepSeen = true
    }

    // Legacy MTK completion side effect (WP 8C-a): old builds never send the
    // mtk_update_complete BLE event; their install FINISHED is the completion signal,
    // and the legacy screen marked MTK as updated this session right there.
    if (
      otaStatusChanged &&
      isLegacyShapedOtaStatus(otaStatus) &&
      otaStatus?.stepType === "mtk" &&
      otaStatus.phase === "install" &&
      otaStatus.status === "complete"
    ) {
      console.log("[OTA_PROGRESS] legacy mtk install complete — marking MTK updated this session")
      useGlassesStore.getState().setMtkUpdatedThisSession(true)
    }

    // Version-change (downgrade) install started: once ASG reports the apk install
    // phase, the handoff to the recovery worker has happened. From here the phone
    // stops driving ota_start (see runConnectEdge) and waits for exact-version
    // convergence — the wipe means no resumable ASG session and no build increase.
    if (
      this.versionChangeSession &&
      !this.versionChangeInstallStarted &&
      // Only latch from a status that belongs to THIS session: an install/apk status is a
      // response to our own acknowledged ota_start, so a leftover from a prior session
      // sitting in the store at mount cannot prematurely enter the detour wait (which would
      // suppress ota_start and hang the fresh downgrade until the global timeout).
      this.otaStartOwnership?.outcome === "acknowledged" &&
      otaStatus?.stepType === "apk" &&
      otaStatus.phase === "install"
    ) {
      console.log("[OTA_PROGRESS] version-change: apk install started — entering detour wait")
      this.versionChangeInstallStarted = true
      this.emitInternalChange()
    }

    // Ownership refuted: ASG emits install/STARTED BEFORE handing off, so the latch above can
    // be set even when no transaction ends up owning the detour. Recovery answers every
    // handoff synchronously, so exactly three error codes prove non-ownership and release the
    // latch: downgrade_handoff_refused (recovery's explicit verdict),
    // downgrade_handoff_failed (no verdict at all — recovery dead/missing, so it never began),
    // and downgrade_transaction_stalled (the long-stop past recovery's own stale give-up).
    // An accepted-but-slow transaction emits NONE of these (acceptance cancels the short
    // watchdog), so the latch is never released while a live worker owns the staged artifact
    // — which recovery additionally claims by rename at acceptance.
    if (
      this.versionChangeInstallStarted &&
      !this.versionChangeConverged &&
      otaStatus?.status === "failed" &&
      (otaStatus.error === "downgrade_handoff_refused" ||
        otaStatus.error === "downgrade_handoff_failed" ||
        otaStatus.error === "downgrade_transaction_stalled")
    ) {
      console.log(
        `[OTA_PROGRESS] version-change: no transaction owns the detour (${otaStatus.error}) — releasing latch`,
      )
      this.versionChangeInstallStarted = false
      this.emitInternalChange()
    }

    // Version-change convergence: the reconnected glasses report exactly the pinned
    // target. This is the ONLY completion signal for a downgrade (lower build, no
    // increase, wiped session). Mirrors the legacy build-increase latch but by equality.
    if (
      this.versionChangeSession &&
      this.versionChangeInstallStarted &&
      !this.versionChangeConverged &&
      this.versionChangeTarget !== null &&
      buildNumberChanged &&
      buildNumber
    ) {
      const currentBuild = Number.parseInt(buildNumber, 10)
      if (Number.isFinite(currentBuild) && currentBuild === this.versionChangeTarget) {
        console.log(`[OTA_PROGRESS] version-change converged: glasses report target ${currentBuild}, completing`)
        this.clearPerStepTimers()
        this.clearGlobalTimeout()
        this.apkStepSeen = true
        this.setErrorMsg("")
        this.versionChangeConverged = true
        this.emitInternalChange()
      }
    }

    // Legacy APK completion by build-number increase (WP 8C-c): old builds reboot into
    // the new build without a reliable explicit reconnect status; the fresh version_info
    // build number is the completion signal (ported from progress-legacy.tsx, which
    // completed from installing-with-apk and from starting/failed).
    if (
      buildNumberChanged &&
      !this.apkCompletedViaBuildIncrease &&
      this.apkExpectedInSession &&
      legacySession &&
      this.initialBuildNumber
    ) {
      const currentBuild = Number.parseInt(buildNumber, 10)
      const initialBuild = Number.parseInt(this.initialBuildNumber, 10)
      const increased = Number.isFinite(currentBuild) && Number.isFinite(initialBuild) && currentBuild > initialBuild
      const apkStepCurrent = otaStatus?.stepType === "apk" || otaProgress?.currentUpdate === "apk"
      const detectable =
        displayState === "starting" || displayState === "failed" || (displayState === "updating" && apkStepCurrent)
      if (increased && detectable) {
        console.log(
          `[OTA_PROGRESS] legacy apk complete via build-number increase (${initialBuild} -> ${currentBuild}), completing session`,
        )
        this.clearPerStepTimers()
        this.clearLegacyApkSettleTimer()
        this.setLegacyApkSettleHold(false)
        this.apkStepSeen = true
        this.setErrorMsg("")
        this.setApkCompletedViaBuildIncrease(true)
      }
    }

    // Cancel the query-reply fallback as soon as the glasses reply with a useful
    // status (in_progress / step_complete / complete / failed) or any progress
    // event. An "idle" ota_status means glasses have no active session, so we
    // must keep the fallback armed and let it retry ota_start.
    if (otaStatusChanged || otaProgressChanged) {
      if (this.queryReplyTimeout && hasRecoveringOtaReply(otaStatus, otaProgress)) {
        this.clearQueryReplyTimeout()
      }
    }

    /**
     * Connect-edge — the only place that decides to send ota_start /
     * ota_query_status and flips sawReconnectEdge
     * on the false -> true transition that signals the BES reboot completed.
     */
    if (connectedChanged) {
      this.runConnectEdge(connected)
    }

    if (displayStateChanged && isTerminalForWatchdog(displayState)) {
      this.clearGlobalTimeout()
    }

    if (isMount) {
      GlobalEventEmitter.on("ota_start_ack", this.handleAck)
      GlobalEventEmitter.on("mtk_update_complete", this.handleMtkComplete)
      GlobalEventEmitter.on("glasses_session_changed", this.handleGlassesSessionChanged)
    }

    // Ping keepalive while an OTA is actively running (legacy sessions pinged on the
    // padded interval — old builds slept less eagerly and pings are costlier for them).
    if (connectedChanged || displayStateChanged) {
      this.clearPingInterval()
      const active =
        connected && (displayState === "starting" || displayState === "updating") && !this.isInVersionChangeDetour()
      if (active) {
        void BluetoothSdk.ping().catch(() => {})
        const pingIntervalMs = legacySession ? LEGACY_PING_INTERVAL_MS : PING_INTERVAL_MS
        this.pingInterval = setInterval(() => {
          void BluetoothSdk.ping().catch(() => {})
          this.maybePollApkInstallStatus()
        }, pingIntervalMs)
      }
    }

    // Any glasses activity proves the logical ota_start was accepted.
    if ((otaStatusChanged || otaProgressChanged) && (otaStatus || otaProgress)) {
      this.onFirstActivity()
    }

    // The stuck-at-zero watchdog clears only on the FIRST real (>0%) progress.
    // Without this distinction, an ota_status reply with stepPercent=0 would
    // disable the watchdog before any download had actually started, hiding
    // wedged downloads from the user.
    if (otaStatusChanged || otaProgressChanged) {
      const stepPct = otaStatus?.stepPercent ?? 0
      const overallPct = otaStatus?.overallPercent ?? 0
      const legacyPct = otaProgress?.progress ?? 0
      if (stepPct > 0 || overallPct > 0 || legacyPct > 0) {
        this.onFirstNonZeroProgress()
      }
    }

    // Progress stall watchdog — fails the update if glasses go silent mid-step.
    // Keyed on the staleness SIGNATURE string (not the object refs) so a store
    // update that doesn't change the signature keeps the same timer running
    // instead of forever re-extending the deadline.
    if (stallSigChanged || displayStateChanged) {
      if (this.isInVersionChangeDetour()) {
        // Recovery worker owns the transaction; there are no progress events to stall on.
        this.clearProgressTimeout()
      } else if (displayState !== "starting" && displayState !== "updating") {
        this.clearProgressTimeout()
      } else if (!stallSig) {
        this.clearProgressTimeout()
      } else {
        const duration = stallDuration
        this.clearProgressTimeout()
        this.progressTimeout = setTimeout(() => {
          this.progressTimeout = null
          if (isTerminalForWatchdog(this.computeDisplayStateNow())) return
          console.log(`[OTA_PROGRESS] watchdog: progress stalled for ${duration}ms, failing`)
          this.setErrorMsg(OtaProgressMessages.stalledOrStuck)
        }, duration)
      }
    }

    // Lockout on Continue button after BES restart to prevent accidental tap
    // (15s unified, 35s for legacy-shaped sessions — WP 8C-f).
    if (displayStateChanged && displayState === "restarting") {
      this.clearContinueLockoutTimer()
      const lockoutMs = legacySession ? LEGACY_BES_CONTINUE_LOCKOUT_MS : BES_CONTINUE_LOCKOUT_MS
      this.setContinueButtonDisabled(true)
      this.continueLockoutTimer = setTimeout(() => {
        this.continueLockoutTimer = null
        this.setContinueButtonDisabled(false)
      }, lockoutMs)
    }

    if (displayStateChanged && displayState === "failed") {
      this.clearPerStepTimers()
    }

    // Legacy MTK install stall simulation (WP 8C-e): display-only. The simulation
    // timers only ever touch the projected snapshot percent — they never feed back
    // into arbitration (no reaction pass, no watchdog resets).
    if (otaProgressChanged) {
      this.runMtkStallSimulationPass(otaProgress, legacySession)
    }

    // Clear the selected update once this session reaches any terminal UI state.
    // Catches paths the MantleManager ota_status listener misses — notably BES success
    // (which terminates as `step_complete`, not `complete`) and APK build-number fallback
    // completions (which never produce a `complete` ota_status).
    if (
      displayStateChanged &&
      (displayState === "complete" || displayState === "restarting" || displayState === "failed")
    ) {
      useGlassesStore.getState().setOtaUpdateAvailable(null)
    }
  }

  /**
   * Reconnect arbitration shared by the physical BLE connect edge and the
   * glasses_session_changed signal. The latter exists because the BES keeps the BLE
   * link alive across asg_client restarts (APK OTA): no physical edge ever fires, so
   * the changed process session id is the only reconnect signal the coordinator gets
   * (incident rep_01KY6BJ0B7A4RBMQ7VN39KAE5E). Always returns true (the caller's
   * edge handling is complete).
   */
  private runReconnectArbitration(label: string): boolean {
    console.log(`[OTA_PROGRESS] ${label}: false->true, flipping sawReconnectEdge=true`)
    // A physical reconnect passed through the disconnect branch first, which cleared
    // these timers; a session-change edge never disconnects, so a fallback armed by an
    // earlier mount/query could otherwise fire alongside the arbitration below and send
    // a duplicate ota_start. Clearing here is a no-op on the physical path.
    this.clearQueryReplyTimeout()
    this.setSawReconnectEdge(true)

    if (this.besRestartDisconnectObserved) {
      console.log(`[OTA_PROGRESS] ${label}: BES reboot reconnect observed — no ota_query_status`)
      this.completeBesRestartRecovery()
      return true
    }

    // Legacy apk settle window (WP 8C): the glasses restarting into the new build is
    // the EXPECTED reconnect here — the legacy screen took no action on it. Skip the
    // query/fallback; the settle timer (or the build-number increase) completes.
    if (this.legacyApkSettleHold) {
      console.log(`[OTA_PROGRESS] ${label}: reconnect during legacy apk settle hold — no query`)
      return true
    }

    console.log(`[OTA_PROGRESS] ${label}: reconnected, sending ota_query_status`)
    if (this.otaStartOwnership?.outcome === "pending") {
      void this.sendOtaStartWithWatchdogs()
    }
    void BluetoothSdk.sendOtaQueryStatus()
    this.armQueryReplyFallback("reconnect")
    return true
  }

  private runConnectEdge(connected: boolean): void {
    const prev = this.prevConnected
    this.prevConnected = connected

    if (!connected) {
      console.log("[OTA_PROGRESS] connect-edge: disconnected")
      // Also drop pending query/retry sends: firing ota_start into a dead link
      // can only produce a false "failed" state. Reconnect arbitration first
      // queries durable status and re-arms the one permitted fallback.
      this.clearQueryReplyTimeout()
      this.clearRetryTimeout()
      return
    }

    const becameConnected = prev === false && connected === true
    if (becameConnected && this.runReconnectArbitration("connect-edge")) {
      return
    }

    // Version-change detour: after the install started, EVERY reconnect is expected
    // (the passive factory build, then the target). Do NOT send ota_start/query — the
    // factory build would treat the pin as a plain upgrade and start a redundant
    // download racing the recovery worker. Convergence (buildNumber === target) is
    // detected in the reaction pass; here we simply take no action.
    if (this.versionChangeSession && this.versionChangeInstallStarted && !this.versionChangeConverged) {
      console.log("[OTA_PROGRESS] connect-edge: reconnect during version-change detour — no query (expected)")
      return
    }

    const storeState = useGlassesStore.getState()

    // Initial mount (prev === current === true). If no session yet, kick off ota_start.
    // An idle ota_status has an empty sessionId; treat it as no session so ota_start
    // still begins an explicit install.
    const isIdleStatus = !!storeState.otaStatus && storeState.otaStatus.sessionId === ""
    const noSessionYet = (!storeState.otaStatus && !storeState.otaProgress) || isIdleStatus
    if (noSessionYet) {
      if (!isIdleStatus && this.otaStartOwnership?.outcome === "acknowledged") {
        console.log("[OTA_PROGRESS] initial mount, acknowledged session has no cached status — reconciling")
        void BluetoothSdk.sendOtaQueryStatus().catch(() => {})
        this.armQueryReplyFallback("initial-mount")
        return
      }
      console.log(
        isIdleStatus
          ? "[OTA_PROGRESS] initial mount, idle status (no sessionId), sending ota_start"
          : "[OTA_PROGRESS] initial mount, no session in store, sending ota_start",
      )
      this.retryCount = 0
      if (isIdleStatus && this.otaStartOwnership?.outcome !== "pending" && !this.prepareFreshOtaStartAttempt()) {
        return
      }
      void this.sendOtaStartWithWatchdogs()
    } else {
      console.log("[OTA_PROGRESS] initial mount, session exists, sending ota_query_status")
      void BluetoothSdk.sendOtaQueryStatus()
      this.armQueryReplyFallback("initial-mount")
    }
  }

  // --- BLE OTA event listeners (engine GlobalEventEmitter, fed by OtaService) ---

  private readonly handleAck = (): void => {
    const ownership = this.otaStartOwnership
    if (!ownership || ownership.outcome === "rejected") return
    if (ownership.outcome === "acknowledged") return
    console.log("[OTA_PROGRESS] ota_start_ack received")
    ownership.outcome = "acknowledged"
    this.clearRetryTimeout()
  }

  /**
   * The asg process restarted while the BES kept the BLE link up (sid change observed
   * by the bridge): treat it exactly like a physical reconnect edge.
   */
  private readonly handleGlassesSessionChanged = (): void => {
    this.runReconnectArbitration("session-change")
  }

  private readonly handleMtkComplete = (): void => {
    console.log("[OTA_PROGRESS] mtk_update_complete received")
    this.clearProgressTimeout()
    this.onFirstActivity()
    this.onFirstNonZeroProgress()
    void BluetoothSdk.sendOtaQueryStatus()
    useGlassesStore.getState().setMtkUpdatedThisSession(true)
  }

  // --- legacy (< 37) compatibility, ported from progress-legacy.tsx (WP 8C) ---

  /**
   * Reacts to a NEW legacy-shaped install-phase "complete" (an old build's
   * `install FINISHED`). Two ports from the legacy screen:
   * - last-write-wins: completion arriving after a watchdog failure overrides it
   *   (the old screen completed from "failed" too);
   * - apk settle window: an apk install FINISHED observed in flight is held out of
   *   "complete" for LEGACY_APK_COMPLETION_SETTLE_MS so the ASG process restart
   *   settles (and fresh version_info lands) before the user can continue. From
   *   starting/failed (post-reboot explicit signal) completion is immediate.
   */
  private handleLegacyInstallCompleteEdge(otaStatus: OtaStatus | null): void {
    if (!isLegacyShapedOtaStatus(otaStatus) || otaStatus?.phase !== "install" || otaStatus.status !== "complete") {
      return
    }

    if (this.errorMsg) {
      console.log(
        "[OTA_PROGRESS] legacy install complete arrived after a failure — completing (legacy last-write-wins)",
      )
      this.setErrorMsg("")
      this.clearLegacyApkSettleTimer()
      this.setLegacyApkSettleHold(false)
      return
    }

    if (
      otaStatus.stepType === "apk" &&
      !this.apkCompletedViaBuildIncrease &&
      !this.legacyApkSettleHold &&
      this.legacyApkSettleTimer === null &&
      this.lastDisplayState === "updating"
    ) {
      console.log(
        `[OTA_PROGRESS] legacy apk install complete — holding complete for ${LEGACY_APK_COMPLETION_SETTLE_MS}ms settle window`,
      )
      this.setLegacyApkSettleHold(true)
      this.legacyApkSettleTimer = setTimeout(() => {
        this.legacyApkSettleTimer = null
        console.log("[OTA_PROGRESS] legacy apk settle window elapsed — releasing complete")
        this.setLegacyApkSettleHold(false)
      }, LEGACY_APK_COMPLETION_SETTLE_MS)
    }
  }

  private isBesRestartExpected(
    otaStatus: OtaStatus | null,
    otaProgress: OtaProgress | null,
    legacySession: boolean,
  ): boolean {
    const statusReadyToRestart =
      otaStatus?.stepType === "bes" &&
      otaStatus.phase === "install" &&
      (otaStatus.status === "step_complete" || otaStatus.status === "complete")
    const progressReadyToRestart =
      legacySession &&
      otaProgress?.currentUpdate === "bes" &&
      otaProgress.stage === "install" &&
      otaProgress.status === "FINISHED"

    // progress-legacy treated a BES disconnect during active installation as the
    // expected power cycle even when its terminal FINISHED event was lost. Keep
    // that fallback only for the sticky pre-37 profile selected when the flow began.
    const legacyInstallInProgress =
      legacySession &&
      ((otaStatus?.stepType === "bes" && otaStatus.phase === "install" && otaStatus.status === "in_progress") ||
        (otaProgress?.currentUpdate === "bes" &&
          otaProgress.stage === "install" &&
          (otaProgress.status === "STARTED" || otaProgress.status === "PROGRESS")))
    return statusReadyToRestart || progressReadyToRestart || legacyInstallInProgress
  }

  /** Complete only after a protocol-authorized BES restart traverses disconnect -> reconnect. */
  private completeBesRestartRecovery(): void {
    if (!this.besRestartDisconnectObserved || this.besRestartRecovery !== "awaiting") return
    console.log("[OTA_PROGRESS] BES restart reconnected — completing by reboot edge")
    this.clearPerStepTimers()
    this.setErrorMsg("")
    this.besRestartRecovery = "complete"
    this.emitInternalChange()
  }

  /**
   * Legacy MTK install stall simulation (WP 8C-e), ported verbatim: the MTK system
   * install typically stalls around 49-50%. Every real event restarts stall detection;
   * after LEGACY_MTK_STALL_DETECT_MS of silence inside the [45, 55) zone, simulate +1%
   * every LEGACY_MTK_SIM_TICK_MS from max(stall+1, 51), capped at 60. Real progress
   * beyond the simulated value clears it. Display-only by construction: the timers call
   * only {@link setMtkSimulatedPercent}, which never queues a reaction pass.
   */
  private runMtkStallSimulationPass(otaProgress: OtaProgress | null, legacySession: boolean): void {
    const isLegacyMtkInstall =
      legacySession &&
      otaProgress?.currentUpdate === "mtk" &&
      otaProgress.stage === "install" &&
      (otaProgress.status === "STARTED" || otaProgress.status === "PROGRESS")

    if (!isLegacyMtkInstall) {
      this.clearMtkSimulationTimers()
      this.setMtkSimulatedPercent(null)
      return
    }

    const realProgress = otaProgress.progress ?? 0
    if (realProgress > 0 && realProgress !== this.lastRealMtkProgress) {
      this.lastRealMtkProgress = realProgress
      if (this.mtkSimulatedPercent !== null && realProgress > this.mtkSimulatedPercent) {
        this.setMtkSimulatedPercent(null)
      }
    }

    // A real event arrived: restart stall detection (and stop any running ticker).
    this.clearMtkSimulationTimers()
    const inStallZone =
      realProgress >= LEGACY_MTK_STALL_ZONE_MIN_PERCENT && realProgress < LEGACY_MTK_STALL_ZONE_MAX_PERCENT
    if (!inStallZone) return

    this.mtkStallDetectTimer = setTimeout(() => {
      this.mtkStallDetectTimer = null
      const stalledAt = this.lastRealMtkProgress
      const prev = this.mtkSimulatedPercent
      const target = Math.max(
        prev !== null ? Math.max(prev, stalledAt + 1) : stalledAt + 1,
        LEGACY_MTK_SIM_FLOOR_PERCENT,
      )
      console.log(
        `[OTA_PROGRESS] legacy mtk install stalled at ${stalledAt}%, simulating display progress from ${target}%`,
      )
      this.setMtkSimulatedPercent(target)
      this.mtkSimTickTimer = setInterval(() => {
        const current = this.mtkSimulatedPercent ?? stalledAt + 1
        const capped = Math.min(current + 1, LEGACY_MTK_SIM_CAP_PERCENT)
        this.setMtkSimulatedPercent(capped)
        if (capped >= LEGACY_MTK_SIM_CAP_PERCENT && this.mtkSimTickTimer) {
          clearInterval(this.mtkSimTickTimer)
          this.mtkSimTickTimer = null
        }
      }, LEGACY_MTK_SIM_TICK_MS)
    }, LEGACY_MTK_STALL_DETECT_MS)
  }

  // --- watchdogs / send path ---

  /**
   * Read the current derived display state from the store + internal state
   * synchronously — used inside setTimeout callbacks.
   */
  private computeDisplayStateNow(): DisplayState {
    const state = useGlassesStore.getState()
    return deriveDisplayState({
      otaStatus: state.otaStatus,
      otaProgress: state.otaProgress,
      connected: isGlassesConnected(state.connection),
      errorMsg: this.errorMsg,
      sawReconnectEdge: this.sawReconnectEdge,
      legacyApkSettleHold: this.legacyApkSettleHold,
      apkCompletedViaBuildIncrease: this.apkCompletedViaBuildIncrease,
      besRestartRecovery: this.besRestartRecovery,
      versionChangeConverged: this.versionChangeConverged,
      versionChangeSession: this.versionChangeSession,
    })
  }

  /**
   * During an APK install the package installer kills and restarts the glasses
   * process, and the new process's completion push can lose its startup race
   * against the UART transport (incident rep_01KY31HEMTSBSMK8DVMNXJ5XGG: the
   * phone sat on a stale "install in_progress 0%" until the stall watchdog
   * failed a successful update). The persisted session on the glasses always
   * knows the truth, so poll ota_query_status on the keepalive tick while an
   * apk step sits in its install phase — the reply either confirms progress or
   * delivers the missed completion. Gated to the apk install phase so a stray
   * idle reply can't disturb an active download; legacy (< 37) builds ignore
   * the query, which is harmless.
   *
   * The native query pends up to 15s and rejects a concurrent call with
   * request_in_flight — longer than the 10s tick — so exactly one poll is kept
   * in flight (the glasses being slow to answer IS the silent-restart window
   * this poll exists for) and rejections are swallowed: the next tick retries.
   */
  private maybePollApkInstallStatus(): void {
    if (this.isInVersionChangeDetour()) return
    if (this.apkInstallPollInFlight) return
    const s = useGlassesStore.getState().otaStatus
    if (s?.stepType === "apk" && s.phase === "install" && s.status === "in_progress") {
      this.apkInstallPollInFlight = true
      void BluetoothSdk.sendOtaQueryStatus()
        .catch(() => {})
        .finally(() => {
          this.apkInstallPollInFlight = false
        })
    }
  }

  /**
   * "Glasses are talking to us" — suppresses retry if the native request later rejects.
   * Important: this does NOT clear the stuck-at-zero watchdog; that one fires
   * on real progress > 0% (see {@link onFirstNonZeroProgress}).
   */
  private onFirstActivity(): void {
    if (this.hasFirstActivity) return
    this.hasFirstActivity = true
    if (this.otaStartOwnership?.outcome === "pending") {
      this.otaStartOwnership.outcome = "acknowledged"
    }
    this.clearRetryTimeout()
  }

  /**
   * "Real download progress arrived" — clears the stuck-at-zero watchdog. We
   * deliberately wait for non-zero progress before clearing this so that an
   * ota_status reply with stepPercent: 0 (which is "first activity" but not
   * "real progress") doesn't disable the only watchdog that catches a wedged
   * download.
   */
  private onFirstNonZeroProgress(): void {
    if (this.hasFirstNonZeroProgress) return
    this.hasFirstNonZeroProgress = true
    this.clearStuckTimeout()
  }

  private maybeStartGlobalTimeout(): void {
    if (this.globalTimeoutStarted) return
    this.globalTimeoutStarted = true
    // Legacy-shape check happens once, when the session cap is armed at the first
    // ota_start send (WP 8C-b): old builds get the padded legacy cap for the whole
    // session; a session that starts unified keeps the unified cap.
    const globalTimeoutMs =
      this.versionChangeSession || this.isLegacySessionShapeNow() ? LEGACY_GLOBAL_OTA_TIMEOUT_MS : GLOBAL_OTA_TIMEOUT_MS
    this.globalTimeout = setTimeout(() => {
      this.globalTimeout = null
      this.globalTimeoutStarted = false
      if (isTerminalForWatchdog(this.computeDisplayStateNow())) return
      console.log("[OTA_PROGRESS] watchdog: global timeout fired, failing session")
      this.clearPerStepTimers()
      // Legacy parity: the old screen's global-timeout handler also killed the apk
      // completion timer and the MTK stall simulation (the flags/percent stay put —
      // errorMsg outranks them in the projection, and retry()/last-write-wins reset them).
      this.clearLegacyApkSettleTimer()
      this.clearMtkSimulationTimers()
      this.setErrorMsg(OtaProgressMessages.globalTimeout)
    }, globalTimeoutMs)
  }

  private armStuckWatchdogOnly(): void {
    this.clearStuckTimeout()

    // Durations resolved at arm time (WP 8C-b): legacy-shaped sessions get the
    // padded values progress-legacy.tsx used for old (< 37) builds.
    const legacySession = this.isLegacySessionShapeNow()
    const stuckTimeoutMs = legacySession ? LEGACY_DOWNLOAD_STUCK_TIMEOUT_MS : DOWNLOAD_STUCK_TIMEOUT_MS

    this.stuckTimeout = setTimeout(() => {
      this.stuckTimeout = null
      const d = this.computeDisplayStateNow()
      const state = useGlassesStore.getState()
      if (d !== "starting" && !(d === "updating" && state.otaStatus?.phase === "download")) {
        return
      }
      const pct = latestPercentForStuck(state.otaStatus, state.otaProgress)
      if (pct !== 0) return
      console.log(`[OTA_PROGRESS] watchdog: stuck at 0% for ${stuckTimeoutMs}ms, failing`)
      this.clearRetryTimeout()
      this.setErrorMsg(OtaProgressMessages.stalledOrStuck)
    }, stuckTimeoutMs)
  }

  /** Arm the 0%-stuck watchdog only when this logical session has none. */
  private maybeArmStuckWatchdog(): void {
    if (this.stuckTimeout || this.hasFirstNonZeroProgress) return
    this.armStuckWatchdogOnly()
  }

  private sendOtaStartWithWatchdogs(): Promise<void> {
    // INVARIANT BACKSTOP — not normal control flow. Every entry point that can drive the
    // glasses (connect-edge, query fallback, retry, mount) carries its own detour gate with the
    // right behavior for that site; this final check only exists so that a FUTURE entry point
    // that forgets its gate degrades to a refused send + loud log instead of a corrupted
    // transaction (an ota_start mid-detour starts a parallel install on the factory build and
    // can trigger a second handoff). If this ever fires, a missed site gate exists — fix it.
    if (this.isInVersionChangeDetour()) {
      console.error(
        "[OTA_PROGRESS] BACKSTOP: refused ota_start during a latched version-change detour — a caller is missing its detour gate",
      )
      return Promise.resolve()
    }
    const existingOwnership = this.otaStartOwnership
    if (existingOwnership?.outcome === "pending") {
      this.maybeStartGlobalTimeout()
      this.maybeArmStuckWatchdog()
      console.log("[OTA_PROGRESS] ota_start already pending — adopting existing native request")
      return existingOwnership.promise
    }
    if (existingOwnership?.outcome === "acknowledged") {
      this.maybeStartGlobalTimeout()
      this.maybeArmStuckWatchdog()
      console.log("[OTA_PROGRESS] ota_start already acknowledged — refusing duplicate start")
      return Promise.resolve()
    }
    if (existingOwnership?.outcome === "rejected" && !this.prepareFreshOtaStartAttempt()) {
      return Promise.resolve()
    }
    this.maybeStartGlobalTimeout()
    this.maybeArmStuckWatchdog()

    const ownership: OtaStartOwnership = {
      outcome: "pending",
      promise: Promise.resolve(),
    }
    ownership.promise = this.performOtaStart(ownership)
    this.otaStartOwnership = ownership
    return ownership.promise
  }

  private async performOtaStart(ownership: OtaStartOwnership): Promise<void> {
    try {
      const state = useGlassesStore.getState()
      const otaVersionUrl = resolveOtaManifestUrl(state.otaVersionUrl, state.buildNumber)
      console.log(`[OTA_PROGRESS] sending ota_start with manifest URL: ${otaVersionUrl}`)
      await BluetoothSdk.startOtaUpdate(otaVersionUrl)
      if (this.otaStartOwnership !== ownership) return
      // The public SDK promise resolves only from ota_start_ack. Treat that
      // resolution as the acknowledgement even if the parallel event dispatch
      // reaches the coordinator later (or is dropped by a remount).
      this.handleAck()
    } catch (err) {
      console.warn("[OTA_PROGRESS] sendOtaStart threw", err)

      if (this.otaStartOwnership !== ownership) return

      // A received ota_status/legacy progress event, or the exact legacy APK
      // build-number proof, proves that this logical start was accepted. Its
      // application-level ack may be lost while the update continues; never
      // create another transaction or fail a live, restarting, or completed
      // session because that stale promise timed out.
      if (this.hasFirstActivity || this.apkCompletedViaBuildIncrease) {
        ownership.outcome = "acknowledged"
        console.log("[OTA_PROGRESS] ota_start rejection arrived after acceptance proof — ignoring stale rejection")
        return
      }

      ownership.outcome = "rejected"
      if (!this.attached) return
      this.clearStuckTimeout()
      if (!isGlassesConnected(useGlassesStore.getState().connection)) {
        console.log(
          "[OTA_PROGRESS] ota_start request ended while disconnected; deferring retry to reconnect arbitration",
        )
        return
      }
      if (this.retryCount < MAX_RETRIES - 1) {
        this.retryCount += 1
        const retryIntervalMs = this.isLegacySessionShapeNow() ? LEGACY_RETRY_INTERVAL_MS : RETRY_INTERVAL_MS
        console.log(
          `[OTA_PROGRESS] ota_start request ended without ack or activity; retrying after ${retryIntervalMs}ms (attempt ${
            this.retryCount + 1
          }/${MAX_RETRIES})`,
        )
        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null
          if (!isGlassesConnected(useGlassesStore.getState().connection)) {
            console.log("[OTA_PROGRESS] ota_start retry paused while disconnected; reconnect arbitration will resume")
            return
          }
          void this.sendOtaStartWithWatchdogs()
        }, retryIntervalMs)
      } else {
        console.log("[OTA_PROGRESS] sendOtaStart failed after max retries, failing session")
        this.setErrorMsg(OtaProgressMessages.sendOtaStartFailed)
      }
    }
  }

  /**
   * After sending ota_query_status, wait QUERY_REPLY_TIMEOUT_MS for the glasses
   * to reply with a useful ota_status. A unified session may start again only
   * after an explicit "idle" reply, or after a locally rejected ota_start has
   * produced no activity and no authoritative reply across reconnect. Legacy
   * builds ignore ota_query_status, so their established timeout fallback
   * remains the compatibility path.
   *
   * Cleared as soon as a non-idle otaStatus or any otaProgress lands in the
   * store (see the reaction block above). An idle reply intentionally does NOT
   * cancel the fallback, so reconnects against a wiped/lost session still recover.
   */
  private armQueryReplyFallback(reason: "reconnect" | "initial-mount" | "retry"): void {
    this.clearQueryReplyTimeout()
    this.queryReplyTimeout = setTimeout(() => {
      this.queryReplyTimeout = null
      const state = useGlassesStore.getState()
      // If we already got a useful reply, we'd have been cleared. Defensive
      // re-check: idle replies must not block the retry. Legacy-shaped state is
      // exempt (WP 8C-b): old (< 37) builds ignore ota_query_status entirely, so
      // whatever legacy-shaped status/progress sits in the store is a pre-query
      // leftover, not a reply — a NEW legacy event would have cleared this timer
      // through the reaction pass. Only a unified reply suppresses the fallback.
      const legacySession = this.isLegacySessionShapeNow()
      if (!legacySession && hasRecoveringOtaReply(state.otaStatus, state.otaProgress)) return
      const explicitIdle = state.otaStatus?.status === "idle"
      const rejectedStart = this.otaStartOwnership?.outcome === "rejected"
      if (!legacySession && !explicitIdle && !rejectedStart) {
        console.log(
          `[OTA_PROGRESS] watchdog: ota_query_status got no authoritative idle reply in ${QUERY_REPLY_TIMEOUT_MS}ms (reason=${reason}); preserving the existing session`,
        )
        return
      }
      // Don't fire if we've left the active phase (e.g. user backed out, error overlay).
      if (isTerminalForWatchdog(this.computeDisplayStateNow())) return
      let fallbackCause = "legacy query timeout"
      if (explicitIdle) fallbackCause = "idle ota_status"
      else if (rejectedStart) fallbackCause = "rejected ota_start with no recovery reply"
      console.log(`[OTA_PROGRESS] watchdog: ${fallbackCause} (reason=${reason}), falling back to ota_start`)
      this.retryCount = 0
      if (this.otaStartOwnership?.outcome !== "pending" && !this.prepareFreshOtaStartAttempt()) return
      void this.sendOtaStartWithWatchdogs()
    }, QUERY_REPLY_TIMEOUT_MS)
  }

  // --- timer cleanup helpers ---

  private clearProgressTimeout(): void {
    if (this.progressTimeout) {
      clearTimeout(this.progressTimeout)
      this.progressTimeout = null
    }
  }

  private clearRetryTimeout(): void {
    if (this.retryTimeout) {
      clearTimeout(this.retryTimeout)
      this.retryTimeout = null
    }
  }

  private clearStuckTimeout(): void {
    if (this.stuckTimeout) {
      clearTimeout(this.stuckTimeout)
      this.stuckTimeout = null
    }
  }

  private clearGlobalTimeout(): void {
    if (this.globalTimeout) {
      clearTimeout(this.globalTimeout)
      this.globalTimeout = null
    }
    this.globalTimeoutStarted = false
  }

  private clearPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval)
      this.pingInterval = null
    }
  }

  private clearQueryReplyTimeout(): void {
    if (this.queryReplyTimeout) {
      clearTimeout(this.queryReplyTimeout)
      this.queryReplyTimeout = null
    }
  }

  private clearContinueLockoutTimer(): void {
    if (this.continueLockoutTimer) {
      clearTimeout(this.continueLockoutTimer)
      this.continueLockoutTimer = null
    }
  }

  private clearLegacyApkSettleTimer(): void {
    if (this.legacyApkSettleTimer) {
      clearTimeout(this.legacyApkSettleTimer)
      this.legacyApkSettleTimer = null
    }
  }

  private clearMtkSimulationTimers(): void {
    if (this.mtkStallDetectTimer) {
      clearTimeout(this.mtkStallDetectTimer)
      this.mtkStallDetectTimer = null
    }
    if (this.mtkSimTickTimer) {
      clearInterval(this.mtkSimTickTimer)
      this.mtkSimTickTimer = null
    }
  }

  /**
   * NOTE (WP 8C): the legacy apk settle timer and the MTK stall simulation timers are
   * deliberately NOT per-step watchdogs — a per-step failure must not kill them (the
   * legacy screen kept the simulation ticking through a watchdog failure, and the
   * settle latch resolves completion, not liveness). They are cleared on detach,
   * retry(), global timeout, and their own supersession paths.
   */
  private clearPerStepTimers(): void {
    this.clearRetryTimeout()
    this.clearStuckTimeout()
    this.clearProgressTimeout()
    this.clearQueryReplyTimeout()
  }

  private clearAllOtaTimers(): void {
    this.clearPerStepTimers()
    this.clearGlobalTimeout()
    this.clearPingInterval()
    this.clearLegacyApkSettleTimer()
    this.clearMtkSimulationTimers()
  }
}

/** Singleton — one install session machine per app process (matches the single progress screen). */
export const otaInstallCoordinator = new OtaInstallCoordinator()
