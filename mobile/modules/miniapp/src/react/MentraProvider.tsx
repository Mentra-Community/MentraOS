/**
 * @fileoverview MentraProvider — optional root provider for miniapp apps.
 *
 * Opt-in conveniences that would otherwise require boilerplate in every
 * miniapp. Currently:
 *   - Keeps `<html class="dark">` in sync with the host's color scheme so the
 *     shared theme CSS switches automatically.
 *   - Calls `mentra.ready()` once the app has mounted, which lifts the host's
 *     splash and fires the background's `session.ui.onOpen` handlers.
 *
 * Usage:
 *   createRoot(root).render(
 *     <MentraProvider>
 *       <App />
 *     </MentraProvider>
 *   )
 *
 * Each convenience is controllable via props so miniapps that manage these
 * things themselves can opt out without forking the provider.
 */

import {type ReactNode, useEffect} from "react"

import {useColorScheme} from "./useColorScheme"

export interface MentraProviderProps {
  children: ReactNode
  /**
   * Toggle `document.documentElement.classList` "dark" to match the host's
   * current color scheme. The toggle runs synchronously during render so
   * children paint with the correct class on first mount — no flash.
   *
   * Default: true. Set to false if your app owns the `dark` class itself
   * (e.g. you integrate a theming library like next-themes).
   */
  syncColorScheme?: boolean
  /**
   * Call `mentra.ready()` after the first mount. A parent's effects run after
   * its children's, so every `mentra.on` subscription the app makes on mount
   * is attached before the background is told the UI is open. Without
   * `ready()` the host keeps its splash up and reports the miniapp as failed.
   *
   * Default: true. Set to false to call `mentra.ready()` yourself, e.g. to keep
   * the splash up until the first screen has its data.
   */
  autoReady?: boolean
}

function getBridge(): {ready?: () => void} | null {
  if (typeof window === "undefined") return null
  return (window as unknown as {mentra?: {ready?: () => void}}).mentra ?? null
}

export function MentraProvider({children, syncColorScheme = true, autoReady = true}: MentraProviderProps) {
  const scheme = useColorScheme()

  useEffect(() => {
    if (autoReady) getBridge()?.ready?.()
  }, [autoReady])

  // Runs during render — before children paint, before effects fire.
  if (syncColorScheme && typeof document !== "undefined") {
    const el = document.documentElement
    const shouldBeDark = scheme === "dark"
    if (el.classList.contains("dark") !== shouldBeDark) {
      el.classList.toggle("dark", shouldBeDark)
    }
  }

  return <>{children}</>
}
