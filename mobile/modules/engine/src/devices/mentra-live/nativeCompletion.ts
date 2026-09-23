import type {
  NativeFirmwareCompletionEvidence,
  NativeFirmwareUpdateSnapshot,
} from "@mentra/bluetooth-sdk/firmware-updates"

import {NativeFirmwareObservation, type NativeFirmwareObservationPorts} from "../../ota/NativeFirmwareObservation"
import {FirmwareUpdateError} from "../../ota/types"

export type LiveCompletionKind = "live-bes-reboot" | "live-apk-build-increase" | "live-apk-target-convergence"

interface CompletionPorts extends NativeFirmwareObservationPorts {
  complete(evidence: NativeFirmwareCompletionEvidence): Promise<NativeFirmwareUpdateSnapshot>
}

/** Binds the coordinator's existing completion verdict to its own native transaction.
 * New native sessions are admitted only before an explicit start, never during finish().
 */
export class LiveNativeCompletion {
  private readonly observation: NativeFirmwareObservation
  private readonly ready: Promise<void>
  private bound: {updaterId: string; sessionId: string} | null = null
  private expectingAfter: string | null = null
  private failure: unknown = null
  private disposed = false
  private unsupported = false

  constructor(
    private readonly deviceId: string,
    private readonly ports: CompletionPorts,
    private readonly changed: () => void = () => {},
  ) {
    this.observation = new NativeFirmwareObservation(
      {integrationId: "mentra-live", deviceId},
      ports,
      (value) => {
        this.changed()
        if (!value.sessionId) return
        if (this.expectingAfter !== null) {
          if (value.sessionId === this.expectingAfter) return
          this.bound = {updaterId: value.updaterId, sessionId: value.sessionId}
          this.expectingAfter = null
        } else if (!this.bound) {
          this.bound = {updaterId: value.updaterId, sessionId: value.sessionId}
        }
      },
      (error) => {
        this.failure = error
      },
    )
    this.ready = this.observation.start().catch((error: unknown) => {
      if ((error as {code?: string})?.code === "unsupported") this.unsupported = true
      else this.failure = error
      this.changed()
    })
  }

  isSafeToRelease(): boolean {
    return this.unsupported || (!this.failure && this.observation.snapshot()?.safeToRelease === true)
  }

  async beforeStart(): Promise<void> {
    await this.ready
    this.assertAvailable()
    if (this.unsupported) return
    const current = await this.ports.read()
    this.assertAvailable()
    this.observation.accept(current)
    this.expectingAfter = current.sessionId ?? ""
    this.bound = null
  }

  async finish(kind: LiveCompletionKind | null): Promise<void> {
    await this.ready
    this.assertAvailable()
    if (this.unsupported) return
    // Status can advance between the read and the native compare-and-set. Retry only that
    // race, with fresh evidence for the same bound transaction; all other failures reach UI.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.ports.read()
      this.assertAvailable()
      const bound = this.bound
      if (current.safeToRelease) return
      if (
        !kind ||
        !bound ||
        current.deviceId !== this.deviceId ||
        current.integrationId !== "mentra-live" ||
        current.updaterId !== bound.updaterId ||
        current.sessionId !== bound.sessionId
      ) {
        throw new FirmwareUpdateError("busy", "The Live update still requires completion verification")
      }
      try {
        const result = await this.ports.complete({
          deviceId: this.deviceId,
          ...bound,
          connectionGeneration: current.connectionGeneration,
          revision: current.revision,
          kind,
        })
        this.observation.accept(result)
        if (!result.safeToRelease) throw new FirmwareUpdateError("busy", "The Live update still owns the glasses")
        return
      } catch (error) {
        if (attempt === 2 || (error as {code?: string})?.code !== "stale_evidence") throw error
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.observation.dispose()
  }

  private assertAvailable(): void {
    if (this.disposed) throw new FirmwareUpdateError("busy", "The Live update owner changed")
    if (this.failure) throw this.failure
  }
}
