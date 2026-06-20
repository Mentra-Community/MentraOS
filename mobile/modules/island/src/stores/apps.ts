/**
 * Island apps store — runtime state of installed and local applets.
 *
 * The OEM-facing API: subscribe to the running set, install/uninstall
 * miniapps, start/stop them. The store delegates install plumbing to
 * AppRegistry, and exposes hooks (`useApps`, `useStart`, `useStop`,
 * `useRefresh`, `useStopAll`) that the host UI can read.
 *
 * Source of `apps`:
 *   - Local: appRegistry.getInstalledMiniapps()    (always)
 */

import {useMemo} from "react"
import {AsyncResult, Result, result as Res} from "typesafe-ts"
import {create} from "zustand"

import type {ClientApp} from "../types/applet"
import {DeviceTypes} from "../types/enums"
import {getModelCapabilities} from "../types/hardware"
import {HardwareCompatibility} from "../utils/hardware/hardware"
import {storage} from "../utils/storage/storage"
import appRegistry from "../services/AppRegistry"
import {islandNotifications} from "../services/NotificationsEmitter"
import {miniappLauncher} from "../services/MiniappLauncher"
import {miniappRunningRegistry} from "../services/MiniappRunningRegistry"
import {SETTINGS, useSettingsStore} from "./settings"
import BluetoothSdk from "@mentra/bluetooth-sdk"

// ---------------------------------------------------------------------------
// Configuration / hooks
// ---------------------------------------------------------------------------

