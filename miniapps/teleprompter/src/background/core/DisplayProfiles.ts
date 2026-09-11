/**
 * Pick a display profile from the connected glasses' model name. Same mapping
 * the captions miniapp uses, kept small and dependency-free.
 */

import {G1_PROFILE, NEX_PROFILE, Z100_PROFILE} from "../../vendor/display-utils/profiles"
import type {DisplayProfile} from "../../vendor/display-utils/profiles"
import type {MiniappSession} from "@mentra/miniapp/background"

export function getProfileForModel(modelName: string | null | undefined): DisplayProfile {
  if (!modelName) return G1_PROFILE
  const lower = modelName.toLowerCase()
  if (lower.includes("g1") || lower.includes("even realities") || lower.includes("even_g1")) {
    return G1_PROFILE
  }
  if (lower.includes("z100") || lower.includes("vuzix") || lower.includes("mach1") || lower.includes("mach 1")) {
    return Z100_PROFILE
  }
  if (lower.includes("nex") || lower.includes("mentra display") || lower.includes("mentra_nex")) {
    return NEX_PROFILE
  }
  return G1_PROFILE
}

/** Read the glasses model name from capabilities (best-effort). */
export function getModelName(session: MiniappSession): string | null {
  try {
    const caps = session.capabilities as Record<string, unknown> | null
    const m = caps?.modelName
    return typeof m === "string" ? m : null
  } catch {
    return null
  }
}

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
    // If we can read a model name, assume a display until told otherwise.
    return typeof caps.modelName === "string"
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
