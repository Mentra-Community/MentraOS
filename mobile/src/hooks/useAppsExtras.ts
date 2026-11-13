import {useMemo, useSyncExternalStore} from "react"
import {engine, SETTINGS, useActiveApps, useApps, useSetting, type ClientApp} from "@mentra/engine"

import {isHiddenFromLaunchers, shouldHideMiniapp} from "@/services/miniapps/miniappVisibility"
import {deploymentStore} from "@/services/deployment/store"
import {type DefaultMiniappListing, useDefaultMiniappsStore} from "@/stores/defaultMiniapps"

const subscribeDeployment = (onChange: () => void) => deploymentStore.subscribe(onChange)
const getDeployment = () => deploymentStore.getActive()

/** Platform restrictions also apply to All Apps, which ignores home hiding. */
export const useAvailableApps = () => {
  const apps = useApps()
  const [showIosNotify] = useSetting<boolean>(SETTINGS.show_notify_ios.key)
  const [superMode] = useSetting<boolean>(SETTINGS.super_mode.key)
  const [miniappDevMode] = useSetting<boolean>(SETTINGS.miniapp_dev_mode.key)
  const deployment = useSyncExternalStore(subscribeDeployment, getDeployment)
  return useMemo(
    () =>
      apps.filter(
        (app) =>
          !isHiddenFromLaunchers(app.packageName) &&
          !shouldHideMiniapp(app.packageName, app.version, {dev: app.isMiniappDev}),
      ),
    [apps, showIosNotify, superMode, miniappDevMode, deployment],
  )
}

/**
 * A default miniapp still installing, as Home shows it: like the installed miniapp it becomes. Opening it waits for
 * its install (MiniappOpenWait).
 */
export function pendingDefaultApp(packageName: string, listing: DefaultMiniappListing): ClientApp {
  return {
    packageName,
    name: listing.name,
    webviewUrl: "",
    logoUrl: listing.iconUrl ?? "",
    type: "standard",
    permissions: [],
    running: false,
    healthy: true,
    hardwareRequirements: [],
    compatibility: {isCompatible: true, missingRequired: [], missingOptional: [], warnings: []},
    loading: false,
    offline: false,
    offlineRoute: "",
    local: true,
    hidden: false,
    version: listing.version,
  }
}

/** The packages Home shows before they are installed (defaults still installing). */
export const usePendingDefaultPackages = (): Set<string> => {
  const apps = useApps()
  const listings = useDefaultMiniappsStore((state) => state.listings)
  return useMemo(() => {
    const installed = new Set(apps.map((app) => app.packageName))
    return new Set(Object.keys(listings).filter((packageName) => !installed.has(packageName)))
  }, [apps, listings])
}

/** Whether Home shows this miniapp before it is installed (a default still installing). */
export function isPendingDefaultApp(packageName: string): boolean {
  return (
    packageName in useDefaultMiniappsStore.getState().listings &&
    !engine.miniapps.list().some((app) => app.packageName === packageName)
  )
}

/**
 * Foreground tray: standard + background apps, then the default miniapps still installing, shown as if they were
 * installed. Filtered to offline-only when `offline_mode` is on so cloud apps don't show up while disconnected.
 */
export const useForegroundApps = () => {
  const apps = useAvailableApps()
  const listings = useDefaultMiniappsStore((state) => state.listings)
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    const installed = new Set(apps.map((app) => app.packageName))
    const pending = Object.entries(listings)
      .filter(
        ([packageName, listing]) =>
          !installed.has(packageName) &&
          !isHiddenFromLaunchers(packageName) &&
          !shouldHideMiniapp(packageName, listing.version),
      )
      .map(([packageName, listing]) => pendingDefaultApp(packageName, listing))
    const all = [...apps, ...pending]
    if (isOffline) {
      return all.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && app.offline)
    }
    return all.filter((app) => app.type === "standard" || app.type === "background" || !app.type)
  }, [apps, listings, isOffline])
}

/**
 * Like {@link useForegroundApps} but only the not-running entries — the apps
 * actually rendered in the home grid (running ones get the active card).
 */
export const useInactiveForegroundApps = () => {
  const apps = useAvailableApps()
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
  const apps = useAvailableApps()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  return useMemo(() => {
    if (!defaultWearable) return apps
    return apps.filter((app) => !app.compatibility?.isCompatible)
  }, [apps, defaultWearable])
}

/** Stable list of running app package names (shallow-equal to avoid re-renders). */
export const useActiveAppPackageNames = () => {
  const active = useActiveApps()
  return useMemo(() => active.map((a) => a.packageName), [active])
}
