/**
 * Model Download Notifications
 * Manages system notifications for STT model download progress
 *
 * Platform differences:
 * - Android: Supports ongoing/sticky notifications that update silently
 * - iOS: Each notification update shows a banner, so we throttle updates
 *        and only show start/complete notifications to avoid spam
 */

import * as Notifications from "expo-notifications"
import {Platform} from "react-native"

// Notification IDs
const DOWNLOAD_NOTIFICATION_ID = "model-download-progress"
const CHANNEL_ID = "model-download"

// iOS throttling - only update every N seconds to avoid banner spam
const IOS_UPDATE_THROTTLE_MS = 10000 // 10 seconds between updates on iOS

// Configure notification handler
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    // On iOS, minimize banner popups for progress updates
    shouldShowBanner: Platform.OS === "android",
    shouldShowList: true,
  }),
})

class ModelDownloadNotifications {
  private static instance: ModelDownloadNotifications
  private channelCreated = false
  private notificationActive = false
  private lastUpdateTime = 0 // For iOS throttling

  // Disable notifications for now - can be re-enabled later
  private notificationsEnabled = false

  private constructor() {}

  static getInstance(): ModelDownloadNotifications {
    if (!ModelDownloadNotifications.instance) {
      ModelDownloadNotifications.instance = new ModelDownloadNotifications()
    }
    return ModelDownloadNotifications.instance
  }

