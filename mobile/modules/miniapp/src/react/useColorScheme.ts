/**
 * @fileoverview useColorScheme — React hook that returns the host's current
 * color scheme and updates when the user flips light/dark.
 *
 * Initial value comes from window.MentraOS (set before the miniapp loads).
 * Subsequent changes arrive as COLOR_SCHEME_CHANGE messages on the session.
 */

import {useEffect, useState} from "react"

import {type MiniappColorScheme} from "../globals"
import {useSession} from "./useSession"

export function useColorScheme(): MiniappColorScheme {
  const session = useSession()
  const [scheme, setScheme] = useState<MiniappColorScheme>(session.colorScheme)

  useEffect(() => {
    setScheme(session.colorScheme)
    return session.onColorSchemeChange(setScheme)
  }, [session])

  return scheme
}
