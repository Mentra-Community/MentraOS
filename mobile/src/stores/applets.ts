import {
  AppletInterface,
  DeviceTypes,
  getModelCapabilities,
  HardwareRequirementLevel,
  HardwareType,
} from "@/../../cloud/packages/types/src"
import {useMemo} from "react"
import {AsyncResult, result as Res, Result} from "typesafe-ts"
import {create} from "zustand"
import * as Sentry from "@sentry/react-native"

import {getCurrentRoute, push} from "@/contexts/NavigationRef"
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import STTModelManager from "@/services/STTModelManager"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {CompatibilityResult, HardwareCompatibility} from "@/utils/hardware"
import {BackgroundTimer} from "@/utils/timers"
import {storage} from "@/utils/storage"
import {useShallow} from "zustand/react/shallow"
import composer from "@/services/Composer"

export interface ClientAppletInterface extends AppletInterface {
  offline: boolean
  offlineRoute: string
  compatibility?: CompatibilityResult
  loading: boolean
  local: boolean
  hidden: boolean
  onStart?: () => AsyncResult<void, Error>
  onStop?: () => AsyncResult<void, Error>
  screenshot?: string
  runtimePermissions?: string[]
  declaredPermissions?: string[]
  version?: string
}

interface AppStatusState {
  apps: ClientAppletInterface[]
  refreshApplets: () => Promise<void>
  startApplet: (packageName: string, appType?: string) => Promise<void>
  stopApplet: (packageName: string) => Promise<void>
  stopAllApplets: () => AsyncResult<void, Error>
  saveScreenshot: (packageName: string, screenshot: string) => Promise<void>
  setInstalledLmas: (installedLmas: ClientAppletInterface[]) => void
  setHiddenStatus: (packageName: string, status: boolean) => void
  uninstallApplet: (packageName: string) => Promise<void>
}

