/**
 * phoneNotifications facade — `toolkit.phoneNotifications`: forward phone
 * notifications to the glasses, with a per-app blocklist. Android-only (the
 * NotificationListenerService); the getters return sensible defaults on iOS.
 *
 * Enabled-state + blocklist are island settings (auto-synced to the native
 * listener); the installed-apps list + the listener permission are CrustModule.
 */
import {Platform} from "react-native"
import CrustModule from "crust"
import {useSettingsStore, SETTINGS} from "../stores/settings"

export const phoneNotifications = {
  /** Is phone-notification forwarding enabled? (false on iOS) */
  enabled: (): boolean => {
    if (Platform.OS !== "android") return false
    return useSettingsStore.getState().getSetting(SETTINGS.notifications_enabled.key) ?? true
  },
  /** Enable/disable phone-notification forwarding. (no-op on iOS) */
  setEnabled: (enabled: boolean) => {
    if (Platform.OS !== "android") return
    return useSettingsStore.getState().setSetting(SETTINGS.notifications_enabled.key, enabled)
  },

  /** The phone's installed apps (package, name, icon). (empty on iOS) */
  installedApps: (): Promise<Array<{packageName: string; appName: string; icon: string | null}>> => {
    if (Platform.OS !== "android") return Promise.resolve([])
    return CrustModule.getInstalledApps()
  },

  /** The per-app blocklist (package names whose notifications are NOT forwarded). */
  blocklist: (): string[] => {
    const b = useSettingsStore.getState().getSetting(SETTINGS.notifications_blocklist.key)
    return Array.isArray(b) ? b : []
  },
  /** Replace the per-app blocklist. */
  setBlocklist: (packageNames: string[]) =>
    useSettingsStore.getState().setSetting(SETTINGS.notifications_blocklist.key, packageNames),

  /** Does the app have the Android notification-listener permission? (false on iOS) */
  hasListenerPermission: (): Promise<boolean> => {
    if (Platform.OS !== "android") return Promise.resolve(false)
    return CrustModule.hasNotificationListenerPermission()
  },
  /** Open the OS settings to grant the notification-listener permission. (no-op on iOS) */
  requestListenerPermission: () => {
    if (Platform.OS !== "android") return
    return CrustModule.openNotificationListenerSettings()
  },
}