export interface StartOptions {
  skipNavigation?: boolean
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface AppStatusState {
  apps: ClientApp[]
  /**
   * Source of truth for which app is foregrounded in the Compositor overlay.
   * The per-app `foregrounded` boolean is derived from this in `projectApps`
   * so a refresh can never drop the flag when an app is transiently missing
   * from one of the two refresh passes (local-only then merged). See
   * `projectApps` / `setForeground` / `clearForeground`.
   */
  foregroundedPackage: string | null
  refresh: () => Promise<void>
  /** Resolves true if the app actually started; false if a host gate aborted it or its JS context failed to spawn. */
  start: (app: ClientApp, opts?: StartOptions) => Promise<boolean>
  stop: (packageName: string) => Promise<void>
  setForeground: (packageName: string) => Promise<void>
  clearForeground: () => void
  stopAll: () => AsyncResult<void, Error>
  install: (url: string, opts?: {versionOverride?: string}) => AsyncResult<void, Error>
  uninstall: (packageName: string, version?: string) => AsyncResult<void, Error>
  saveScreenshot: (packageName: string, screenshot: string) => Promise<void>
  setHiddenStatus: (packageName: string, status: boolean) => void
  getHiddenStatus: (packageName: string) => boolean
  /** Replace the whole apps array. Hosts use this when their extra source changes. */
  setApps: (apps: ClientApp[]) => void
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

// In-memory cache for hidden flags. `projectApps` reads getHiddenStatus once
// per app per refresh — without a cache that was a synchronous JNI hop per
// app per refresh on a hot UI path. Kept consistent with disk by writing
// through in setHiddenStatus. Map of packageName → hidden boolean.
const hiddenStatusCache = new Map<string, boolean>()

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

/**
 * Build the final `apps` array for the store from the installed/offline app
 * source. Pure — same inputs -> same outputs.
 */
function projectApps(previousState: AppStatusState, localApps: ClientApp[]): ClientApp[] {
  // Dedupe by packageName, keep first occurrence.
  const byPackage = new Map<string, ClientApp>()
  for (const app of localApps) {
    if (!byPackage.has(app.packageName)) byPackage.set(app.packageName, app)
  }

  // Index previous snapshot for cheap lookups (was O(N²) via .find()).
  const previousByPackage = new Map<string, ClientApp>()
  for (const oldApp of previousState.apps) {
    previousByPackage.set(oldApp.packageName, oldApp)
  }

  const defaultWearable =
    (useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key) as DeviceTypes | undefined) ||
    DeviceTypes.NONE
  const capabilities = getModelCapabilities(defaultWearable)

  // Single pass: dedupe → screenshot carry-over → compat → hidden, all into
  // fresh objects. The previous in-place mutation re-used object references
  // across refreshes, which broke React.memo / referential-equality
  // memoization downstream (every refresh propagated re-renders even when
  // nothing meaningful changed) AND tripped Reanimated's "tried to modify
  // key of an object already passed to a worklet" warning whenever the home
  // screen's animated app cards held a reference to a previous snapshot's
  // app object that we then mutated.
  return Array.from(byPackage.values()).map((app) => ({
    ...app,
    screenshot: previousByPackage.get(app.packageName)?.screenshot ?? app.screenshot,
    compatibility: HardwareCompatibility.checkCompatibility(app.hardwareRequirements, capabilities),
    hidden: previousState.getHiddenStatus(app.packageName),
    // Derive the foreground flag from the store's single source of truth
    // (`foregroundedPackage`), NOT from the previous snapshot. Carrying it over
    // per-app meant a refresh that momentarily omitted an app (e.g. the
    // two-pass local-only → merged emit) would reset its flag to false — which
    // raced OfflineAppHost's interceptor guard and made the hosted miniapp fall
    // through to the root router (restart). Deriving here keeps the flag stable
    // across both passes.
    foregrounded: app.packageName === previousState.foregroundedPackage,
  }))
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  apps: [],
  foregroundedPackage: null,

  refresh: async () => {
    const previousState = get()
    const localApps = await appRegistry.getInstalledMiniapps()
    set({apps: projectApps(previousState, localApps)})
  },

  start: async (clientApp: ClientApp, _opts?: StartOptions) => {
    const state = get()
    const packageName = clientApp.packageName
    const app = state.apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: app not found for package name: ${packageName}`)
      return false
    }

    // Skip if any app is currently loading.
    if (state.apps.some((a) => a.loading)) {
      console.log(`ISLAND: skipping start ${packageName} — another app is loading`)
      return false
    }

    if (!app.offline && !app.local) {
      console.warn(`ISLAND: cloud-v1 app entries are no longer supported: ${packageName}`)
      return false
    }

    // Island-native incompatibility gate. Block the launch and raise a structured
    // notification the host can render off toolkit.notifications.
    if (app.compatibility?.isCompatible === false) {
      islandNotifications.emit({
        kind: "version_incompatible",
        packageName,
        reason: `${app.name ?? packageName} is not compatible with the connected glasses`,
        metadata: {missingRequired: app.compatibility.missingRequired ?? []},
        timestamp: Date.now(),
      })
      return false
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

    set((s) => ({
      apps: s.apps.map((a) => (a.packageName === packageName ? {...a, running: true, loading: false} : a)),
    }))

    saveLastOpenTime(packageName)
    await startStopApp(app, true)

    // Spawn the background JS context for local miniapps. This used to be a
    // side effect of LocalMiniappView mounting on foreground; pulling it here
    // lets start() actually run the app even when nothing foregrounds it (e.g.
    // a system app launching another miniapp via session.miniapps). Idempotent
    // with the view's own ensureRunning; a no-op for native offline built-ins
    // and cloud apps (no JS bundle).
    if (app.local) {
      try {
        await miniappLauncher.ensureRunning(packageName)
      } catch (e) {
        // Spawn / bundle-resolve failed — revert the optimistic running flag so
        // the home list and miniapps.list() don't show a "running" app with no
        // JS context, and report failure to the caller (session.miniapps.start).
        console.warn(`ISLAND: launcher.ensureRunning failed for ${packageName}`, e)
        set((s) => ({
          apps: s.apps.map((a) => (a.packageName === packageName ? {...a, running: false, loading: false} : a)),
        }))
        // onStart already persisted running:true to disk (saveLocalAppRunningState)
        // before the spawn; run onStop to undo it so a refresh/reboot doesn't
        // resurrect a "running" app with no JS context.
        await startStopApp(app, false)
        return false
      }
    }

    return true
  },

  stop: async (packageName: string) => {
    const state = get()
    const app = state.apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: app not found for package name: ${packageName}`)
      return
    }

