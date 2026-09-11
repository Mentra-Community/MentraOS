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
 *
 * `liveDistanceMeters` (optional): a freshly-computed distance to the next
 * maneuver, derived from the user's LIVE position against the route polyline by
 * the caller (see liveDistanceToNextTurn). When provided it OVERRIDES the
 * maneuver event's own `distanceMeters`, so the "In X m" / "Arriving in X m"
 * line ticks down on every location update instead of only when a new native
 * RouteProgress maneuver event arrives. Both the phone card and the glasses HUD
 * pass it, so they recompute identically and stay in lockstep — without waiting
 * on a background→UI re-broadcast. Omit it to use the event's own distance.
 */
export function deriveManeuverDisplay(
  maneuver: NavManeuver | null,
  status: NavStatus | undefined,
  liveDistanceMeters?: number | null,
): ManeuverDisplay | null {
  if (status === "arrived" || !maneuver) return null

  const kind = maneuver.maneuverType
  const instructionRaw = maneuver.instruction?.trim() || null

  // Prefer the live position-derived distance when the caller supplies one;
  // fall back to the maneuver event's own (slower-updating) distance.
  const liveDist =
    liveDistanceMeters != null && liveDistanceMeters >= 0 ? liveDistanceMeters : null
  const eventDist =
    maneuver.distanceMeters != null && maneuver.distanceMeters >= 0 ? maneuver.distanceMeters : null
  // DISPLAYED distance: live (smooth) when available, else the event's.
  const distanceMeters = liveDist ?? eventDist

  // "At turn" (and therefore whether to show a DIRECTIONAL arrow) must be gated
  // on the EVENT's own distance — NOT the live distance. Reason: `kind` (the
  // turn direction) comes from the maneuver EVENT, while `liveDist` is derived
  // from the live position against the route STEPS and can already be measuring
  // the turn AFTER the one `kind` describes. If we let liveDist decide atTurn,
  // there's a brief window right as you pass a turn where liveDist says "now"
  // but `kind` still points at the wrong/next turn — that's the flash of the
  // wrong arrow (right turn shows, then a left arrow blips before it settles).
  // Gating atTurn on eventDist keeps the arrow and its direction from the SAME
  // turn, so the glyph can never disagree with the distance that triggered it.
  const atTurn = eventDist != null && eventDist <= AT_TURN_M

  // Arrival leg (the LAST step) — show ONLY the destination countdown
  // ("Arriving in X m") and drop the turn instruction entirely: there are no
  // more turns, just the destination ahead. Fires for ANY ARRIVE maneuver,
  // even when Mapbox supplies an instruction string ("Your destination is on
  // the right.") — we deliberately replace that with the clean countdown.
  if (kind === "ARRIVE") {
    // On the arrival leg the relevant distance is to the destination. Prefer
    // the live distance (caller passes distance-to-destination here), else the
    // event's own toDest.
    const toDest = liveDist ?? maneuver.distanceToDestinationMeters
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

/**
 * Live distance (m) from the user's current position to the NEXT maneuver,
 * measured ALONG the route — the value that should drive the "In X m" line so
 * it ticks down on every location update (not only when a native maneuver event
 * fires). SHARED by the phone card and the glasses HUD so both recompute the
 * same number from the same live coords.
 *
 * `remaining` is the caller's `remainingRouteMeters(point, route)` implementation
 * (injected so this shared module stays free of a geometry import / cross-layer
 * dependency). Returns null when it can't be computed — caller then falls back
 * to the maneuver event's own distance.
 *
 * Algorithm: the next turn is the closest route step still AHEAD of the user.
 * Each step's remaining-along-route distance is measured the same way as the
 * user's, so `userRemaining - stepRemaining` is the live gap to that step.
 *
 * Robustness: some routes (e.g. a ferry leg) contain a huge coordinate
 * discontinuity that corrupts the along-route arithmetic, making every gap
 * negative or null. In that case we fall back to the STRAIGHT-LINE (haversine)
 * distance to the nearest step ahead, so the line never freezes. `straightLine`
 * is injected (like `remaining`) to keep this module dependency-free.
 */
export function liveDistanceToNextTurn(
  me: {lat: number; lng: number} | null,
  route: Array<{lat: number; lng: number}> | null,
  steps: Array<{lat: number; lng: number}> | null,
  remaining: (
    p: {lat: number; lng: number} | null,
    r: Array<{lat: number; lng: number}> | null,
  ) => number | null,
  straightLine?: (a: {lat: number; lng: number}, b: {lat: number; lng: number}) => number,
): number | null {
  if (!me || !route || route.length < 2 || !steps || steps.length === 0) return null

  // Primary: along-route gap to the closest step ahead of the user.
  const meRemaining = remaining(me, route)
  if (meRemaining != null) {
    let bestGap: number | null = null
    for (const s of steps) {
      const stepRemaining = remaining({lat: s.lat, lng: s.lng}, route)
      if (stepRemaining == null) continue
      const gap = meRemaining - stepRemaining
      if (gap <= 1) continue // behind us or essentially here — skip
      if (bestGap == null || gap < bestGap) bestGap = gap
    }
    if (bestGap != null) return bestGap
  }

  // Fallback: straight-line distance to the nearest step (when the along-route
  // math degenerates). Better a slightly-off live number than a frozen one.
  if (straightLine) {
    let best: number | null = null
    for (const s of steps) {
      const d = straightLine(me, {lat: s.lat, lng: s.lng})
      if (d <= 1) continue
      if (best == null || d < best) best = d
    }
    if (best != null) return best
  }

  return null
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
      return "Turn around"
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
