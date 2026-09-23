import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import {
  FirmwareUpdateError,
  type FirmwareActionRequest,
  type FirmwareActionResult,
  type FirmwareOpenOptions,
  type FirmwareProvider,
  type FirmwareSnapshot,
  type FirmwareTarget,
  type FirmwarePhase,
} from "../../ota/types"
import {MentraLiveOtaSession, type LiveOtaPorts} from "./session"
import type {MentraLiveOtaState} from "./types"

const phases: Record<MentraLiveOtaState["screen"], FirmwarePhase> = {
  initializing: "checking",
  checking: "checking",
  finishing: "verifying",
  update_available: "available",
  battery_required: "blocked",
  wifi_required: "blocked",
  up_to_date: "complete",
  dev_build: "unavailable",
  unofficial_client: "unavailable",
  check_failed: "failed",
  update_info_unavailable: "unavailable",
  starting: "preparing",
  preparing_hotspot: "preparing",
  updating: "installing",
  restarting: "restarting",
  verifying: "verifying",
  complete: "complete",
  failed: "failed",
  disconnected: "interrupted",
}

/** The Live implementation of the same managed-provider boundary used by file-based updaters. */
export class MentraLiveFirmwareProvider implements FirmwareProvider {
  session: MentraLiveOtaSession
  private snapshots: RevisionedSnapshot<FirmwareSnapshot>
  private unsubscribe: () => void
  private opened = false
  private admitted = false
  private suspended = false
  private cleanup: Promise<void> | null = null
  private cleanupFailed = false
  private lifecycleGeneration = 0
  private allowDevelopmentSkip = false
  private readonly flowId = `live-${Date.now()}-${Math.random().toString(36).slice(2)}`

  constructor(
    readonly target: FirmwareTarget,
    private readonly ports: LiveOtaPorts,
    private readonly validateTarget: () => Promise<void>,
    private readonly safeToRelease: () => boolean,
    private readonly acquireOwner: (validate: () => Promise<void>, retry: () => void) => () => void,
    private readonly inspectRecovery?: (options: FirmwareOpenOptions) => Promise<boolean>,
  ) {
    this.session = new MentraLiveOtaSession(ports)
    this.snapshots = new RevisionedSnapshot(this.project())
    this.unsubscribe = this.session.subscribe(this.refresh)
  }

  private releaseOwner: (() => void) | null = null
  snapshot = (): FirmwareSnapshot => this.snapshots.snapshot()
  subscribe = (listener: (snapshot: FirmwareSnapshot) => void) => this.snapshots.subscribe(listener)

  async open(options: FirmwareOpenOptions): Promise<void> {
    const generation = this.lifecycleGeneration
    this.allowDevelopmentSkip = options.allowDevelopmentSkip === true
    await this.validateTarget()
    if (this.cleanup) await this.cleanup
    if (generation !== this.lifecycleGeneration)
      throw new FirmwareUpdateError("action_unavailable", "The host runtime stopped")
    this.cleanupFailed = false
    if (this.opened) {
      this.suspended = false
      this.session.resumeNewWork()
      return this.session.open()
    }
    const observationOnly = (await this.inspectRecovery?.(options)) ?? false
    if (generation !== this.lifecycleGeneration)
      throw new FirmwareUpdateError("action_unavailable", "The host runtime stopped")
    this.suspended = false
    if (this.session.isDisposed) {
      this.session = new MentraLiveOtaSession(this.ports)
      this.unsubscribe = this.session.subscribe(this.refresh)
    }
    this.releaseOwner = this.acquireOwner(this.validateTarget, () => this.ports.installSession.retry())
    this.opened = true
    try {
      await this.session.open({
        initialPage: observationOnly || options.legacyProgressEntry ? "progress" : "check",
        initializeRuntime: options.initializeRuntime,
        observationOnly,
      })
    } catch (error) {
      if (this.snapshot().safeToRelease) this.release()
      throw error
    }
  }

  async perform(request: FirmwareActionRequest): Promise<FirmwareActionResult> {
    const generation = this.lifecycleGeneration
    if (this.suspended)
      throw new FirmwareUpdateError("action_unavailable", "Reopen this update flow to recover the device")
    if (!this.opened) throw new FirmwareUpdateError("action_unavailable", "Open this update flow first")
    const state = this.snapshot()
    if (request.action === "install") {
      if (!request.offerId || request.offerId !== state.offer?.id)
        throw new FirmwareUpdateError("stale_offer", "Check the update again")
      if (state.active) return {kind: "none"}
    }
    const action = state.presentation.actions.find((item) => item.id === request.action)
    if (!action || action.disabled)
      throw new FirmwareUpdateError("action_unavailable", "This update action is unavailable")
    if (["check", "install", "retry"].includes(request.action)) await this.validateTarget()
    if (generation !== this.lifecycleGeneration || this.suspended)
      throw new FirmwareUpdateError("action_unavailable", "The host runtime stopped")
    const current = this.snapshot()
    if (request.action === "install" && request.offerId !== current.offer?.id)
      throw new FirmwareUpdateError("stale_offer", "The update changed while verifying the paired device")
    const currentAction = current.presentation.actions.find((item) => item.id === request.action)
    if (!currentAction || currentAction.disabled)
      throw new FirmwareUpdateError("action_unavailable", "The update state changed; try again")
    switch (request.action) {
      case "install":
        this.admitted = true
        try {
          return this.session.install()
        } finally {
          this.admitted = false
        }
      case "retry":
        if (this.session.snapshot().page === "progress") this.session.retryInstall()
        else this.session.check()
        break
      case "check":
        this.session.check()
        break
      case "wifi":
        return this.session.openWifiSetup()
      case "discard":
        return this.session.discard()
      case "finish": {
        const result = await this.session.finish()
        if (result.kind === "finished") this.release()
        return result
      }
    }
    return {kind: "none"}
  }

