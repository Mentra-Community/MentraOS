import {useEffect} from "react"

import {useApps} from "@mentra/island"

import {cameraPackageName} from "@/constants/miniapps"
import {SETTINGS, useSetting} from "@/stores/settings"

/**
 * Syncs gallery mode state to glasses based on app status.
 *
 * Gallery mode (capture enabled) is TRUE when:
 * - Camera app is running, OR
 * - No standard/background apps are running
 *
 * This allows button press to capture photos when no apps are active,
 * while preventing capture when other apps are handling button events.
 */
export function GalleryModeSync() {
  const applets = useApps()
  const [galleryMode, setGalleryMode] = useSetting(SETTINGS.gallery_mode.key)

  useEffect(() => {
    // console.log(`📸 [GalleryModeSync] Effect triggered, ${applets.length} applets loaded`)

    // Debug: log all running apps
    // const runningApps = applets.filter((app) => app.running)
    // console.log(
    //   `[GalleryModeSync] Running apps (${runningApps.length}):`,
    //   runningApps.map((app) => `${app.name} (${app.type}, ${app.packageName})`).join(", ") || "NONE",
    // )

    const cameraApp = applets.find((app) => app.packageName === cameraPackageName && app.running)
    const otherButtonHandlingApp = applets.find(
      (app) =>
        (app.type === "standard" || app.type === "background") &&
        app.running &&
        app.packageName !== cameraPackageName,
    )

    const shouldEnableCapture = !!cameraApp || !otherButtonHandlingApp

    // console.log(
    //   `[GalleryModeSync] Capture: ${shouldEnableCapture ? "ENABLED" : "DISABLED"} ` +
    //     `(setting gallery_mode to ${shouldEnableCapture})`,
    // )

    if (galleryMode !== shouldEnableCapture) {
      setGalleryMode(shouldEnableCapture)
    }
  }, [applets])

  return null
}
