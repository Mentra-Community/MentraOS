/**
 * MiniappRunningRegistry — tracks currently-mounted miniapp packageNames
 * and the last time each was foregrounded.
 *
 * "Running" for a local miniapp means "MiniappHost has a WebView mounted for
 * this package," foreground OR backgrounded. It is a session-scoped fact
 * (cleared on app boot) so it lives in memory, not MMKV.
 *
 * `lastForegroundAt` tracks the most recent `Date.now()` at which the
 * package transitioned to foreground (via `markForeground`). `add` initialises
 * it to 0 ("never foregrounded"), so the eviction policy treats freshly-mounted
 * background apps as oldest-first candidates. `setForeground` on the
 * MiniappHost public API is the single caller of `markForeground`.
 *
 * MiniappHost is the single writer for membership: mount/mountDev add,
 * unmount removes. setForeground/setBackground don't change membership —
 * backgrounded miniapps are still running, but the foreground transition
 * is what stamps `lastForegroundAt`.
 *
 * Composer.getLocalApplets() reads from here when projecting the `running`
 * field for local applets, so the switcher / tray reflect actual mount state
 * regardless of how many `refreshApplets()` calls fire.
 */

type Listener = () => void

export interface RegistryEntry {
  packageName: string
  /** Unix-ms timestamp of the most recent foregrounding. 0 if never foregrounded. */
  lastForegroundAt: number
}

const entries = new Map<string, RegistryEntry>()
const listeners = new Set<Listener>()

function notify(): void {
  for (const fn of listeners) {
    try {
      fn()
    } catch (e) {
      console.warn("MiniappRunningRegistry: listener threw", e)
    }
  }
}

export const miniappRunningRegistry = {
  add(packageName: string): void {
    if (entries.has(packageName)) return
    entries.set(packageName, {packageName, lastForegroundAt: 0})
    notify()
  },

  remove(packageName: string): void {
    if (!entries.delete(packageName)) return
    notify()
  },

  has(packageName: string): boolean {
    return entries.has(packageName)
  },

  /**
   * Stamp `lastForegroundAt` with `Date.now()` (or a provided timestamp).
   * No-op if the package isn't registered. Idempotent — callers can stamp
   * on every setForeground transition without checking has().
   */
  markForeground(packageName: string, at: number = Date.now()): void {
    const entry = entries.get(packageName)
    if (!entry) return
    entry.lastForegroundAt = at
    notify()
  },

  /** Returns the last-foregrounded timestamp, or 0 if unknown / never foregrounded. */
  getLastForegroundAt(packageName: string): number {
    return entries.get(packageName)?.lastForegroundAt ?? 0
  },

  getAll(): string[] {
    return Array.from(entries.keys())
  },

  /** Full registry snapshot, including foreground timestamps. */
  getAllWithTimestamps(): RegistryEntry[] {
    return Array.from(entries.values(), (e) => ({...e}))
  },

  /**
   * Subscribe to membership / timestamp changes. Listener fires after every
   * add / remove / markForeground. Returns an unsubscribe function.
   */
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  /**
   * Test-only: wipe all entries. Production code should not call this.
   */
  _resetForTests(): void {
    entries.clear()
    notify()
  },
}
