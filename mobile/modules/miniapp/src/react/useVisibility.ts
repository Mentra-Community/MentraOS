/**
 * @fileoverview useVisibility — React hook that returns "foreground" or
 * "background" to match the host's current visibility state for this miniapp.
 * Updates when the host sends VISIBILITY_CHANGE.
 */

import {useEffect, useState} from "react"

import {type MiniappVisibility} from "../session"
import {useSession} from "./useSession"

export function useVisibility(): MiniappVisibility {
  const session = useSession()
  const [visibility, setVisibility] = useState<MiniappVisibility>(session.visibility)

  useEffect(() => {
    setVisibility(session.visibility)
    return session.onVisibilityChange(setVisibility)
  }, [session])

  return visibility
}
