/**
 * Island apps store — runtime state of installed and remote applets.
 *
 * The OEM-facing API: subscribe to the running set, install/uninstall
 * miniapps, start/stop them. The store delegates install plumbing to
 * AppRegistry, and exposes hooks (`useApps`, `useStart`, `useStop`,
 * `useRefresh`, `useStopAll`) that the host UI can read.
 *
 * Side-effects the host needs (cloud REST calls, navigation, alerts) are
 * injected via `configureIsland`. The store invokes those hooks at the
 * right moments — but never imports them directly.
 *
 * Source of `apps`:
 *   - Local: appRegistry.getInstalledMiniapps()    (always)
 *   - Extra: hostHooks.loadExtraApps?.()           (e.g. cloud applets)
 */

import {useMemo} from "react"
import {AsyncResult, Result, result as Res} from "typesafe-ts"
import {create} from "zustand"

import type {ClientApp} from "../types/applet"
import type {Capabilities} from "../types/hardware"
import {DeviceTypes} from "../types/enums"
import {getModelCapabilities} from "../types/hardware"
import {HardwareCompatibility} from "../utils/hardware/hardware"
import {storage} from "../utils/storage/storage"
import appRegistry from "../services/AppRegistry"
import {miniappRunningRegistry} from "../services/MiniappRunningRegistry"

// ---------------------------------------------------------------------------
// Configuration / hooks
// ---------------------------------------------------------------------------

export interface StartOptions {
  skipNavigation?: boolean
}

export interface IslandHostHooks {
  /** Return host-provided extra apps (e.g. cloud applets). Called on every refresh. */
  loadExtraApps?: () => Promise<ClientApp[]>
  /** Return the connected device's capabilities for compatibility checks. */
  getCapabilities?: () => Capabilities | null
  /** Called by start() before applet.onStart. Return false to abort the start. */
  beforeStart?: (app: ClientApp, opts?: StartOptions) => Promise<boolean> | boolean
  /** Called by stop() before applet.onStop. */
  beforeStop?: (app: ClientApp) => Promise<void> | void
  /** Called by uninstall() before appRegistry.uninstall — e.g. for cloud-side cleanup. */
  onUninstall?: (app: ClientApp) => Promise<void> | void
  /** Called after the apps array is rebuilt — host can mutate / re-sort. */
  postProcessApps?: (apps: ClientApp[]) => ClientApp[] | Promise<ClientApp[]>
}

let hostHooks: IslandHostHooks = {}

