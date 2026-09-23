import {FirmwareUpdateError} from "../../ota/types"
import {acquireFirmwareRuntime} from "../../ota/RuntimeLease"

let owner: symbol | null = null
let validateTarget: (() => Promise<void>) | null = null
let recoverClock: (() => void | Promise<void>) | null = null
let deviceId: string | null = null

export function managedLiveDeviceId(): string | null {
  return deviceId
}

/** Called at the destructive command boundary, including coordinator retries and later passes. */
export function validateManagedLiveTarget(): Promise<void> | undefined {
  return validateTarget?.()
}

/** A managed flow retries through its coordinator, preserving its selected hotspot URL. */
export async function recoverManagedLiveClock(): Promise<boolean> {
  const token = owner
  const retry = recoverClock
  if (!token || !retry) return false
  await validateTarget?.()
  if (owner !== token)
    throw new FirmwareUpdateError("action_unavailable", "The update owner changed during clock recovery")
  await retry()
  return true
}

export function hasManagedLiveOwner(): boolean {
  return owner !== null
}

export function assertLegacyLiveControlAvailable(): void {
  if (owner) throw new FirmwareUpdateError("busy", "A managed Live update owns this session")
}

export function acquireManagedLiveOwner(
  validate: () => Promise<void>,
  retry: () => void | Promise<void>,
  nativeDeviceId?: string,
): () => void {
  assertLegacyLiveControlAvailable()
  const token = Symbol("Live firmware flow")
  const releaseRuntime = acquireFirmwareRuntime()
  owner = token
  deviceId = nativeDeviceId ?? null
  validateTarget = validate
  recoverClock = retry
  return () => {
    if (owner === token) {
      owner = null
      deviceId = null
      validateTarget = null
      recoverClock = null
      releaseRuntime()
    }
  }
}