export const DUMMY_APPLET: ClientAppletInterface = {
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

/**
 * Offline Apps Configuration
 *
 * These are local React Native apps that don't require webviews or server communication.
 * They navigate directly to specific React Native routes when activated.
 */

export const cameraPackageName = "com.mentra.camera"
export const captionsPackageName = "com.mentra.captions"
export const galleryPackageName = "com.mentra.gallery"
export const settingsPackageName = "com.mentra.settings"
export const storePackageName = "com.mentra.store"
export const simulatedPackageName = "com.mentra.simulated"
export const mirrorPackageName = "com.mentra.mirror"
export const lmaInstallerPackageName = "com.mentra.lma_installer"

export const uninstallAppUI = (clientApp: ClientAppletInterface) => {
  console.log(`Uninstalling app: ${clientApp.packageName}`)

  showAlert(
    translate("appSettings:uninstallApp"),
    translate("appSettings:uninstallConfirm", {appName: clientApp.name}),
    [
      {
        text: translate("common:cancel"),
        style: "cancel",
      },
      {
        text: translate("appSettings:uninstall"),
        style: "destructive",
        onPress: async () => {
          try {
            // First stop the app if it's running
            if (clientApp.running) {
              useAppletStatusStore.getState().stopApplet(clientApp.packageName)
            }

            await useAppletStatusStore.getState().uninstallApplet(clientApp.packageName)
            showAlert(
              translate("common:success"),
              translate("appSettings:uninstalledSuccess", {appName: clientApp.name}),
              [{text: translate("common:ok"), onPress: () => {}}],
            )
          } catch (error: any) {
            console.error("Error uninstalling app:", error)
            useAppletStatusStore.getState().refreshApplets()
            showAlert(
              translate("common:error"),
              translate("appSettings:uninstallError", {error: error.message || "Unknown error"}),
              [{text: translate("common:ok")}],
            )
          }
        },
      },
    ],
    {
      iconName: "trash",
      iconSize: 48,
    },
  )
}

const getHiddenStatus = (packageName: string): boolean => {
  const hidden = storage.load<boolean>(`${packageName}_hidden`)
  if (hidden.is_ok()) {
    return hidden.value
  }
  return false
}

export const saveLocalAppRunningState = (packageName: string, status: boolean): AsyncResult<void, Error> => {
  return Res.try_async(async () => {
    await storage.save(`${packageName}_running`, status)
    return undefined
  })
}

export const setLastOpenTime = (packageName: string): AsyncResult<void, Error> => {
  return Res.try_async(async () => {
    await storage.save(`${packageName}_last_open_time`, Date.now())
    return undefined
  })
}

export const getLastOpenTime = (packageName: string): AsyncResult<number, Error> => {
  return Res.try_async(async () => {
    const lastOpenTime = await storage.load<number>(`${packageName}_last_open_time`)
    if (lastOpenTime.is_ok()) {
      return lastOpenTime.value
    }
    return 0
  })
}

const getRawPackageNamePriority = (pkg: string) => {
  if (pkg.includes("__empty")) {
    return 1000
  }
  switch (pkg) {
    case cameraPackageName:
      return 0
    case galleryPackageName:
      return 2
    case settingsPackageName:
      return 3
    case storePackageName:
      return 4
    default:
      return 1
  }
}
export const getPackageNamePriority = (a: ClientAppletInterface, b: ClientAppletInterface): number => {
  // const pa = getRawPackageNamePriority(a.packageName)
  // const pb = getRawPackageNamePriority(b.packageName)
  // if (pa !== pb) return pa - pb
  const appSwitcherUi = useSettingsStore.getState().getSetting(SETTINGS.app_switcher_ui.key)
  if (!appSwitcherUi) {
    const pa = getRawPackageNamePriority(a.packageName)
    const pb = getRawPackageNamePriority(b.packageName)
    if (pa !== pb) return pa - pb
  }
  return a.name.localeCompare(b.name)
}

// these apps cannot be uninstalled:
export const SYSTEM_APPS = [
  cameraPackageName,
  captionsPackageName,
  galleryPackageName,
  settingsPackageName,
  storePackageName,
  simulatedPackageName,
  mirrorPackageName,
]

// get offline applets:
const getOfflineApplets = async (): Promise<ClientAppletInterface[]> => {
  let miniApps: ClientAppletInterface[] = [
    {
      packageName: cameraPackageName,
      name: translate("miniApps:camera"),
      type: "standard", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      logoUrl: require("@assets/applet-icons/camera.png"),
      // description: "Capture photos and videos with your Mentra glasses.",
      webviewUrl: "",
      // version: "0.0.1",
      permissions: [],
      offlineRoute: "/asg/gallery",
      local: false,
      running: false,
      loading: false,
      healthy: true,
      hidden: false,
      hardwareRequirements: [{type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED}],
      onStart: (): AsyncResult<void, Error> => {
        return Res.try_async(async () => {
          await storage.save(`${cameraPackageName}_running`, true)
          // tell the core:
          await useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, true)
          return undefined
        })
      },
      onStop: (): AsyncResult<void, Error> => {
        return Res.try_async(async () => {
          await storage.save(`${cameraPackageName}_running`, false)
          // tell the core:
          await useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, false)
          return undefined
        })
      },
    },
    {
      packageName: captionsPackageName,
      name: translate("miniApps:offlineCaptions"),
      type: "standard", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      // logoUrl: getCaptionsIcon(isDark),
      logoUrl: require("@assets/applet-icons/captions.png"),
      // description: "Live captions for your mentra glasses.",
      webviewUrl: "",
      healthy: true,
      hidden: false,
      permissions: [],
      offlineRoute: "",
      running: false,
      loading: false,
      local: false,
      hardwareRequirements: [{type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED}],
      onStart: (): AsyncResult<void, Error> => {
        return Res.try_async(async () => {
          const modelAvailable = await STTModelManager.isModelAvailable()
          if (modelAvailable) {
            await storage.save(`${captionsPackageName}_running`, true)
            // tell the core:
            await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, true)
            return undefined
          }

          showAlert(translate("transcription:noModelInstalled"), translate("transcription:noModelInstalledMessage"), [
            {text: translate("common:cancel"), style: "cancel"},
            {
              text: translate("transcription:goToSettings"),
              onPress: () => {
                push("/settings/transcription")
              },
            },
          ])

          throw new Error("No model available")
        })
      },
      onStop: (): AsyncResult<void, Error> => {
        return Res.try_async(async () => {
          await storage.save(`${captionsPackageName}_running`, false)
          // tell the core:
          await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, false)
          return undefined
        })
      },
    },
    {
      packageName: galleryPackageName,
      name: translate("miniApps:gallery"),
      type: "background", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      logoUrl: require("@assets/applet-icons/gallery.png"),
      local: false,
      running: false,
      loading: false,
      healthy: true,
      hidden: false,
      permissions: [],
      offlineRoute: "/asg/gallery",
      webviewUrl: "",
      hardwareRequirements: [{type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED}],
      onStart: () => saveLocalAppRunningState(galleryPackageName, true),
      onStop: () => saveLocalAppRunningState(galleryPackageName, false),
    },
    {
      packageName: settingsPackageName,
      name: translate("miniApps:settings"),
      type: "background", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      logoUrl: require("@assets/applet-icons/settings.png"),
      local: false,
      running: false,
      loading: false,
      healthy: true,
      hidden: false,
      permissions: [],
      offlineRoute: "/settings/account",
      webviewUrl: "",
      hardwareRequirements: [],
      onStart: () => saveLocalAppRunningState(settingsPackageName, true),
      onStop: () => saveLocalAppRunningState(settingsPackageName, false),
    },
    {
      packageName: storePackageName,
      name: translate("miniApps:store"),
      offlineRoute: "/miniapps/store/store",
      webviewUrl: "",
      healthy: true,
      hidden: false,
      permissions: [],
      offline: true,
      running: false,
      loading: false,
      hardwareRequirements: [],
      type: "background",
      logoUrl: require("@assets/applet-icons/store.png"),
      local: false,
      onStart: () => saveLocalAppRunningState(storePackageName, true),
      onStop: () => saveLocalAppRunningState(storePackageName, false),
    },
    {
      packageName: mirrorPackageName,
      name: translate("miniApps:mirror"),
      offlineRoute: "/miniapps/mirror/mirror",
      webviewUrl: "",
      healthy: true,
      hidden: false,
      permissions: [],
      offline: true,
      running: false,
      loading: false,
      hardwareRequirements: [{type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED}],
      type: "background",
      logoUrl: require("@assets/applet-icons/mirror.png"),
      local: false,
      onStart: () => saveLocalAppRunningState(mirrorPackageName, true),
      onStop: () => saveLocalAppRunningState(mirrorPackageName, false),
    },
    // {
    //   packageName: simulatedPackageName,
    //   name: translate("miniApps:simulated"),
    //   offlineRoute: "/miniapps/simulated",
    //   webviewUrl: "",
    //   healthy: true,
    //   permissions: [],
    //   offline: true,
    //   running: false,
    //   loading: false,
    //   hardwareRequirements: [],
    //   type: "background",
    //   logoUrl: require("@assets/applet-icons/simulated.png"),
    //   local: false,
    //   onStart: () => saveLocalAppRunningState(simulatedPackageName, true),
    //   onStop: () => saveLocalAppRunningState(simulatedPackageName, false),
    // },
  ]

  let superMode = useSettingsStore.getState().getSetting(SETTINGS.super_mode.key)
  let appSwitcherUi = useSettingsStore.getState().getSetting(SETTINGS.app_switcher_ui.key)
  if (superMode && appSwitcherUi) {
    miniApps.push({
      packageName: lmaInstallerPackageName,
      name: translate("miniApps:lmaInstaller"),
      type: "standard",
      offline: true,
      offlineRoute: "/miniapps/dev/mini-app-installer",
      local: false,
      webviewUrl: "",
      permissions: [],
      running: false,
      loading: false,
      healthy: true,
      hidden: false,
      hardwareRequirements: [],
      logoUrl: require("@assets/applet-icons/store.png"),
      onStart: () => saveLocalAppRunningState(lmaInstallerPackageName, true),
      onStop: () => saveLocalAppRunningState(lmaInstallerPackageName, false),
    })
  }

  if (!appSwitcherUi) {
    // remove the settings, gallery, and simulator apps:
    miniApps = miniApps.filter(
      (app) =>
        app.packageName !== settingsPackageName &&
        app.packageName !== galleryPackageName &&
        app.packageName !== simulatedPackageName &&
        app.packageName !== mirrorPackageName,
    )
  }

  // check the storage for the running state of the applets and update them:
  for (const mapp of miniApps) {
    let runningRes = await storage.load(`${mapp.packageName}_running`)
    if (runningRes.is_ok() && runningRes.value) {
      mapp.running = true
    }
    // let screenshotRes = await storage.load<string>(`${mapp.packageName}_screenshot`)
    // if (screenshotRes.is_ok() && screenshotRes.value) {
    //   mapp.screenshot = screenshotRes.value
    // }
  }
  return miniApps as ClientAppletInterface[]
}