export function configureIsland(hooks: IslandHostHooks): void {
  hostHooks = {...hostHooks, ...hooks}
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AppStatusState {
  apps: ClientApp[]
  refresh: () => Promise<void>
  start: (app: ClientApp, opts?: StartOptions) => Promise<void>
  stop: (packageName: string) => Promise<void>
  stopAll: () => AsyncResult<void, Error>
  install: (url: string, opts?: {versionOverride?: string}) => AsyncResult<void, Error>
  uninstall: (packageName: string, version?: string) => AsyncResult<void, Error>
  saveScreenshot: (packageName: string, screenshot: string) => Promise<void>
  setHiddenStatus: (packageName: string, status: boolean) => void
  getHiddenStatus: (packageName: string) => boolean
  /** Replace the whole apps array. Hosts use this when their extra source changes. */
  setApps: (apps: ClientApp[]) => void
  /** Mark a single app as the foreground miniapp; clears foreground on all others. */
  setForeground: (packageName: string) => void
  /** Clear foreground on every app — used when the user swipes/closes the host overlay. */
  clearForeground: () => void
}

export const DUMMY_APPLET: ClientApp = {
  packageName: "",
  name: "",
  webviewUrl: "",
  logoUrl: "",
  type: "standard",
  permissions: [],
  running: false,
  loading: false,
  healthy: true,
  hardwareRequirements: [],
  offline: true,
  offlineRoute: "",
  local: false,
  hidden: false,
}

export type OrderMap = Record<string, number>
const APP_ORDER_KEY = "foreground_apps_order"

export const saveAppsOrder = (orderMap: OrderMap): Result<void, Error> => {
  return storage.save(APP_ORDER_KEY, orderMap)
}

export const getAppsOrder = (): Result<OrderMap, Error> => {
  return storage.load<OrderMap>(APP_ORDER_KEY)
}

const getRawPackageNamePriority = (pkg: string): number => {
  if (pkg.includes("@empty")) {
    return 1000
  }
  return 0
}

export const sortAppsByPackageNamePriority = (a: ClientApp, b: ClientApp): number => {
  const pa = getRawPackageNamePriority(a.packageName)
  const pb = getRawPackageNamePriority(b.packageName)
  if (pa !== pb) {
    return pa - pb
  }
  return a.name.localeCompare(b.name)
}

export const saveLastOpenTime = (packageName: string): void => {
  storage.save(`${packageName}_last_open_time`, Date.now())
}

export const getLastOpenTime = (packageName: string): number => {
  const res = storage.load<number>(`${packageName}_last_open_time`)
  if (res.is_ok()) return res.value
  return 0
}

export const sortAppsByLastOpenTime = async <T extends {packageName: string}>(apps: T[]): Promise<T[]> => {
  const timestamps = apps.map((app) => ({app, time: getLastOpenTime(app.packageName)}))
  return timestamps.sort((a, b) => a.time - b.time).map((entry) => entry.app)
}

const startStopApp = async (app: ClientApp, status: boolean): Promise<void> => {
  if (!status && app.onStop) {
    try {
      app.onStop()
    } catch (e) {
      console.warn(`ISLAND: onStop threw for ${app.packageName}`, e)
    }
  }
  if (status && app.onStart) {
    try {
      app.onStart()
    } catch (e) {
      console.warn(`ISLAND: onStart threw for ${app.packageName}`, e)
    }
  }
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  apps: [],

  refresh: async () => {
    const state = get()

    const localApps = await appRegistry.getInstalledMiniapps()
    const extraApps = (await hostHooks.loadExtraApps?.()) ?? []

    let apps: ClientApp[] = [...extraApps, ...localApps]

    // Dedupe by packageName, keep first occurrence (extra/cloud wins over local).
    const byPackage = new Map<string, ClientApp>()
    for (const app of apps) {
      if (!byPackage.has(app.packageName)) {
        byPackage.set(app.packageName, app)
      }
    }
    apps = Array.from(byPackage.values())

    // Carry over screenshots + foreground flag from the previous snapshot.
    // refresh() rebuilds from registry+cloud sources which don't know about
    // UI state (foreground), so preserving here keeps the Compositor's overlay
    // from snapping off when an unrelated registry event fires mid-launch.
    const oldApps = state.apps
    for (const oldApp of oldApps) {
      const next = apps.find((a) => a.packageName === oldApp.packageName)
      if (!next) continue
      if (oldApp.screenshot) next.screenshot = oldApp.screenshot
      if (oldApp.foreground) next.foreground = true
    }

    // Compatibility info using host-provided capabilities.
    const capabilities = hostHooks.getCapabilities?.() ?? getModelCapabilities(DeviceTypes.NONE)
    for (const app of apps) {
      app.compatibility = HardwareCompatibility.checkCompatibility(app.hardwareRequirements, capabilities)
    }

    // Hidden flag from MMKV.
    for (const app of apps) {
      app.hidden = state.getHiddenStatus(app.packageName)
    }

    if (hostHooks.postProcessApps) {
      apps = await hostHooks.postProcessApps(apps)
    }

    set({apps})
  },

  start: async (clientApp: ClientApp, opts?: StartOptions) => {
    const state = get()
    const packageName = clientApp.packageName
    const app = state.apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: app not found for package name: ${packageName}`)
      return
    }

    // Skip if any app is currently loading.
    if (state.apps.some((a) => a.loading)) {
      console.log(`ISLAND: skipping start ${packageName} — another app is loading`)
      return
    }

    // Host gate (incompatible alerts, offline-mode rejection, etc.).
    if (hostHooks.beforeStart) {
      const proceed = await hostHooks.beforeStart(app, opts)
      if (!proceed) return
    }

    // Foreground-only-one rule: stop other running standard apps.
    if (app.type === "standard") {
      const runningForeground = state.apps.filter(
        (a) => a.running && a.type === "standard" && a.packageName !== packageName,
      )
      for (const r of runningForeground) {
        await get().stop(r.packageName)
      }
    }

    const shouldLoad = !app.offline && !app.local
    set((s) => ({
      apps: s.apps.map((a) =>
        a.packageName === packageName ? {...a, running: true, loading: shouldLoad} : a,
      ),
    }))

    saveLastOpenTime(packageName)
    await startStopApp(app, true)
  },

  stop: async (packageName: string) => {
    const state = get()
    const app = state.apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: app not found for package name: ${packageName}`)
      return
    }

    if (hostHooks.beforeStop) {
      await hostHooks.beforeStop(app)
    }

    const shouldLoad = !app.offline && !app.local
    set((s) => ({
      apps: s.apps.map((a) =>
        a.packageName === packageName ? {...a, running: false, screenshot: undefined, loading: shouldLoad} : a,
      ),
    }))

    await startStopApp(app, false)
  },

  stopAll: () => {
    return Res.try_async(async () => {
      const running = get().apps.filter((a) => a.running)
      for (const a of running) {
        await get().stop(a.packageName)
      }
    })
  },

  install: (url, opts) => appRegistry.installFromUrl(url, opts),

  uninstall: (packageName, version) => {
    return Res.try_async(async () => {
      if (hostHooks.onUninstall) {
        const app = get().apps.find((a) => a.packageName === packageName)
        if (app) {
          await hostHooks.onUninstall(app)
        }
      }
      const res = await appRegistry.uninstall(packageName, version)
      if (res.is_error()) throw res.error
      set((s) => ({apps: s.apps.filter((a) => a.packageName !== packageName)}))
    })
  },

  saveScreenshot: async (packageName: string, screenshot: string) => {
    storage.save(`${packageName}_screenshot`, screenshot)
    set((s) => ({
      apps: s.apps.map((a) => (a.packageName === packageName ? {...a, screenshot} : a)),
    }))
  },

  setHiddenStatus: (packageName: string, status: boolean) => {
    set((s) => ({
      apps: s.apps.map((a) => (a.packageName === packageName ? {...a, hidden: status} : a)),
    }))
    storage.save(`${packageName}_hidden`, status)
    if (!status) {
      const orderMap = getAppsOrder()
      if (orderMap.is_ok()) {
        delete orderMap.value[packageName]
        saveAppsOrder(orderMap.value)
      }
    }
  },

  getHiddenStatus: (packageName: string): boolean => {
    const res = storage.load<boolean>(`${packageName}_hidden`)
    if (res.is_ok()) return res.value
    return false
  },

  setApps: (apps) => set({apps}),

  setForeground: (packageName: string) => {
    set((s) => ({
      apps: s.apps.map((a) => ({...a, foreground: a.packageName === packageName})),
    }))
  },

  clearForeground: () => {
    set((s) => {
      if (!s.apps.some((a) => a.foreground)) return s
      return {apps: s.apps.map((a) => (a.foreground ? {...a, foreground: false} : a))}
    })
  },
}))

