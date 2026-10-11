/**
 * Automatic updates that waited for a running miniapp.
 *
 * An update deferred because its miniapp was running resumes when that
 * miniapp stops: the host subscribes and runs Store maintenance again, which
 * then finds the miniapp idle and installs the release.
 */
import {miniappRunningRegistry} from "./MiniappRunningRegistry"

const deferred = new Set<string>()
const listeners = new Set<(packageName: string) => void>()
let unsubscribeRegistry: (() => void) | null = null

function checkStopped(): void {
  for (const packageName of [...deferred]) {
    if (miniappRunningRegistry.has(packageName)) continue
    deferred.delete(packageName)
    for (const listener of [...listeners]) {
      try {
        listener(packageName)
      } catch (error) {
        console.warn("Deferred update listener threw", error)
      }
    }
  }
  if (deferred.size === 0) {
    unsubscribeRegistry?.()
    unsubscribeRegistry = null
  }
}

/** Remember that `packageName`'s automatic update waits for it to stop. */
export function markMiniappUpdateDeferred(packageName: string): void {
  // A context that is not projected as user activity (a transient action wake)
  // stops on its own; the next periodic check retries it.
  if (!miniappRunningRegistry.has(packageName)) return
  deferred.add(packageName)
  unsubscribeRegistry ??= miniappRunningRegistry.subscribe(checkStopped)
}

/** Called with a package whose deferred update can now run. Returns an unsubscribe function. */
export function onDeferredMiniappUpdateReady(listener: (packageName: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests only. */
export function resetDeferredMiniappUpdatesForTests(): void {
  deferred.clear()
  listeners.clear()
  unsubscribeRegistry?.()
  unsubscribeRegistry = null
}
