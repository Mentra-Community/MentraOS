import {Platform} from "react-native"
import * as Sentry from "@sentry/react-native"

import BluetoothSdk from "@mentra/bluetooth-sdk-internal"
import {
  appRegistry,
  BgTimer,
  configureIsland,
  decideDevLaunchRoute,
  HardwareCompatibility,
  HardwareRequirementLevel,
  HardwareType,
  type ClientApp,
  type StartOptions,
  useAppStatusStore,
} from "@mentra/island"

import {DeviceTypes, getModelCapabilities} from "@/../../cloud/packages/types/src"
import {miniappHost} from "@/components/miniapp/MiniappHost"
import {showAlert} from "@/contexts/ModalContext"
import {useNavigationStore} from "@/stores/navigation"
import {translate} from "@/i18n"
import {submitMiniappStartFailedBugReport} from "@/services/bugReport/miniappStartBugReport"
import restComms from "@/services/RestComms"
import STTModelManager from "@/services/STTModelManager"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import {getDefaultMenuApps, type GlassesMenuItem} from "@/utils/glassesMenu"

import {
  cameraPackageName,
  captionsPackageName,
  feedbackPackageName,
  lmaInstallerPackageName,
  mirrorPackageName,
  notifyPackageName,
  settingsPackageName,
  storePackageName,
} from "@/constants/miniapps"

/**
 * MiniappCatalog
 *
 * Owns the manager-side glue between the island apps store and mobile
 * concerns: registers offline applets at boot, fetches cloud applets,
 * gates start/stop on UX rules (incompatibility alerts, captions STT
 * model availability, foreground navigation), and drives server polling
 * after start/stop. The island store calls back into this via the host
 * hooks wired in `init()`.
 */
class MiniappCatalog {
  private static _instance: MiniappCatalog | null = null
  private initialized = false

  private refreshTimeout: ReturnType<typeof BgTimer.setTimeout> | null = null
  private refreshInterval: ReturnType<typeof BgTimer.setInterval> | null = null

  static getInstance(): MiniappCatalog {
    if (!MiniappCatalog._instance) {
      MiniappCatalog._instance = new MiniappCatalog()
    }
    return MiniappCatalog._instance
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    for (const app of this.buildOfflineApps()) {
      appRegistry.installOfflineApp(app)
    }

    configureIsland({
      loadExtraApps: () => this.loadExtraApps(),
      getCapabilities: () => this.getCapabilities(),
      beforeStart: (app, opts) => this.beforeStart(app, opts),
      beforeStop: (app) => this.beforeStop(app),
      onUninstall: (app) => this.onUninstall(app),
      postProcessApps: (apps) => this.postProcessApps(apps),
    })

    // Re-evaluate compatibility when default_wearable changes — without this,
    // switching glasses leaves apps greyed out with stale compatibility.
    useSettingsStore.subscribe(
      (state) => state.getSetting(SETTINGS.default_wearable.key),
      () => {
        useAppStatusStore.getState().refresh()
      },
    )
  }

  /** Public refresh — non-React entry point used by SocketComms, deeplinks, etc. */
  refresh(): Promise<void> {
    return useAppStatusStore.getState().refresh()
  }

