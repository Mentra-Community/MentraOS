/**
 * useUser
 *
 * The single React entry point for the app. Returns the User singleton,
 * subscribed via `useSyncExternalStore` so any change to its reactive
 * properties (`coords`, `heading`, `mapsReady`, ...) re-renders the
 * calling component.
 *
 *   const user = useUser()
 *
 *   user.coords        // reactive — re-renders on GPS update
 *   user.heading       // reactive — re-renders on compass update
 *   user.mapsReady     // reactive
 *
 *   user.navigation    // imperative — start/stop/deviate/format
 *   user.display       // imperative — showText/showCard/clear
 */

import {useSyncExternalStore} from "react"

import {User} from "@/backend/session/User"

// Install one-time global teardown listeners. WebView close fires
// `pagehide` reliably on iOS/Android; `beforeunload` covers
// desktop/dev. Both end up calling `User.dispose()`, which is
// idempotent so duplicate fires are harmless.
let teardownInstalled = false
function installTeardownOnce(): void {
  if (teardownInstalled) return
  if (typeof window === "undefined") return
  teardownInstalled = true
  const teardown = () => {
    try {
      User.getInstance().dispose()
    } catch (err) {
      console.warn("[useUser] dispose on unload failed:", err)
    }
  }
  window.addEventListener("pagehide", teardown)
  window.addEventListener("beforeunload", teardown)
}

export function useUser(): User {
  installTeardownOnce()
  const user = User.getInstance()
  useSyncExternalStore(user.subscribe, user.getSnapshot, user.getSnapshot)
  return user
}
