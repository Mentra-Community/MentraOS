/**
 * @fileoverview Routes-API instruction parsing helpers for the pivot
 * engine.
 *
 * The Routes REST API returns per-step `navigationInstruction.instructions`
 * strings like "Turn left onto Octavia Blvd" that unambiguously name the
 * road being entered. Parsing these is the most reliable way to label a
 * turn — more reliable than `StepInfo.road` from the Android Nav SDK,
 * which lags one step behind for the live currentStep + uses a destination
 * placeholder for the arrival leg.
 *
 * Originally lived in the Navigation miniapp's NavigationPage.tsx; moved
 * into the SDK so every miniapp using `navigation.onPivot()` gets the
 * same accurate road names without having to re-implement the parser.
 *
 * All helpers are pure — no side effects, no shared state.
 */

import type {LatLng, ManeuverKind} from "../navigation"
import {bearingDeg, haversineMeters, signedAngleDiff} from "./geometry"

/**
 * Bare direction words that can sneak through the regex when the
 * instruction's "onto"/"on" clause is followed directly by a bare
 * direction ("Head south on the right"). Reject these so the parser
 * returns null and the caller can hide the label instead of showing
 * "the right" as a road name.
 */
const DIRECTION_WORDS = new Set(["right", "left", "the right", "the left", "north", "south", "east", "west"])

/**
 * Maneuver verbs that appear in stacked instructions like
 * "Turn left, then turn right onto Linden St" or fragments like
 * "Continue onto Octavia". If a captured "road" contains any of
 * these, it's not a road name — it's leftover instruction syntax
 * from a multi-clause sentence. The parser rejects the capture.
 */
const MANEUVER_VERBS = /\b(turn|slight|sharp|continue|head|merge|exit|uturn|u-turn|then|keep)\b/i

/**
 * Pull a short road name out of a Routes-API instruction string.
 * Instructions look like:
 *   "Turn left onto Octavia Blvd"
 *   "Slight right onto Octavia St"
 *   "Turn right onto Haight St\nDestination will be on the right"
 *
 * Returns null when the parse fails (e.g. instruction is missing, the
 * "onto" clause is absent, or the captured text contains another
 * maneuver verb / direction word). Callers treat null as "no road
 * name available" and hide the label.
 *
 * Only "onto" is matched here — `\bon\b` was previously used as a
 * fallback for depart steps ("Head north on Market St") but it
 * over-matched, capturing maneuver verbs from stacked instructions
 * ("Turn left, then turn right on..."). The depart step is the
 * very first step and is dropped by the slice(0, -1) loop before
 * this parser is called anyway, so removing the fallback costs us
 * nothing real.
 */
export function roadNameFromInstruction(instruction?: string | null): string | null {
  if (!instruction) return null
  // Only the first line — drop "Destination will be on the right" etc.
  const firstLine = instruction.split("\n")[0] ?? ""
  // Match "onto ROAD" only. The "on" fallback was removed because it
  // matched inside maneuver fragments and captured verbs as fake road
  // names. Real turn instructions always use "onto"; depart steps
  // (the only legitimate "on" users) aren't passed through this path.
  const m = firstLine.match(/\bonto\s+(.+)$/i)
  let raw = (m ? m[1] : "").trim()
  if (!raw) return null
  // A captured road name never contains a comma. If it does, we
  // grabbed the rest of a multi-clause sentence by mistake.
  if (raw.includes(",")) return null
  // Cut trailing direction/continuation clauses the API appends.
  raw = raw.split(/\s+(?:toward|towards|to|and|then|for)\b/i)[0]?.trim() ?? ""
  // Strip a unit/suite suffix ("Hayes St #116" → "Hayes St").
  raw = raw.replace(/\s+#.*$/, "").trim()
  if (!raw) return null
  // Reject a bare direction word that slipped through.
  if (DIRECTION_WORDS.has(raw.toLowerCase())) return null
  // Reject anything containing maneuver verbs — the regex caught the
  // wrong clause of a stacked instruction. Real road names don't
  // contain "turn", "slight", "continue", etc.
  if (MANEUVER_VERBS.test(raw)) return null
  return raw
}

/**
 * Equality check for road names that's robust to suffix variation
 * ("Gough St" vs "Gough Street"), case, and trailing punctuation.
 * Used to drop "stay on the same road" turns where the routes API
 * names a turn but the user perceives a single continuous street.
 */
const ROAD_SUFFIXES =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|hwy|highway)\b\.?/g
function normalizeRoad(road: string): string {
  return road.toLowerCase().replace(ROAD_SUFFIXES, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim()
}
export function sameRoad(a: string, b: string): boolean {
  return normalizeRoad(a) === normalizeRoad(b)
}

/**
 * Coarse left/right classifier for a maneuver string. Collapses all
 * left variants (TURN_LEFT, SLIGHT_LEFT, SHARP_LEFT, UTURN_LEFT) to
 * "left" and the rights to "right". Returns null when the maneuver
 * isn't a directional turn (STRAIGHT, NAME_CHANGE, ARRIVE, etc.).
 */
export function turnDirection(maneuver?: string | null): "left" | "right" | null {
  if (!maneuver) return null
  const m = maneuver.toUpperCase()
  if (m.includes("LEFT")) return "left"
  if (m.includes("RIGHT")) return "right"
  return null
}

/**
 * How sharply the polyline actually bends at a given junction, in
 * degrees [0, 180]. Probe walks outward from the polyline point
 * nearest the junction until ~PROBE_METERS in each direction, then
 * compares incoming vs outgoing bearings. The wide probe (22m) is
 * deliberate: real street corners are rounded over 20–30m and a
 * tighter probe under-reports the angle.
 *
 * Used to drop phantom turns the Routes API names at complex
 * interchanges (Market → Gough → Market) where the drawn polyline is
 * visually one straight line. Returns null when the polyline is too
 * short to measure.
 */
const PROBE_METERS = 22
export function bendAngleAt(points: LatLng[], junction: LatLng): number | null {
  const signed = signedBendAt(points, junction)
  return signed == null ? null : Math.abs(signed)
}

/**
 * Signed polyline bend at a junction. Positive = right turn, negative
 * = left turn, in [-180, 180]. Used to pick a pivot's left/right
 * direction from geometry when the Routes API's first-step maneuver
 * is misleading (e.g. a curb-alignment micro-jog labeled TURN_LEFT
 * right before the real right turn off Hayes onto Gough).
 */
export function signedBendAt(points: LatLng[], junction: LatLng): number | null {
  if (points.length < 3) return null
  let mid = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = haversineMeters(points[i], junction)
    if (d < bestDist) {
      bestDist = d
      mid = i
    }
  }
  let before = mid
  while (before > 0 && haversineMeters(points[before], points[mid]) < PROBE_METERS) before--
  let after = mid
  while (after < points.length - 1 && haversineMeters(points[after], points[mid]) < PROBE_METERS) after++
  if (before === mid || after === mid) return null
  const incoming = bearingDeg(points[before], points[mid])
  const outgoing = bearingDeg(points[mid], points[after])
  return signedAngleDiff(outgoing, incoming)
}

