import {engine} from "@mentra/engine"

/**
 * Home is outside the pairing flow, so a model the user picked but never finished pairing (app
 * killed mid-scan, a failed attempt, an orphaned identity demoted at boot) is cancelled there
 * instead of being offered back. A link that is still busy, or glasses that paired natively but
 * whose identity echo has not landed yet, are not leftovers, so they are left alone.
 */
export async function cancelLeftoverPairing(): Promise<void> {
  try {
    // Connecting or bonding: the attempt is still running and may finish.
    if (engine.glasses.status().state !== "disconnected") return
    if (await engine.glasses.hasDefaultDevice()) return
    await engine.pairing.abandonAttempt({clearPendingSelection: true})
  } catch (error) {
    console.warn("Failed to cancel leftover pairing:", error)
  }
}
