import {useCallback, useSyncExternalStore} from "react"
import {engine, type MiniappStartWait} from "@mentra/engine"

const subscribe = (onChange: () => void) => engine.miniapps.onStartWaitChanged(onChange)

/**
 * What the start of a miniapp waits for before it runs: its update check, or the update that check found, installing
 * (`engine.miniapps.startWait`). Null when no start of it waits, and without a package.
 */
export function useMiniappStartWait(packageName: string | undefined): MiniappStartWait | null {
  const read = useCallback(() => (packageName ? engine.miniapps.startWait(packageName) : null), [packageName])
  return useSyncExternalStore(subscribe, read, read)
}
