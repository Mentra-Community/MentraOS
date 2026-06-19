import {useCallback, useRef, useState} from "react"

/**
 * Hidden developer mode, toggled by pressing and holding the settings gear in
 * the bottom nav for {@link HOLD_DURATION_MS}. Developer-only chrome (cloud
 * transport status, debug trays) stays hidden until this flips on, keeping the
 * default UI looking like a native app rather than a debug console.
 *
 * The flag lives in memory only — it resets on reload, which is the right
 * default for a debug affordance nobody should land in by accident.
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
    timerRef.current = setTimeout(() => {
      setDeveloperMode((on) => !on)
    }, HOLD_DURATION_MS)
  }, [clear])

  return {
    developerMode,
    holdHandlers: {
      onPointerDown,
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
    },
  }
}
