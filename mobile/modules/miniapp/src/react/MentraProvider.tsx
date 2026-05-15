/**
 * @fileoverview MentraProvider — optional root provider for miniapp apps.
 *
 * Opt-in conveniences that would otherwise require boilerplate in every
 * miniapp. Currently:
 *   - Keeps `<html class="dark">` in sync with the host's color scheme so the
 *     shared theme CSS switches automatically.
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

import {type ReactNode} from "react"

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
}

export function MentraProvider({children, syncColorScheme = true}: MentraProviderProps) {
  const scheme = useColorScheme()

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
