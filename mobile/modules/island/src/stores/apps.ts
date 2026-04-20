import {useMemo} from "react"
import {AsyncResult, result as Res, Result} from "typesafe-ts"
import {create} from "zustand"

import {CompatibilityResult} from "../utils/hardware"
import {storage} from "../utils/storage"
import composer from "../services/AppRegistry"
import {AppletPermission, AppletType, HardwareRequirement, HardwareType} from "../types"
// import registry from "../services/AppRegistry"

// runtime state of an applet:
export interface ClientApp {
  packageName: string
  name: string
  webviewUrl: string
  logoUrl: string
  type: AppletType
  permissions: AppletPermission[]
  running: boolean
  healthy: boolean
  hardwareRequirements: HardwareRequirement[]
  installedDate?: string
  lastActiveAt?: string
  offline: boolean
  offlineRoute: string
  compatibility?: CompatibilityResult
  loading: boolean
  local: boolean
  hidden: boolean
  onStart?: () => void
  onStop?: () => void
  screenshot?: string
  runtimePermissions?: string[]
  declaredPermissions?: string[]
  version?: string
  needsPcm?: boolean
  needsTranscript?: boolean
}

interface AppStatusState {
  apps: ClientApp[]
  refresh: () => Promise<void>
  start: (applet: ClientApp) => Promise<void>
  stop: (packageName: string) => Promise<void>
  stopAll: () => AsyncResult<void, Error>
  saveScreenshot: (packageName: string, screenshot: string) => Promise<void>
  setInstalledLmas: (installedLmas: ClientApp[]) => void
  setHiddenStatus: (packageName: string, status: boolean) => void
  getHiddenStatus: (packageName: string) => boolean
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
export const saveAppsOrder = (orderMap: OrderMap) => {
  return storage.save(APP_ORDER_KEY, orderMap)
}

export const getAppsOrder = (): Result<OrderMap, Error> => {
  return storage.load<OrderMap>(APP_ORDER_KEY)
}

const getRawPackageNamePriority = (pkg: string) => {
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

const startStopApplet = (applet: ClientApp, status: boolean): AsyncResult<void, Error> => {
  return Res.try_async(async () => {
    if (!status && applet.onStop) {
      await applet.onStop()
    }

    if (status && applet.onStart) {
      await applet.onStart()
    }
  })
}

export const useAppStatusStore = create<AppStatusState>((set, get) => ({
  apps: [],

  refresh: async () => {
    // const state = get()
    console.log(`APPLETS: refreshApplets()`)

    // merge in the offline apps:
    let applets: ClientApp[] = [...(await composer.getApps())]

    // add in any existing screenshots:
    let oldApplets = useAppStatusStore.getState().apps
    oldApplets.forEach((app) => {
      if (app.screenshot) {
        for (const applet of applets) {
          if (applet.packageName === app.packageName) {
            applet.screenshot = app.screenshot
          }
        }
      }
    })

    // // add in the compatibility info:
    // let defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    // let capabilities = getModelCapabilities(defaultWearable || DeviceTypes.NONE)

    // for (const applet of applets) {
    //   // console.log(`APPLETS: ${applet.packageName} ${JSON.stringify(applet.hardwareRequirements)}`)
    //   let result = HardwareCompatibility.checkCompatibility(applet.hardwareRequirements, capabilities)
    //   applet.compatibility = result
    // }

    // for (const applet of applets) {
    //   applet.hidden = state.getHiddenStatus(applet.packageName)
    // }

    // // Platform-specific app filtering and routing
    // applets = applets.filter((applet) => {
    //   // Notify is not supported on iOS yet - remove entirely
    //   if (Platform.OS === "ios" && applet.packageName === notifyPackageName) {
    //     return false
    //   }
    //   return true
    // })
    // for (const applet of applets) {
    //   if (applet.packageName === notifyPackageName) {
    //     // On Android, route to notification settings instead of generic webview settings
    //     applet.offlineRoute = "/miniapps/settings/notifications"
    //   }
    // }

    set({apps: applets})
  },

  start: async (clientApp: ClientApp) => {
    const state = get()
    const packageName = clientApp.packageName
    const applet = state.apps.find((a) => a.packageName === packageName)

    if (!applet) {
      console.error(`Applet not found for package name: ${packageName}`)
      return
    }

    // do nothing if any applet is currently loading:
    if (state.apps.some((a) => a.loading)) {
      console.log(`APPLETS: Skipping start applet ${packageName} because another applet is currently loading`)
      return
    }

    // console.log(`APPLETS: Starting applet ${packageName}`, applet.compatibility)
    // console.log(`APPLETS: All apps: ${applet}`)

    // show incompatible alert if the applet is incompatible:
    if (!applet.compatibility?.isCompatible) {
      // if one of the missing types is EXIST, show a specific message:
      const missingTypes = applet.compatibility?.missingRequired?.map((req) => req.type) || []
      if (missingTypes.includes(HardwareType.EXIST)) {
        // await showAlert({
        //   title: translate("home:glassesRequired"),
        //   buttons: [{text: translate("common:ok")}],
        //   message: translate("home:glassesRequiredMessage", {app: applet.name}),
        // })
        return
      }
      // const missingHardware =
      //   missingTypes
      //     .filter((t) => t !== HardwareType.EXIST)
      //     .map((t) => t.toLowerCase())
      //     .join(", ") || "required features"

      // await showAlert({
      //   title: translate("home:hardwareIncompatible"),
      //   buttons: [{text: translate("common:ok")}],
      //   message: translate("home:hardwareIncompatibleMessage", {
      //     app: applet.name,
      //     missing: missingHardware,
      //   }),
      // })

      return
    }

    // Start the new app
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, running: true, loading: false} : a)),
    }))

    // open the app webview if it has one:
    // if (!options?.skipNavigation) {
    //   // only open if the current route is home:
    //   const currentRoute = getCurrentRoute()
    //   if (currentRoute === "/home") {
    //     saveLastOpenTime(applet.packageName)
    //     if (applet.offlineRoute) {
    //       push(applet.offlineRoute, {transition: "zoom"})
    //     } else if (applet.offline) {
    //       // offline app with no route - nothing to navigate to
    //     } else if (applet.local) {
    //       push("/applet/local", {
    //         packageName: applet.packageName,
    //         version: applet.version,
    //         appName: applet.name,
    //         transition: "zoom",
    //       })
    //     } else if (applet.webviewUrl && applet.healthy) {
    //       // Check if app has webviewURL and navigate directly to it
    //       push("/applet/webview", {
    //         webviewURL: applet.webviewUrl,
    //         appName: applet.name,
    //         packageName: applet.packageName,
    //         transition: "zoom",
    //       })
    //     } else {
    //       // open settings page
    //       push("/applet/settings", {
    //         packageName: applet.packageName,
    //         appName: applet.name,
    //         transition: "zoom",
    //       })
    //     }
    //   }
    // }

    const result = await startStopApplet(applet, true)
    if (result.is_error()) {
      console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
      set((state) => ({
        apps: state.apps.map((a) => (a.packageName === packageName ? {...a, running: false, loading: false} : a)),
      }))
      return
    }
  },

  stop: async (packageName: string) => {
    const state = get()
    const applet = state.apps.find((a) => a.packageName === packageName)
    if (!applet) {
      console.error(`Applet with package name ${packageName} not found`)
      return
    }

    let shouldLoad = !applet.offline && !applet.local
    set((state) => ({
      apps: state.apps.map((a) =>
        a.packageName === packageName ? {...a, running: false, screenshot: undefined, loading: shouldLoad} : a,
      ),
    }))

    startStopApplet(applet, false)
  },

  setHiddenStatus: (packageName: string, status: boolean) => {
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, hidden: status} : a)),
    }))
    storage.save(`${packageName}_hidden`, status)
    if (!status) {
      // update the order map to remove the entry for the package name:
      const orderMap = getAppsOrder()
      if (orderMap.is_ok()) {
        delete orderMap.value[packageName]
        saveAppsOrder(orderMap.value)
      }
    }
  },

  getHiddenStatus: (packageName: string): boolean => {
    const hidden = storage.load<boolean>(`${packageName}_hidden`)
    if (hidden.is_ok()) {
      return hidden.value
    }
    return false
  },

  stopAll: (): AsyncResult<void, Error> => {
    return Res.try_async(async () => {
      const state = get()
      const runningApps = state.apps.filter((app) => app.running)

      for (const app of runningApps) {
        await state.stop(app.packageName)
      }
    })
  },

  saveScreenshot: async (packageName: string, screenshot: string) => {
    // await storage.save(`${packageName}_screenshot`, screenshot)
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, screenshot} : a)),
    }))
  },

  setInstalledLmas: (_installedLmas: ClientApp[]) => {
    // set({localMiniApps: installedLmas})
  },
}))

