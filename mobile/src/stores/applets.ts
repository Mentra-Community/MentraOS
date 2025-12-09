import {
  AppletInterface,
  getModelCapabilities,
  HardwareRequirementLevel,
  HardwareType,
} from "@/../../cloud/packages/types/src"
import {useMemo} from "react"
import {AsyncResult, result as Res} from "typesafe-ts"
import {create} from "zustand"

import {push} from "@/contexts/NavigationRef"
import {translate} from "@/i18n"
import restComms from "@/services/RestComms"
import STTModelManager from "@/services/STTModelManager"
import {SETTINGS, useSetting, useSettingsStore} from "@/stores/settings"
import showAlert from "@/utils/AlertUtils"
import {CompatibilityResult, HardwareCompatibility} from "@/utils/hardware"

export interface ClientAppletInterface extends AppletInterface {
  offline: boolean
  offlineRoute: string
  compatibility?: CompatibilityResult
  loading: boolean
  onStart?: () => AsyncResult<void, Error>
}

interface AppStatusState {
  apps: ClientAppletInterface[]
  refreshApplets: () => Promise<void>
  startApplet: (packageName: string, appType?: string) => Promise<void>
  stopApplet: (packageName: string) => Promise<void>
  stopAllApplets: () => AsyncResult<void, Error>
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
}

/**
 * Offline Apps Configuration
 *
 * These are local React Native apps that don't require webviews or server communication.
 * They navigate directly to specific React Native routes when activated.
 */

export const cameraPackageName = "com.mentra.camera"
export const captionsPackageName = "com.augmentos.livecaptions"

// get offline applets:
export const getOfflineApplets = async (): Promise<ClientAppletInterface[]> => {
  const offlineCameraRunning = await useSettingsStore.getState().getSetting(SETTINGS.gallery_mode.key)
  const offlineCaptionsRunning = await useSettingsStore.getState().getSetting(SETTINGS.offline_captions_running.key)
  return [
    {
      packageName: cameraPackageName,
      name: "Camera",
      type: "standard", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      logoUrl: require("@assets/applet-icons/camera.png"),
      // description: "Capture photos and videos with your Mentra glasses.",
      webviewUrl: "",
      // version: "0.0.1",
      permissions: [],
      offlineRoute: "/asg/gallery",
      running: offlineCameraRunning,
      loading: false,
      healthy: true,
      hardwareRequirements: [{type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED}],
    },
    {
      packageName: captionsPackageName,
      name: "Live Captions",
      type: "standard", // Foreground app (only one at a time)
      offline: true, // Works without internet connection
      // logoUrl: getCaptionsIcon(isDark),
      logoUrl: require("@assets/applet-icons/captions.png"),
      // description: "Live captions for your mentra glasses.",
      webviewUrl: "",
      healthy: true,
      permissions: [],
      offlineRoute: "",
      running: offlineCaptionsRunning,
      loading: false,
      hardwareRequirements: [{type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED}],
      onStart: (): AsyncResult<void, Error> => {
        return Res.try_async(async () => {
          const modelAvailable = await STTModelManager.isModelAvailable()
          if (modelAvailable) {
            return undefined
          }

          showAlert(
            translate("transcription:noModelInstalled"),
            translate("transcription:noModelInstalledMessage"),
            [
              {text: translate("common:cancel"), style: "cancel"},
              {
                text: translate("transcription:goToSettings"),
                onPress: () => {
                  push("/settings/transcription")
                },
              },
            ],
            {iconName: "alert-circle-outline"},
          )

          throw new Error("No model available")
        })
      },
    },
  ]
}

export const getMoreAppsApplet = (): ClientAppletInterface => {
  return {
    packageName: "com.mentra.store",
    name: "Get more apps",
    offlineRoute: "/store",
    webviewUrl: "",
    healthy: true,
    permissions: [],
    offline: true,
    running: false,
    loading: false,
    hardwareRequirements: [],
    type: "standard",
    logoUrl: require("@assets/applet-icons/store.png"),
  }
}

const startStopOfflineApplet = (packageName: string, status: boolean): AsyncResult<void, Error> => {
  // await useSettingsStore.getState().setSetting(packageName, status)
  return Res.try_async(async () => {
    // Captions app special handling
    if (packageName === captionsPackageName) {
      console.log(`APPLET: Captions app ${status ? "started" : "stopped"}`)
      await useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, status)
    }

    // Camera app special handling - send gallery mode to glasses
    if (packageName === cameraPackageName) {
      console.log(`APPLET: Camera app ${status ? "started" : "stopped"}`)
      await useSettingsStore.getState().setSetting(SETTINGS.gallery_mode.key, status)
    }
  })
}

let refreshTimeout: ReturnType<typeof setTimeout> | null = null
// actually turn on or off an applet:
const startStopApplet = (applet: ClientAppletInterface, status: boolean): AsyncResult<void, Error> => {
  // TODO: not the best way to handle this, but it works reliably:
  if (refreshTimeout) {
    clearTimeout(refreshTimeout)
    refreshTimeout = null
  }
  refreshTimeout = setTimeout(() => {
    useAppletStatusStore.getState().refreshApplets()
  }, 2000)

  if (applet.offline) {
    return startStopOfflineApplet(applet.packageName, status)
  }

  if (status) {
    return restComms.startApp(applet.packageName)
  } else {
    return restComms.stopApp(applet.packageName)
  }
}

