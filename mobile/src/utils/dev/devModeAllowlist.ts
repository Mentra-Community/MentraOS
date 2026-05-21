import restComms from "@/services/RestComms"
import {SETTINGS, useSettingsStore} from "@/stores/settings"

function getAllowlistedEmails(): Set<string> {
  const raw = process.env.EXPO_PUBLIC_DEV_MODE_EMAILS ?? ""
  return new Set(
    raw
      .split(",")
      .map((e: string) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

export function isDevModeAllowlisted(email: string | null | undefined): boolean {
  if (!email) return false
  return getAllowlistedEmails().has(email.toLowerCase().trim())
}

/** Enable dev_mode for allowlisted accounts (syncs to cloud user settings). */
export async function ensureDevModeForUser(email: string | null | undefined): Promise<void> {
  if (!isDevModeAllowlisted(email)) return

  const current = useSettingsStore.getState().getSetting(SETTINGS.dev_mode.key)
  if (current === true) return

  console.log("DEV: Auto-enabling dev_mode for allowlisted user")
  const result = await useSettingsStore.getState().setSetting(SETTINGS.dev_mode.key, true)
  if (result.is_error()) {
    console.warn("DEV: Failed to persist dev_mode:", result.error)
    // Still enable locally so Developer settings is reachable this session.
    useSettingsStore.setState((state) => ({
      settings: {...state.settings, [SETTINGS.dev_mode.key]: true},
    }))
    void restComms.writeUserSettings({[SETTINGS.dev_mode.key]: true})
  }
}
