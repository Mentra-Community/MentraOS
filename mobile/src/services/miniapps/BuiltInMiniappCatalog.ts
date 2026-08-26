import {createElement} from "react"
import {Platform} from "react-native"

import {
  decideDevLaunchRoute,
  HardwareRequirementLevel,
  HardwareType,
  SETTINGS,
  engine,
  type ClientApp,
} from "@mentra/engine"
import {appRegistry, installAppStoreHooks} from "@mentra/engine-host-internal"

import {DevIcon} from "@/components/miniapps/DevIcons"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {getDefaultMenuApps, type GlassesMenuItem} from "@/utils/glassesMenu"

import {
  cameraPackageName,
  CHINA_HIDDEN_APPS,
  feedbackPackageName,
  isChinaBuild,
  miniappDeveloperPackageName,
  mirrorPackageName,
  notifyPackageName,
  settingsPackageName,
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

    installAppStoreHooks({
      onIncompatibleBlocked: (app) => this.showIncompatibleAlert(app),
      onOpenRequested: (app, opts) => {
        const nav = useNavigationStore.getState()
        if (!opts?.skipNavigation && nav.getCurrentRoute() === "/home") {
          this.navigateForApp(app)
        }
      },
    })

    engine.miniapps.onChanged(() => {
      void this.syncGlassesMenuApps()
    })

    engine.settings.onChanged<boolean>(SETTINGS.miniapp_dev_mode.key, (showOnHomeScreen) => {
      appRegistry.setOfflineAppHidden(miniappDeveloperPackageName, !showOnHomeScreen)
    })

    void this.syncGlassesMenuApps()
  }

  /** Branded incompatible-launch alert (island already blocked the start). */
  private showIncompatibleAlert(app: ClientApp): void {
    const missingTypes = app.compatibility?.missingRequired?.map((req) => req.type) || []
    if (missingTypes.includes(HardwareType.EXIST)) {
      void showAlert({
        title: translate("home:glassesRequired"),
        buttons: [{text: translate("common:ok")}],
        message: translate("home:glassesRequiredMessage", {app: app.name}),
      })
      return
    }

    const missingHardware =
      missingTypes
        .filter((type) => type !== HardwareType.EXIST)
        .map((type) => type.toLowerCase())
        .join(", ") || "required features"
    void showAlert({
      title: translate("home:hardwareIncompatible"),
      buttons: [{text: translate("common:ok")}],
      message: translate("home:hardwareIncompatibleMessage", {app: app.name, missing: missingHardware}),
    })
  }

  private navigateForApp(app: ClientApp): void {
    const nav = useNavigationStore.getState()
    const appOpenTransition = "fade"

    if (app.offlineRoute) {
      if (isOfflineHosted(app.packageName)) {
        engine.miniapps.setForeground(app.packageName)
        return
      }
      nav.push(app.offlineRoute, {transition: appOpenTransition})
      return
    }

    if (app.offline) return

    if (app.isMiniappDev && app.devUrl) {
      const {packageName, devUrl, name: appName, logoUrl} = app
      decideDevLaunchRoute(packageName, devUrl).then((result) => {
        if (result.decision === "live") {
          engine.miniapps.setForeground(packageName)
        } else {
          nav.push("/applet/dev-offline", {packageName, name: appName, iconUrl: logoUrl})
        }
      })
      return
    }

    if (app.local) {
      engine.miniapps.setForeground(app.packageName)
    }
  }

  private async syncGlassesMenuApps(): Promise<void> {
    if (this.syncInFlight) {
      this.syncPending = true
      return
    }
    this.syncInFlight = true
    try {
      const apps = engine.miniapps.list()
      let menuItems = engine.settings.get(SETTINGS.menu_apps.key) as GlassesMenuItem[] | undefined
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
        engine.settings.set(SETTINGS.menu_apps.key, itemsForNative)
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
          engine.settings.set(SETTINGS.offline_camera_running.key, true)
        },
        onStop: () => {
          engine.settings.set(SETTINGS.offline_camera_running.key, false)
        },
        hardwareRequirements: [
          {type: HardwareType.CAMERA, level: HardwareRequirementLevel.REQUIRED},
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
        // Notifications is a persistent system helper, not the foreground
        // miniapp. Starting its settings UI must not stop Captions (or any
        // other running standard miniapp).
        type: "background",
        offline: true,
        logoUrl: require("@assets/applet-icons/notification.png"),
        webviewUrl: "",
        healthy: true,
        hidden: false,
        // The home-screen launcher uses manifest permissions to request the
        // Android NotificationListenerService grant before opening this UI.
        permissions: [{type: "READ_NOTIFICATIONS", required: true}],
        offlineRoute: "/miniapps/settings/notifications",
        running: false,
        loading: false,
        local: false,
        // A display is the nicest way to surface a notification, not the only
        // one: camera-only glasses (Mentra Live) speak it instead. Requiring
        // DISPLAY greyed the app out entirely there, so notifications could not
        // even be captured or stored on those glasses (OS-1821).
        hardwareRequirements: [
          {type: HardwareType.DISPLAY, level: HardwareRequirementLevel.OPTIONAL},
          {type: HardwareType.EXIST, level: HardwareRequirementLevel.REQUIRED},
        ],
      })
    }

    apps.push({
      packageName: miniappDeveloperPackageName,
      name: translate("miniApps:lmaLoader"),
      type: "standard",
      offline: true,
      offlineRoute: "/miniapps/settings/miniapp-dev",
      local: false,
      webviewUrl: "",
      permissions: [],
      running: false,
      loading: false,
      healthy: true,
      hidden: !engine.settings.get(SETTINGS.miniapp_dev_mode.key),
      hardwareRequirements: [],
      logoUrl: require("@assets/applet-icons/store.png"),
      iconComponent: createElement(DevIcon),
    })

    return isChinaBuild() ? apps.filter((app) => !CHINA_HIDDEN_APPS.includes(app.packageName)) : apps
  }
}

const builtInMiniappCatalog = BuiltInMiniappCatalog.getInstance()
export default builtInMiniappCatalog
