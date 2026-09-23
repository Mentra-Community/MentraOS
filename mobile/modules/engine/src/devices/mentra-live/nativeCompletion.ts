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
        this.failure = null
        if (value.sessionId) {
          if (this.expectingAfter !== null) {
            if (value.sessionId !== this.expectingAfter) {
              this.bound = {updaterId: value.updaterId, sessionId: value.sessionId}
              this.expectingAfter = null
            }
          } else if (!this.bound) {
            this.bound = {updaterId: value.updaterId, sessionId: value.sessionId}
          }
        }
        this.changed()
      },
      (error) => {
        this.failure = error
        this.changed()
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
    const current = await this.readCurrent()
    this.acceptRead(current)
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
      const current = await this.readCurrent()
      const bound = this.bound
      if (current.safeToRelease) {
        this.acceptRead(current)
        if (!this.isSafeToRelease()) throw new FirmwareUpdateError("busy", "The Live update still owns the glasses")
        return
      }
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
      this.acceptRead(current)
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
  }

  private acceptRead(current: NativeFirmwareUpdateSnapshot): void {
    this.failure = null
    this.observation.acceptRead(current)
    // A retry may read the same revision that was observed before the bridge error.
    this.changed()
    this.assertAvailable()
  }

  /** Failed reads block release until fresh native evidence arrives, not all future retries. */
  private async readCurrent(): Promise<NativeFirmwareUpdateSnapshot> {
    try {
      const current = await this.ports.read()
      this.assertAvailable()
      const observed = this.observation.snapshot()
      if (
        current.schemaVersion !== 1 ||
        current.deviceId !== this.deviceId ||
        current.integrationId !== "mentra-live" ||
        !Number.isSafeInteger(current.revision) ||
        current.revision < 0 ||
        !Number.isSafeInteger(current.connectionGeneration) ||
        current.connectionGeneration < 0 ||
        (observed &&
          (current.connectionGeneration < observed.connectionGeneration ||
            (current.updaterId === observed.updaterId && current.revision < observed.revision)))
      )
        throw new FirmwareUpdateError("busy", "Fresh Live firmware status is required")
      return current
    } catch (error) {
      if (!this.disposed) {
        this.failure = error
        this.changed()
      }
      throw error
    }
  }
}