  /**
   * Initialize notification channel (Android only)
   */
  private async ensureChannel(): Promise<void> {
    if (this.channelCreated) return

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: "Model Download",
        description: "Shows progress when downloading speech recognition models",
        importance: Notifications.AndroidImportance.LOW, // Low = no sound, shows in shade
        vibrationPattern: [0], // No vibration
        lightColor: "#4A90D9",
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
        bypassDnd: false,
        enableLights: false,
        enableVibrate: false,
        showBadge: false,
      })
    }

    this.channelCreated = true
  }

  /**
   * Request notification permissions
   */
  async requestPermissions(): Promise<boolean> {
    const {status: existingStatus} = await Notifications.getPermissionsAsync()

    if (existingStatus === "granted") {
      return true
    }

    const {status} = await Notifications.requestPermissionsAsync()
    return status === "granted"
  }

  /**
   * Show initial download notification
   */
  async showDownloadStarted(modelName: string): Promise<void> {
    if (!this.notificationsEnabled) {
      console.log(`[ModelDownloadNotifications] Notifications disabled, skipping start notification for ${modelName}`)
      return
    }
    await this.ensureChannel()

    const hasPermission = await this.requestPermissions()
    if (!hasPermission) {
      console.log("[ModelDownloadNotifications] No notification permission, skipping")
      return
    }

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Downloading speech model",
        body: `Preparing to download ${modelName}...`,
        data: {type: "model-download"},
        sticky: Platform.OS === "android", // Ongoing notification on Android
      },
      trigger: null, // Show immediately
    })

    this.notificationActive = true
    this.lastUpdateTime = Date.now() // Reset throttle timer
    console.log(`[ModelDownloadNotifications] Started download notification for ${modelName}`)
  }

  /**
   * Create a visual progress bar (Android only)
   */
  private createProgressBar(progress: number, width: number = 15): string {
    const filled = Math.round((progress / 100) * width)
    const empty = width - filled
    const filledBar = "●".repeat(filled)
    const emptyBar = "○".repeat(empty)
    return `${filledBar}${emptyBar}`
  }

  /**
   * Update download progress notification
   * On iOS, updates are throttled to avoid spamming the user with banner notifications
   */
  async updateDownloadProgress(modelName: string, progress: number): Promise<void> {
    if (!this.notificationsEnabled) return
    if (!this.notificationActive) return

    // On iOS, throttle updates to avoid banner spam
    if (Platform.OS === "ios") {
      const now = Date.now()
      const timeSinceLastUpdate = now - this.lastUpdateTime

      // Only update if enough time has passed OR if download is completing
      const isCompleting = progress >= 99
      if (timeSinceLastUpdate < IOS_UPDATE_THROTTLE_MS && !isCompleting) {
        return // Skip this update on iOS to avoid banner spam
      }
      this.lastUpdateTime = now
    }

    await this.ensureChannel()

    // Build notification body - progress bar only on Android
    let body: string
    if (Platform.OS === "android") {
      const progressBar = this.createProgressBar(progress)
      body = `${progressBar} ${progress}%\nDownloading ${modelName}`
    } else {
      // iOS: simple text only, no progress bar
      body = `Downloading ${modelName} (${progress}%)`
    }

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Downloading speech model",
        body,
        data: {type: "model-download", progress},
        sticky: Platform.OS === "android",
      },
      trigger: null,
    })
  }

  /**
   * Update extraction progress notification
   */
  async updateExtractionProgress(modelName: string, progress: number): Promise<void> {
    if (!this.notificationsEnabled) return
    if (!this.notificationActive) return

    // On iOS, throttle updates
    if (Platform.OS === "ios") {
      const now = Date.now()
      const timeSinceLastUpdate = now - this.lastUpdateTime
      const isCompleting = progress >= 99
      if (timeSinceLastUpdate < IOS_UPDATE_THROTTLE_MS && !isCompleting) {
        return
      }
      this.lastUpdateTime = now
    }

    await this.ensureChannel()

    let body: string
    if (Platform.OS === "android") {
      const progressBar = this.createProgressBar(progress)
      body = `${progressBar} ${progress}%\nExtracting ${modelName}`
    } else {
      body = `Extracting ${modelName} (${progress}%)`
    }

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Installing speech model",
        body,
        data: {type: "model-download", progress, phase: "extracting"},
        sticky: Platform.OS === "android",
      },
      trigger: null,
    })
  }

  /**
   * Show activating model notification
   */
  async showActivating(modelName: string): Promise<void> {
    if (!this.notificationsEnabled) return
    if (!this.notificationActive) return

    await this.ensureChannel()

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Installing speech model",
        body: `Activating ${modelName}...`,
        data: {type: "model-download", phase: "activating"},
        sticky: Platform.OS === "android",
      },
      trigger: null,
    })
  }

  /**
   * Show download complete notification
   */
  async showComplete(modelName: string): Promise<void> {
    if (!this.notificationsEnabled) {
      console.log(`[ModelDownloadNotifications] Notifications disabled, skipping complete notification for ${modelName}`)
      return
    }
    await this.ensureChannel()

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Model ready",
        body: `${modelName} is now available for offline transcription`,
        data: {type: "model-download-complete"},
      },
      trigger: null,
    })

    this.notificationActive = false
    console.log(`[ModelDownloadNotifications] Download complete: ${modelName}`)

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      this.dismiss()
    }, 5000)
  }

  /**
   * Show download error notification
   */
  async showError(errorMessage: string): Promise<void> {
    if (!this.notificationsEnabled) {
      console.log(`[ModelDownloadNotifications] Notifications disabled, skipping error notification: ${errorMessage}`)
      return
    }
    await this.ensureChannel()

    await Notifications.scheduleNotificationAsync({
      identifier: DOWNLOAD_NOTIFICATION_ID,
      content: {
        title: "Download failed",
        body: errorMessage,
        data: {type: "model-download-error"},
      },
      trigger: null,
    })

    this.notificationActive = false
    console.log(`[ModelDownloadNotifications] Download error: ${errorMessage}`)

    // Auto-dismiss after 5 seconds
    setTimeout(() => {
      this.dismiss()
    }, 5000)
  }

  /**
   * Show download cancelled notification (just dismisses)
   */
  async showCancelled(): Promise<void> {
    if (!this.notificationsEnabled) {
      console.log("[ModelDownloadNotifications] Notifications disabled, skipping cancelled notification")
      return
    }
    await this.dismiss()
    this.notificationActive = false
    console.log("[ModelDownloadNotifications] Download cancelled, notification dismissed")
  }

  /**
   * Dismiss download notification
   */
  async dismiss(): Promise<void> {
    try {
      await Notifications.dismissNotificationAsync(DOWNLOAD_NOTIFICATION_ID)
      this.notificationActive = false
    } catch (error) {
      // Notification may already be dismissed
      console.log("[ModelDownloadNotifications] Error dismissing notification:", error)
    }
  }

  /**
   * Check if download notification is currently active
   */
  isActive(): boolean {
    return this.notificationActive
  }
}

export const modelDownloadNotifications = ModelDownloadNotifications.getInstance()
