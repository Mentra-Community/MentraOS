import type {NativeFirmwareStartRequest, NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"
import {NativeFirmwareObservation, type NativeFirmwareObservationPorts} from "../../ota/NativeFirmwareObservation"
import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import {
  FirmwareUpdateError,
  type FirmwareActionRequest,
  type FirmwareActionResult,
  type FirmwareOpenOptions,
  type FirmwarePhase,
  type FirmwareProvider,
  type FirmwareSnapshot,
  type FirmwareTarget,
} from "../../ota/types"
import type {Ar99SourceConfiguration, Ar99VersionInfo} from "./releaseSource"

export interface Ar99PreparedFile {
  artifact: NonNullable<NativeFirmwareStartRequest["artifact"]>
  release(): Promise<void>
}
export interface Ar99FirmwarePorts extends NativeFirmwareObservationPorts {
  validateTarget(): Promise<void>
  refreshInventory(): Promise<NativeFirmwareUpdateSnapshot>
  reconcile(): Promise<NativeFirmwareUpdateSnapshot>
  start(request: NativeFirmwareStartRequest): Promise<NativeFirmwareUpdateSnapshot>
  acknowledge(): Promise<NativeFirmwareUpdateSnapshot>
  source(): Ar99SourceConfiguration | null
  lookup(source: Ar99SourceConfiguration, native: NativeFirmwareUpdateSnapshot): Promise<Ar99VersionInfo>
  stage(release: Ar99VersionInfo, progress: (percent: number | null) => void): Promise<Ar99PreparedFile>
  acquireRuntime(): () => void
  id(): string
}
interface Offer {
  id: string
  release: Ar99VersionInfo
  source: string
  context: string
}
const messageKeys: Readonly<Record<string, string>> = {
  "Vendor firmware services are unavailable in this deployment.": "ar99Ota:sourceDisabled",
  "The glasses validated the transferred image. The running firmware version has not yet been confirmed.":
    "ar99Ota:activationUnverified",
  "Keep your glasses nearby. The existing transfer resumes when they reconnect.": "ar99Ota:resumeExplanation",
}
const identity = (value: NativeFirmwareUpdateSnapshot) =>
  JSON.stringify([
    value.deviceId,
    value.updaterId,
    value.connectionGeneration,
    value.observedFirmware,
    value.inventory.serialNumber,
    value.inventory.projectName,
  ])

/** Vendor selection and approval only; native retains transfer/reconnect ownership across view/runtime changes. */
export class Ar99FirmwareProvider implements FirmwareProvider {
  private readonly state: RevisionedSnapshot<FirmwareSnapshot>
  private readonly observation: NativeFirmwareObservation
  private offer: Offer | null = null
  private generation = 0
  private suspended = false
  private disposed = false
  private opened = false
  private pendingStart = false
  private file: Ar99PreparedFile | null = null
  private releaseRuntime: (() => void) | null = null

  constructor(
    readonly target: FirmwareTarget,
    private readonly ports: Ar99FirmwarePorts,
  ) {
    this.state = new RevisionedSnapshot<FirmwareSnapshot>({
      target,
      flowId: ports.id(),
      revision: 0,
      attemptId: null,
      nativeSessionId: null,
      phase: "idle",
      active: false,
      safeToRelease: true,
      offer: null,
      error: null,
      presentation: {
        title: {text: "AR99 firmware", key: "ar99Ota:firmwareTitle"},
        busy: false,
        success: false,
        actions: [],
      },
    })
    this.observation = new NativeFirmwareObservation(target, ports, this.onNative, (error) =>
      this.fail(error, !this.snapshot().safeToRelease),
    )
  }
  snapshot = () => this.state.snapshot()
  subscribe = (listener: (value: FirmwareSnapshot) => void) => this.state.subscribe(listener)

  async open(_options: FirmwareOpenOptions): Promise<void> {
    if (this.disposed) throw new FirmwareUpdateError("action_unavailable", "This AR99 flow has ended")
    this.suspended = false
    const generation = this.generation
    await this.ports.validateTarget()
    await this.observation.start()
    // A successful reread can resolve a lost Start response without a new revision.
    const native = this.observation.snapshot()
    if (native?.safeToRelease && !native.sessionId) this.onNative(native)
    if (!this.current(generation) || this.nativeOwnsFlow() || this.opened || this.snapshot().active) return
    this.opened = true
    await this.check()
  }

  async perform(request: FirmwareActionRequest): Promise<FirmwareActionResult> {
    if (this.suspended || this.disposed)
      throw new FirmwareUpdateError("action_unavailable", "The AR99 flow is suspended")
    if (!this.snapshot().presentation.actions.some((action) => action.id === request.action))
      throw new FirmwareUpdateError("action_unavailable", "This AR99 action is unavailable")
    const native = this.observation.snapshot()
    if (request.action === "finish") {
      if (!this.snapshot().safeToRelease) throw new FirmwareUpdateError("busy", "AR99 still owns its update")
      if (native?.sessionId) this.observation.accept(await this.ports.acknowledge())
      if (!this.snapshot().safeToRelease) throw new FirmwareUpdateError("busy", "A native AR99 update is still active")
      await this.releaseFile()
      return {kind: "finished"}
    }
    if (request.action === "retry" && !this.snapshot().safeToRelease) {
      await this.ports.validateTarget()
      if (native && !native.safeToRelease) this.observation.accept(await this.ports.reconcile())
      else {
        await this.observation.start()
        const current = this.observation.snapshot()
        if (current) this.onNative(current)
      }
    } else if (request.action === "check" || request.action === "retry") {
      if (native?.sessionId) this.observation.accept(await this.ports.acknowledge())
      await this.check()
    } else if (request.action === "install") {
      if (!this.offer || request.offerId !== this.offer.id)
        throw new FirmwareUpdateError("stale_offer", "Check AR99 firmware again")
      await this.install(this.offer)
    }
    return {kind: "none"}
  }

  suspendNewWork(): void {
    this.suspended = true
    this.opened = false
    this.generation++
    this.offer = null
    if (this.snapshot().safeToRelease && !this.pendingStart)
      this.show("idle", "firmwareTitle", "AR99 firmware", undefined, {offer: null, active: false})
  }
  dispose(): void {
    if (!this.snapshot().safeToRelease || this.pendingStart) return
    this.suspendNewWork()
    this.disposed = true
    this.observation.dispose()
    this.releaseRuntime?.()
    this.releaseRuntime = null
    void this.releaseFile()
  }
  private nativeOwnsFlow(): boolean {
    const native = this.observation.snapshot()
    return Boolean(native && (native.sessionId || !native.safeToRelease))
  }
  private current(generation: number): boolean {
    return !this.disposed && !this.suspended && generation === this.generation
  }

  private async check(): Promise<void> {
    const generation = ++this.generation
    this.offer = null
    this.show("checking", "checkingFirmware", "Checking firmware", undefined, {offer: null, error: null, active: false})
    try {
      await this.ports.validateTarget()
      if (!this.current(generation)) return
      const source = this.ports.source()
      if (!source) {
        this.show(
          "unavailable",
          "sourceUnavailable",
          "AR99 firmware service unavailable",
          "Vendor firmware services are unavailable in this deployment.",
        )
        return
      }
      const native = await this.ports.refreshInventory()
      if (!this.current(generation)) return
      this.observation.accept(native)
      if (this.nativeOwnsFlow()) return
      if (!native.observedFirmware?.trim() || !native.inventory.serialNumber?.trim())
        throw new Error("AR99 device information is not ready")
      const sourceId = JSON.stringify(source)
      const release = await this.ports.lookup(source, native)
      if (!this.current(generation)) return
      await this.ports.validateTarget()
      const after = await this.ports.read()
      this.observation.accept(after)
      if (!this.current(generation) || this.nativeOwnsFlow()) return
      if (sourceId !== JSON.stringify(this.ports.source()) || identity(after) !== identity(native))
        throw new FirmwareUpdateError("stale_offer", "AR99 or its firmware source changed; check again")
      if (release.hasUpdate) {
        const id = this.ports.id()
        this.offer = {id, release, source: sourceId, context: identity(native)}
        this.show("available", "firmwareUpdateAvailable", "Firmware update available", undefined, {
          offer: {
            id,
            required: release.forceUpdate,
            observedVersion: native.observedFirmware ?? null,
            targetVersion: release.currentVersion,
          },
        })
      } else this.show("complete", "firmwareUpToDate", "Firmware up to date", native.observedFirmware, {offer: null})
    } catch (error) {
      if (this.current(generation) && !this.nativeOwnsFlow()) this.fail(error)
    }
  }

  private async install(offer: Offer): Promise<void> {
    const generation = ++this.generation
    let file: Ar99PreparedFile | null = null
    try {
      await this.ports.validateTarget()
      if (!this.current(generation)) return
      this.assertOffer(offer, await this.ports.refreshInventory(), generation)
      this.show("downloading", "downloadingFirmware", "Downloading firmware", undefined, {active: true})
      file = await this.ports.stage(offer.release, (progress) => {
        if (this.current(generation))
          this.show("downloading", "downloadingFirmware", "Downloading firmware", undefined, {active: true}, progress)
      })
      if (!this.current(generation)) return
      await this.ports.validateTarget()
      const native = await this.ports.read()
      this.assertOffer(offer, native, generation)
      this.file = file
      file = null
      this.pendingStart = true
      this.show("preparing", "preparingUpdate", "Preparing firmware update", undefined, {
        active: true,
        safeToRelease: false,
        attemptId: this.ports.id(),
      })
      this.releaseRuntime ??= this.ports.acquireRuntime()
      this.observation.accept(
        await this.ports.start({
          deviceId: this.target.deviceId,
          connectionGeneration: native.connectionGeneration,
          offerId: offer.id,
          kind: "file",
          artifact: this.file.artifact,
          metadata: {},
        }),
      )
    } catch (error) {
      if (this.pendingStart) {
        try {
          const native = await this.ports.read()
          const accepted = this.observation.acceptRead(native)
          const current = this.observation.snapshot()
          if (current?.safeToRelease && !current.sessionId) this.fail(error, !accepted)
        } catch {
          this.fail(error, true)
        }
      } else if (this.current(generation) && !this.nativeOwnsFlow()) this.fail(error)
    } finally {
      this.pendingStart = false
      await file?.release()
      if (this.snapshot().safeToRelease) {
        this.releaseRuntime?.()
        this.releaseRuntime = null
        await this.releaseFile()
      }
    }
  }
  private assertOffer(offer: Offer, native: NativeFirmwareUpdateSnapshot, generation: number): void {
    if (
      !this.current(generation) ||
      this.offer !== offer ||
      !native.safeToRelease ||
      native.sessionId ||
      native.deviceId !== this.target.deviceId ||
      native.integrationId !== this.target.integrationId ||
      identity(native) !== offer.context ||
      JSON.stringify(this.ports.source()) !== offer.source
    )
      throw new FirmwareUpdateError("stale_offer", "AR99, its version or firmware source changed; check again")
  }

  private onNative = (native: NativeFirmwareUpdateSnapshot): void => {
    if (this.disposed) return
    if (
      !this.pendingStart &&
      ((native.sessionId && native.sessionId !== this.snapshot().nativeSessionId) ||
        (!native.safeToRelease && this.snapshot().safeToRelease))
    )
      this.generation++
    if (!native.sessionId && native.safeToRelease) {
      // This covers legacy release and a failed managed Start whose status read
      // was lost. Native idle proves no ownership, not successful activation.
      if (!this.pendingStart && (!this.snapshot().safeToRelease || this.snapshot().nativeSessionId !== null)) {
        this.generation++
        this.opened = true
        this.offer = null
        this.releaseRuntime?.()
        this.releaseRuntime = null
        void this.releaseFile()
        this.show("idle", "checkAgain", "Check firmware again", undefined, {
          nativeSessionId: null,
          attemptId: null,
          active: false,
          safeToRelease: true,
          offer: null,
          error: null,
          details: {observedVersion: native.observedFirmware},
        })
        return
      }
      if (this.offer && identity(native) !== this.offer.context) {
        this.offer = null
        this.show("idle", "checkAgain", "Check firmware again", undefined, {offer: null})
      }
      return
    }
    if (!native.safeToRelease) this.releaseRuntime ??= this.ports.acquireRuntime()
    else {
      this.releaseRuntime?.()
      this.releaseRuntime = null
      void this.releaseFile()
    }
    const phase: FirmwarePhase =
      native.phase === "transferring"
        ? "installing"
        : native.phase === "paused"
          ? "interrupted"
          : ["preparing", "complete", "failed", "interrupted"].includes(native.phase)
            ? (native.phase as FirmwarePhase)
            : "interrupted"
    const paused = native.phase === "paused"
    const copy =
      phase === "complete"
        ? ["transferComplete", "Firmware transfer complete"]
        : paused
          ? ["waitingForReconnect", "Waiting for reconnect"]
          : phase === "installing"
            ? ["updatingFirmware", "Updating firmware"]
            : phase === "preparing"
              ? ["preparingUpdate", "Preparing firmware update"]
              : ["recoveryRequired", "Firmware update needs attention"]
    const message =
      native.error ??
      (phase === "complete" && native.inventory.activation !== "verified"
        ? "The glasses validated the transferred image. The running firmware version has not yet been confirmed."
        : paused
          ? "Keep your glasses nearby. The existing transfer resumes when they reconnect."
          : undefined)
    this.show(
      phase,
      copy[0]!,
      copy[1]!,
      message,
      {
        nativeSessionId: native.sessionId ?? null,
        safeToRelease: native.safeToRelease,
        active: !native.safeToRelease,
        error: native.error ? {code: "native_update", message: native.error} : null,
        details: {
          observedVersion: native.observedFirmware,
          targetVersion: native.targetFirmware,
          activation: native.inventory.activation,
        },
      },
      native.progress === undefined ? null : native.progress * 100,
    )
  }

  private show(
    phase: FirmwarePhase,
    key: string,
    title: string,
    message?: string,
    patch: Partial<FirmwareSnapshot> = {},
    progress?: number | null,
  ): void {
    const next = {...this.snapshot(), ...patch, phase}
    const busy = ["checking", "downloading", "preparing", "installing"].includes(phase)
    const actions: FirmwareSnapshot["presentation"]["actions"][number][] = []
    const action = (id: "check" | "install" | "retry" | "finish", key: string, text: string, secondary = false) =>
      actions.push({id, label: {text, key: `ar99Ota:${key}`}, secondary})
    if (!next.safeToRelease) {
      const native = this.observation.snapshot()
      if (phase === "interrupted" && (native?.canReconcile || (native?.safeToRelease && !native.sessionId)))
        action("retry", "inspectFirmware", "Check recovery")
    } else if (!busy) {
      if (phase === "available") action("install", "upgrade", "Upgrade")
      else if (phase !== "complete") action("check", "retry", "Retry")
      if (phase !== "available" || !next.offer?.required)
        action("finish", phase === "complete" ? "done" : "close", phase === "complete" ? "Done" : "Close", true)
    }
    this.state.publish({
      ...next,
      presentation: {
        title: {text: title, key: `ar99Ota:${key}`},
        message: message ? {text: message, key: messageKeys[message]} : undefined,
        busy,
        success: phase === "complete",
        progress,
        actions,
        releaseNotes: this.offer?.release.changeLog
          ? [{version: this.offer.release.currentVersion, markdown: this.offer.release.changeLog}]
          : undefined,
      },
    })
  }
  private fail(error: unknown, unsafe = false): void {
    this.offer = null
    const message = error instanceof Error ? error.message : "AR99 firmware information is unavailable"
    this.show(unsafe ? "interrupted" : "failed", "updateFailed", "Firmware update failed", message, {
      active: unsafe,
      safeToRelease: !unsafe,
      offer: null,
      error: {code: "ar99_update", message},
    })
  }
  private async releaseFile(): Promise<void> {
    const file = this.file
    this.file = null
    try {
      await file?.release()
    } catch (error) {
      console.warn("AR99 staging cleanup failed", error)
    }
  }
}