/**
 * Minimum bend (degrees) for a junction to count as a real turn worth
 * a pivot. Below this the route is effectively straight through the
 * point; the Routes API may name it as a turn for legal/lane reasons
 * but the user perceives no direction change.
 */
export const MIN_TURN_ANGLE_DEG = 30

/**
 * Shape of a Routes-API computed step (matches `ComputedRouteStep` in
 * the navigation module). Re-declared locally to avoid a circular
 * import; the field set this helper needs is small.
 */
type ComputedStep = {
  lat: number
  lng: number
  endLat: number
  endLng: number
  distanceMeters: number
  maneuver?: ManeuverKind
  instruction?: string
  /**
   * Pre-resolved road name from the host's hybrid resolver (Phase 1).
   * Preferred over `instruction` parsing when present — same parser
   * runs host-side, just earlier in the pipeline. Older callers that
   * only pass `instruction` still work via the parse fallback below.
   */
  road?: string | null
}

/**
 * A pivot derived from Routes-API computed steps. Carries the
 * instruction-parsed road labels alongside the geometric corner,
 * ready to be merged into the SDK's `Pivot` shape by the caller.
 *
 * `fromRoad` is required — we drop pivots whose entry road couldn't
 * be parsed. `toRoad` is nullable because the LAST real turn before
 * arrival has a known fromRoad but unknown toRoad (the arrival
 * step's instruction is "Destination will be on the right", no road
 * name in it). The pivot engine treats those nulls as candidates
 * for the reverse-geocode fallback.
 */
export type InstructionPivot = {
  lat: number
  lng: number
  fromRoad: string
  toRoad: string | null
  direction: "left" | "right" | null
  maneuver: ManeuverKind
}

/**
 * Derive accurate turn pivots from a Routes-API step list. Each
 * computed step's `instruction` describes the maneuver that BEGINS
 * that step ("Turn left onto Guerrero St"). A pivot sits at
 * `step[i].end` — the junction where you leave step[i]'s road and
 * turn onto step[i+1]'s road. So for each pair (step[i], step[i+1]):
 *
 *   fromRoad = roadNameFromInstruction(step[i].instruction)
 *   toRoad   = roadNameFromInstruction(step[i+1].instruction)
 *   anchor   = (step[i].endLat, step[i].endLng)
 *   maneuver = step[i+1].maneuver (the actual turn type at the corner)
 *
 * A pivot survives these filters:
 *   1. `fromRoad` parsed successfully from step[i]'s instruction.
 *      Drop the pivot otherwise — we don't know the road the user
 *      came from, and labeling the dot wouldn't make sense.
 *   2. If `toRoad` parsed too, it must differ from `fromRoad` (drop
 *      "stay on same road" jogs). If `toRoad` failed to parse, keep
 *      the pivot with `toRoad: null` so the engine can recover it
 *      via reverse-geocode. This is what keeps the LAST real turn
 *      before arrival in the list — that step's instruction is
 *      "Destination will be on the right" with no road name, but
 *      the turn itself is real and the user needs to see it.
 *   3. The drawn polyline bends ≥ MIN_TURN_ANGLE_DEG at the junction
 *      (drops phantom turns where the geometry is visually straight).
 *
 * The LAST step (the arrival leg itself) is dropped by slice(0, -1) —
 * the destination isn't a turn.
 *
 * Mirrors the Navigation miniapp's preview-turn extraction so live
 * pivots match preview accuracy.
 */