// Project miniappRunningRegistry membership into the store's `running` field
// for local apps so the home tray and switcher reflect actual mount state
// without waiting for the next refresh() cycle.
miniappRunningRegistry.subscribe(() => {
  const running = new Set(miniappRunningRegistry.getAll())
  const state = useAppStatusStore.getState()
  let changed = false
  const updated = state.apps.map((app) => {
    if (!app.local) return app
    const next = running.has(app.packageName)
    if (app.running === next) return app
    changed = true
    return {...app, running: next}
  })
  if (changed) {
    useAppStatusStore.setState({apps: updated})
  }
})

// AppRegistry change events trigger a store refresh.
appRegistry.subscribe(() => {
  void useAppStatusStore.getState().refresh()
})

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

export const useApps = () => useAppStatusStore((state) => state.apps)
export const useStart = () => useAppStatusStore((state) => state.start)
export const useStop = () => useAppStatusStore((state) => state.stop)
export const useRefresh = () => useAppStatusStore((state) => state.refresh)
export const useStopAll = () => useAppStatusStore((state) => state.stopAll)
export const useInstall = () => useAppStatusStore((state) => state.install)
export const useUninstall = () => useAppStatusStore((state) => state.uninstall)

export const useActiveApps = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.running), [apps])
}

export const useActiveBackgroundApps = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.type === "background" && app.running), [apps])
}

export const useBackgroundApps = () => {
  const apps = useApps()
  return useMemo(
    () => ({
      active: apps.filter((app) => app.type === "background" && app.running),
      inactive: apps.filter((app) => app.type === "background" && !app.running),
    }),
    [apps],
  )
}

export const useActiveForegroundApp = () => {
  const apps = useApps()
  return useMemo(() => apps.find((app) => (app.type === "standard" || !app.type) && app.running) ?? null, [apps])
}

export const useActiveBackgroundAppsCount = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.type === "background" && app.running).length, [apps])
}

export const useLocalMiniApps = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.local), [apps])
}

/** Currently-foregrounded local miniapp, if any. The Compositor renders this. */
export const useForegroundMiniApp = () => {
  const apps = useApps()
  return useMemo(() => apps.find((app) => app.local && app.foreground) ?? null, [apps])
}

export const useSetForeground = () => useAppStatusStore((state) => state.setForeground)
export const useClearForeground = () => useAppStatusStore((state) => state.clearForeground)
