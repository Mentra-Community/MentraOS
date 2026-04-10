import {useState, useEffect, useCallback} from "react"
import {isGlassesLinkLayerBusy} from "@/stores/glasses"

/**
 * Debounces the `searching` flag by 500 ms so the UI doesn't flash a
 * "Connect" button in the gap between searching→false and connected→true.
 * Also folds in the native link-layer busy state (CONNECTING / SCANNING / BONDING).
 */
export function useSearchingState(searching: boolean, connectionState: string | undefined) {
  const [wasSearching, setWasSearching] = useState(false)

  useEffect(() => {
    if (searching) {
      setWasSearching(true)
      return undefined
    }
    if (wasSearching) {
      const timer = setTimeout(() => setWasSearching(false), 500)
      return () => clearTimeout(timer)
    }
    return undefined
  }, [searching, wasSearching])

  const nativeLinkBusy = isGlassesLinkLayerBusy(connectionState)

  const resetSearching = useCallback(() => {
    setWasSearching(false)
  }, [])

  return {wasSearching, nativeLinkBusy, resetSearching}
}
