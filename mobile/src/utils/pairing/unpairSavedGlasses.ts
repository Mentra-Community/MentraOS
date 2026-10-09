import {engine, SETTINGS} from "@mentra/engine"

/**
 * Unpair the saved glasses natively, then clear the phone's pairing identity so
 * Home returns to the no-glasses state. Throws if the native unpair fails.
 */
export async function unpairSavedGlasses(): Promise<void> {
  await engine.glasses.unpair()
  await engine.settings.set(SETTINGS.default_wearable.key, "", false)
  await engine.settings.set(SETTINGS.device_name.key, "", false)
  await engine.settings.set(SETTINGS.device_address.key, "", false)
  await engine.settings.set(SETTINGS.pending_wearable.key, "", false)
  await engine.settings.set(SETTINGS.mentra_live_owner_lost.key, false, false)
}