const startStopOfflineApplet = (applet: ClientAppletInterface, status: boolean): AsyncResult<void, Error> => {
  // await useSettingsStore.getState().setSetting(packageName, status)
  return Res.try_async(async () => {
    let packageName = applet.packageName

    let appSwitcherUi = useSettingsStore.getState().getSetting(SETTINGS.app_switcher_ui.key)
    if (packageName === storePackageName && !appSwitcherUi) {
      push("/store")
      return
    }

    if (!status && applet.onStop) {
      const result = await applet.onStop()
      if (result.is_error()) {
        console.error(`APPLET: Failed to stop applet onStop() for ${applet.packageName}: ${result.error}`)
        return
      }
    }

    if (status && applet.onStart) {
      const result = await applet.onStart()
      if (result.is_error()) {
        console.error(`APPLET: Failed to start applet onStart() for ${applet.packageName}: ${result.error}`)
        return
      }
    }

    // // Captions app special handling
    // if (packageName === captionsPackageName) {
    //   console.log(`APPLET: Captions app ${status ? "started" : "stopped"}`)
    //   await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, status)
    // }

    // // Camera app special handling - track running state separately from gallery_mode
    // if (packageName === cameraPackageName) {
    //   console.log(`APPLET: Camera app ${status ? "started" : "stopped"}`)
    //   await useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, status)
    //   // Note: GalleryModeSync will detect this change and update gallery_mode accordingly
    // }
  })
}

