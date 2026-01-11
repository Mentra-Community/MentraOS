/**
 * Gallery Sync Notifications
 * Manages system notifications for gallery sync progress
 *
 * Platform differences:
 * - Android: Supports ongoing/sticky notifications that update silently
 * - iOS: Each notification update shows a banner, so we throttle updates
 *        and only show start/complete notifications to avoid spam
 */

// import * as Notifications from "expo-notifications"
import {Platform} from "react-native"

// Notification IDs
const _SYNC_NOTIFICATION_ID = "gallery-sync-progress"
const _CHANNEL_ID = "gallery-sync"

// iOS throttling - only update every N seconds to avoid banner spam
const IOS_UPDATE_THROTTLE_MS = 10000 // 10 seconds between updates on iOS

// Configure notification handler
// Notifications.setNotificationHandler({
//   handleNotification: async () => ({
//     shouldShowAlert: true,
//     shouldPlaySound: false,
//     shouldSetBadge: false,
//     // On iOS, minimize banner popups for progress updates
//     shouldShowBanner: Platform.OS === "android",
//     shouldShowList: true,
//   }),
// })

class GallerySyncNotifications {
  private static instance: GallerySyncNotifications
  private channelCreated = false
  private notificationActive = false
  private lastUpdateTime = 0 // For iOS throttling

  private constructor() {}

  static getInstance(): GallerySyncNotifications {
    if (!GallerySyncNotifications.instance) {
      GallerySyncNotifications.instance = new GallerySyncNotifications()
    }
    return GallerySyncNotifications.instance
  }

  /**
   * Initialize notification channel (Android only)
   */
  private async ensureChannel(): Promise<void> {
    // if (this.channelCreated) return

    // if (Platform.OS === "android") {
    //   await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    //     name: "Gallery Sync",
    //     description: "Shows progress when syncing photos from your glasses",
    //     importance: Notifications.AndroidImportance.LOW, // Low = no sound, shows in shade
    //     vibrationPattern: [0], // No vibration
    //     lightColor: "#4A90D9",
    //     lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    //     bypassDnd: false,
    //     enableLights: false,
    //     enableVibrate: false,
    //     showBadge: false,
    //   })
    // }

    this.channelCreated = true
  }

  /**
   * Request notification permissions
   */
  async requestPermissions(): Promise<boolean> {
    // const {status: existingStatus} = await Notifications.getPermissionsAsync()

    // if (existingStatus === "granted") {
    //   return true
    // }

    // const {status} = await Notifications.requestPermissionsAsync()
    // return status === "granted"
    return true // Always return true when notifications disabled
  }

