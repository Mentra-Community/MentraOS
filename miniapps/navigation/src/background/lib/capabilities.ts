import type {GlassesCapabilitySnapshot} from "../../shared/types"

/**
 * Normalize the host's glasses capability payload for navigation.
 *
 * Display capability fields are optional because older hosts do not send all
 * of them. Absence means "unknown", so preserve Navigation's established
 * positioned HUD unless the host explicitly says positioning is unsupported.
 * Current G1 and Z100 profiles send `canPosition: false` and take the compact
 * text fallback; current G2 and Mentra Display profiles send `true`.
 */
export function readGlassesCapabilities(capabilities: unknown): GlassesCapabilitySnapshot {
  const record = (capabilities ?? {}) as Record<string, unknown>
  const display =
    record.display && typeof record.display === "object" ? (record.display as Record<string, unknown>) : null
  const modelName = typeof record.modelName === "string" ? record.modelName : null
  // Respect an explicit top-level false. Some legacy profiles retain a display
  // descriptor for shape/documentation even when no display is currently
  // available; the descriptor alone must not turn the display back on.
  const hasDisplay = typeof record.hasDisplay === "boolean" ? record.hasDisplay : display != null

  return {
    modelName,
    hasDisplay,
    canPosition: hasDisplay && display != null && display.canPosition !== false,
    hasSpeaker: record.hasSpeaker === true,
    hasButton: record.hasButton === true,
  }
}
