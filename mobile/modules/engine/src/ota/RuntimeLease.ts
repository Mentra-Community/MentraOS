/** Device-local projections can outlive authenticated Engine/UI teardown during an unsafe update. */
const owners = new Set<symbol>()
const deferredStops = new Set<() => void>()

export function acquireFirmwareRuntime(): () => void {
  const token = Symbol("firmware runtime")
  owners.add(token)
  return () => {
    if (!owners.delete(token) || owners.size) return
    const stops = [...deferredStops]
    deferredStops.clear()
    for (const stop of stops) stop()
  }
}

export function deferStopForFirmware(stop: () => void): boolean {
  if (!owners.size) return false
  deferredStops.add(stop)
  return true
}

/** A later Engine start supersedes a stop deferred by an earlier runtime. */
export function cancelDeferredFirmwareStop(stop: () => void): void {
  deferredStops.delete(stop)
}
