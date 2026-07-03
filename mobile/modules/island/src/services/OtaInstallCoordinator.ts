/**
 * OtaInstallCoordinator — island-owned OTA install state machine (WP 8B).
 *
 * Owns every timer/retry/sequencing rule that used to live in the host screen
 * `mobile/src/app/ota/progress.tsx`: the global session timeout, the no-ack
 * retry watchdog, the stuck-at-zero watchdog, the progress-stall watchdog keyed
 * on a staleness signature, connect-edge arbitration (initial mount vs
 * reconnect vs post-APK reboot), the ota_query_status reply fallback, the ping
 * keepalive, the ota_start_ack / mtk_update_complete listeners, and terminal
 * cleanup. The host progress screen is a pure renderer over
 * `snapshot()`/`onSnapshot()` plus the `attach()/detach()/retry()/finish()`
 * commands (exposed as `toolkit.ota.installSession`).
 *
 * Behavior contract: everything here was MOVED, not changed — every timer
 * duration (see ./otaInstallPolicy), arbitration rule, and "[OTA_PROGRESS]"
 * log line is a field-debugging contract and stays byte-identical to the old
 * screen. The reaction pass mirrors the old component's effect ordering: a
 * pass diffs the store-derived inputs (connected / otaStatus / otaProgress /
 * displayState / stall signature) exactly like the old effect dep arrays, and
 * state written mid-pass queues a follow-up pass — the same way a setState
 * during React effects scheduled a re-render after the current effect batch.
 */
import BluetoothSdk from "@mentra/bluetooth-sdk/internal"
import type {OtaProgress, OtaStatus} from "@mentra/bluetooth-sdk/internal"
import GlobalEventEmitter from "../utils/GlobalEventEmitter"
import {isGlassesConnected, useGlassesStore} from "../stores/glasses"
import {getAsgOtaVersionUrl} from "./asgOtaVersionUrl"
import {deriveDisplayState, type DisplayState} from "./otaDisplayState"
import {
  DOWNLOAD_STUCK_TIMEOUT_MS,
  GLOBAL_OTA_TIMEOUT_MS,
  MAX_RETRIES,
  MTK_INSTALL_TIMEOUT_MS,
  OtaProgressMessages,
  PING_INTERVAL_MS,
  POST_APK_OTA_START_DELAY_MS,
  PROGRESS_TIMEOUT_MS,
  QUERY_REPLY_TIMEOUT_MS,
  RETRY_INTERVAL_MS,
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
  if (otaProgress && (otaProgress.status === "PROGRESS" || otaProgress.status === "STARTED")) {
    return `p:${otaProgress.currentUpdate}|${otaProgress.stage}|${otaProgress.status}|${otaProgress.progress}`
  }
  return ""
}

