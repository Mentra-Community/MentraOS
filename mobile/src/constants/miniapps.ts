export const cameraPackageName = "com.mentra.camera"
export const captionsPackageName = "com.mentra.offline_captions"
export const galleryPackageName = "com.mentra.gallery"
export const settingsPackageName = "com.mentra.settings"
export const storePackageName = "com.mentra.store"
export const simulatedPackageName = "com.mentra.simulated"
export const mirrorPackageName = "com.mentra.mirror"
export const mentraAiPackageName = "com.mentra.ai"
export const feedbackPackageName = "com.mentra.feedback"
export const notifyPackageName = "cloud.augmentos.notify"
export const navigationPackageName = "com.mentra.navigation" // "Mentra Map"

/** True when this binary is the China (com.mentra.mentra.cn) build. */
export const isChinaBuild = (): boolean => process.env.EXPO_PUBLIC_DEPLOYMENT_REGION === "china"

/**
 * Apps that are not shipped in the China build: Mentra Map (navigation),
 * Offline Captions, Notify, and Feedback. Enforced at every registration
 * surface — bundled-miniapp install, the offline-app catalog, and the
 * post-process filter that the cloud/local merge flows through.
 */
export const CHINA_HIDDEN_APPS = [navigationPackageName, captionsPackageName, notifyPackageName, feedbackPackageName]

// these apps cannot be uninstalled:
export const SYSTEM_APPS = [
  cameraPackageName,
  captionsPackageName,
  galleryPackageName,
  settingsPackageName,
  storePackageName,
  simulatedPackageName,
  mirrorPackageName,
  mentraAiPackageName,
  notifyPackageName,
  feedbackPackageName,
]