  dispose(): void {
    if (!this.snapshot().safeToRelease) throw new FirmwareUpdateError("busy", "The Live update still owns the device")
    this.unsubscribe()
    this.session.dispose()
    this.release()
  }

  suspendNewWork(): void {
    this.lifecycleGeneration++
    this.suspended = true
    this.session.suspendNewWork()
    this.refresh()
  }

  private refresh = (): void => {
    this.snapshots.publish(this.project())
    if (!this.suspended || this.admitted) return
    if (!this.session.requiresCleanup) {
      if (!this.cleanup && this.safeToRelease()) {
        this.unsubscribe?.()
        this.session.dispose()
        this.release()
        this.snapshots.publish(this.project())
      }
      return
    }
    if (this.cleanup || this.cleanupFailed || !this.canFinishSuspendedWork()) return
    // Native/store subscribers run synchronously. Defer until the coordinator has
    // processed this same event, then retain the owner through transport teardown.
    const session = this.session
    const generation = this.lifecycleGeneration
    const cleanup = Promise.resolve()
      .then(async () => {
        if (!this.suspended || session !== this.session || generation !== this.lifecycleGeneration) return
        if (this.admitted || !this.canFinishSuspendedWork()) return
        await session.finishSuspendedWork()
      })
      .catch((error) => {
        this.cleanupFailed = true
        console.warn("Suspended Live OTA cleanup failed; reopen to retry", error)
      })
      .finally(() => {
        if (this.cleanup === cleanup) {
          this.cleanup = null
          this.refresh()
        }
      })
    this.cleanup = cleanup
  }

  private canFinishSuspendedWork(): boolean {
    // Legacy BES/APK completion needs the coordinator's existing proof reconciled
    // into the native journal. finish() performs that verification before cleanup.
    return this.safeToRelease() || this.session.snapshot().state.screen === "complete"
  }

  private release(): void {
    this.releaseOwner?.()
    this.releaseOwner = null
    this.opened = false
  }

  private project(): FirmwareSnapshot {
    const snapshot = this.session.snapshot()
    const s = snapshot.state
    const terminalSafe = (s.screen === "complete" || s.screen === "failed") && this.safeToRelease()
    const active =
      !this.session.isDisposed &&
      (this.admitted ||
        this.session.requiresCleanup ||
        (snapshot.page === "progress" && !terminalSafe) ||
        this.session.chain.isOtaAutoChainActive())
    const actions: FirmwareSnapshot["presentation"]["actions"][number][] = []
    if (!active && s.screen !== "checking" && s.screen !== "initializing")
      actions.push({id: "check", label: {text: "Check for updates", key: "ota:checkingForUpdates"}})
    if (s.canInstall || s.screen === "battery_required")
      actions.push({id: "install", label: {text: "Update Now", key: "ota:updateNow"}, disabled: !s.canInstall})
    if (s.canRetry) actions.push({id: "retry", label: {text: "Retry"}})
    if (s.canOpenWifiSetup) actions.push({id: "wifi", label: {text: "Set up Wi-Fi", key: "ota:setupWifi"}})
    if (
      s.canFinish ||
      s.canDismiss ||
      snapshot.exitRequest > 0 ||
      (this.allowDevelopmentSkip && snapshot.page === "check" && !active)
    )
      actions.push({
        id: "finish",
        label: {text: s.canDismiss ? "Later" : "Continue", key: s.canDismiss ? "ota:updateLater" : "common:continue"},
        disabled: s.continueDisabled,
        secondary: s.canDismiss,
      })
    if (
      this.allowDevelopmentSkip &&
      snapshot.page === "progress" &&
      !this.session.chain.isOtaAutoChainActive() &&
      this.safeToRelease()
    )
      actions.push({id: "discard", label: {text: "Skip (super)"}, secondary: true})
    return {
      target: this.target,
      flowId: this.flowId,
      attemptId: snapshot.pass ? `${this.flowId}:${snapshot.pass}` : null,
      nativeSessionId: this.ports.snapshot().status?.sessionId ?? null,
      revision: 0,
      phase: phases[s.screen],
      active,
      safeToRelease:
        !this.admitted &&
        !this.cleanup &&
        !this.session.requiresCleanup &&
        !this.session.chain.isOtaAutoChainActive() &&
        this.safeToRelease(),
      offer: snapshot.offerId
        ? {
            id: snapshot.offerId,
            required: s.updateRequired,
            observedVersion: s.releaseTransition?.fromVersion ?? this.ports.snapshot().appVersion,
            targetVersion: s.releaseTransition?.toVersion ?? null,
          }
        : null,
      error: s.error ? {code: s.error.code, message: s.error.message, deviceCode: s.error.glassesCode} : null,
      presentation: {
        title: {text: s.screen.replaceAll("_", " ")},
        progress: s.progress,
        busy: active || s.screen === "checking" || s.screen === "initializing",
        success: s.screen === "up_to_date",
        actions,
        releaseNotes: s.changelogs,
      },
      details: s,
    }
  }
}
