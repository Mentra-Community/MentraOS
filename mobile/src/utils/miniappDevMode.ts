import {SETTINGS, engine} from "@mentra/engine"

/**
 * Flip the latent per-account "this user is a developer" signal.
 *
 * `miniapp_dev_mode` controls whether the Miniapp Developer settings are
 * visible. Set it the first time someone actually loads a development miniapp
 * so the tools remain easy to reach afterward. Idempotent and cheap: once set,
 * it skips the write (and the server push) entirely.
 */
export function markMiniappDevMode(): void {
  if (engine.settings.get(SETTINGS.miniapp_dev_mode.key)) return
  void engine.settings.set(SETTINGS.miniapp_dev_mode.key, true)
}
