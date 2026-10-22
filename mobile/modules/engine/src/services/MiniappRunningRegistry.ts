/**
 * MiniappRunningRegistry — module-level set of currently-running miniapp
 * packageNames.
 *
 * "Running" means the miniapp is projected as **user activity**. Its
 * background JSContext is normally alive too, while an invocation-scoped
 * transient action context may be alive without entering this registry.
 * The UI WebView open/close state is separate — that's tracked by
 * MentraUIRouter.isBound(). A miniapp can be "running" (JSContext alive,
 * processing glasses events) without any WebView mounted, which is the
 * steady-state.
 *
 * MentraJSRouter is the single writer: a visible spawn or a promotion adds,
 * `unregister` removes. Home tile / tray reads from here to project the
 * `running` field on local applets.
 */

type Listener = () => void

function packageSet(name: string) {
  const members = new Set<string>()
  const listeners = new Set<Listener>()
  const removedListeners = new Set<(packageName: string) => void>()

  function notify(removed?: string): void {
    for (const fn of listeners) {
      try {
        fn()
      } catch (e) {
        console.warn(`${name}: listener threw`, e)
      }
    }
    if (removed === undefined) return
    for (const fn of removedListeners) {
      try {
        fn(removed)
      } catch (e) {
        console.warn(`${name}: listener threw`, e)
      }
    }
  }

  return {
    add(packageName: string): void {
      if (members.has(packageName)) return
      members.add(packageName)
      notify()
    },

    remove(packageName: string): void {
      if (!members.delete(packageName)) return
      notify(packageName)
    },

    has(packageName: string): boolean {
      return members.has(packageName)
    },

    getAll(): string[] {
      return Array.from(members)
    },

    subscribe(fn: Listener): () => void {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },

    /** Calls `fn` with each package that leaves the set. */
    onRemoved(fn: (packageName: string) => void): () => void {
      removedListeners.add(fn)
      return () => {
        removedListeners.delete(fn)
      }
    },
  }
}

export const miniappRunningRegistry = packageSet("MiniappRunningRegistry")

/**
 * Every package with a live background JSContext, whether it projects as user activity or not (a hidden action
 * wake). MentraJSRouter is the single writer: a registration adds, `unregister` removes; a crash respawn keeps it.
 */
export const miniappContextRegistry = packageSet("MiniappContextRegistry")