// // Re-evaluate app compatibility when default_wearable changes
// // This fixes the bug where switching devices leaves apps greyed out with stale compatibility
// useSettingsStore.subscribe(
//   (state) => state.getSetting(SETTINGS.default_wearable.key),
//   (defaultWearable) => {
//     const apps = useAppStatusStore.getState().apps
//     if (apps.length === 0) return

//     const capabilities = getModelCapabilities(defaultWearable || DeviceTypes.NONE)
//     let changed = false
//     const updatedApps = apps.map((applet) => {
//       const result = HardwareCompatibility.checkCompatibility(applet.hardwareRequirements, capabilities)
//       if (result.isCompatible !== applet.compatibility?.isCompatible) {
//         changed = true
//       }
//       return {...applet, compatibility: result}
//     })

//     if (changed) {
//       useAppStatusStore.setState({apps: updatedApps})
//     }
//   },
// )

export const useApps = () => useAppStatusStore((state) => state.apps)
export const useStart = () => useAppStatusStore((state) => state.start)
export const useStop = () => useAppStatusStore((state) => state.stop)
export const useRefresh = () => useAppStatusStore((state) => state.refresh)
export const useStopAll = () => useAppStatusStore((state) => state.stopAll)
// export const useInactiveForegroundApps = () => {
//   const apps = useApplets()
//   const [isOffline] = useSetting(SETTINGS.offline_mode.key)
//   return useMemo(() => {
//     if (isOffline) {
//       return apps.filter((app) => (app.type === "standard" || app.type === "background") && !app.running && app.offline)
//     }
//     return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && !app.running)
//   }, [apps, isOffline])
// }
// export const useForegroundApps = () => {
//   const apps = useApplets()
//   const [isOffline] = useSetting(SETTINGS.offline_mode.key)
//   return useMemo(() => {
//     if (isOffline) {
//       return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && app.offline)
//     }
//     return apps.filter((app) => app.type === "standard" || app.type === "background" || !app.type)
//   }, [apps, isOffline])
// }

export const useActiveApps = () => {
  const apps = useApps()
  return useMemo(() => apps.filter((app) => app.running), [apps])
}

// export const useIncompatibleApps = () => {
//   const apps = useApplets()
//   const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

//   return useMemo(() => {
//     // if no default wearable, return all apps:
//     if (!defaultWearable) {
//       return apps
//     }
//     // otherwise, return only incompatible apps:
//     return apps.filter((app) => !app.compatibility?.isCompatible)
//   }, [apps, defaultWearable])
// }

// export const useLocalMiniApps = () => {
//   return useAppStatusStore.getState().apps.filter((app) => app.local)
// }

// export const useActiveAppPackageNames = () =>
//   useAppStatusStore(useShallow((state) => state.apps.filter((app) => app.running).map((a) => a.packageName)))
