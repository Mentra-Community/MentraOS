import type {ota as liveOta} from "../../facades/ota"
import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import type {FirmwareActionResult} from "../../ota/types"
import {
  createOtaAutoChain,
  OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS,
  otaAutoChainFingerprint,
  type OtaAutoChain,
} from "../../services/OtaAutoChain"
import {shouldRequireGlassesRebootForBesFailure} from "../../services/OtaErrorMapping"
import type {OtaCheckCurrentGlassesResult} from "../../services/OtaUpdateCheckService"
import {
  currentReleaseVersion,
  projectLiveOtaState,
  releaseChangelogsForActiveChain,
  releaseRangeTargetVersion,
  releaseTransitionFromRange,
} from "./presentation"
import type {CheckState, MentraLiveOtaFlowPage, MentraLiveOtaReleaseTransition, MentraLiveOtaState} from "./types"

export type LiveOtaPorts = Pick<
  typeof liveOta,
  | "initialize"
  | "snapshot"
  | "onSnapshot"
  | "installSession"
  | "checkForUpdates"
  | "getReleaseChangelogs"
  | "clearProgress"
  | "clearUpdateAvailable"
>

export interface LiveSessionData {
  page: MentraLiveOtaFlowPage
  runtimeReady: boolean
  checkState: CheckState
  isUpdateRequired: boolean
  isVersionChange: boolean
  errorKind: "network" | "pin_unavailable"
  unofficialClientPackage: string | null
  offeredReleaseTransition: MentraLiveOtaReleaseTransition | null
  completedReleaseTransition: MentraLiveOtaReleaseTransition | null
  completedUpdate: boolean
  completedChangelogs: ReturnType<LiveOtaPorts["getReleaseChangelogs"]>
  batteryBlocked: boolean
}

export interface LiveSessionSnapshot {
  readonly revision: number
  readonly state: MentraLiveOtaState
  readonly page: MentraLiveOtaFlowPage
  readonly exitRequest: number
}

export const MINIMUM_OTA_BATTERY_LEVEL = 25
const NONE: FirmwareActionResult = {kind: "none"}

/** Owns the former React flow's decisions; the install coordinator still owns wire recovery. */
export class MentraLiveOtaSession {
  readonly chain: OtaAutoChain
  private data: LiveSessionData = {
    page: "check",
    runtimeReady: false,
    checkState: "checking",
    isUpdateRequired: true,
    isVersionChange: false,
    errorKind: "network",
    unofficialClientPackage: null,
    offeredReleaseTransition: null,
    completedReleaseTransition: null,
    completedUpdate: false,
    completedChangelogs: [],
    batteryBlocked: false,
  }
  private readonly snapshots: RevisionedSnapshot<LiveSessionSnapshot>
  private unsubscribers: Array<() => void> = []
  private started = false
  private disposed = false
  private attached = false
  private reacting = false
  private reactQueued = false
  private checkGeneration = 0
  private checkInputs = ""
  private checkStarted = false
  private checkCompleted = false
  private selectedResult: OtaCheckCurrentGlassesResult | null = null
  private updateFingerprint: string | null = null
  private installPending = false
  private autoChainAdvanced = false
  private exitRequest = 0
  private claimedExitRequest = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private completionTimer: ReturnType<typeof setTimeout> | null = null
  private finishing: Promise<FirmwareActionResult> | null = null
  private delays = new Map<ReturnType<typeof setTimeout>, () => void>()

  constructor(private readonly ports: LiveOtaPorts, chain = createOtaAutoChain()) {
    this.chain = chain
    this.snapshots = new RevisionedSnapshot<LiveSessionSnapshot>({
      revision: 0,
      state: projectLiveOtaState(this.data, ports, chain),
      page: "check",
      exitRequest: 0,
    })
  }

  snapshot = (): LiveSessionSnapshot => this.snapshots.snapshot()
  subscribe = (listener: (snapshot: LiveSessionSnapshot) => void): (() => void) => this.snapshots.subscribe(listener)

  open = async (options: {initialPage?: MentraLiveOtaFlowPage; initializeRuntime?: boolean} = {}): Promise<void> => {
    if (this.started || this.disposed) return
    this.started = true
    this.data.page = options.initialPage ?? "check"
    this.data.runtimeReady = options.initializeRuntime === false
    this.unsubscribers = [this.ports.onSnapshot(this.react), this.ports.installSession.onSnapshot(this.react)]
    this.react()
    if (this.data.runtimeReady) return
    try {
      await this.ports.initialize()
    } finally {
      if (!this.disposed) {
        this.data.runtimeReady = true
        this.react()
      }
    }
  }

