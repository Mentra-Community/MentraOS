/**
 * Phone-notifications sync — engine-owned. Pushes the notification-forwarding
 * operational kill switch + config (`android_notification_listener_enabled`
 * and `notifications_blocklist`) to the native
 * NotificationListener via `CrustModule.setNotificationConfig`, so
 * the blocklist reaches the listener for ANY host — not just the Mentra App,
 * where this used to live in MantleManager. The Android service is desired by
 * default now that its cold start is isolated from React Native. Native code
 * keeps the component discoverable in Android's notification-access Settings,
 * but only binds the service after access is granted. The debug setting remains
 * a hidden emergency kill switch; Notify's running state gates presentation,
 * not capture. Android-only; a no-op elsewhere. Started by `engine.start()`.
 */
import {shallow} from "zustand/shallow"
import CrustModule from "@mentra/crust"

import {useSettingsStore, SETTINGS} from "../stores/settings"

let unsubscribe: (() => void) | null = null

function pushConfig(): void {
  const s = useSettingsStore.getState()
  const listenerEnabled = Boolean(s.getSetting(SETTINGS.android_notification_listener_enabled.key))
  const blocklist = s.getSetting(SETTINGS.notifications_blocklist.key)
  CrustModule.setNotificationConfig(listenerEnabled, Array.isArray(blocklist) ? blocklist : []).catch((err: unknown) =>
    console.warn(`PhoneNotificationsSync: setNotificationConfig failed: ${(err as Error)?.message ?? err}`),
  )
}

export function startPhoneNotificationsSync(): void {
  if (unsubscribe) return
  pushConfig() // initial sync so the listener has the current config
  unsubscribe = useSettingsStore.subscribe(
    (state) => ({
      listenerEnabled: state.getSetting(SETTINGS.android_notification_listener_enabled.key),
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
