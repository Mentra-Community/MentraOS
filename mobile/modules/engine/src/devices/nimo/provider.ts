import type {NativeFirmwareStartRequest, NativeFirmwareUpdateSnapshot} from "@mentra/bluetooth-sdk/firmware-updates"

import type {StagedFirmwareArtifact} from "../../ota/FirmwareArtifacts"
import {NativeFirmwareObservation, type NativeFirmwareObservationPorts} from "../../ota/NativeFirmwareObservation"
import {RevisionedSnapshot} from "../../ota/RevisionedSnapshot"
import {firmwareSourceIdentity, type FirmwareManifestPin} from "../../ota/sourcePolicy"
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
import {nimoCompatibility, type NimoCompatibleFirmware} from "./firmwareVersion"
import type {NimoFirmwareManifest} from "./manifest"
import {nimoFirmwareCopy} from "./copy"

export interface NimoFirmwarePorts extends NativeFirmwareObservationPorts {
  validateTarget(): Promise<void>
  refreshInventory(): Promise<NativeFirmwareUpdateSnapshot>
  reconcile(): Promise<NativeFirmwareUpdateSnapshot>
  start(request: NativeFirmwareStartRequest): Promise<NativeFirmwareUpdateSnapshot>
  acknowledge(): Promise<NativeFirmwareUpdateSnapshot>
  source(): FirmwareManifestPin | null
  loadManifest(pin: FirmwareManifestPin): Promise<NimoFirmwareManifest>
  configureCompatibility(manifest: NimoFirmwareManifest, pin: FirmwareManifestPin): Promise<void>
  readonly compatible: readonly NimoCompatibleFirmware[]
  stage(manifest: NimoFirmwareManifest, progress: (percent: number | null) => void): Promise<StagedFirmwareArtifact>
  acquireRuntime(): () => void
  id(): string
}

interface ApprovedOffer {
  id: string
  manifest: NimoFirmwareManifest
  source: string
  observed: string
  updaterId: string
  connectionGeneration: number
}

function inventoryIdentity(value: NativeFirmwareUpdateSnapshot): string {
  return JSON.stringify([value.observedFirmware, value.inventory.packedVersion])
}

const nativePhases = new Set<FirmwarePhase>([
  "preparing",
  "installing",
  "synchronizing",
  "restarting",
  "verifying",
  "complete",
  "failed",
  "interrupted",
])

/** Release policy and approval live here. Native owns every byte, timeout, reboot and recovery decision. */
export class NimoFirmwareProvider implements FirmwareProvider {
  private readonly state: RevisionedSnapshot<FirmwareSnapshot>
  private readonly observation: NativeFirmwareObservation
  private offer: ApprovedOffer | null = null
  private entryPoint: FirmwareOpenOptions["entryPoint"] = "settings"
  private generation = 0
  private suspended = false
  private disposed = false
  private started = false
  private pendingStart = false
  private file: StagedFirmwareArtifact | null = null
  private releaseRuntime: (() => void) | null = null

