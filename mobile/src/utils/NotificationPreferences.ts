import {SETTINGS} from "@/stores/settings"
import {storage} from "@/utils/storage/storage"

export interface NotificationAppPreference {
  packageName: string
  appName: string
  enabled: boolean
  lastUpdated: number
}

export interface NotificationApp {
  packageName: string
  appName: string
  icon?: string
  category: string
  firstSeen: number
  lastSeen: number
  notificationCount: number
  enabled?: boolean
}

/**
 * Utility class for managing notification preferences
 */
export class NotificationPreferences {
  /**
   * Get app-specific notification preferences
   */
  static async getAppPreferences(): Promise<Record<string, NotificationAppPreference>> {
    const res = storage.load<Record<string, NotificationAppPreference>>(SETTINGS.notification_app_preferences.key)
    if (res.is_error()) {
      console.error("Failed to get app preferences", res.error)
      return {}
    }
    const preferences = res.value
    return preferences
  }

  /**
   * Set preference for a specific app
   */
  static async setAppPreference(packageName: string, appName: string, enabled: boolean): Promise<void> {
    const preferences = await this.getAppPreferences()
    preferences[packageName] = {
      packageName,
      appName,
      enabled,
      lastUpdated: Date.now(),
    }

    const res = await storage.save(SETTINGS.notification_app_preferences.key, preferences)
    if (res.is_error()) {
      console.error("Failed to save app preferences", res.error)
    }

    // Also store a simple app name -> blocked mapping for Android to read easily
    const simpleBlacklist: Record<string, boolean> = {}
    Object.values(preferences).forEach(pref => {
      if (pref.packageName.startsWith("manual.")) {
        simpleBlacklist[pref.appName] = !pref.enabled // blocked = !enabled
      }
    })

    const res2 = await storage.save("SIMPLE_NOTIFICATION_BLACKLIST", simpleBlacklist)
    if (res2.is_error()) {
      console.error("Failed to save simple blacklist", res2.error)
    }
    console.log("📋 Updated simple blacklist:", simpleBlacklist)
  }

  /**
   * Completely remove an app preference
   */
  static async removeAppPreference(packageName: string): Promise<void> {
    const preferences = await this.getAppPreferences()
    delete preferences[packageName]

    const res = await storage.save(SETTINGS.notification_app_preferences.key, preferences)
    if (res.is_error()) {
      console.error("Failed to save app preferences", res.error)
    }
  }

  /**
   * Bulk update multiple app preferences
   */
  static async bulkUpdateAppPreferences(
    updates: Array<{packageName: string; appName: string; enabled: boolean}>,
  ): Promise<void> {
    const preferences = await this.getAppPreferences()

    updates.forEach(update => {
      preferences[update.packageName] = {
        packageName: update.packageName,
        appName: update.appName,
        enabled: update.enabled,
        lastUpdated: Date.now(),
      }
    })

    const res = await storage.save(SETTINGS.notification_app_preferences.key, preferences)
    if (res.is_error()) {
      console.error("Failed to save app preferences", res.error)
    }
  }

  /**
   * Reset all preferences to default (all enabled)
   */
  static async resetToDefaults(): Promise<void> {
    const res = await storage.remove(SETTINGS.notification_app_preferences.key)
    if (res.is_error()) {
      console.error("Error resetting preferences", res.error)
    }
  }

  /**
   * Get enabled apps count
   */
  static async getEnabledAppsCount(): Promise<number> {
    try {
      const preferences = await this.getAppPreferences()
      return Object.values(preferences).filter(pref => pref.enabled).length
    } catch (error) {
      console.error("Error getting enabled apps count:", error)
      return 0
    }
  }

  /**
   * Get disabled apps count
   */
  static async getDisabledAppsCount(): Promise<number> {
    try {
      const preferences = await this.getAppPreferences()
      return Object.values(preferences).filter(pref => !pref.enabled).length
    } catch (error) {
      console.error("Error getting disabled apps count:", error)
      return 0
    }
  }

  /**
   * Export preferences for backup/sync
   */
  static async exportPreferences(): Promise<{apps: Record<string, NotificationAppPreference>}> {
    return {
      apps: await this.getAppPreferences(),
    }
  }

  /**
   * Import preferences from backup/sync
   */
  static async importPreferences(data: {apps: Record<string, NotificationAppPreference>}): Promise<void> {
    const res = await storage.save(SETTINGS.notification_app_preferences.key, data.apps)
    if (res.is_error()) {
      console.error("Failed to import preferences", res.error)
    }
  }
}
