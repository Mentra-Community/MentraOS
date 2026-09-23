import {FirmwareUpdateError} from "../../ota/types"
import {acquireFirmwareRuntime} from "../../ota/RuntimeLease"

let owner: symbol | null = null
let validateTarget: (() => Promise<void>) | null = null
let recoverClock: (() => void | Promise<void>) | null = null

/** Called at the destructive command boundary, including coordinator retries and later passes. */
export function validateManagedLiveTarget(): Promise<void> | undefined {
  return validateTarget?.()
}

/** A managed flow retries through its coordinator, preserving its selected hotspot URL. */
export async function recoverManagedLiveClock(): Promise<boolean> {
  if (!owner || !recoverClock) return false
  await validateTarget?.()
  await recoverClock()
  return true
}

export function hasManagedLiveOwner(): boolean {
  return owner !== null
}

export function assertLegacyLiveControlAvailable(): void {
  if (owner) throw new FirmwareUpdateError("busy", "A managed Live update owns this session")
}

export function acquireManagedLiveOwner(validate: () => Promise<void>, retry: () => void | Promise<void>): () => void {
  assertLegacyLiveControlAvailable()
  const token = Symbol("Live firmware flow")
  const releaseRuntime = acquireFirmwareRuntime()
  owner = token
  validateTarget = validate
  recoverClock = retry
  return () => {
    if (owner === token) {
      owner = null
      validateTarget = null
      recoverClock = null
      releaseRuntime()
    }
  }
}
