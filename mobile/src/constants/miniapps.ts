import {Platform} from "react-native"

export const cameraPackageName = "com.mentra.camera"
export const galleryPackageName = "com.mentra.gallery"
export const settingsPackageName = "com.mentra.settings"
export const simulatedPackageName = "com.mentra.simulated"
export const mirrorPackageName = "com.mentra.mirror"
export const mentraAiPackageName = "com.mentra.ai"
export const feedbackPackageName = "com.mentra.feedback"
export const miniappDeveloperPackageName = "com.mentra.miniappdev"
export const notifyPackageName = "cloud.augmentos.notify"
export const navigationPackageName = "com.mentra.navigation" // "Mentra Map"
export const mentraCallPackageName = "com.mentra.call"

/** True when this binary is the China (com.mentra.mentra.cn) build. */
export const isChinaBuild = (): boolean => process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"

/**
 * Apps that are not shipped in the China build: Mentra Map (navigation),
 * Notify, and Feedback. Enforced at every registration surface —
 * bundled-miniapp install, the offline-app catalog, and leftover hide.
 */
export const CHINA_HIDDEN_APPS = [navigationPackageName, notifyPackageName, feedbackPackageName]

export const IOS_HIDDEN_APPS = [mentraCallPackageName, notifyPackageName]

/** Expo inlines this optional override into the JS bundle. */
export const isIosCallBuildEnabled = (): boolean => process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS === "true"

/** Pure policy; host callers supply the hydrated, device-local debug setting. */
export const shouldHideMiniapp = (
  packageName: string,
  os: typeof Platform.OS = Platform.OS,
  showIosCall = false,
): boolean => {
  if (isChinaBuild() && CHINA_HIDDEN_APPS.includes(packageName)) return true
  if (os !== "ios") return false
  if (packageName === mentraCallPackageName) return !isIosCallBuildEnabled() && !showIosCall
  return IOS_HIDDEN_APPS.includes(packageName)
}

// these apps cannot be uninstalled:
export const SYSTEM_APPS = [
  cameraPackageName,
  galleryPackageName,
  settingsPackageName,
  simulatedPackageName,
  mirrorPackageName,
  mentraAiPackageName,
  notifyPackageName,
  feedbackPackageName,
  miniappDeveloperPackageName,
]
