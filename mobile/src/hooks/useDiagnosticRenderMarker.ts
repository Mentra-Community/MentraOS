import {useIsFocused} from "@react-navigation/native"
import {engine} from "@mentra/engine"
import {useEffect, useRef} from "react"

type Surface = "glasses_battery" | "wifi_scan"

/**
 * Diagnostic only (Android device-test provenance; nothing is displayed). Reports the native
 * event ids behind what `surface` currently shows, following the navigation lifecycle:
 * - focused: the displayed `value` with its ids (an empty list when it has no provenance);
 * - covered by another route (still mounted in the stack) or unmounted: an empty marker with no
 *   value, and updates while hidden stay silent;
 * - focused again: the state shown now.
 * An unchanged state is not reported twice.
 */
export function useDiagnosticRenderMarker(surface: Surface, eventIds: readonly string[], value: number): void {
  const isFocused = useIsFocused()
  const lastReported = useRef<string | null>(null)
  const idsKey = eventIds.join("\n")

  useEffect(() => {
    const ids = isFocused && idsKey ? idsKey.split("\n") : []
    const key = JSON.stringify([ids, isFocused ? value : null])
    if (lastReported.current === key) return
    lastReported.current = key
    if (isFocused) engine.glasses.reportDiagnosticRender(surface, ids, value)
    else engine.glasses.reportDiagnosticRender(surface, [])
  }, [surface, isFocused, idsKey, value])

  useEffect(
    () => () => {
      engine.glasses.reportDiagnosticRender(surface, [])
    },
    [surface],
  )
}
