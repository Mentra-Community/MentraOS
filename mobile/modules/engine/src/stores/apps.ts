/**
 * Engine apps store — runtime state of installed and local applets.
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
import {HardwareCompatibility, type CompatibilityResult} from "../utils/hardware/hardware"
import {storage} from "../utils/storage/storage"
import appRegistry from "../services/AppRegistry"
import localDisplayManager from "../services/LocalDisplayManager"
import {islandNotifications} from "../services/NotificationsEmitter"
import sttModelManager from "../services/STTModelManager"
import {miniappLauncher} from "../services/MiniappLauncher"
import {miniappRunningRegistry} from "../services/MiniappRunningRegistry"
import {resolveHiddenStatus} from "./appVisibility"
import {SETTINGS, useSettingsStore} from "./settings"
import {runAppsRefresh} from "./appsRefresh"
import BluetoothSdk from "@mentra/bluetooth-sdk"

// ---------------------------------------------------------------------------
// Configuration / hooks
// ---------------------------------------------------------------------------

export interface StartOptions {
  skipNavigation?: boolean
}

export interface AppStoreHooks {
  /**
   * A start was blocked because the app is hardware-incompatible. Engine made
   * the decision (and raised the `version_incompatible` notification); the host
   * renders its branded alert here.
   */
  onIncompatibleBlocked?: (app: ClientApp) => void
  /**
   * A start was blocked because the app requires the on-device STT model
   * (declared at registration — see AppRegistry.installOfflineApp) and none is
   * installed. Engine decided via its model manager; the host renders the
   * alert / settings navigation here.
   */
  onMissingSpeechModel?: (app: ClientApp) => void
  /**
   * An open request passed the gates — fired on EVERY open, including
   * re-opening an already-running app, so the host's navigation / open
   * animation always plays.
   */
  onOpenRequested?: (app: ClientApp, opts?: StartOptions) => void
}

let hostHooks: AppStoreHooks = {}

export function installAppStoreHooks(hooks: AppStoreHooks): void {
  hostHooks = {...hostHooks, ...hooks}
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
  /** True once the first refresh() (success or failure) has completed. `apps`
   * before this point is only ever the persisted cache (or empty) — the host
   * uses this to distinguish "still loading" from "confirmed empty" (#1222). */
  initialized: boolean
  /** True while a refresh() is in flight. */
  loading: boolean
  /** Message from the most recent failed refresh(); cleared on the next
   * attempt (success or failure). Null when no refresh has failed. */
  refreshError: string | null
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

// Last-known app list, persisted so the home screen has something to paint
// immediately on cold boot instead of an empty grid while the on-disk scan
// in AppRegistry.getInstalledMiniapps() completes (#1222). Best-effort only:
// a missing/corrupt cache just falls back to an empty list, same as before.
const CACHED_APPS_KEY = "cached_app_list"

export const loadCachedApps = (): ClientApp[] => {
  const res = storage.load<ClientApp[]>(CACHED_APPS_KEY)
  return res.is_ok() ? res.value : []
}

// Functions (onStart/onStop) don't survive JSON.stringify — they're silently
// dropped, which is fine: a cached snapshot is only ever shown for the brief
// window before the first live refresh() replaces it.
const saveCachedApps = (apps: ClientApp[]): void => {
  storage.save(CACHED_APPS_KEY, apps)
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
  //
  // Identity stability: refresh() is event-driven and fires repeatedly (and
  // twice per cycle via the local-only → merged two-pass emit). If we always
  // returned fresh objects, every poll changed the identity of EVERY app —
  // which re-rendered the Compositor (via useForegroundApp) mid-slide and made
  // the open/close animation hitch, and churned the home grid / switcher pill.
  // So we build the candidate object, then REUSE the previous reference when
  // nothing meaningful changed. Same pattern as the miniappRunningRegistry
  // projection below. A stable foreground-app reference lets the Compositor's
  // slide run uninterrupted on the UI thread.
  return Array.from(byPackage.values()).map((app) => {
    const next: ClientApp = {
      ...app,
      screenshot: previousByPackage.get(app.packageName)?.screenshot ?? app.screenshot,
      compatibility: HardwareCompatibility.checkCompatibility(app.hardwareRequirements, capabilities),
      // A registry source can force an app off the primary home screen (for
      // example, Miniapp Developer while its home-screen setting is disabled).
      // Compose that gate with the user's persisted home-screen layout instead
      // of replacing it, otherwise a default-false persisted value makes a
      // source-hidden app visible again during projection.
      hidden: resolveHiddenStatus(app.hidden, previousState.getHiddenStatus(app.packageName)),
      // Derive the foreground flag from the store's single source of truth
      // (`foregroundedPackage`), NOT from the previous snapshot. Carrying it over
      // per-app meant a refresh that momentarily omitted an app (e.g. the
      // two-pass local-only → merged emit) would reset its flag to false — which
      // raced OfflineAppHost's interceptor guard and made the hosted miniapp fall
      // through to the root router (restart). Deriving here keeps the flag stable
      // across both passes.
      foregrounded: app.packageName === previousState.foregroundedPackage,
    }
    const prev = previousByPackage.get(app.packageName)
    return prev && shallowEqualApp(prev, next) ? prev : next
  })
}

// Cheap equality check used by projectApps to preserve object identity across
// refreshes when nothing meaningful changed. Most keys are compared by
// reference (the source app's nested fields — permissions, hardwareRequirements,
// parameters — are reference-stable within a refresh). The ONE exception is
// `compatibility`, which projectApps recomputes into a fresh object every call;
// comparing it by reference would always differ and defeat the whole point. We
// compare it structurally instead so identity is only broken when the device's
// actual compatibility verdict changes (e.g. glasses connect/disconnect).
function shallowEqualApp(a: ClientApp, b: ClientApp): boolean {
  const aKeys = Object.keys(a) as (keyof ClientApp)[]
  const bKeys = Object.keys(b) as (keyof ClientApp)[]
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (k === "compatibility") {
      if (!compatibilityEqual(a.compatibility, b.compatibility)) return false
      continue
    }
    if (a[k] !== b[k]) return false
  }
  return true
}

