/**
 * MiniappRunningRegistry — module-level set of currently-mounted miniapp
 * packageNames.
 *
 * "Running" for a local miniapp means "MiniappHost has a WebView mounted for
 * this package," foreground OR backgrounded. It is a session-scoped fact
 * (cleared on app boot) so it lives in memory, not MMKV.
 *
 * MiniappHost is the single writer: mount/mountDev add, unmount removes.
 * setForeground/setBackground don't change membership — backgrounded miniapps
 * are still running.
 *
 * Composer.getLocalApplets() reads from here when projecting the `running`
 * field for local applets, so the switcher / tray reflect actual mount state
 * regardless of how many `refreshApplets()` calls fire.
 */

type Listener = () => void

const running = new Set<string>()
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
    if (running.has(packageName)) return
    running.add(packageName)
    notify()
  },

  remove(packageName: string): void {
    if (!running.delete(packageName)) return
    notify()
  },

  has(packageName: string): boolean {
    return running.has(packageName)
  },

  getAll(): string[] {
    return Array.from(running)
  },

  /**
   * Subscribe to membership changes. Listener fires after every add/remove.
   * Returns an unsubscribe function.
   */
  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