  /** A replayed terminal snapshot cannot repeatedly navigate several host observers. */
  claimExitRequest(request: number): boolean {
    if (!request || request <= this.claimedExitRequest) return false
    this.claimedExitRequest = request
    return true
  }

  check = (): void => {
    this.data.batteryBlocked = false
    this.data.offeredReleaseTransition = null
    this.data.completedReleaseTransition = null
    this.data.completedUpdate = false
    this.data.completedChangelogs = []
    this.returnToCheck()
  }

  install = (): FirmwareActionResult => {
    if (this.installPending || this.data.page !== "check") return NONE
    const result = this.selectedResult
    if (!result) {
      this.data.errorKind = "network"
      this.data.checkState = "error"
      this.react()
      return NONE
    }
    const snapshot = this.ports.snapshot()
    if (snapshot.batteryLevel !== null && snapshot.batteryLevel < MINIMUM_OTA_BATTERY_LEVEL) {
      this.data.batteryBlocked = true
      this.react()
      return NONE
    }
    if (!snapshot.wifiStatusKnown) {
      this.check()
      return NONE
    }
    if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1) return {kind: "wifi-required"}
    this.ports.installSession.prepare(result)
    this.data.batteryBlocked = false
    this.data.completedUpdate = false
    this.data.completedChangelogs = []
    if (this.updateFingerprint) {
      this.chain.beginOtaAutoChain(this.updateFingerprint, this.data.isVersionChange, {
        fromVersion: this.data.offeredReleaseTransition
          ? this.data.offeredReleaseTransition.fromVersion
          : currentReleaseVersion(snapshot.appVersion),
        toVersion: releaseRangeTargetVersion(result),
        releaseVersion: result.releaseVersion,
      })
    }
    this.navigateToProgress()
    return NONE
  }

  retryInstall = (): void => {
    if (this.data.page === "progress") this.ports.installSession.retry()
    this.react()
  }

  finish = async (): Promise<FirmwareActionResult> => {
    if (this.data.page === "check") return {kind: "finished"}
    const snapshot = this.ports.installSession.snapshot()
    if (
      snapshot.displayState === "restarting" ||
      snapshot.versionChangePhase === "restarting" ||
      snapshot.versionChangePhase === "verifying"
    )
      return NONE
    if (shouldRequireGlassesRebootForBesFailure(snapshot.otaStatus, snapshot.otaProgress, snapshot.errorMsg)) {
      this.chain.stopOtaAutoChain()
    }
    return this.finishPass(false)
  }

  discard = async (): Promise<FirmwareActionResult> => {
    if (this.data.page !== "progress") return NONE
    this.chain.stopOtaAutoChain()
    return this.finishPass(true)
  }

  openWifiSetup = (): FirmwareActionResult => {
    if (this.data.page === "progress") this.chain.stopOtaAutoChain()
    this.react()
    return {kind: "wifi-required"}
  }

  /** Execution disposal is explicit; a React unsubscription never calls this. */
  dispose(): void {
    this.disposed = true
    this.checkGeneration++
    this.unsubscribers.forEach((unsubscribe) => unsubscribe())
    this.unsubscribers = []
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.completionTimer) clearTimeout(this.completionTimer)
    for (const [timer, resolve] of this.delays) {
      clearTimeout(timer)
      resolve()
    }
    this.delays.clear()
    if (this.attached) this.ports.installSession.detach()
    this.attached = false
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.delays.delete(timer)
        resolve()
      }, ms)
      this.delays.set(timer, resolve)
    })
  }

  private requestExit(): void {
    this.exitRequest++
  }

  private returnToCheck(): void {
    this.installPending = false
    this.autoChainAdvanced = false
    this.data.checkState = "checking"
    this.data.page = "check"
    this.checkStarted = false
    this.checkCompleted = false
    this.selectedResult = null
    this.checkInputs = ""
    this.checkGeneration++
    this.react()
  }

  private navigateToProgress(): void {
    this.installPending = true
    this.ports.clearProgress()
    this.data.page = "progress"
    this.react()
  }

  private continueApprovedChain(result: OtaCheckCurrentGlassesResult): boolean {
    if (this.installPending || !this.chain.isOtaAutoChainActive() || !result.updateInfo) return false
    const snapshot = this.ports.snapshot()
    if (!snapshot.wifiStatusKnown || (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1)) return false
    const admission = this.chain.tryAdvanceOtaAutoChain(
      otaAutoChainFingerprint(result),
      result.updateInfo.isDowngrade === true,
      releaseRangeTargetVersion(result),
      result.releaseVersion,
    )
    if (!admission.advance) return false
    this.checkCompleted = true
    this.ports.installSession.prepare(result)
    this.navigateToProgress()
    return true
  }

  private finishPass(discard: boolean): Promise<FirmwareActionResult> {
    if (this.finishing) return this.finishing
    this.finishing = (async () => {
      await (discard ? this.ports.installSession.discard() : this.ports.installSession.finish())
      if (!this.disposed) this.returnToCheck()
      return NONE
    })().finally(() => {
      this.finishing = null
    })
    return this.finishing
  }

  private react = (): void => {
    if (!this.started || this.disposed) return
    if (this.reacting) {
      this.reactQueued = true
      return
    }
    this.reacting = true
    try {
      do {
        this.reactQueued = false
        const snapshot = this.ports.snapshot()
        if (
          this.data.batteryBlocked &&
          (snapshot.batteryLevel === null || snapshot.batteryLevel >= MINIMUM_OTA_BATTERY_LEVEL)
        ) {
          this.data.batteryBlocked = false
        }
        const shouldAttach = this.data.runtimeReady && this.data.page === "progress"
        if (shouldAttach !== this.attached) {
          this.attached = shouldAttach
          if (shouldAttach) this.ports.installSession.attach()
          else this.ports.installSession.detach()
        }
        const inputs = JSON.stringify([
          this.data.runtimeReady,
          this.data.page,
          snapshot.connected,
          snapshot.ready,
          snapshot.wifiStatusKnown,
        ])
        if (inputs !== this.checkInputs) {
          this.checkInputs = inputs
          const generation = ++this.checkGeneration
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
          this.reconnectTimer = null
          if (this.data.runtimeReady && this.data.page === "check") void this.performCheck(generation)
        }
        if (
          this.data.runtimeReady &&
          this.data.page === "check" &&
          snapshot.wifiStatusKnown &&
          (this.data.checkState === "checking" || this.data.checkState === "update_available") &&
          this.chain.isOtaAutoChainActive() &&
          this.selectedResult?.updateAvailable &&
          this.selectedResult.updateInfo
        ) {
          if (!snapshot.wifiConnected && snapshot.hotspotOtaVersion !== 1) this.data.checkState = "update_available"
          else this.continueApprovedChain(this.selectedResult)
        }
        const install = this.ports.installSession.snapshot()
        const shouldAdvance =
          this.data.page === "progress" &&
          install.displayState === "complete" &&
          install.connected &&
          this.chain.isOtaAutoChainActive() &&
          !this.autoChainAdvanced
        if (!shouldAdvance && this.completionTimer) {
          clearTimeout(this.completionTimer)
          this.completionTimer = null
        }
        if (shouldAdvance && !this.completionTimer) {
          this.completionTimer = setTimeout(() => {
            this.completionTimer = null
            if (this.disposed || !this.chain.isOtaAutoChainActive()) return
            this.autoChainAdvanced = true
            void this.finishPass(false).catch((error) => {
              console.warn("OTA pass cleanup failed", error)
              this.data.checkState = "error"
              this.react()
            })
          }, 750)
        }
        const value = {
          state: projectLiveOtaState(this.data, this.ports, this.chain),
          page: this.data.page,
          exitRequest: this.exitRequest,
        }
        const {revision: _revision, ...previous} = this.snapshots.snapshot()
        if (JSON.stringify(value) !== JSON.stringify(previous)) this.snapshots.publish(value)
      } while (this.reactQueued)
    } finally {
      this.reacting = false
    }
  }

  private async performCheck(generation: number): Promise<void> {
    if (this.checkCompleted) return
    const cancelled = () => this.disposed || generation !== this.checkGeneration
    const snapshot = this.ports.snapshot()
    if (this.chain.isOtaAutoChainActive() && !snapshot.ready) {
      const remaining = this.chain.otaAutoChainReconnectWaitRemaining()
      if (remaining !== null)
        this.reconnectTimer = setTimeout(() => {
          if (cancelled() || this.ports.snapshot().ready) return
          this.chain.stopOtaAutoChain()
          this.checkCompleted = true
          this.data.checkState = "error"
          this.react()
        }, remaining)
      return
    }
    if (!snapshot.connected) {
      if (this.checkStarted) {
        this.chain.stopOtaAutoChain()
        this.data.checkState = "error"
      } else this.requestExit()
      this.checkCompleted = true
      this.react()
      return
    }
    this.chain.clearOtaAutoChainReconnectWait()
    this.checkStarted = true
    const startedAt = Date.now()
    try {
      const options = {
        waitForBuildNumberMs: 10_000,
        waitForBesVersionMs: 5000,
        waitForMtkVersionMs: 2000,
        waitForLegacyMigrationMs: this.chain.isOtaAutoChainActive() ? OTA_AUTO_CHAIN_RECONNECT_TIMEOUT_MS : 0,
        refreshVersionInfo: true,
        fixClockBeforeCheck: false,
      }
      let result = await this.ports.checkForUpdates(options)
      if (cancelled()) return
      if (!result.hasCheckCompleted && result.checkFailureReason === "network" && this.chain.isOtaAutoChainActive()) {
        await this.delay(5000)
        if (cancelled()) return
        result = await this.ports.checkForUpdates(options)
      }
      if (cancelled()) return
      this.selectedResult = result
      await this.delay(Math.max(0, 1100 - (Date.now() - startedAt)))
      if (cancelled()) return
      this.applyCheckResult(result)
    } catch (error) {
      console.error("OTA check failed:", error)
      await this.delay(Math.max(0, 1100 - (Date.now() - startedAt)))
      if (cancelled()) return
      this.chain.stopOtaAutoChain()
      this.checkCompleted = true
      this.data.errorKind = "network"
      this.data.checkState = "error"
    }
    this.react()
  }

  private applyCheckResult(result: OtaCheckCurrentGlassesResult): void {
    this.checkCompleted = true
    if (result.skippedReason === "disconnected") {
      this.chain.stopOtaAutoChain()
      this.data.checkState = "error"
      return
    }
    if (result.skippedReason === "missing_build") {
      if (this.chain.isOtaAutoChainActive()) {
        this.chain.stopOtaAutoChain()
        this.data.checkState = "error"
      } else this.requestExit()
      return
    }
    if (result.skippedReason === "dev_build" || result.skippedReason === "unofficial_client") {
      this.chain.stopOtaAutoChain()
      this.ports.clearUpdateAvailable()
      this.data.unofficialClientPackage = result.packageName ?? null
      this.data.checkState = result.skippedReason
      return
    }
    if (!result.hasCheckCompleted) {
      if (result.checkFailureReason !== "version_info") this.chain.stopOtaAutoChain()
      this.data.errorKind = result.checkFailureReason === "pin_unavailable" ? "pin_unavailable" : "network"
      this.data.checkState = "error"
      return
    }
    if (result.updateAvailable && result.updateInfo) {
      this.data.isUpdateRequired = result.isRequired
      this.data.isVersionChange = result.updateInfo.isDowngrade === true
      this.updateFingerprint = otaAutoChainFingerprint(result)
      if (!this.chain.isOtaAutoChainActive()) {
        const fromVersion = currentReleaseVersion(this.ports.snapshot().appVersion)
        this.data.offeredReleaseTransition = result.releaseVersion
          ? {fromVersion, toVersion: result.releaseVersion}
          : null
      }
      if (this.chain.isOtaAutoChainActive() && !this.ports.snapshot().wifiStatusKnown) return
      if (this.continueApprovedChain(result)) return
      this.data.checkState = "update_available"
      return
    }
    this.data.completedUpdate = this.chain.isOtaAutoChainActive()
    if (this.data.completedUpdate) {
      this.data.completedChangelogs = releaseChangelogsForActiveChain(this.ports, this.chain)
      this.data.completedReleaseTransition = releaseTransitionFromRange(this.chain.otaAutoChainReleaseRange())
    }
    this.chain.stopOtaAutoChain()
    this.ports.clearUpdateAvailable()
    this.data.checkState = "no_update"
  }
}