let refreshTimeout: ReturnType<typeof BackgroundTimer.setTimeout> | null = null
// actually turn on or off an applet:
const startStopApplet = (applet: ClientAppletInterface, status: boolean): AsyncResult<void, Error> => {
  // Offline apps don't need to wait for server confirmation
  if (applet.offline) {
    return startStopOfflineApplet(applet, status)
  }

  if (applet.local) {
    // return composer.startStop(applet, status)
    return startStopOfflineApplet(applet, status)
  }

  // TODO: not the best way to handle this, but it works reliably:
  // For online apps, schedule a refresh to confirm the state from the server
  if (refreshTimeout) {
    BackgroundTimer.clearTimeout(refreshTimeout)
    refreshTimeout = null
  }
  refreshTimeout = BackgroundTimer.setTimeout(() => {
    useAppletStatusStore.getState().refreshApplets()
  }, 2000)

  if (status) {
    return restComms.startApp(applet.packageName)
  } else {
    return restComms.stopApp(applet.packageName)
  }
}

export const useAppletStatusStore = create<AppStatusState>((set, get) => ({
  apps: [],

  refreshApplets: async () => {
    console.log(`APPLETS: refreshApplets()`)
    // cancel any pending refresh timeouts:
    if (refreshTimeout) {
      BackgroundTimer.clearTimeout(refreshTimeout)
      refreshTimeout = null
    }

    let onlineApps: ClientAppletInterface[] = []
    // let res = await restComms.getApplets()
    let res = await restComms.retry(() => restComms.getApplets(), 3, 1000)
    if (res.is_error()) {
      console.error(`APPLETS: Failed to get applets: ${res.error}`)
      // continue anyway in case we're just offline:
      Sentry.captureException(res.error)
    } else {
      // convert to the client applet interface:
      onlineApps = res.value.map((app) => ({
        ...app,
        loading: false,
        offline: false,
        offlineRoute: "",
        local: false,
        hidden: false,
      }))
    }

    // merge in the offline apps:
    let applets: ClientAppletInterface[] = [
      ...onlineApps,
      ...(await getOfflineApplets()),
      ...(await composer.getLocalApplets()),
    ]
    const offlineMode = useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)

    // remove duplicates and keep the online versions:
    const packageNameMap = new Map<string, ClientAppletInterface>()
    applets.forEach((app) => {
      const existing = packageNameMap.get(app.packageName)
      if (!existing || offlineMode) {
        packageNameMap.set(app.packageName, app)
      }
    })
    applets = Array.from(packageNameMap.values())

    // add in any existing screenshots:
    let oldApplets = useAppletStatusStore.getState().apps
    oldApplets.forEach((app) => {
      if (app.screenshot) {
        for (const applet of applets) {
          if (applet.packageName === app.packageName) {
            applet.screenshot = app.screenshot
          }
        }
      }
    })

    // add in the compatibility info:
    let defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    let capabilities = getModelCapabilities(defaultWearable || DeviceTypes.NONE)

    for (const applet of applets) {
      // console.log(`APPLETS: ${applet.packageName} ${JSON.stringify(applet.hardwareRequirements)}`)
      let result = HardwareCompatibility.checkCompatibility(applet.hardwareRequirements, capabilities)
      applet.compatibility = result
    }

    for (const applet of applets) {
      applet.hidden = getHiddenStatus(applet.packageName)
    }

    set({apps: applets})
  },

  startApplet: async (packageName: string) => {
    let allApps = [...get().apps]
    const applet = allApps.find((a) => a.packageName === packageName)

    if (!applet) {
      console.error(`Applet not found for package name: ${packageName}`)
      return
    }

    // do nothing if any applet is currently loading:
    if (get().apps.some((a) => a.loading)) {
      console.log(`APPLETS: Skipping start applet ${packageName} because another applet is currently loading`)
      return
    }

    // Handle foreground apps - only one can run at a time
    if (applet.type === "standard") {
      const runningForegroundApps = get().apps.filter(
        (app) => app.running && app.type === "standard" && app.packageName !== packageName,
      )

      console.log(`Found ${runningForegroundApps.length} running foreground apps to stop`)

      // Stop all other running foreground apps (both online and offline)
      for (const runningApp of runningForegroundApps) {
        console.log(`Stopping foreground app: ${runningApp.name} (${runningApp.packageName})`)

        startStopApplet(runningApp, false)
      }
    }

    // offline apps should not need to load:
    let shouldLoad = !applet.offline && !applet.local

    // Start the new app
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, running: true, loading: shouldLoad} : a)),
    }))

    const result = await startStopApplet(applet, true)
    if (result.is_error()) {
      console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
      set((state) => ({
        apps: state.apps.map((a) => (a.packageName === packageName ? {...a, running: false, loading: false} : a)),
      }))
      return
    }

    // open the app webview if it has one:
    let appSwitcherUi = useSettingsStore.getState().getSetting(SETTINGS.app_switcher_ui.key)
    if (appSwitcherUi) {
      // only open if the current route is home:
      const currentRoute = getCurrentRoute()
      if (currentRoute === "/home") {
        setLastOpenTime(applet.packageName)
        if (applet.offline) {
          const offlineRoute = applet.offlineRoute
          if (offlineRoute) {
            push(offlineRoute, {transition: "fade"})
          }
        }

        // Check if app has webviewURL and navigate directly to it
        if (applet.webviewUrl && applet.healthy) {
          push("/applet/webview", {
            webviewURL: applet.webviewUrl,
            appName: applet.name,
            packageName: applet.packageName,
            transition: "fade",
          })
        }

        if (applet.local) {
          console.log("APPLETS: Pushing local applet", applet.packageName, applet.version, applet.name)
          push("/applet/local", {
            packageName: applet.packageName,
            version: applet.version,
            appName: applet.name,
            transition: "fade",
          })
        }
      }
    }

    await useSettingsStore.getState().setSetting(SETTINGS.has_ever_activated_app.key, true)
  },

  stopApplet: async (packageName: string) => {
    const applet = get().apps.find((a) => a.packageName === packageName)
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

  uninstallApplet: async (packageName: string) => {
    const applet = get().apps.find((a) => a.packageName === packageName)
    if (!applet) {
      console.error(`Applet with package name ${packageName} not found`)
      return
    }

    if (applet.running) {
      await startStopApplet(applet, false)
    }
    await restComms.uninstallApp(packageName)
    set((state) => ({
      apps: state.apps.filter((a) => a.packageName !== packageName),
    }))
  },

  setHiddenStatus: (packageName: string, status: boolean) => {
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, hidden: status} : a)),
    }))
    storage.save(`${packageName}_hidden`, status)
  },

  stopAllApplets: (): AsyncResult<void, Error> => {
    return Res.try_async(async () => {
      const runningApps = get().apps.filter((app) => app.running)

      for (const app of runningApps) {
        await get().stopApplet(app.packageName)
      }
    })
  },

  saveScreenshot: async (packageName: string, screenshot: string) => {
    // await storage.save(`${packageName}_screenshot`, screenshot)
    set((state) => ({
      apps: state.apps.map((a) => (a.packageName === packageName ? {...a, screenshot} : a)),
    }))
  },

  setInstalledLmas: (installedLmas: ClientAppletInterface[]) => {
    // set({localMiniApps: installedLmas})
  },
}))