  constructor(
    readonly target: FirmwareTarget,
    private readonly ports: NimoFirmwarePorts,
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
      presentation: {title: nimoFirmwareCopy("NIMO firmware"), busy: false, success: false, actions: []},
    })
    this.observation = new NativeFirmwareObservation(target, ports, this.onNative, (error) => {
      this.fail("observation_failed", error, !this.snapshot().safeToRelease)
    })
  }

  snapshot = (): FirmwareSnapshot => this.state.snapshot()
  subscribe = (listener: (value: FirmwareSnapshot) => void): (() => void) => this.state.subscribe(listener)

  async open(options: FirmwareOpenOptions): Promise<void> {
    if (this.disposed) throw new FirmwareUpdateError("action_unavailable", "This firmware flow has ended")
    const generation = this.generation
    this.entryPoint = options.entryPoint
    this.suspended = false
    await this.ports.validateTarget()
    await this.observation.start()
    // A successful reread can resolve a lost Start response without a new revision.
    const native = this.observation.snapshot()
    if (native?.safeToRelease && !native.sessionId) this.onNative(native)
    if (this.suspended || generation !== this.generation) return
    if (this.nativeOwnsFlow() || this.snapshot().active || this.started) return
    this.started = true
    await this.check()
  }

  async perform(request: FirmwareActionRequest): Promise<FirmwareActionResult> {
    if (this.disposed || this.suspended)
      throw new FirmwareUpdateError("action_unavailable", "The firmware flow is suspended")
    const native = this.observation.snapshot()
    if (request.action === "finish" || request.action === "discard") {
      if (
        !this.snapshot().safeToRelease ||
        !this.snapshot().presentation.actions.some((action) => action.id === request.action)
      )
        throw new FirmwareUpdateError("busy", "The device still requires firmware recovery")
      if (native?.sessionId) this.observation.accept(await this.ports.acknowledge())
      if (!this.snapshot().safeToRelease) throw new FirmwareUpdateError("busy", "A native update still owns the device")
      await this.releaseFile()
      return request.action === "discard" ? {kind: "finished", outcome: "cancelled"} : {kind: "finished"}
    }
    if (request.action === "retry" && !this.snapshot().safeToRelease) {
      if (native && !native.safeToRelease && !native.canReconcile)
        throw new FirmwareUpdateError("action_unavailable", "No verified recovery command is available")
      await this.ports.validateTarget()
      if (native && !native.safeToRelease) this.observation.accept(await this.ports.reconcile())
      else {
        await this.observation.start()
        const current = this.observation.snapshot()
        if (current) this.onNative(current)
      }
      return {kind: "none"}
    }
    if (request.action === "check" || request.action === "retry") {
      if (native && !native.safeToRelease)
        throw new FirmwareUpdateError("busy", "The current native update must finish first")
      if (native?.sessionId) this.observation.accept(await this.ports.acknowledge())
      await this.check()
      return {kind: "none"}
    }
    if (request.action !== "install") throw new FirmwareUpdateError("action_unavailable", "This action is unavailable")
    if (!this.offer || request.offerId !== this.offer.id)
      throw new FirmwareUpdateError("stale_offer", "Check firmware again before installing")
    await this.install(this.offer)
    return {kind: "none"}
  }

  suspendNewWork(): void {
    this.suspended = true
    this.started = false
    this.generation++
    this.offer = null
    if (this.snapshot().safeToRelease && !this.pendingStart)
      this.show("idle", "NIMO firmware", "Reopen this flow to check the current glasses.", {offer: null, active: false})
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

  private async check(): Promise<void> {
    const generation = ++this.generation
    this.offer = null
    this.show("checking", "Checking NIMO firmware", "Keep your glasses connected.", {
      offer: null,
      error: null,
      active: false,
    })
    try {
      await this.ports.validateTarget()
      if (!this.isCurrent(generation)) return
      const pin = this.ports.source()
      const source = firmwareSourceIdentity(pin)
      const [native, release] = await Promise.all([
        this.ports.refreshInventory(),
        pin
          ? this.ports.loadManifest(pin).then(
              (manifest) => ({manifest, error: null}),
              (error: unknown) => ({manifest: null, error}),
            )
          : Promise.resolve({manifest: null, error: null}),
      ])
      if (!this.isCurrent(generation)) return
      this.observation.accept(native)
      if (this.nativeOwnsFlow()) return
      if (source !== firmwareSourceIdentity(this.ports.source()))
        throw new FirmwareUpdateError("stale_offer", "Firmware source changed; check again")
      if (release.manifest && pin) {
        await this.ports.configureCompatibility(release.manifest, pin)
        if (!this.isCurrent(generation)) return
        const current = await this.ports.read()
        if (
          current.updaterId !== native.updaterId ||
          current.connectionGeneration !== native.connectionGeneration ||
          inventoryIdentity(current) !== inventoryIdentity(native) ||
          source !== firmwareSourceIdentity(this.ports.source())
        )
          throw new FirmwareUpdateError("stale_offer", "NIMO changed during the compatibility check")
      }
      const observed = {fullVersion: native.observedFirmware ?? "", packedVersion: native.inventory.packedVersion ?? ""}
      const compatible = [...this.ports.compatible, ...(release.manifest?.compatible ?? [])]
      const compatibility =
        native.inventory.compatible === "true"
          ? "compatible"
          : nimoCompatibility(observed, compatible, release.manifest?.upgradeFrom ?? [])
      const manifest = release.manifest
      if (manifest && manifest.upgradeFrom.includes(observed.packedVersion) && compatibility !== "unknown") {
        const id = this.ports.id()
        this.offer = {
          id,
          manifest,
          source,
          observed: inventoryIdentity(native),
          updaterId: native.updaterId,
          connectionGeneration: native.connectionGeneration,
        }
        this.show("available", "NIMO update available", "Keep both sides charged and nearby during the update.", {
          offer: {
            id,
            required: compatibility === "upgrade-required",
            observedVersion: observed.fullVersion,
            targetVersion: manifest.target.fullVersion,
          },
        })
      } else if (compatibility === "compatible") {
        this.show(
          "complete",
          "NIMO is ready",
          release.error
            ? "Your installed firmware is compatible. New update information is currently unavailable."
            : "Your installed firmware is compatible.",
          {offer: null},
        )
      } else {
        this.show(
          pin && !release.error ? "blocked" : "unavailable",
          "NIMO firmware needs attention",
          release.error
            ? "Could not check the required firmware. Reconnect to the Internet and try again."
            : manifest
              ? "This firmware version has no approved upgrade path. Contact support before updating."
              : "No approved NIMO firmware source is configured for this deployment.",
          {offer: null},
        )
      }
    } catch (error) {
      if (this.isCurrent(generation) && !this.nativeOwnsFlow()) this.fail("check_failed", error)
    }
  }

  private async install(offer: ApprovedOffer): Promise<void> {
    const generation = ++this.generation
    let staged: StagedFirmwareArtifact | null = null
    try {
      await this.ports.validateTarget()
      if (!this.isCurrent(generation)) return
      const inventory = await this.ports.refreshInventory()
      this.assertOffer(offer, inventory, generation)
      this.show("downloading", "Downloading NIMO firmware", "Keep the Mentra App open while preparing the update.", {
        active: true,
      })
      staged = await this.ports.stage(offer.manifest, (progress) => {
        if (this.isCurrent(generation))
          this.show("downloading", "Downloading NIMO firmware", undefined, {active: true}, progress)
      })
      if (!this.isCurrent(generation)) return
      await this.ports.validateTarget()
      const native = await this.ports.read()
      this.assertOffer(offer, native, generation)
      this.file = staged
      staged = null
      this.pendingStart = true
      this.show("preparing", "Preparing NIMO update", "Keep both sides nearby. Do not disconnect your glasses.", {
        active: true,
        safeToRelease: false,
        attemptId: this.ports.id(),
      })
      this.holdRuntime()
      const result = await this.ports.start({
        kind: "file",
        deviceId: this.target.deviceId,
        connectionGeneration: native.connectionGeneration,
        offerId: offer.id,
        artifact: {
          path: this.file!.path,
          targetVersion: offer.manifest.target.fullVersion,
          size: offer.manifest.artifact.size,
          sha256: offer.manifest.artifact.sha256,
        },
        metadata: {
          hardwareId: offer.manifest.hardwareId,
          packedVersion: offer.manifest.target.packedVersion,
          peerVersion: offer.manifest.target.peerVersion,
        },
      })
      this.observation.accept(result)
    } catch (error) {
      if (this.pendingStart) {
        // A bridge rejection is not proof that native failed to admit the update.
        try {
          const native = await this.ports.read()
          const accepted = this.observation.acceptRead(native)
          const current = this.observation.snapshot()
          if (current?.safeToRelease && !current.sessionId)
            this.fail(accepted ? "start_failed" : "start_uncertain", error, !accepted)
        } catch {
          this.fail("start_uncertain", error, true)
        }
      } else if (this.isCurrent(generation)) {
        this.offer = null
        this.fail("prepare_failed", error)
      }
    } finally {
      this.pendingStart = false
      await staged?.release()
      if (this.snapshot().safeToRelease) {
        this.releaseRuntime?.()
        this.releaseRuntime = null
        await this.releaseFile()
      }
    }
  }

  private assertOffer(offer: ApprovedOffer, native: NativeFirmwareUpdateSnapshot, generation: number): void {
    if (
      !this.isCurrent(generation) ||
      this.offer !== offer ||
      native.deviceId !== this.target.deviceId ||
      native.integrationId !== this.target.integrationId ||
      native.updaterId !== offer.updaterId ||
      native.connectionGeneration !== offer.connectionGeneration ||
      inventoryIdentity(native) !== offer.observed ||
      firmwareSourceIdentity(this.ports.source()) !== offer.source ||
      !native.safeToRelease ||
      native.sessionId
    )
      throw new FirmwareUpdateError(
        "stale_offer",
        "The device, firmware or source changed; check again before installing",
      )
  }

  private onNative = (native: NativeFirmwareUpdateSnapshot): void => {
    if (this.disposed) return
    if (
      !this.pendingStart &&
      ((native.sessionId && native.sessionId !== this.snapshot().nativeSessionId) ||
        (!native.safeToRelease && this.snapshot().safeToRelease))
    ) {
      // Another native caller or retained transaction takes precedence over optional JS check/download work.
      this.generation++
    }
    if (
      this.offer &&
      !this.snapshot().active &&
      (native.updaterId !== this.offer.updaterId ||
        native.connectionGeneration !== this.offer.connectionGeneration ||
        inventoryIdentity(native) !== this.offer.observed)
    ) {
      this.offer = null
      this.show("idle", "NIMO firmware changed", "Check again before updating these glasses.", {offer: null})
    }
    if (!native.sessionId && native.safeToRelease) {
      // Native idle resolves uncertain admission; it does not establish that the
      // required firmware was installed. Require a new check/approval before Start.
      if (!this.pendingStart && (!this.snapshot().safeToRelease || this.snapshot().nativeSessionId !== null)) {
        this.generation++
        this.started = true
        this.offer = null
        this.releaseRuntime?.()
        this.releaseRuntime = null
        void this.releaseFile()
        this.show("idle", "NIMO firmware", "Check again before updating these glasses.", {
          nativeSessionId: null,
          attemptId: null,
          active: false,
          safeToRelease: true,
          offer: null,
          error: null,
        })
      }
      return
    }
    if (!native.safeToRelease) this.holdRuntime()
    else {
      this.releaseRuntime?.()
      this.releaseRuntime = null
      void this.releaseFile()
    }
    const phase: FirmwarePhase =
      native.phase === "transferring"
        ? "installing"
        : native.phase === "validating"
          ? "verifying"
          : nativePhases.has(native.phase as FirmwarePhase)
            ? (native.phase as FirmwarePhase)
            : "interrupted"
    const titles: Partial<Record<FirmwarePhase, string>> = {
      preparing: "Preparing NIMO update",
      installing: "Updating NIMO",
      synchronizing: "Updating both sides",
      restarting: "Restarting NIMO",
      verifying: "Verifying NIMO firmware",
      complete: "NIMO update complete",
      failed: "NIMO update failed",
      interrupted: "NIMO update needs recovery",
    }
    this.show(
      phase,
      titles[phase] ?? "NIMO update needs recovery",
      native.error ??
        (native.safeToRelease ? undefined : "Keep both sides charged and nearby. Do not reset your glasses."),
      {
        nativeSessionId: native.sessionId ?? null,
        active: !native.safeToRelease,
        safeToRelease: native.safeToRelease,
        error: native.error ? {code: "native_update", message: native.error} : null,
      },
      native.progress === undefined ? undefined : Math.min(100, Math.max(0, native.progress * 100)),
    )
  }

  private show(
    phase: FirmwarePhase,
    title: string,
    message?: string,
    patch: Partial<FirmwareSnapshot> = {},
    progress?: number | null,
  ): void {
    const next = {...this.snapshot(), ...patch, phase}
    const actions: FirmwareSnapshot["presentation"]["actions"][number][] = []
    const native = this.observation?.snapshot()
    const busy = [
      "checking",
      "downloading",
      "preparing",
      "installing",
      "synchronizing",
      "restarting",
      "verifying",
    ].includes(phase)
    if (!next.safeToRelease) {
      if (phase === "interrupted" && (native?.canReconcile || (native?.safeToRelease && !native.sessionId)))
        actions.push({id: "retry", label: nimoFirmwareCopy("Check recovery")})
    } else if (!busy) {
      if (phase === "available" && next.offer) actions.push({id: "install", label: nimoFirmwareCopy("Update now")})
      if (phase !== "available")
        actions.push({id: "check", label: nimoFirmwareCopy("Check again"), secondary: phase === "complete"})
      if (phase === "complete" || this.entryPoint !== "pairing" || next.offer?.required === false)
        actions.push({
          id: "finish",
          label: nimoFirmwareCopy(phase === "complete" ? "Continue" : "Close"),
          secondary: phase !== "complete",
        })
      else actions.push({id: "discard", label: nimoFirmwareCopy("Cancel setup"), secondary: true})
    }
    this.state.publish({
      ...next,
      presentation: {
        title: nimoFirmwareCopy(title),
        message: message ? nimoFirmwareCopy(message) : undefined,
        busy,
        success: phase === "complete",
        progress: progress ?? null,
        actions,
        releaseNotes: this.offer?.manifest.releaseNotes
          ? [{version: this.offer.manifest.target.packedVersion, markdown: this.offer.manifest.releaseNotes}]
          : undefined,
      },
    })
  }

  private fail(code: string, error: unknown, unsafe = false): void {
    this.offer = null
    const message = error instanceof Error ? error.message : "Firmware update information is unavailable"
    this.show(
      unsafe ? "interrupted" : "failed",
      unsafe ? "NIMO update needs recovery" : "NIMO update could not continue",
      message,
      {active: unsafe, safeToRelease: !unsafe, offer: null, error: {code, message}},
    )
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && !this.suspended && generation === this.generation
  }
  private holdRuntime(): void {
    this.releaseRuntime ??= this.ports.acquireRuntime()
  }
  private async releaseFile(): Promise<void> {
    const file = this.file
    this.file = null
    try {
      await file?.release()
    } catch (error) {
      console.warn("Firmware staging cleanup failed", error)
    }
  }
}
