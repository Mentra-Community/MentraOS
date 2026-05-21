/**
 * @fileoverview SDK-side dev-reload listener — auto-installed when the host
 * indicates we're running in a dev miniapp.
 *
 * Companion to the phone-side console-tap shim (which is injected by the
 * MentraOS app, not by the SDK). The SDK installs this listener on import so
 * authors get live reload without any opt-in code.
 *
 * Mechanism:
 *   - Phone-side `DevServerBridge` receives `{type: "reload"}` from the dev
 *     server's WebSocket.
 *   - Phone-side `MiniappHost` then injects a `MessageEvent` into the WebView
 *     with payload `{type: "miniapp_dev_reload"}`.
 *   - This listener catches that MessageEvent and calls `location.reload()`.
 *
 * Gated on `window.MentraOS.miniappDeveloperMode === true` so production
 * miniapps never set up the listener. In production WebViews the host won't
 * inject the message anyway, but belt-and-suspenders.
 */

const RELOAD_MESSAGE_TYPE = "miniapp_dev_reload"

export function installDevReloadListenerIfDevMode(): void {
  if (typeof window === "undefined") return
  const mentra = (window as {MentraOS?: {miniappDeveloperMode?: boolean}}).MentraOS
  if (!mentra?.miniappDeveloperMode) return

  // Avoid double-install if the SDK is hot-reloaded mid-session.
  const flagKey = "__mentraDevReloadInstalled"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any)[flagKey]) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[flagKey] = true

  const handler = (ev: MessageEvent): void => {
    const data = typeof ev.data === "string" ? ev.data : null
    if (!data) return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const env = parsed as {payload?: {type?: string}}
    const type = env?.payload?.type
    if (type !== RELOAD_MESSAGE_TYPE) return
    // eslint-disable-next-line no-console
    console.log("[mentra-miniapp] dev reload signal received — reloading")
    try {
      location.reload()
    } catch {
      // Some embedded contexts forbid reload; ignore.
    }
  }

  window.addEventListener("message", handler)
  if (typeof document !== "undefined") {
    document.addEventListener("message", handler as unknown as EventListener)
  }
}