export const useApplets = () => useAppletStatusStore((state) => state.apps)
export const useStartApplet = () => useAppletStatusStore((state) => state.startApplet)
export const useStopApplet = () => useAppletStatusStore((state) => state.stopApplet)
export const useRefreshApplets = () => useAppletStatusStore((state) => state.refreshApplets)
export const useStopAllApplets = () => useAppletStatusStore((state) => state.stopAllApplets)
export const useInactiveForegroundApps = () => {
  const apps = useApplets()
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    if (isOffline) {
      return apps.filter((app) => (app.type === "standard" || app.type === "background") && !app.running && app.offline)
    }
    return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && !app.running)
  }, [apps, isOffline])
}
export const useForegroundApps = () => {
  const apps = useApplets()
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    if (isOffline) {
      return apps.filter((app) => (app.type === "standard" || app.type === "background" || !app.type) && app.offline)
    }
    return apps.filter((app) => app.type === "standard" || app.type === "background" || !app.type)
  }, [apps, isOffline])
}

export const useActiveApps = () => {
  const apps = useApplets()
  return useMemo(() => apps.filter((app) => app.running), [apps])
}

export const useActiveBackgroundApps = () => {
  const apps = useApplets()
  return useMemo(() => apps.filter((app) => app.type === "background" && app.running), [apps])
}

