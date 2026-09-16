import type {MiniappSession} from "@mentra/miniapp/background"

/** Best-effort: does the connected device have a display we can render to? */
export function hasDisplayCapability(session: MiniappSession): boolean {
  try {
    const caps = session.capabilities as Record<string, unknown> | null
    if (!caps) return false
    // Capability shapes vary across host versions; accept the common flags.
    if (typeof caps.hasDisplay === "boolean") return caps.hasDisplay
    const display = caps.display as {present?: boolean} | boolean | undefined
    if (typeof display === "boolean") return display
    if (display && typeof display === "object") return display.present !== false
    return false
  } catch {
    return false
  }
}

/**
 * Best-effort: does the connected device have a microphone? Voice-follow
 * can't work without one, so this drives the deterministic fall-back to timed
 * scrolling. Conservatively assume yes when capabilities haven't loaded yet —
 * the worst case is voice-follow simply waiting for speech that never comes,
 * which the UI surfaces and the user can resolve by switching to timed scroll.
 */
export function hasMicrophoneCapability(session: MiniappSession): boolean {
  try {
    const caps = session.capabilities as Record<string, unknown> | null
    if (!caps) return true
    if (typeof caps.hasMicrophone === "boolean") return caps.hasMicrophone
    const mic = caps.microphone as {present?: boolean} | boolean | undefined
    if (typeof mic === "boolean") return mic
    if (mic && typeof mic === "object") return mic.present !== false
    return true
  } catch {
    return true
  }
}
