import type {GlassesCapabilitySnapshot} from "../../shared/types"

const EVEN_REALITIES_G2_MODEL = "even realities g2"

/**
 * Normalize the host's glasses capability payload for navigation.
 *
 * `display.canPosition` was added after G2 support shipped, so older Mentra
 * App hosts can identify the device as G2 without including that field. G2's
 * model profile is authoritative here: every G2 supports the positioned scene
 * HUD. Other devices still require an explicit capability so G1 and Z100 keep
 * the compact text fallback.
 */
export function readGlassesCapabilities(capabilities: unknown): GlassesCapabilitySnapshot {
  const record = (capabilities ?? {}) as Record<string, unknown>
  const display =
    record.display && typeof record.display === "object" ? (record.display as Record<string, unknown>) : null
  const modelName = typeof record.modelName === "string" ? record.modelName : null
  const isEvenRealitiesG2 = modelName?.trim().toLowerCase() === EVEN_REALITIES_G2_MODEL

  return {
    modelName,
    hasDisplay: record.hasDisplay === true || !!display,
    canPosition: isEvenRealitiesG2 || display?.canPosition === true,
    hasSpeaker: record.hasSpeaker === true,
    hasButton: record.hasButton === true,
  }
}
