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
export const linkLingoPackageName = "com.mentra.link"

/** True when this binary is the China (com.mentra.mentra.cn) build. */
export const isChinaBuild = (): boolean => process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"

/**
 * Apps that are not shipped in the China build: Mentra Map (navigation),
 * Notify, and Feedback. Enforced at every registration surface —
 * default-miniapp install, the offline-app catalog, and leftover hide.
 */
export const CHINA_HIDDEN_APPS = [navigationPackageName, notifyPackageName, feedbackPackageName]

/** Consumer Call ships on every platform; Notify still uses a local iOS opt-in. */
export const shouldHideMiniapp = (
  packageName: string,
  os: typeof Platform.OS = Platform.OS,
  {showIosNotify = false}: {showIosNotify?: boolean} = {},
): boolean => {
  if (isChinaBuild() && CHINA_HIDDEN_APPS.includes(packageName)) return true
  if (os !== "ios") return false
  if (packageName === notifyPackageName) return !showIosNotify
  return false
}

/**
 * The system miniapps of this build, like an Android system image's system apps: Mentra's own miniapps, which install
 * and update from the deployment's miniapp host (`artifacts.firstPartyMiniappsUrl`) and may run with the build's
 * privileges (Mentra AI's tool calls into other miniapps). Only this list makes a package one: no manifest can add to
 * it or stand in for it (a workspace can only leave a package out or pin its own release), and a local or development
 * build of one of these names never gets those privileges. Which ones a phone gets is the deployment's default list.
 */
export const SYSTEM_MINIAPP_PACKAGES = [
  mentraAiPackageName,
  mentraCallPackageName,
  "com.mentra.enterprise",
  linkLingoPackageName,
  "com.mentra.livestreamer",
  "com.mentra.merge",
  "com.mentra.notes",
  "com.mentra.captions",
  navigationPackageName,
  "com.mentra.recorder",
  "com.mentra.teleprompter",
  "com.mentra.translation",
] as const

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