export function extractPivotsFromComputedSteps(
  steps: ComputedStep[] | undefined,
  polyline: LatLng[],
): InstructionPivot[] {
  if (!steps || steps.length < 2) return []

  // Phantom A→B→A collapse. The Routes API sometimes decomposes a
  // single perceived turn into 3-5 micro-steps that briefly bounce
  // onto an intersecting road and back ("Market → Octavia → Market →
  // Gough" for a single right turn off Market onto Gough). Walking
  // the resolved road sequence and dropping any single-entry sandwich
  // between two same-road entries collapses those jogs before we
  // pair adjacent entries into pivots — otherwise the extractor emits
  // a bogus "Market → Octavia" pivot AND a bogus "Octavia → Market"
  // pivot at the same corner. Repeated up to 4 passes to catch
  // A,B,A,B,A patterns where the same intersection contributes more
  // than one jog.
  //
  // Mirrors the collapse pass the Navigation miniapp runs before
  // building its preview/live turn dots — moving it here means every
  // downstream consumer (the on-screen banner, the glasses display)
  // gets the corrected pivots without each rebuilding the logic.
  type Annotated = {stepIdx: number; name: string | null}
  const initial: Annotated[] = steps.map((s, i) => ({
    stepIdx: i,
    name: s.road ?? roadNameFromInstruction(s.instruction),
  }))
  let annotated = initial
  for (let pass = 0; pass < 4; pass++) {
    const collapsed: Annotated[] = []
    for (let i = 0; i < annotated.length; i++) {
      const prev = collapsed[collapsed.length - 1]
      const here = annotated[i]
      const next = annotated[i + 1]
      if (
        prev?.name &&
        next?.name &&
        here.name &&
        !sameRoad(prev.name, here.name) &&
        sameRoad(prev.name, next.name)
      ) {
        // `here` is a sandwiched micro-jog — drop it. `next` will be
        // collapsed against `prev` on the same-road check below.
        continue
      }
      collapsed.push(here)
    }
    if (collapsed.length === annotated.length) break
    annotated = collapsed
  }

  const out: InstructionPivot[] = []
  // Pair each annotated entry with the next one. Note we no longer
  // walk `steps` directly — `annotated` is the collapsed view, so
  // adjacent annotated entries already represent the real road
  // transitions. `stepIdx` is preserved so we can still look up the
  // junction coordinates and maneuver from the original `steps` array.
  for (let i = 0; i < annotated.length - 1; i++) {
    const here = annotated[i]
    const nextAnn = annotated[i + 1]
    const s = steps[here.stepIdx]
    const next = steps[nextAnn.stepIdx]
    const fromRoad = here.name
    const toRoad = nextAnn.name
    // fromRoad is required; toRoad is nullable (last-turn-before-arrival
    // has no road name in the arrival step's instruction).
    if (!fromRoad) continue
    if (toRoad && sameRoad(fromRoad, toRoad)) continue
    if (!Number.isFinite(s.endLat) || !Number.isFinite(s.endLng)) continue

    const junction = {lat: s.endLat, lng: s.endLng}
    const signedBend = signedBendAt(polyline, junction)
    // No polyline to measure → keep (don't drop a labeled turn just
    // because geometry was unavailable).
    if (signedBend != null && Math.abs(signedBend) < MIN_TURN_ANGLE_DEG) continue

    // Direction precedence: trust polyline geometry first. The Routes
    // API decomposes some junctions into micro-step jogs whose first
    // step's maneuver lies (e.g. a "TURN_LEFT" curb-alignment jog
    // right before the actual right turn off Hayes onto Gough).
    // Geometry doesn't lie. Falls back to the maneuver string when
    // the polyline is too short to measure a bend.
    const geomDir: "left" | "right" | null =
      signedBend == null ? null : signedBend > 0 ? "right" : "left"
    const direction = geomDir ?? turnDirection(next.maneuver)

    out.push({
      lat: s.endLat,
      lng: s.endLng,
      fromRoad,
      toRoad,
      direction,
      maneuver: next.maneuver ?? (direction === "left" ? "TURN_LEFT" : "TURN_RIGHT"),
    })
  }
  return out
}
