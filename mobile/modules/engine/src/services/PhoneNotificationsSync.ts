/**
 * Phone-notifications sync — engine-owned. Pushes the notification-forwarding
 * developer gate + config (`android_notification_listener_enabled`,
 * `notifications_enabled`, and `notifications_blocklist`) to the native
 * NotificationListener via `CrustModule.setNotificationConfig`, so
 * `engine.phoneNotifications.setEnabled()/setBlocklist()` actually reach the
 * listener for ANY host — not just the Mentra app, where this used to live in
 * MantleManager. The Android service component is disabled unless the developer
 * gate is explicitly enabled. Android-only; a no-op elsewhere. Started by
 * `engine.start()`.
 */
import {shallow} from "zustand/shallow"
import CrustModule from "@mentra/crust"

import {useSettingsStore, SETTINGS} from "../stores/settings"

let unsubscribe: (() => void) | null = null

function pushConfig(): void {
  const s = useSettingsStore.getState()
  const listenerEnabled = Boolean(s.getSetting(SETTINGS.android_notification_listener_enabled.key))
  const notificationsEnabled = Boolean(s.getSetting(SETTINGS.notifications_enabled.key))
  const blocklist = s.getSetting(SETTINGS.notifications_blocklist.key)
  CrustModule.setNotificationConfig(
    listenerEnabled,
    notificationsEnabled,
    Array.isArray(blocklist) ? blocklist : [],
  ).catch((err: unknown) =>
    console.warn(`PhoneNotificationsSync: setNotificationConfig failed: ${(err as Error)?.message ?? err}`),
  )
}

export function startPhoneNotificationsSync(): void {
  if (unsubscribe) return
  pushConfig() // initial sync so the listener has the current config
  unsubscribe = useSettingsStore.subscribe(
    (state) => ({
      listenerEnabled: state.getSetting(SETTINGS.android_notification_listener_enabled.key),
      enabled: state.getSetting(SETTINGS.notifications_enabled.key),
      blocklist: state.getSetting(SETTINGS.notifications_blocklist.key),
    }),
    () => pushConfig(),
    {equalityFn: shallow},
  )
}

export function stopPhoneNotificationsSync(): void {
  unsubscribe?.()
  unsubscribe = null
}
