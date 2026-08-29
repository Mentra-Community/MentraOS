import {useEffect} from "react"

import {DeviceTypes} from "@mentra/engine"
import {useAppTheme} from "@/contexts/ThemeContext"
import {useApps, useStart, engine, SETTINGS, useSetting} from "@mentra/engine"
import {askPermissionsUI} from "@/utils/PermissionsUtils"
import {ButtonPressEvent} from "@mentra/bluetooth-sdk"

import {shouldUseMentraLiveNativeCapture} from "@/effects/buttonCapturePolicy"

export function ButtonActions() {
  const applets = useApps()
  const startApplet = useStart()
  const {theme} = useAppTheme()
  const [defaultWearable] = useSetting(SETTINGS.default_wearable.key)

  // Validate and update default button action app when device or applets change
  useEffect(() => {
    // Default Button Action is Mentra Live only — G2's "button" is a touchpad and the
    // auto-launcher clobbers the glasses' native menu UI when it fires.
    if (defaultWearable !== DeviceTypes.LIVE) return

    const validateAndSetDefaultApp = async () => {
      const currentDefaultApp = await engine.settings.get(SETTINGS.default_button_action_app.key)

      // 1. If camera app is available and compatible, ALWAYS prefer it
      // This ensures glasses with cameras always default to camera app
      const cameraApp = applets.find(
        (app) => app.packageName === "com.mentra.camera" && app.compatibility?.isCompatible !== false,
      )

      if (cameraApp) {
        if (currentDefaultApp !== cameraApp.packageName) {
          console.log("BUTTON_ACTION: Setting default button app to camera (glasses have camera)")
          await engine.settings.set(SETTINGS.default_button_action_app.key, cameraApp.packageName)
        }
        return
      }

      // 2. For glasses WITHOUT camera, keep current app if compatible
      const currentApp = applets.find((app) => app.packageName === currentDefaultApp)
      const isCurrentAppCompatible = currentApp?.compatibility?.isCompatible !== false

      if (isCurrentAppCompatible && currentDefaultApp) {
        // Current app is fine, no change needed
        return
      }

      // 3. Fallback: find first compatible standard app
      const firstCompatibleApp = applets.find(
        (app) => app.type === "standard" && app.compatibility?.isCompatible !== false,
      )

      if (firstCompatibleApp) {
        console.log("BUTTON_ACTION: Setting default button app to:", firstCompatibleApp.packageName)
        await engine.settings.set(SETTINGS.default_button_action_app.key, firstCompatibleApp.packageName)
      }
    }

    validateAndSetDefaultApp()
  }, [applets, defaultWearable]) // Run when applets change (which includes compatibility info)

  // Listen for button press events from glasses
  useEffect(() => {
    if (defaultWearable !== DeviceTypes.LIVE) return

    const onButtonPress = async (event: ButtonPressEvent) => {
      console.log("BUTTON_ACTION: BUTTON_PRESS event in ButtonActionProvider:", event)

      // For V1: Handle short+long button presses the same.
      // Later, we'll differentiate actions based on pressType and have a fancy button configuration system for it.
      // if (event.pressType !== "short") {
      //   console.log("BUTTON_ACTION: Ignoring non-short press:", event.pressType)
      //   return
      // }

      // Check if default button action is enabled
      const defaultButtonActionEnabled = await engine.settings.get(SETTINGS.default_button_action_enabled.key)

      if (!defaultButtonActionEnabled) {
        console.log("BUTTON_ACTION: Default button action is disabled")
        return
      }

      // A running miniapp only owns Mentra Live's hardware button while it has
      // an active button_press subscription. This keeps UI-only miniapps such
      // as Give Feedback from disabling native photo/video capture.
      const buttonPressSubscribers = engine.miniapps.buttonPressSubscribers()
      if (!shouldUseMentraLiveNativeCapture(buttonPressSubscribers)) {
        console.log(
          "BUTTON_ACTION: Button event delivered to subscribed miniapp(s):",
          buttonPressSubscribers.join(", "),
        )
        return
      }

      // No miniapp owns this button press - start the default app.
      const defaultAppPackageName = await engine.settings.get(SETTINGS.default_button_action_app.key)

      if (!defaultAppPackageName) {
        console.log("BUTTON_ACTION: No default app configured")
        return
      }

      // Validate app compatibility before starting
      const targetApp = applets.find((app) => app.packageName === defaultAppPackageName)
      if (!targetApp) {
        console.log("BUTTON_ACTION: Default app not found:", defaultAppPackageName)
        return
      }

      if (targetApp.compatibility?.isCompatible === false) {
        console.log("BUTTON_ACTION: Default app is incompatible with current device:", defaultAppPackageName)
        return
      }

      // Check and request permissions before starting
      const result = await askPermissionsUI(targetApp, theme)
      if (result !== 1) {
        console.log("BUTTON_ACTION: Permissions not granted for default app:", defaultAppPackageName)
        return
      }

      console.log("BUTTON_ACTION: Starting default app:", defaultAppPackageName)
      startApplet(targetApp, {skipNavigation: true})
    }

    let unsub = engine.glasses.onButtonPress(onButtonPress)

    return () => {
      unsub()
    }
  }, [applets, startApplet, theme, defaultWearable])

  return null
}