  /**
   * Show initial sync notification
   */
  async showSyncStarted(totalFiles: number): Promise<void> {
    await this.ensureChannel()

    const hasPermission = await this.requestPermissions()
    if (!hasPermission) {
      console.log("[SyncNotifications] No notification permission, skipping")
      return
    }

    // await Notifications.scheduleNotificationAsync({
    //   identifier: SYNC_NOTIFICATION_ID,
    //   content: {
    //     title: "Syncing photos from glasses",
    //     body: `Preparing to download ${totalFiles} ${totalFiles === 1 ? "file" : "files"}...`,
    //     data: {type: "gallery-sync"},
    //     sticky: Platform.OS === "android", // Ongoing notification on Android
    //   },
    //   trigger: null, // Show immediately
    // })

    this.notificationActive = true
    this.lastUpdateTime = Date.now() // Reset throttle timer
    console.log(`[SyncNotifications] Started sync notification for ${totalFiles} files (notifications disabled)`)
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
   * Update sync progress notification
   * On iOS, updates are throttled to avoid spamming the user with banner notifications
   */
  async updateProgress(
    currentFile: number,
    totalFiles: number,
    _fileName: string,
    fileProgress: number,
  ): Promise<void> {
    if (!this.notificationActive) return

    // On iOS, throttle updates to avoid banner spam
    // iOS doesn't support silent notification updates like Android's ongoing notifications
    if (Platform.OS === "ios") {
      const now = Date.now()
      const timeSinceLastUpdate = now - this.lastUpdateTime

      // Only update if enough time has passed OR if this is the last file completing
      const isLastFileCompleting = currentFile === totalFiles && fileProgress >= 99
      if (timeSinceLastUpdate < IOS_UPDATE_THROTTLE_MS && !isLastFileCompleting) {
        return // Skip this update on iOS to avoid banner spam
      }
      this.lastUpdateTime = now
    }

    await this.ensureChannel()

    // Calculate overall progress (completed files + current file progress)
    const overallProgress = Math.round(((currentFile - 1 + fileProgress / 100) / totalFiles) * 100)

    // Build notification body - progress bar only on Android
    let _body: string
    if (Platform.OS === "android") {
      const progressBar = this.createProgressBar(overallProgress)
      _body = `${progressBar} ${overallProgress}%\nDownloading ${currentFile} of ${totalFiles}`
    } else {
      // iOS: simple text only, no progress bar
      _body = `Downloading ${currentFile} of ${totalFiles} (${overallProgress}%)`
    }

    // await Notifications.scheduleNotificationAsync({
    //   identifier: SYNC_NOTIFICATION_ID,
    //   content: {
    //     title: "Syncing photos from glasses",
    //     body,
    //     data: {type: "gallery-sync", progress: overallProgress},
    //     sticky: Platform.OS === "android", // Keep notification visible on Android
    //   },
    //   trigger: null,
    // })
  }

  /**
   * Show sync complete notification
   */
  async showSyncComplete(downloadedCount: number, failedCount: number = 0): Promise<void> {
    await this.ensureChannel()

    let _title: string
    let _body: string

    if (failedCount === 0) {
      _title = "Sync complete"
      _body = `Downloaded ${downloadedCount} ${downloadedCount === 1 ? "file" : "files"} from your glasses`
    } else if (downloadedCount === 0) {
      _title = "Sync failed"
      _body = `Failed to download ${failedCount} ${failedCount === 1 ? "file" : "files"}`
    } else {
      _title = "Sync complete with errors"
      _body = `Downloaded ${downloadedCount}, failed ${failedCount}`
    }

    // await Notifications.scheduleNotificationAsync({
    //   identifier: SYNC_NOTIFICATION_ID,
    //   content: {
    //     title,
    //     body,
    //     data: {type: "gallery-sync-complete"},
    //   },
    //   trigger: null,
    // })

    this.notificationActive = false
    console.log(
      `[SyncNotifications] Sync complete: ${downloadedCount} downloaded, ${failedCount} failed (notifications disabled)`,
    )

    // Auto-dismiss after 5 seconds
    // setTimeout(() => {
    //   this.dismiss()
    // }, 5000)
  }

  /**
   * Show sync error notification
   */
  async showSyncError(errorMessage: string): Promise<void> {
    await this.ensureChannel()

    // await Notifications.scheduleNotificationAsync({
    //   identifier: SYNC_NOTIFICATION_ID,
    //   content: {
    //     title: "Sync failed",
    //     body: errorMessage,
    //     data: {type: "gallery-sync-error"},
    //   },
    //   trigger: null,
    // })

    this.notificationActive = false
    console.log(`[SyncNotifications] Sync error: ${errorMessage} (notifications disabled)`)

    // Auto-dismiss after 5 seconds
    // setTimeout(() => {
    //   this.dismiss()
    // }, 5000)
  }

  /**
   * Show sync cancelled notification
   */
  async showSyncCancelled(): Promise<void> {
    await this.dismiss()
    this.notificationActive = false
    console.log("[SyncNotifications] Sync cancelled, notification dismissed")
  }

  /**
   * Dismiss sync notification
   */
  async dismiss(): Promise<void> {
    try {
      // await Notifications.dismissNotificationAsync(SYNC_NOTIFICATION_ID)
      this.notificationActive = false
    } catch (error) {
      // Notification may already be dismissed
      console.log("[SyncNotifications] Error dismissing notification:", error)
    }
  }

  /**
   * Check if sync notification is currently active
   */
  isActive(): boolean {
    return this.notificationActive
  }
}

export const gallerySyncNotifications = GallerySyncNotifications.getInstance()
