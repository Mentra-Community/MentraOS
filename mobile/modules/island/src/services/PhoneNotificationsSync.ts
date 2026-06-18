/**
 * Phone-notifications sync — island-owned. Pushes the notification-forwarding
 * config (`notifications_enabled` + `notifications_blocklist`) to the native
 * NotificationListener via `CrustModule.setNotificationConfig`, so
 * `toolkit.phoneNotifications.setEnabled()/setBlocklist()` actually reach the
 * listener for ANY host — not just the Mentra app, where this used to live in
 * MantleManager. Android-only; a no-op elsewhere. Started by `toolkit.start()`.
 */
import {shallow} from "zustand/shallow"
import CrustModule from "@mentra/crust"

import {useSettingsStore, SETTINGS} from "../stores/settings"

let unsubscribe: (() => void) | null = null

function pushConfig(): void {
  const s = useSettingsStore.getState()
  const enabled = Boolean(s.getSetting(SETTINGS.notifications_enabled.key))
  const blocklist = s.getSetting(SETTINGS.notifications_blocklist.key)
  // Unconditional (matches the prior MantleManager sync) — the listener is
  // Android-only, but CrustModule.setNotificationConfig is a safe no-op elsewhere;
  // the Android-only gating lives on the facade's setEnabled/setBlocklist.
  CrustModule.setNotificationConfig(enabled, Array.isArray(blocklist) ? blocklist : []).catch((err) =>
    console.warn(`PhoneNotificationsSync: setNotificationConfig failed: ${(err as Error)?.message ?? err}`),
  )
}

export function startPhoneNotificationsSync(): void {
  if (unsubscribe) return
  pushConfig() // initial sync so the listener has the current config
  unsubscribe = useSettingsStore.subscribe(
    (state) => ({
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