function progressTimeoutDurationMs(otaStatus: OtaStatus | null, otaProgress: OtaProgress | null): number {
  if (otaStatus?.stepType === "mtk" && otaStatus.phase === "install") return MTK_INSTALL_TIMEOUT_MS
  if (otaProgress?.currentUpdate === "mtk" && otaProgress.stage === "install") return MTK_INSTALL_TIMEOUT_MS
  return PROGRESS_TIMEOUT_MS
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

  // Timer handles
  private globalTimeout: ReturnType<typeof setTimeout> | null = null
  private globalTimeoutStarted = false
  private retryTimeout: ReturnType<typeof setTimeout> | null = null
  private stuckTimeout: ReturnType<typeof setTimeout> | null = null
  private progressTimeout: ReturnType<typeof setTimeout> | null = null
  private postApkDelay: ReturnType<typeof setTimeout> | null = null
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private queryReplyTimeout: ReturnType<typeof setTimeout> | null = null
  private continueLockoutTimer: ReturnType<typeof setTimeout> | null = null

  // Retry / ack bookkeeping (no glasses source)
  private hasReceivedAck = false
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
  private lastDisplayState: DisplayState | null = null
  private lastStallSig = ""

  // Reaction pass re-entrancy guard (mirrors React deferring a setState-during-
  // effects re-render until the current effect batch finished).
  private reacting = false
  private reactQueued = false

  private storeUnsubscribe: (() => void) | null = null
  private snapshotCheckers = new Set<() => void>()

  // --- public surface (toolkit.ota.installSession) ---

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
    this.clearAllOtaTimers()
    this.clearContinueLockoutTimer()
    this.resetSessionState()
  }

  /** Retry after a failure: clear state and re-send ota_start (if connected). */
  retry(): void {
    console.log("[OTA_PROGRESS] retry pressed, clearing state and re-sending ota_start")
    // Batch like the old event handler: React ran the whole handler (including
    // the ota_start send) before re-rendering + re-running effects.
    const wasReacting = this.reacting
    this.reacting = true
    try {
      this.clearPerStepTimers()
      this.retryCount = 0
      this.hasFirstActivity = false
      this.hasReceivedAck = false
      this.setSawReconnectEdge(false)
      this.setErrorMsg("")
      const store = useGlassesStore.getState()
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
    useGlassesStore.getState().setOtaUpdateAvailable(null)
    if (this.apkStepSeen) {
      BluetoothSdk.updateGlasses({buildNumber: ""})
      useGlassesStore.getState().setGlassesInfo({buildNumber: ""})
    }
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
      }),
      errorMsg: this.errorMsg,
      continueButtonDisabled: this.continueButtonDisabled,
      connected,
      otaStatus,
      otaProgress,
    }
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
    this.hasReceivedAck = false
    this.hasFirstActivity = false
    this.hasFirstNonZeroProgress = false
    this.retryCount = 0
    this.globalTimeoutStarted = false
    this.prevDisplayState = null
    this.lastConnected = false
    this.lastOtaStatus = null
    this.lastOtaProgress = null
    this.lastDisplayState = null
    this.lastStallSig = ""
    this.reactQueued = false
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

    // Derived UI state — the glasses data IS the source of truth.
    const displayState = deriveDisplayState({
      otaStatus,
      otaProgress,
      connected,
      errorMsg: this.errorMsg,
      sawReconnectEdge: this.sawReconnectEdge,
    })
    const stallSig = buildProgressStalenessSignature(otaStatus, otaProgress, displayState)
    const stallDuration = progressTimeoutDurationMs(otaStatus, otaProgress)

    const connectedChanged = isMount || connected !== this.lastConnected
    const otaStatusChanged = isMount || otaStatus !== this.lastOtaStatus
    const otaProgressChanged = isMount || otaProgress !== this.lastOtaProgress
    const displayStateChanged = isMount || displayState !== this.lastDisplayState
    const stallSigChanged = isMount || stallSig !== this.lastStallSig

    // Commit this pass's inputs BEFORE running the blocks so state written
    // mid-pass (which queues a follow-up pass) diffs against what this pass
    // already handled — like React committing the render before its effects.
    this.lastConnected = connected
    this.lastOtaStatus = otaStatus
    this.lastOtaProgress = otaProgress
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
     * ota_query_status, handles POST_APK delay, and flips sawReconnectEdge
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
    }

    // Ping keepalive while an OTA is actively running
    if (connectedChanged || displayStateChanged) {
      this.clearPingInterval()
      const active = connected && (displayState === "starting" || displayState === "updating")
      if (active) {
        void BluetoothSdk.ping().catch(() => {})
        this.pingInterval = setInterval(() => {
          void BluetoothSdk.ping().catch(() => {})
        }, PING_INTERVAL_MS)
      }
    }

    // Any glasses activity (ota_status or otaProgress) clears the no-ack retry watchdog.
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
      if (displayState !== "starting" && displayState !== "updating") {
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

    // 15s lockout on Continue button after BES restart to prevent accidental tap.
    if (displayStateChanged) {
      this.clearContinueLockoutTimer()
      if (displayState === "restarting") {
        this.setContinueButtonDisabled(true)
        this.continueLockoutTimer = setTimeout(() => {
          this.continueLockoutTimer = null
          this.setContinueButtonDisabled(false)
        }, 15_000)
      }
    }

    if (displayStateChanged && displayState === "failed") {
      this.clearPerStepTimers()
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

  private runConnectEdge(connected: boolean): void {
    const prev = this.prevConnected
    this.prevConnected = connected

    if (!connected) {
      console.log("[OTA_PROGRESS] connect-edge: disconnected")
      this.clearPostApkDelay()
      return
    }

    const becameConnected = prev === false && connected === true
    if (becameConnected) {
      console.log("[OTA_PROGRESS] connect-edge: false->true, flipping sawReconnectEdge=true")
      this.setSawReconnectEdge(true)
    }

    const storeState = useGlassesStore.getState()
    const s = storeState.otaStatus
    const postApkAwaiting =
      s?.stepType === "apk" && (s?.totalSteps ?? 0) > 1 && (s.status === "step_complete" || s.status === "complete")

    if (becameConnected && postApkAwaiting) {
      console.log("[OTA_PROGRESS] connect-edge: post-APK reboot detected, arming POST_APK delay for sendOtaStart")
      this.clearPostApkDelay()
      this.postApkDelay = setTimeout(() => {
        this.postApkDelay = null
        this.retryCount = 0
        this.hasFirstActivity = false
        this.hasFirstNonZeroProgress = false
        this.hasReceivedAck = false
        console.log("[OTA_PROGRESS] POST_APK delay fired, sending ota_start")
        void this.sendOtaStartWithWatchdogs()
      }, POST_APK_OTA_START_DELAY_MS)
      return
    }

    if (becameConnected) {
      console.log("[OTA_PROGRESS] connect-edge: reconnected, sending ota_query_status")
      void BluetoothSdk.sendOtaQueryStatus()
      this.armQueryReplyFallback("reconnect")
      return
    }

    // Initial mount (prev === current === true). If no session yet, kick off ota_start.
    // An idle ota_status has an empty sessionId; treat it as no session so ota_start
    // still begins an explicit install.
    const isIdleStatus = !!storeState.otaStatus && storeState.otaStatus.sessionId === ""
    const noSessionYet = (!storeState.otaStatus && !storeState.otaProgress) || isIdleStatus
    if (noSessionYet) {
      console.log(
        isIdleStatus
          ? "[OTA_PROGRESS] initial mount, idle status (no sessionId), sending ota_start"
          : "[OTA_PROGRESS] initial mount, no session in store, sending ota_start",
      )
      this.retryCount = 0
      this.hasFirstActivity = false
      this.hasFirstNonZeroProgress = false
      this.hasReceivedAck = false
      void this.sendOtaStartWithWatchdogs()
    } else {
      console.log("[OTA_PROGRESS] initial mount, session exists, sending ota_query_status")
      void BluetoothSdk.sendOtaQueryStatus()
      this.armQueryReplyFallback("initial-mount")
    }
  }

  // --- BLE OTA event listeners (island GlobalEventEmitter, fed by OtaService) ---

  private readonly handleAck = (): void => {
    if (this.hasReceivedAck) return
    console.log("[OTA_PROGRESS] ota_start_ack received")
    this.hasReceivedAck = true
    this.clearRetryTimeout()
  }

  private readonly handleMtkComplete = (): void => {
    console.log("[OTA_PROGRESS] mtk_update_complete received")
    this.clearProgressTimeout()
    this.onFirstActivity()
    this.onFirstNonZeroProgress()
    void BluetoothSdk.sendOtaQueryStatus()
    useGlassesStore.getState().setMtkUpdatedThisSession(true)
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
    })
  }

  /**
   * "Glasses are talking to us" — clears the no-ack retry watchdog only.
   * Important: this does NOT clear the stuck-at-zero watchdog; that one fires
   * on real progress > 0% (see {@link onFirstNonZeroProgress}).
   */
  private onFirstActivity(): void {
    if (this.hasFirstActivity) return
    this.hasFirstActivity = true
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
    this.globalTimeout = setTimeout(() => {
      this.globalTimeout = null
      this.globalTimeoutStarted = false
      if (isTerminalForWatchdog(this.computeDisplayStateNow())) return
      console.log("[OTA_PROGRESS] watchdog: global timeout fired, failing session")
      this.clearPerStepTimers()
      this.setErrorMsg(OtaProgressMessages.globalTimeout)
    }, GLOBAL_OTA_TIMEOUT_MS)
  }

  private armAckAndStuckWatchdogsOnly(): void {
    this.clearRetryTimeout()
    this.clearStuckTimeout()

    this.retryTimeout = setTimeout(() => {
      this.retryTimeout = null
      if (this.hasReceivedAck || this.hasFirstActivity) return
      if (this.computeDisplayStateNow() !== "starting") return
      if (this.retryCount < MAX_RETRIES - 1) {
        this.retryCount += 1
        this.hasReceivedAck = false
        console.log(
          `[OTA_PROGRESS] watchdog: no ack in ${RETRY_INTERVAL_MS}ms, retrying ota_start (attempt ${this.retryCount})`,
        )
        void this.sendOtaStartWithWatchdogs(true)
          .then(() => {
            this.armAckAndStuckWatchdogsOnly()
          })
          .catch(() => {})
      } else {
        console.log(`[OTA_PROGRESS] watchdog: ota_start ack never received after ${MAX_RETRIES} attempts, failing`)
        this.setErrorMsg(OtaProgressMessages.noAckResponse)
      }
    }, RETRY_INTERVAL_MS)

    this.stuckTimeout = setTimeout(() => {
      this.stuckTimeout = null
      const d = this.computeDisplayStateNow()
      const state = useGlassesStore.getState()
      if (d !== "starting" && !(d === "updating" && state.otaStatus?.phase === "download")) {
        return
      }
      const pct = latestPercentForStuck(state.otaStatus, state.otaProgress)
      if (pct !== 0) return
      console.log(`[OTA_PROGRESS] watchdog: stuck at 0% for ${DOWNLOAD_STUCK_TIMEOUT_MS}ms, failing`)
      this.clearRetryTimeout()
      this.setErrorMsg(OtaProgressMessages.stalledOrStuck)
    }, DOWNLOAD_STUCK_TIMEOUT_MS)
  }

  private async sendOtaStartWithWatchdogs(retryAlreadyCounted = false): Promise<void> {
    this.maybeStartGlobalTimeout()
    this.hasReceivedAck = false
    this.armAckAndStuckWatchdogsOnly()
    try {
      const state = useGlassesStore.getState()
      const otaVersionUrl = getAsgOtaVersionUrl(state.otaVersionUrl, state.buildNumber)
      console.log(`[OTA_PROGRESS] sending ota_start with manifest URL: ${otaVersionUrl}`)
      await BluetoothSdk.startOtaUpdate(otaVersionUrl)
    } catch (err) {
      console.warn("[OTA_PROGRESS] sendOtaStart threw", err)
      this.clearRetryTimeout()
      this.clearStuckTimeout()
      if (this.retryCount < MAX_RETRIES - 1) {
        if (!retryAlreadyCounted) {
          this.retryCount += 1
        }
        this.retryTimeout = setTimeout(() => {
          this.retryTimeout = null
          void this.sendOtaStartWithWatchdogs()
        }, RETRY_INTERVAL_MS)
      } else {
        console.log("[OTA_PROGRESS] sendOtaStart failed after max retries, failing session")
        this.setErrorMsg(OtaProgressMessages.sendOtaStartFailed)
      }
    }
  }

  /**
   * After sending ota_query_status, wait QUERY_REPLY_TIMEOUT_MS for the glasses
   * to reply with a useful ota_status. If nothing arrives (e.g. the glasses'
   * OTA session was wiped between mount and reconnect), or the glasses reply
   * with an explicit "idle" status (no session), fall back to ota_start so the
   * user doesn't sit on a spinner forever.
   *
   * Cleared as soon as a non-idle otaStatus or any otaProgress lands in the
   * store (see the reaction block above). An idle reply intentionally does NOT
   * cancel the fallback, so reconnects against a wiped/lost session still recover.
   */
  private armQueryReplyFallback(reason: "reconnect" | "initial-mount"): void {
    this.clearQueryReplyTimeout()
    this.queryReplyTimeout = setTimeout(() => {
      this.queryReplyTimeout = null
      const state = useGlassesStore.getState()
      // If we already got a useful reply, we'd have been cleared. Defensive
      // re-check: idle replies must not block the retry.
      if (hasRecoveringOtaReply(state.otaStatus, state.otaProgress)) return
      // Don't fire if we've left the active phase (e.g. user backed out, error overlay).
      if (isTerminalForWatchdog(this.computeDisplayStateNow())) return
      console.log(
        `[OTA_PROGRESS] watchdog: ota_query_status got no useful reply in ${QUERY_REPLY_TIMEOUT_MS}ms (reason=${reason}), falling back to ota_start`,
      )
      this.retryCount = 0
      this.hasFirstActivity = false
      this.hasFirstNonZeroProgress = false
      this.hasReceivedAck = false
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

  private clearPostApkDelay(): void {
    if (this.postApkDelay) {
      clearTimeout(this.postApkDelay)
      this.postApkDelay = null
    }
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

  private clearPerStepTimers(): void {
    this.clearRetryTimeout()
    this.clearStuckTimeout()
    this.clearProgressTimeout()
    this.clearPostApkDelay()
    this.clearQueryReplyTimeout()
  }

  private clearAllOtaTimers(): void {
    this.clearPerStepTimers()
    this.clearGlobalTimeout()
    this.clearPingInterval()
  }
}

/** Singleton — one install session machine per app process (matches the single progress screen). */
export const otaInstallCoordinator = new OtaInstallCoordinator()
