import {useEffect} from "react"

import {useApplets, useStartApplet} from "@/stores/applets"
import {SETTINGS, useSettingsStore} from "@/stores/settings"
import GlobalEventEmitter from "@/utils/GlobalEventEmitter"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {useAppTheme} from "@/utils/useAppTheme"

export function ButtonActions() {
  const applets = useApplets()
  const startApplet = useStartApplet()
  const {theme} = useAppTheme()

  // Validate and update default button action app when device or applets change
  useEffect(() => {
    const validateAndSetDefaultApp = async () => {
      const currentDefaultApp = await useSettingsStore.getState().getSetting(SETTINGS.default_button_action_app.key)

      // 1. If camera app is available and compatible, ALWAYS prefer it
      // This ensures glasses with cameras always default to camera app
      const cameraApp = applets.find(
        app => app.packageName === "com.mentra.camera" && app.compatibility?.isCompatible !== false,
      )

      if (cameraApp) {
        if (currentDefaultApp !== cameraApp.packageName) {
          console.log("🔘 Setting default button app to camera (glasses have camera)")
          await useSettingsStore.getState().setSetting(SETTINGS.default_button_action_app.key, cameraApp.packageName)
        }
        return
      }

      // 2. For glasses WITHOUT camera, keep current app if compatible
      const currentApp = applets.find(app => app.packageName === currentDefaultApp)
      const isCurrentAppCompatible = currentApp?.compatibility?.isCompatible !== false

      if (isCurrentAppCompatible && currentDefaultApp) {
        // Current app is fine, no change needed
        return
      }

      // 3. Fallback: find first compatible standard app
      const firstCompatibleApp = applets.find(
        app => app.type === "standard" && app.compatibility?.isCompatible !== false,
      )

      if (firstCompatibleApp) {
        console.log("🔘 Setting default button app to:", firstCompatibleApp.packageName)
        await useSettingsStore
          .getState()
          .setSetting(SETTINGS.default_button_action_app.key, firstCompatibleApp.packageName)
      }
    }

    validateAndSetDefaultApp()
  }, [applets]) // Run when applets change (which includes compatibility info)

  // Listen for button press events from glasses
  useEffect(() => {
    const onButtonPress = async (event: {buttonId: string; pressType: string; timestamp: number}) => {
      console.log("🔘 BUTTON_PRESS event in ButtonActionProvider:", event)

      // For V1: Handle short+long button presses the same.
      // Later, we'll differentiate actions based on pressType and have a fancy button configuration system for it.
      // if (event.pressType !== "short") {
      //   console.log("🔘 Ignoring non-short press:", event.pressType)
      //   return
      // }

      // Check if default button action is enabled
      const defaultButtonActionEnabled = await useSettingsStore
        .getState()
        .getSetting(SETTINGS.default_button_action_enabled.key)

      if (!defaultButtonActionEnabled) {
        console.log("🔘 Default button action is disabled")
        return
      }

      // Check if any foreground app is running
      const activeForegroundApp = applets.find(app => app.type === "standard" && app.running)

      if (activeForegroundApp) {
        console.log(
          "🔘 Foreground app is running - button event already sent to server for app:",
          activeForegroundApp.name,
        )
        return
      }

      // No foreground app running - start default app
      const defaultAppPackageName = await useSettingsStore.getState().getSetting(SETTINGS.default_button_action_app.key)

      if (!defaultAppPackageName) {
        console.log("🔘 No default app configured")
        return
      }

      // Validate app compatibility before starting
      const targetApp = applets.find(app => app.packageName === defaultAppPackageName)
      if (!targetApp) {
        console.log("🔘 Default app not found:", defaultAppPackageName)
        return
      }

      if (targetApp.compatibility?.isCompatible === false) {
        console.log("🔘 Default app is incompatible with current device:", defaultAppPackageName)
        return
      }

      // Check and request permissions before starting
      const result = await askPermissionsUI(targetApp, theme)
      if (result !== 1) {
        console.log("🔘 Permissions not granted for default app:", defaultAppPackageName)
        return
      }

      console.log("🔘 Starting default app:", defaultAppPackageName)
      startApplet(defaultAppPackageName)
    }

    GlobalEventEmitter.on("BUTTON_PRESS", onButtonPress)
    return () => {
      GlobalEventEmitter.removeListener("BUTTON_PRESS", onButtonPress)
    }
  }, [applets, startApplet, theme])

  return null
}
