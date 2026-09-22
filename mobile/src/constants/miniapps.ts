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

/** Expo inlines this optional Call-only override into the JS bundle. */
export const isIosCallBuildEnabled = (): boolean => process.env.EXPO_PUBLIC_ENABLE_MENTRA_CALL_IOS === "true"

/** Pure policy; host callers supply the hydrated, device-local debug settings. */
export const shouldHideMiniapp = (
  packageName: string,
  os: typeof Platform.OS = Platform.OS,
  {showIosCall = false, showIosNotify = false}: {showIosCall?: boolean; showIosNotify?: boolean} = {},
): boolean => {
  if (isChinaBuild() && CHINA_HIDDEN_APPS.includes(packageName)) return true
  if (os !== "ios") return false
  if (packageName === mentraCallPackageName) return !isIosCallBuildEnabled() && !showIosCall
  if (packageName === notifyPackageName) return !showIosNotify
  return false
}

/**
 * Host utilities that should not appear in the glasses' launch menu.
 *
 * This is deliberately separate from SYSTEM identity: bundled glasses-facing
 * miniapps such as Notes and Translation are SYSTEM-owned but remain valid
 * menu choices.
 */
export const GLASSES_MENU_EXCLUDED_APPS = [
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