export const useAppletStatusStore = create<AppStatusState>((set, get) => ({
  apps: [],

  refreshApplets: async () => {
    let res = await restComms.getApplets()
    if (res.is_error()) {
      console.error(`Failed to get applets: ${res.error}`)
      return
    }
    const appsData = res.value

    const onlineApps: ClientAppletInterface[] = appsData.map(app => ({
      ...app,
      loading: false,
      offline: false,
      offlineRoute: "",
    }))

    // merge in the offline apps:
    let applets: ClientAppletInterface[] = [...onlineApps, ...(await getOfflineApplets())]
    const offlineMode = useSettingsStore.getState().getSetting(SETTINGS.offline_mode.key)

    // remove duplicates and keep the online versions:
    const packageNameMap = new Map<string, ClientAppletInterface>()
    applets.forEach(app => {
      const existing = packageNameMap.get(app.packageName)
      if (!existing || offlineMode) {
        packageNameMap.set(app.packageName, app)
      }
    })
    applets = Array.from(packageNameMap.values())

    // add in the compatibility info:
    let defaultWearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key)
    let capabilities = getModelCapabilities(defaultWearable)

    for (const applet of applets) {
      let result = HardwareCompatibility.checkCompatibility(applet.hardwareRequirements, capabilities)
      applet.compatibility = result
    }

    set({apps: applets})
  },

  startApplet: async (packageName: string) => {
    let allApps = [...get().apps, getMoreAppsApplet()]
    const applet = allApps.find(a => a.packageName === packageName)

    if (!applet) {
      console.error(`Applet not found for package name: ${packageName}`)
      return
    }

    // do nothing if any applet is currently loading:
    if (get().apps.some(a => a.loading)) {
      console.log(`APPLET: Skipping start applet ${packageName} because another applet is currently loading`)
      return
    }

    if (applet.offline && applet.onStart) {
      const result = await applet.onStart()
      if (result.is_error()) {
        console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
        return
      }
    }

    // Handle foreground apps - only one can run at a time
    if (applet.type === "standard") {
      const runningForegroundApps = get().apps.filter(
        app => app.running && app.type === "standard" && app.packageName !== packageName,
      )

      console.log(`Found ${runningForegroundApps.length} running foreground apps to stop`)

      // Stop all other running foreground apps (both online and offline)
      for (const runningApp of runningForegroundApps) {
        console.log(`Stopping foreground app: ${runningApp.name} (${runningApp.packageName})`)

        startStopApplet(runningApp, false)
      }
    }

    // Start the new app
    set(state => ({
      apps: state.apps.map(a => (a.packageName === packageName ? {...a, running: true, loading: true} : a)),
    }))

    const result = await startStopApplet(applet, true)
    if (result.is_error()) {
      console.error(`Failed to start applet ${applet.packageName}: ${result.error}`)
      set(state => ({
        apps: state.apps.map(a => (a.packageName === packageName ? {...a, running: false, loading: false} : a)),
      }))
      return
    }

    await useSettingsStore.getState().setSetting(SETTINGS.has_ever_activated_app.key, true)
  },

  stopApplet: async (packageName: string) => {
    const applet = get().apps.find(a => a.packageName === packageName)
    if (!applet) {
      console.error(`Applet with package name ${packageName} not found`)
      return
    }

    set(state => ({
      apps: state.apps.map(a => (a.packageName === packageName ? {...a, running: false, loading: true} : a)),
    }))

    startStopApplet(applet, false)
  },

  stopAllApplets: (): AsyncResult<void, Error> => {
    return Res.try_async(async () => {
      const runningApps = get().apps.filter(app => app.running)

      for (const app of runningApps) {
        await startStopApplet(app, false)
      }

      set({apps: get().apps.map(a => ({...a, running: false}))})
    })
  },
}))

export const useApplets = () => useAppletStatusStore(state => state.apps)
export const useStartApplet = () => useAppletStatusStore(state => state.startApplet)
export const useStopApplet = () => useAppletStatusStore(state => state.stopApplet)
export const useRefreshApplets = () => useAppletStatusStore(state => state.refreshApplets)
export const useStopAllApplets = () => useAppletStatusStore(state => state.stopAllApplets)
export const useInactiveForegroundApps = () => {
  const apps = useApplets()
  const [isOffline] = useSetting(SETTINGS.offline_mode.key)
  return useMemo(() => {
    if (isOffline) {
      return apps.filter(app => app.type === "standard" && !app.running && app.offline)
    }
    return apps.filter(app => (app.type === "standard" || !app.type) && !app.running)
  }, [apps, isOffline])
}
export const useBackgroundApps = () => {
  const apps = useApplets()
  return useMemo(
    () => ({
      active: apps.filter(app => app.type === "background" && app.running),
      inactive: apps.filter(app => app.type === "background" && !app.running),
    }),
    [apps],
  )
}

export const useActiveForegroundApp = () => {
  const apps = useApplets()
  return useMemo(() => apps.find(app => (app.type === "standard" || !app.type) && app.running) || null, [apps])
}

export const useActiveBackgroundAppsCount = () => {
  const apps = useApplets()
  return useMemo(() => apps.filter(app => app.type === "background" && app.running).length, [apps])
}

export const useIncompatibleApps = () => {
  const apps = useApplets()
  return useMemo(() => apps.filter(app => !app.compatibility?.isCompatible), [apps])
}

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
