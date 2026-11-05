// Every hotspot user reserves before BLE AP changes or native association,
// and releases only after its owned cleanup completes.
let owner: symbol | null = null
let releasedAt = Number.NEGATIVE_INFINITY
let acquisitions = 0

/**
 * How long after a release an enabled report is taken as that owner's late enable. A
 * set_hotspot_state can wait in the BLE queue past its caller's timeout and reach the glasses
 * after the caller's disable (OS-2133).
 */
export const LATE_ENABLE_WINDOW_MS = 60_000

export function acquireGlassesHotspot(): () => void {
  if (owner) throw new Error("The glasses hotspot is already in use")
  const token = Symbol("glasses hotspot")
  owner = token
  acquisitions += 1
  return () => {
    if (owner !== token) return
    owner = null
    releasedAt = Date.now()
  }
}

/**
 * Counts acquisitions. A BLE hotspot command deferred under one value must not be sent once it
 * has changed: the AP then belongs to a later owner.
 */
export function hotspotAcquisitions(): number {
  return acquisitions
}

/**
 * Turn off a hotspot that came up with no owner, soon after an owner released it. The
 * reservation is held while the disable is sent, so it can never land on a new owner's AP.
 * An AP the glasses start on their own, long after any phone use, is left alone.
 */
export async function reclaimLateHotspot(setHotspotState: (enabled: false) => Promise<unknown>): Promise<boolean> {
  if (owner || Date.now() - releasedAt >= LATE_ENABLE_WINDOW_MS) return false
  const release = acquireGlassesHotspot()
  try {
    console.warn("[GlassesHotspot] An enabled hotspot has no owner after a release; turning it off")
    await setHotspotState(false)
    return true
  } finally {
    release()
  }
}
