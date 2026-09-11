import {useCallback, useRef, useState} from "react"

/**
 * Hidden developer mode, toggled by pressing and holding the settings gear in
 * the bottom nav for {@link HOLD_DURATION_MS}. Surfaces a small debug footer
 * (cursor / line position) without cluttering the default UI.
 *
 * In-memory only — resets on reload, the right default for a debug affordance.
 */
const HOLD_DURATION_MS = 5000

export interface HoldHandlers {
  onPointerDown: () => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onPointerCancel: () => void
}

export function useDeveloperMode(): {developerMode: boolean; holdHandlers: HoldHandlers} {
  const [developerMode, setDeveloperMode] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clear = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const onPointerDown = useCallback(() => {
    clear()
    timerRef.current = setTimeout(() => setDeveloperMode((on) => !on), HOLD_DURATION_MS)
  }, [clear])

  return {
    developerMode,
    holdHandlers: {onPointerDown, onPointerUp: clear, onPointerLeave: clear, onPointerCancel: clear},
  }
}
