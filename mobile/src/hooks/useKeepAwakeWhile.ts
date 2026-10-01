import {activateKeepAwakeAsync, deactivateKeepAwake} from "expo-keep-awake"
import {useEffect} from "react"

/**
 * Keep the phone screen on (no auto-dim, no auto-lock) while `active` is true.
 *
 * Used during glasses software updates: if the phone sleeps mid-update the OS
 * can suspend the app's JS timers and BLE keepalives, stalling or stranding the
 * install. Each caller passes its own `tag` so independent flows can hold the
 * lock without releasing each other's.
 */
export function useKeepAwakeWhile(active: boolean, tag: string): void {
  useEffect(() => {
    if (!active) return
    activateKeepAwakeAsync(tag).catch((error) => {
      console.warn(`KEEP_AWAKE: failed to activate "${tag}"`, error)
    })
    return () => {
      deactivateKeepAwake(tag).catch(() => {})
    }
  }, [active, tag])
}
