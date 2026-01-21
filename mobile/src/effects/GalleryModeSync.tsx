import {useEffect} from "react"

import {useApplets, cameraPackageName} from "@/stores/applets"
import {SETTINGS, useSetting} from "@/stores/settings"

/**
 * Syncs gallery mode state to glasses based on foreground app status.
 *
 * Gallery mode (capture enabled) is TRUE when:
 * - Camera app is running, OR
 * - No foreground apps are running
 *
 * This allows button press to capture photos when no apps are active,
 * while preventing capture when other apps are handling button events.
 */
export function GalleryModeSync() {
  const applets = useApplets()
  const [galleryMode, setGalleryMode] = useSetting(SETTINGS.gallery_mode.key)

  useEffect(() => {
    // console.log(`📸 [GalleryModeSync] Effect triggered, ${applets.length} applets loaded`)

    // Debug: log all running apps
    // const runningApps = applets.filter((app) => app.running)
    // console.log(
    //   `[GalleryModeSync] Running apps (${runningApps.length}):`,
    //   runningApps.map((app) => `${app.name} (${app.type}, ${app.packageName})`).join(", ") || "NONE",
    // )

    // Find camera app if running
    const cameraApp = applets.find((app) => app.packageName === cameraPackageName && app.running)

    // Find any other foreground app (excluding camera)
    const otherForegroundApp = applets.find(
      (app) => app.type === "standard" && app.running && app.packageName !== cameraPackageName,
    )

    // Determine capture state based on app states
    // - If camera app running: TRUE (camera wants to capture)
    // - If other foreground app running: FALSE (let app handle button)
    // - If no apps running: TRUE (allow capture anyway)
    const shouldEnableCapture = !!cameraApp || !otherForegroundApp

    // console.log(
    //   `[GalleryModeSync] Camera: ${cameraApp ? `RUNNING` : "NOT RUNNING"}, ` +
    //     `OtherApp: ${otherForegroundApp ? `RUNNING (${otherForegroundApp.name}, ${otherForegroundApp.packageName})` : "NOT RUNNING"}, ` +
    //     `Capture: ${shouldEnableCapture ? "ENABLED" : "DISABLED"} ` +
    //     `(Setting gallery_mode to ${shouldEnableCapture})`,
    // )

    if (galleryMode !== shouldEnableCapture) {
      setGalleryMode(shouldEnableCapture)
    }
  }, [applets])

  return null
}