function compatibilityEqual(a?: CompatibilityResult, b?: CompatibilityResult): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.isCompatible === b.isCompatible &&
    a.missingRequired.length === b.missingRequired.length &&
    a.missingOptional.length === b.missingOptional.length &&
    a.warnings.length === b.warnings.length
  )
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  apps: loadCachedApps(),
  foregroundedPackage: null,
  initialized: false,
  loading: false,
  refreshError: null,

  refresh: async () => {
    const previousState = get()
    set({loading: true})
    const result = await runAppsRefresh(
      () => appRegistry.getInstalledMiniapps(),
      (localApps) => projectApps(previousState, localApps),
      saveCachedApps,
    )
    set({
      ...(result.apps ? {apps: result.apps} : {}),
      loading: false,
      initialized: true,
      refreshError: result.refreshError,
    })
  },

  start: async (clientApp: ClientApp, opts?: StartOptions) => {
    const state = get()
    const packageName = clientApp.packageName
    const app = state.apps.find((a) => a.packageName === packageName)
    if (!app) {
      console.error(`ISLAND: app not found for package name: ${packageName}`)
      return false
    }

    // Skip spawning a NEW app while another is mid-launch — concurrent spawns
    // race the foreground-only-one teardown. This is checked BEFORE the gates
    // and the onOpenRequested seam (which navigates/foregrounds) so a gated
    // launch doesn't paint a splash it can't back. Re-opening an already-running
    // app is exempt: it has nothing to spawn, so it skips this gate and is
    // allowed to re-navigate/animate below.
    // That exemption is the fix for the "second tap during another app's launch
    // window silently does nothing" bug.
    if (!app.running && state.apps.some((a) => a.loading)) {
      console.log(`ISLAND: skipping start ${packageName} — another app is loading`)
      return false
    }

    if (!app.offline && !app.local) {
      console.warn(`ISLAND: cloud-v1 app entries are no longer supported: ${packageName}`)
      return false
    }

    // Hardware-compatibility gate — engine decides and blocks; the host renders
    // its branded alert via onIncompatibleBlocked (and/or the structured
    // notification below). `!isCompatible` (not `=== false`) keeps the semantics
    // of the host gate this replaces: an unknown verdict blocks, not launches.
    if (!app.compatibility?.isCompatible) {
      islandNotifications.emit({
        kind: "version_incompatible",
        packageName,
        reason: `${app.name ?? packageName} is not compatible with the connected glasses`,
        metadata: {missingRequired: app.compatibility?.missingRequired ?? []},
        timestamp: Date.now(),
      })
      hostHooks.onIncompatibleBlocked?.(app)
      return false
    }

    // Missing-speech-model gate for apps registered with requiresLocalSttModel.
    // Engine decides via its own model manager; the host renders the alert and
    // any settings navigation via onMissingSpeechModel.
    if (appRegistry.requiresLocalSttModel(packageName) && !(await sttModelManager.isModelAvailable())) {
      islandNotifications.emit({
        kind: "missing_speech_model",
        packageName,
        reason: `${app.name ?? packageName} needs an on-device speech model before it can start`,
        timestamp: Date.now(),
      })
      hostHooks.onMissingSpeechModel?.(app)
      return false
    }

    // Host navigation / open-animation seam. Runs on EVERY accepted open —
    // including re-opening an already-running app — so the animation always
    // plays (BuiltInMiniappCatalog.navigateForApp: overlay apps setForeground
    // for the slide).
    hostHooks.onOpenRequested?.(app, opts)

    // First-activation mark (moved from the host's old beforeStart — engine
    // owns the settings store).
    useSettingsStore.getState().setSetting(SETTINGS.has_ever_activated_app.key, true)

    // If the tapped app is already running, this is a re-open: the nav/foreground
    // above already drove the animation, and there's nothing to spawn. Short-
    // circuit before the spawn pipeline.
    if (app.running) {
      saveLastOpenTime(packageName)
      return true
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

// The display-manager's core (foreground) slot is DERIVED state: always the
// currently-running standard app, no matter HOW it came to run — user tap
// (start()), boot restore (autostartLocalMiniapps → registry projection
// above), crash-respawn, or interop. One reconciler instead of per-path call
// sites, so no launch/stop path can forget to claim or release the slot.
// onCoreAppChange is idempotent, so firing on every store write is free.
useAppStatusStore.subscribe((state) => {
  const core = state.apps.find((a) => a.running && (a.type === "standard" || !a.type))
  localDisplayManager.onCoreAppChange(core?.packageName ?? null)
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
export const useAppsInitialized = () => useAppStatusStore((state) => state.initialized)
export const useAppsLoading = () => useAppStatusStore((state) => state.loading)
export const useAppsRefreshError = () => useAppStatusStore((state) => state.refreshError)
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
