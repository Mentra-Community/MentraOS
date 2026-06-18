/**
 * Shared maneuver → display derivation.
 *
 * SINGLE SOURCE OF TRUTH for what the next-turn UI says. Both the phone
 * OrientationCard and the glasses HUD consume this so they can never drift
 * apart on instruction text, distance, or turn direction — they read the
 * exact same Mapbox `maneuver` event through the exact same logic.
 *
 * It returns the raw PIECES (instruction string, distance in meters, arrow
 * glyph, an "at turn / arriving" mode) rather than a finished string, so
 * each surface can lay them out its own way (the card is two lines; the
 * glasses HUD prepends a directional arrow) while still agreeing on every
 * value. Distance formatting is left to the caller so each side applies its
 * own unit system.
 */

import type {NavManeuver} from "@mentra/miniapp"
import type {NavStatus} from "./types"

/** Distance (m) at/under which we say "Now" instead of "In X m". */
const AT_TURN_M = 10

export type ManeuverDisplay = {
  /** Big instruction line — Mapbox's verbatim text, or a reconstructed verb+road. */
  instruction: string
  /** Maneuver kind (drives icon on the card, arrow glyph on the HUD). */
  kind: string
  /** Directional arrow glyph for the glasses HUD (←/→/↑). */
  arrow: string
  /**
   * Distance to the maneuver in meters, or null when unknown. Callers
   * format this with their own unit system (e.g. `In ${formatDistance(...)}`).
   */
  distanceMeters: number | null
  /** True within AT_TURN_M of the maneuver — show "Now" instead of distance. */
  atTurn: boolean
  /** Final-leg arrival mode: show "Arriving in <distanceMeters>" not "In X m, <turn>". */
  arriving: boolean
}

/**
 * Derive the shared display fields from the live `maneuver` event (Mapbox's
 * own current-step tracking, delivered natively from RouteProgress).
 * Returns null when there's nothing to show (no maneuver / arrived) — the
 * caller decides the empty/arrival framing.
 */
export function deriveManeuverDisplay(
  maneuver: NavManeuver | null,
  status: NavStatus | undefined,
): ManeuverDisplay | null {
  if (status === "arrived" || !maneuver) return null

  const kind = maneuver.maneuverType
  const instructionRaw = maneuver.instruction?.trim() || null

  const hasDist = maneuver.distanceMeters != null && maneuver.distanceMeters >= 0
  const distanceMeters = hasDist ? maneuver.distanceMeters : null
  const atTurn = hasDist && maneuver.distanceMeters <= AT_TURN_M

  // Arrival leg (the LAST step) — show ONLY the destination countdown
  // ("Arriving in X m") and drop the turn instruction entirely: there are no
  // more turns, just the destination ahead. Fires for ANY ARRIVE maneuver,
  // even when Mapbox supplies an instruction string ("Your destination is on
  // the right.") — we deliberately replace that with the clean countdown.
  if (kind === "ARRIVE") {
    const toDest = maneuver.distanceToDestinationMeters
    return {
      instruction: "Arriving",
      kind: "ARRIVE",
      arrow: "↑",
      distanceMeters: toDest != null && toDest >= 0 ? toDest : null,
      atTurn: false,
      arriving: true,
    }
  }

  // Bottom/instruction line: Mapbox's verbatim instruction, falling back to
  // a reconstructed "<verb> onto <road>" only when none is present.
  let instruction = instructionRaw
  if (!instruction) {
    const verb = verbForManeuver(kind)
    const onto = realRoadName(maneuver.nextStepRoad)
    instruction = onto ? `${verb} onto ${onto}` : verb
  }

  return {
    instruction,
    kind,
    // Directional arrow (←/→) ONLY once we're AT the turn (atTurn / "Now").
    // While still approaching ("In 90 m, turn left") the arrow stays ↑ —
    // straight ahead — so it doesn't claim "turn now" the whole walk in.
    // Applies to both the glasses HUD and the phone card (shared source).
    arrow: atTurn ? arrowForKind(kind) : "↑",
    distanceMeters,
    atTurn,
    arriving: false,
  }
}

/** Plain arrow glyph for the glasses HUD (corner-curve variants don't render). */
export function arrowForKind(kind: string | null | undefined): string {
  const m = (kind ?? "").toUpperCase()
  if (m.includes("LEFT")) return "←"
  if (m.includes("RIGHT")) return "→"
  return "↑"
}

/** Map a ManeuverKind to a verb (fallback when no verbatim instruction). */
export function verbForManeuver(kind: string): string {
  switch (kind) {
    case "TURN_LEFT":
    case "SLIGHT_LEFT":
    case "SHARP_LEFT":
      return kind === "SLIGHT_LEFT" ? "Slight left" : kind === "SHARP_LEFT" ? "Sharp left" : "Turn left"
    case "TURN_RIGHT":
    case "SLIGHT_RIGHT":
    case "SHARP_RIGHT":
      return kind === "SLIGHT_RIGHT" ? "Slight right" : kind === "SHARP_RIGHT" ? "Sharp right" : "Turn right"
    case "U_TURN":
      return "Make a U-turn"
    case "CONTINUE":
    case "STRAIGHT":
      return "Continue"
    case "NAME_CHANGE":
      return "Continue"
    case "DEPART":
      return "Head out"
    case "CROSS_STREET":
      return "Cross the street"
    default:
      return "Continue"
  }
}

/** Drop instruction-like strings masquerading as road names; trim the rest. */
export function realRoadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (
    /^(toward|turn|continue|destination|head|cross|slight|sharp|keep|merge|fork|exit|take|roundabout|u[\s-]?turn|arrive|arriving|depart|enter|leave|stay)\b/i.test(
      trimmed,
    )
  )
    return null
  return trimmed
}
