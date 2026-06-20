import {createElement} from "react"
import {Platform} from "react-native"

import {
  appRegistry,
  HardwareRequirementLevel,
  HardwareType,
  toolkit,
  type ClientApp,
  useAppStatusStore,
} from "@mentra/island"

import {DevToolsIcon} from "@/components/miniapps/DevIcons"
import {translate} from "@/i18n"
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
 * Registers the Mentra app's built-in/offline miniapps.
 *
 * The cloud-v1 app catalog has been removed from the runtime app list. This
 * service intentionally does not fetch cloud applets or send v1 start/stop
 * requests; it only installs local built-ins and keeps the glasses menu setting
 * projected from the island app store.
 */
class BuiltInMiniappCatalog {
  private static instance: BuiltInMiniappCatalog | null = null
  private initialized = false
  private syncInFlight = false
  private syncPending = false

  static getInstance(): BuiltInMiniappCatalog {
    if (!BuiltInMiniappCatalog.instance) {
      BuiltInMiniappCatalog.instance = new BuiltInMiniappCatalog()
    }
    return BuiltInMiniappCatalog.instance
  }

  init(): void {
    if (this.initialized) return
    this.initialized = true

    for (const app of this.buildOfflineApps()) {
      appRegistry.installOfflineApp(app)
    }

    useAppStatusStore.subscribe(() => {
      void this.syncGlassesMenuApps()
    })

    void this.syncGlassesMenuApps()
  }

  private async syncGlassesMenuApps(): Promise<void> {
    if (this.syncInFlight) {
      this.syncPending = true
      return
    }
    this.syncInFlight = true
    try {
      const settingsStore = useSettingsStore.getState()
      const apps = useAppStatusStore.getState().apps
      let menuItems = settingsStore.getSetting(SETTINGS.menu_apps.key) as GlassesMenuItem[] | undefined
      if (!menuItems) {
        menuItems = await getDefaultMenuApps(apps)
      }

      const itemsForNative = menuItems.map((item) => {
        const app = apps.find((candidate) => candidate.packageName === item.packageName)
        return {name: item.name, packageName: item.packageName, running: app?.running ?? false}
      })

      const changed =
        menuItems.length !== itemsForNative.length ||
        itemsForNative.some((item, index) => {
          const old = menuItems![index]
          return old.packageName !== item.packageName || (old.running ?? false) !== item.running
        })

      if (changed) {
        settingsStore.setSetting(SETTINGS.menu_apps.key, itemsForNative)
      }
    } finally {
      this.syncInFlight = false
      if (this.syncPending) {
        this.syncPending = false
        void this.syncGlassesMenuApps()
      }
    }
  }

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
        onStart: () => {
          useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, true)
        },
        onStop: () => {
          useSettingsStore.getState().setSetting(SETTINGS.offline_camera_running.key, false)
        },
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
        onStart: () => {
          void toolkit.speech.restartTranscriber()
          useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, true)
        },
        onStop: () => {
          useSettingsStore.getState().setSetting(SETTINGS.offline_captions_running.key, false)
        },
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

    if (Platform.OS !== "ios") {
      apps.push({
        packageName: notifyPackageName,
        name: translate("miniApps:notify"),
        type: "standard",
        offline: true,
        logoUrl: require("@assets/applet-icons/notification.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        permissions: [],
        offlineRoute: "/miniapps/settings/notifications",
        running: false,
        loading: false,
        local: false,
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.REQUIRED},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      })
    }

    if (
      useSettingsStore.getState().getSetting(SETTINGS.miniapp_dev_mode.key) ||
      useSettingsStore.getState().getSetting(SETTINGS.debug_mode.key)
    ) {
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
        iconComponent: createElement(DevToolsIcon),
      })
    }

    return apps
  }
}

const builtInMiniappCatalog = BuiltInMiniappCatalog.getInstance()
export default builtInMiniappCatalog