    set((s) => ({
      apps: s.apps.map((a) =>
        a.packageName === packageName ? {...a, running: false, screenshot: undefined, loading: false} : a,
      ),
    }))

    // if there are no apps running, call clearDisplay():
    // read fresh state via get() — `state` was captured before the set() above, so it still shows
    // this app as running and would never reach 0 when stopping the last app.
    if (get().apps.filter((a) => a.running).length === 0) {
      BluetoothSdk.clearDisplay()
    }
    await startStopApp(app, false)

    // Tear down the background JS context for local miniapps. No-op for native
    // offline built-ins.
    if (app.local) {
      try {
        await miniappLauncher.stop(packageName)
      } catch (e) {
        console.warn(`ISLAND: launcher.stop failed for ${packageName}`, e)
      }
    }
  },

  setForeground: async (packageName: string) => {
    const app = get().apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: setForeground — app not found: ${packageName}`)
      return
    }

    // Flip the foreground flag synchronously so the Compositor's open
    // animation starts on the same frame as the tap. We do NOT await start()
    // first — that gated the flag (and thus the animation) behind the whole
    // JSContext-spawn chain, which was the perceived launch delay. The
    // Compositor/LocalMiniappView already handle the spawn being in-flight
    // (the phase machine), so foregrounding needn't wait for it.
    saveLastOpenTime(packageName)
    set((s) => ({
      foregroundedPackage: packageName,
      apps: s.apps.map((a) => ({...a, foregrounded: a.packageName === packageName})),
    }))

    // Ensure the JSContext exists. start() is idempotent for an
    // already-running app and enforces the foreground-only-one rule for
    // standard apps. Fire-and-forget after the flag flip so it doesn't block
    // paint.
    // if (!app.running) {
    //   get().start(app)
    // }
  },

  clearForeground: () => {
    set((s) => ({
      foregroundedPackage: null,
      apps: s.apps.some((a) => a.foregrounded)
        ? s.apps.map((a) => (a.foregrounded ? {...a, foregrounded: false} : a))
        : s.apps,
    }))
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
    hiddenStatusCache.set(packageName, status)
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
    const cached = hiddenStatusCache.get(packageName)
    if (cached !== undefined) return cached
    const res = storage.load<boolean>(`${packageName}_hidden`)
    const value = res.is_ok() ? res.value : false
    hiddenStatusCache.set(packageName, value)
    return value
  },

  setApps: (apps) => set({apps}),
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

// Re-evaluate hardware compatibility when the paired/default wearable changes.
useSettingsStore.subscribe(
  (state) => state.getSetting(SETTINGS.default_wearable.key),
  () => {
    void useAppStatusStore.getState().refresh()
  },
)

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

export const useApps = () => useAppStatusStore((state) => state.apps)
export const useStart = () => useAppStatusStore((state) => state.start)
export const useStop = () => useAppStatusStore((state) => state.stop)
export const useSetForeground = () => useAppStatusStore((state) => state.setForeground)
export const useClearForeground = () => useAppStatusStore((state) => state.clearForeground)
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

/**
 * The single app currently foregrounded in the Compositor overlay, or null.
 * Driven by setForeground/clearForeground — distinct from the "active
 * standard app" (running) selector above.
 */
export const useForegroundApp = () => {
  const apps = useApps()
  return useMemo(() => apps.find((app) => app.foregrounded) ?? null, [apps])
}

export const useActiveBackgroundAppsCount = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.type === "background" && app.running).length, [apps])
}

export const useLocalMiniApps = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.local), [apps])
}
