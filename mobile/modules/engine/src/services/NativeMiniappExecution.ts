/**
 * NativeMiniappExecution — the packageNames of the native built-in miniapps
 * (Gallery, Mirror, Notify) executing now.
 *
 * The counterpart of MiniappRunningRegistry for built-ins that have no JS
 * context and so never enter it. Each declares how it executes
 * (`ClientApp.nativeExecution`); the apps store derives the set from its own
 * state on every change and is the single writer. Fleet reads it to measure
 * their run time.
 *
 * Imports nothing at run time, so a reader carries none of the apps store.
 */

type Listener = () => void

let executing: ReadonlySet<string> = new Set()
const listeners = new Set<Listener>()

export const nativeMiniappExecution = {
  /** Replaces the set; listeners hear only a change. */
  set(packageNames: Iterable<string>): void {
    const next = new Set(packageNames)
    if (next.size === executing.size && [...next].every((packageName) => executing.has(packageName))) return
    executing = next
    for (const fn of listeners) {
      try {
        fn()
      } catch (e) {
        console.warn("NativeMiniappExecution: listener threw", e)
      }
    }
  },

  getAll(): string[] {
    return Array.from(executing)
  },

  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