export const useBackgroundApps = () => {
  const apps = useApplets()
  return useMemo(
    () => ({
      active: apps.filter((app) => app.type === "background" && app.running),
      inactive: apps.filter((app) => app.type === "background" && !app.running),
    }),
    [apps],
  )
}

export const useActiveForegroundApp = () => {
  const apps = useApplets()
  return useMemo(() => apps.find((app) => (app.type === "standard" || !app.type) && app.running) || null, [apps])
}

export const useActiveBackgroundAppsCount = () => {
  const apps = useApplets()
  return useMemo(() => apps.filter((app) => app.type === "background" && app.running).length, [apps])
}

export const useIncompatibleApps = () => {
  const apps = useApplets()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  return useMemo(() => {
    // if no default wearable, return all apps:
    if (!defaultWearable) {
      return apps
    }
    // otherwise, return only incompatible apps:
    return apps.filter((app) => !app.compatibility?.isCompatible)
  }, [apps, defaultWearable])
}

export const useLocalMiniApps = () => {
  return useAppletStatusStore.getState().apps.filter((app) => app.local)
}

export const useActiveAppPackageNames = () =>
  useAppletStatusStore(useShallow((state) => state.apps.filter((app) => app.running).map((a) => a.packageName)))

// export const useIncompatibleApps = async () => {
//   const apps = useApplets()
//   const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)

//   const capabilities: Capabilities | null = await getCapabilitiesForModel(defaultWearable)
//   if (!capabilities) {
//     console.error("Failed to fetch capabilities")
//     return []
//   }

//   return useMemo(() => {
//     return apps.filter((app) => {
//       let result = HardwareCompatibility.checkCompatibility(app.hardwareRequirements, capabilities)
//       return !result.isCompatible
//     })
//   }, [apps])
// }

// export const useFilteredApps = async () => {
//   const apps = useApplets()
//   const defaultWearable = await useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)

//   const capabilities: Capabilities | null = getCapabilitiesForModel(defaultWearable)
//   if (!capabilities) {
//     console.error("Failed to fetch capabilities")
//     throw new Error("Failed to fetch capabilities")
//   }

//   return useMemo(() => {
//     return {

//     })
//   }, [apps])
// }
