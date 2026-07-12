import {SETTINGS, engine} from "@mentra/engine"
// In-memory forced write below has no facade equivalent by design (it exists
// for the storage-failure fallback) — allowlisted raw store access.
import {useSettingsStore} from "@mentra/engine/internal"

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

  const current = engine.settings.get(SETTINGS.debug_mode.key)
  if (current === true) return

  console.log("DEV: Auto-enabling debug_mode for allowlisted user")
  const result = await engine.settings.set(SETTINGS.debug_mode.key, true)
  if (result.is_error()) {
    console.warn("DEV: Failed to persist debug_mode:", result.error)
    // Still enable locally so Developer settings is reachable this session.
    // (V1 server write removed; settings are local-first post-cutover.)
    useSettingsStore.setState((state) => ({
      settings: {...state.settings, [SETTINGS.debug_mode.key]: true},
    }))
  }
}