  /** Re-send start request and poll for state confirmation. Used by the webview error retry. */
  async retryStart(packageName: string): Promise<void> {
    if (this.refreshInterval) {
      BgTimer.clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
    this.startPolling()

    const app = useAppStatusStore.getState().apps.find((a) => a.packageName === packageName)
    const startResult = await restComms.startApp(packageName)
    if (startResult.is_error() && app) {
      console.error(`MiniappCatalog: retry start failed for ${packageName}: ${startResult.error}`)
      if (!app.isMiniappDev) {
        submitMiniappStartFailedBugReport(app, startResult.error, "retry_start")
      }
    }
  }

  // ---------------------------------------------------------------------
  // Host hooks
  // ---------------------------------------------------------------------

  private async loadExtraApps(): Promise<ClientApp[]> {
    const res = await restComms.getApplets()
    if (res.is_error()) {
      console.error(`MiniappCatalog: getApplets failed: ${res.error}`)
      Sentry.captureException(res.error)
      // Bail — keep last known cloud apps. Returning [] would flip every
      // running flag to false and cascade into "Cannot reach" error screens.
      // The island store will keep the prior snapshot for whatever isn't
      // re-emitted from local sources during refresh().
      return useAppStatusStore.getState().apps.filter((a) => !a.local && !a.offline)
    }
    return res.value.map((app) => ({
      ...app,
      loading: false,
      offline: false,
      offlineRoute: "",
      local: false,
      hidden: false,
      hardwareRequirements: [
        ...app.hardwareRequirements,
        {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
      ],
    }))
  }

  private getCapabilities() {
    const wearable = useSettingsStore.getState().getSetting(SETTINGS.default_wearable.key) || DeviceTypes.NONE
    return getModelCapabilities(wearable)
  }

  private async beforeStart(app: ClientApp, opts?: StartOptions): Promise<boolean> {
    const nav = useNavigationStore.getState()
    // 1. Compatibility gate
    if (!app.compatibility?.isCompatible) {
      const missingTypes = app.compatibility?.missingRequired?.map((req) => req.type) || []
      if (missingTypes.includes(HardwareType.EXIST)) {
        await showAlert({
          title: translate("home:glassesRequired"),
          buttons: [{text: translate("common:ok")}],
          message: translate("home:glassesRequiredMessage", {app: app.name}),
        })
        return false
      }
      const missingHardware =
        missingTypes
          .filter((t) => t !== HardwareType.EXIST)
          .map((t) => t.toLowerCase())
          .join(", ") || "required features"
      await showAlert({
        title: translate("home:hardwareIncompatible"),
        buttons: [{text: translate("common:ok")}],
        message: translate("home:hardwareIncompatibleMessage", {app: app.name, missing: missingHardware}),
      })
      return false
    }

    // 2. Captions: gate on STT model availability
    if (app.packageName === captionsPackageName) {
      const modelAvailable = await STTModelManager.isModelAvailable()
      if (!modelAvailable) {
        const result = await showAlert({
          title: translate("transcription:noModelInstalled"),
          message: translate("transcription:noModelInstalledMessage"),
          buttons: [
            {text: translate("common:cancel"), style: "cancel"},
            {text: translate("transcription:goToSettings"), style: "default"},
          ],
        })
        if (result === 1) {
          nav.push("/miniapps/settings/transcription")
        }
        return false
      }
      await BluetoothSdk.restartTranscriber()
      useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, true)
    }

    // Camera: keep the legacy setting in sync.
    if (app.packageName === cameraPackageName) {
      useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, true)
    }

    // 3. Foreground navigation (skip when caller asked to)
    if (!opts?.skipNavigation && nav.getCurrentRoute() === "/home") {
      this.navigateForApp(app)
    }

    // 4. Online apps: kick start request + polling
    if (!app.offline && !app.local) {
      this.clearPolling()
      this.startPolling()
      const startResult = await restComms.startApp(app.packageName)
      if (startResult.is_error()) {
        console.error(`MiniappCatalog: startApp failed for ${app.packageName}: ${startResult.error}`)
        if (!app.isMiniappDev) {
          submitMiniappStartFailedBugReport(app, startResult.error, "initial_start")
        }
        // Reset the loading/running stamp the store applies post-beforeStart.
        // Caller (island.start) already set running:true,loading:true; flip back.
        useAppStatusStore.setState((s) => ({
          apps: s.apps.map((a) => (a.packageName === app.packageName ? {...a, running: false, loading: false} : a)),
        }))
        return false
      }
    }

    useSettingsStore.getState().setSetting(SETTINGS.has_ever_activated_app.key, true)
    return true
  }

