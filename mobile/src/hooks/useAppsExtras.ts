import {useMemo} from "react"
import {useShallow} from "zustand/react/shallow"

import {useApps, useAppStatusStore} from "@mentra/island"

import {SETTINGS, useSetting} from "@/stores/settings"

/**
 * Foreground tray: standard + background apps. Filtered to offline-only when
 * `offline_mode` is on so cloud apps don't show up while disconnected.
 */
export const useForegroundApps = () => {
  const apps = useApps()
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    if (isOffline) {
      return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && app.offline)
    }
    return apps.filter((app) => app.type === "standard" || app.type === "background" || !app.type)
  }, [apps, isOffline])
}

/**
 * Like {@link useForegroundApps} but only the not-running entries — the apps
 * actually rendered in the home grid (running ones get the active card).
 */
export const useInactiveForegroundApps = () => {
  const apps = useApps()
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    if (isOffline) {
      return apps.filter((app) => (app.type === "standard" || app.type === "background") && !app.running && app.offline)
    }
    return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && !app.running)
  }, [apps, isOffline])
}

/**
 * Apps incompatible with the currently configured wearable. Returns all apps
 * if no wearable is selected (so the UI surface "all apps need glasses").
 */
export const useIncompatibleApps = () => {
  const apps = useApps()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  return useMemo(() => {
    if (!defaultWearable) return apps
    return apps.filter((app) => !app.compatibility?.isCompatible)
  }, [apps, defaultWearable])
}

/** Stable list of running app package names (shallow-equal to avoid re-renders). */
export const useActiveAppPackageNames = () =>
  useAppStatusStore(useShallow((state) => state.apps.filter((app) => app.running).map((a) => a.packageName)))
