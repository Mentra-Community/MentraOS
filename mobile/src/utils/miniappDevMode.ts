import {SETTINGS, useSettingsStore} from "@/stores/settings"

/**
 * Flip the latent per-account "this user is a developer" signal.
 *
 * The miniapp dev tools (Scan QR / Load from URL) no longer hide behind a
 * user-facing toggle — they live openly under the Miniapp Developer settings
 * screen. But `miniapp_dev_mode` is still a useful server-synced signal, so we
 * set it the first time someone actually loads a dev mini app. Idempotent and
 * cheap: once set, it skips the write (and the server push) entirely.
 */
export function markMiniappDevMode(): void {
  const store = useSettingsStore.getState()
  if (store.getSetting(SETTINGS.miniapp_dev_mode.key)) return
  void store.setSetting(SETTINGS.miniapp_dev_mode.key, true)
}