  private async beforeStop(app: ClientApp): Promise<void> {
    if (app.isMiniappDev) {
      miniappHost.unmount(app.packageName)
      return
    }

    if (app.packageName === cameraPackageName) {
      useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, false)
    }
    if (app.packageName === captionsPackageName) {
      useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, false)
    }

    if (!app.offline && !app.local) {
      this.clearPolling()
      this.refreshTimeout = BgTimer.setTimeout(() => {
        this.refresh()
      }, 2000)
      restComms.stopApp(app.packageName)
    }
  }

  private async onUninstall(app: ClientApp): Promise<void> {
    if (app.isMiniappDev) return // appRegistry handles dev miniapps locally
    if (app.local) return // local non-dev miniapps don't have a cloud entry
    if (app.offline) return
    const res = await restComms.uninstallApp(app.packageName)
    if (res.is_error()) {
      console.error(`MiniappCatalog: cloud uninstall failed for ${app.packageName}: ${res.error}`)
      throw res.error
    }
  }

  private async postProcessApps(apps: ClientApp[]): Promise<ClientApp[]> {
    let out = apps
    // Notify is not supported on iOS yet — drop entirely.
    if (Platform.OS === "ios") {
      out = out.filter((a) => a.packageName !== notifyPackageName)
    } else {
      // Android: route notify to the in-app notification settings instead of a webview.
      for (const a of out) {
        if (a.packageName === notifyPackageName) {
          a.offlineRoute = "/miniapps/settings/notifications"
        }
      }
    }

    // menu_apps: persist projected list for the native dashboard.
    let menuItems = useSettingsStore.getState().getSetting(SETTINGS.menu_apps.key) as GlassesMenuItem[] | undefined
    if (!menuItems) {
      menuItems = await getDefaultMenuApps(out)
    }
    const itemsForNative = menuItems.map((item) => {
      const a = out.find((x) => x.packageName === item.packageName)
      return {name: item.name, packageName: item.packageName, running: a?.running ?? false}
    })
    // only set the menu_apps if the list of packageNames or the status of running apps changed:
    const changed =
      menuItems.length !== itemsForNative.length ||
      itemsForNative.some((item, i) => {
        const old = menuItems![i]
        return old.packageName !== item.packageName || (old.running ?? false) !== item.running
      })
    if (changed) {
      useSettingsStore.getState().setSetting(SETTINGS.menu_apps.key, itemsForNative)
    }

    return out
  }

  // ---------------------------------------------------------------------
  // Polling helpers
  // ---------------------------------------------------------------------

  private clearPolling(): void {
    if (this.refreshTimeout) {
      BgTimer.clearTimeout(this.refreshTimeout)
      this.refreshTimeout = null
    }
    if (this.refreshInterval) {
      BgTimer.clearInterval(this.refreshInterval)
      this.refreshInterval = null
    }
  }

  private startPolling(): void {
    let pollCount = 0
    const MAX_POLLS = 6
    this.refreshInterval = BgTimer.setInterval(() => {
      pollCount++
      this.refresh()
      if (pollCount >= MAX_POLLS && this.refreshInterval) {
        BgTimer.clearInterval(this.refreshInterval)
        this.refreshInterval = null
      }
    }, 1000)
  }

  // ---------------------------------------------------------------------
  // Foreground navigation
  // ---------------------------------------------------------------------

  private navigateForApp(app: ClientApp): void {
    console.log("MiniappCatalog: navigateForApp()", app.packageName)
    const nav = useNavigationStore.getState()
    // const appOpenTransition = "zoom"
    const appOpenTransition = "fade"
    if (app.offlineRoute) {
      nav.push(app.offlineRoute, {transition: appOpenTransition})
      return
    }
    if (app.offline) return // offline app without a route — nothing to navigate to
    if (app.isMiniappDev && app.devUrl) {
      // Dev miniapps don't push a route. The Compositor (running as an effect)
      // sees foreground=true and mounts/foregrounds the webview over /home.
      // Reachability check still routes to the offline screen if the dev
      // server isn't responding.
      const {packageName, devUrl, name: appName, logoUrl} = app
      decideDevLaunchRoute(packageName, devUrl).then((result) => {
        if (result.decision === "live") {
          useAppStatusStore.getState().setForeground(packageName)
        } else {
          nav.push("/applet/dev-offline", {packageName, name: appName, iconUrl: logoUrl})
        }
      })
      return
    }
    if (app.local) {
      // Local miniapps: no route push. Compositor renders the foregrounded
      // app over /home; swipe-to-back clears foreground but keeps it running.
      useAppStatusStore.getState().setForeground(app.packageName)
      return
    }
    if (app.webviewUrl && app.healthy) {
      nav.push("/applet/webview", {
        webviewURL: app.webviewUrl,
        appName: app.name,
        packageName: app.packageName,
        transition: appOpenTransition,
      })
      return
    }
    nav.push("/applet/settings", {
      packageName: app.packageName,
      appName: app.name,
      transition: appOpenTransition,
    })
  }

  // ---------------------------------------------------------------------
  // Offline app catalog
  // ---------------------------------------------------------------------

  private buildOfflineApps(): ClientApp[] {
    const apps: ClientApp[] = [
      {
        packageName: cameraPackageName,
        name: translate("miniApps:camera"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/camera.png"),
        webviewUrl: "",
        permissions: [],
        offlineRoute: "/asg/gallery",
        local: false,
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        hardwareRequirements: [
          {type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: captionsPackageName,
        name: translate("miniApps:offlineCaptions"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/captions.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "",
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: notifyPackageName,
        name: translate("miniApps:notify"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/notification.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "",
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      },
      {
        packageName: settingsPackageName,
        name: translate("miniApps:settings"),
        type: "background",
        offline: true,
        logoUrl: require("@assets/applet-icons/settings.png"),
        local: false,
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "/miniapps/settings/main",
        webviewUrl: "",
        hardwareRequirements: [],
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
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
        type: "background",
        logoUrl: require("@assets/applet-icons/mirror.png"),
        local: false,
      },
      {
        packageName: feedbackPackageName,
        name: translate("miniApps:feedback"),
        type: "background",
        offline: true,
        logoUrl: require("@assets/applet-icons/feedback.png"),
        offlineRoute: "/miniapps/settings/feedback",
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [],
      },
    ]

    if (useSettingsStore.getState().getSetting(SETTINGS.super_mode.key)) {
      apps.push({
        packageName: lmaInstallerPackageName,
        name: translate("miniApps:lmaInstaller"),
        type: "standard",
        offline: true,
        offlineRoute: "/miniapps/miniappdev/main",
        local: false,
        webviewUrl: "",
        permissions: [],
        running: false,
        loading: false,
        healthy: true,
        hidden: false,
        hardwareRequirements: [],
        logoUrl: require("@assets/applet-icons/store.png"),
      })
    }

    return apps
  }
}

const miniappCatalog = MiniappCatalog.getInstance()
export default miniappCatalog
