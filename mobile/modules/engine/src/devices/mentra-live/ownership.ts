import {FirmwareUpdateError} from "../../ota/types"
import {acquireFirmwareRuntime} from "../../ota/RuntimeLease"

let owner: symbol | null = null
let ownerKind: "managed" | "legacy" | null = null
let validateTarget: (() => Promise<void>) | null = null
let recoverClock: (() => void | Promise<void>) | null = null
let deviceId: string | (() => string | null) | null = null

export function managedLiveDeviceId(): string | null {
  return typeof deviceId === "function" ? deviceId() : deviceId
}

export function hasLiveExecutionOwner(): boolean {
  return owner !== null
}

/** Called at the destructive command boundary, including coordinator retries and later passes. */
export function validateManagedLiveTarget(): Promise<void> | undefined {
  return validateTarget?.()
}

/** Both execution owners retry through their coordinator, preserving the native attempt binding and selected hotspot URL. */
export async function recoverLiveClock(): Promise<boolean> {
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
  return ownerKind === "managed"
}

export function assertLegacyLiveControlAvailable(): void {
  if (ownerKind === "managed") throw new FirmwareUpdateError("busy", "A managed Live update owns this session")
}

export function acquireManagedLiveOwner(
  validate: () => Promise<void>,
  retry: () => void | Promise<void>,
  nativeDeviceId?: string,
): () => void {
  return acquireOwner("managed", validate, retry, nativeDeviceId)
}

export function acquireLegacyLiveOwner(
  validate: () => Promise<void>,
  retry: () => void | Promise<void>,
  nativeDeviceId: () => string | null,
): () => void {
  return acquireOwner("legacy", validate, retry, nativeDeviceId)
}

function acquireOwner(
  kind: "managed" | "legacy",
  validate: () => Promise<void>,
  retry: () => void | Promise<void>,
  nativeDeviceId?: string | (() => string | null),
): () => void {
  if (owner) throw new FirmwareUpdateError("busy", "A Live update controller already owns this session")
  const token = Symbol("Live firmware flow")
  const releaseRuntime = acquireFirmwareRuntime()
  owner = token
  ownerKind = kind
  deviceId = nativeDeviceId ?? null
  validateTarget = validate
  recoverClock = retry
  return () => {
    if (owner === token) {
      owner = null
      ownerKind = null
      deviceId = null
      validateTarget = null
      recoverClock = null
      releaseRuntime()
    }
  }
}
