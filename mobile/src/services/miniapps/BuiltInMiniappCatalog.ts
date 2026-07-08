import {createElement} from "react"
import {Platform} from "react-native"

import {
  decideDevLaunchRoute,
  HardwareRequirementLevel,
  HardwareType,
  toolkit,
  type ClientApp,
  type StartOptions,
} from "@mentra/island"
import {appRegistry, installAppStoreHooks, useAppStatusStore} from "@mentra/island/internal"

import {DevIcon} from "@/components/miniapps/DevIcons"
import {isOfflineHosted} from "@/components/miniapp/offlineHostedPackages"
import {showAlert} from "@/contexts/ModalContext"
import {translate} from "@/i18n"
import {useNavigationStore} from "@/stores/navigation"
import {SETTINGS} from "@mentra/island"
import {getDefaultMenuApps, type GlassesMenuItem} from "@/utils/glassesMenu"
import {markMiniappDevMode} from "@/utils/miniappDevMode"

import {
  cameraPackageName,
  captionsPackageName,
  CHINA_HIDDEN_APPS,
  feedbackPackageName,
  isChinaBuild,
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
      // Captions cannot start without the on-device STT model; island gates
      // start() on this flag and calls onMissingSpeechModel when it blocks.
      appRegistry.installOfflineApp(app, {requiresLocalSttModel: app.packageName === captionsPackageName})
    }

    installAppStoreHooks({
      onIncompatibleBlocked: (app) => this.showIncompatibleAlert(app),
      onMissingSpeechModel: (app) => void this.showMissingSpeechModelAlert(app),
      onOpenRequested: (app, opts) => {
        const nav = useNavigationStore.getState()
        if (!opts?.skipNavigation && nav.getCurrentRoute() === "/home") {
          this.navigateForApp(app)
        }
      },
    })

    useAppStatusStore.subscribe(() => {
      void this.syncGlassesMenuApps()
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

  /** Missing on-device STT model alert + optional settings navigation (island already blocked). */
  private async showMissingSpeechModelAlert(_app: ClientApp): Promise<void> {
    const result = await showAlert({
      title: translate("transcription:noModelInstalled"),
      message: translate("transcription:noModelInstalledMessage"),
      buttons: [
        {text: translate("common:cancel"), style: "cancel"},
        {text: translate("transcription:goToSettings"), style: "default"},
      ],
    })
    if (result === 1) {
      useNavigationStore.getState().push("/miniapps/settings/speech")
    }
  }

  private navigateForApp(app: ClientApp): void {
    const nav = useNavigationStore.getState()
    const appOpenTransition = "fade"

    if (app.offlineRoute) {
      if (isOfflineHosted(app.packageName)) {
        useAppStatusStore.getState().setForeground(app.packageName)
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
          markMiniappDevMode()
          useAppStatusStore.getState().setForeground(packageName)
        } else {
          nav.push("/applet/dev-offline", {packageName, name: appName, iconUrl: logoUrl})
        }
      })
      return
    }

    if (app.local) {
      useAppStatusStore.getState().setForeground(app.packageName)
    }
  }

  private async syncGlassesMenuApps(): Promise<void> {
    if (this.syncInFlight) {
      this.syncPending = true
      return
    }
    this.syncInFlight = true
    try {
      const apps = useAppStatusStore.getState().apps
      let menuItems = toolkit.settings.get(SETTINGS.menu_apps.key) as GlassesMenuItem[] | undefined
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
        toolkit.settings.set(SETTINGS.menu_apps.key, itemsForNative)
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
          toolkit.settings.set(SETTINGS.offline_camera_running.key, true)
        },
        onStop: () => {
          toolkit.settings.set(SETTINGS.offline_camera_running.key, false)
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
          toolkit.settings.set(SETTINGS.offline_captions_running.key, true)
        },
        onStop: () => {
          toolkit.settings.set(SETTINGS.offline_captions_running.key, false)
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
      toolkit.settings.get(SETTINGS.miniapp_dev_mode.key) && false
    ) {
      apps.push({
        packageName: "com.mentra.miniappdev",
        name: translate("miniApps:lmaLoader"),
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
        iconComponent: createElement(DevIcon),
      })
    }

    return isChinaBuild() ? apps.filter((app) => !CHINA_HIDDEN_APPS.includes(app.packageName)) : apps
  }
}

const builtInMiniappCatalog = BuiltInMiniappCatalog.getInstance()
export default builtInMiniappCatalog
