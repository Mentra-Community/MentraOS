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

  subscribe(fn: Listener): () => void {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}
