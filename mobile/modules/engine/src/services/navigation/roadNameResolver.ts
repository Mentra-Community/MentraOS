/**
 * Hybrid road-name resolver for Routes-API steps. Used to fill
 * `ComputedRouteStep.road` so miniapps don't have to parse instruction
 * prose or geocode themselves — every miniapp talking to the SDK sees
 * the same accurate names for preview AND live trip.
 *
 * Strategy per step:
 *   1. Parse "onto X" from the Routes-API instruction when present
 *      (the API literally tells us the road; no second-guessing).
 *   2. Fall back to reverse-geocoding the step MIDPOINT when the
 *      instruction has no road name ("Slight right", "Turn left toward
 *      …", "Destination will be on the right", bare depart steps).
 *
 * Endpoints get rejected as fallback probe points: they sit on
 * junctions and snap to whichever cross-street has higher weight;
 * the midpoint sits on the step's own road.
 *
 * This is a direct port of the resolver that used to live in the Nav
 * miniapp's NavigationPage.tsx. Lives on the host so all miniapps
 * benefit and so preview + live can share a single implementation.
 */

type StepLike = {
  lat: number
  lng: number
  endLat: number
  endLng: number
  instruction?: string
}

type ReverseGeocode = (coord: {lat: number; lng: number}) => Promise<{
  ok: boolean
  road?: string | null
  error?: string
}>

const DIRECTION_WORDS = new Set([
  "right",
  "left",
  "the right",
  "the left",
  "north",
  "south",
  "east",
  "west",
])

/**
 * Pull a short road name out of a Routes-API instruction. Instructions
 * look like:
 *   "Turn left onto Octavia Blvd"
 *   "Head northeast on Market St toward Octavia St"
 *   "Turn right onto Haight St\nDestination will be on the right"
 *
 * Pitfalls this guards against (seen in real data):
 *   - Multi-line: API appends "Destination will be on the right" etc.
 *     Only the first line is parsed, otherwise the greedy "on" match
 *     grabs "on the right" → "the right".
 *   - Trailing clauses ("… toward Octavia St", "… and continue"):
 *     cut at the first such keyword.
 *   - Unit suffixes: "Hayes St #116" → "Hayes St".
 *   - Bare direction words slipping through: rejected so the resolver
 *     falls back to geocoding instead of labeling a step "left".
 */
export function roadNameFromInstruction(instruction?: string): string | null {
  if (!instruction) return null
  const firstLine = instruction.split("\n")[0] ?? ""
  // Prefer "onto" (always immediately precedes the road); fall back to
  // "on" for depart steps ("Head north on Market St").
  const m = firstLine.match(/\bonto\s+(.+)$/i) ?? firstLine.match(/\bon\s+(.+)$/i)
  let raw = (m ? m[1] : "").trim()
  if (!raw) return null
  // Cut trailing direction/continuation clauses the API appends.
  raw = raw.split(/\s+(?:toward|towards|to|and|then|for)\b/i)[0]?.trim() ?? ""
  // Strip a unit/suite suffix.
  raw = raw.replace(/\s+#.*$/, "").trim()
  if (!raw) return null
  if (DIRECTION_WORDS.has(raw.toLowerCase())) return null
  return raw
}

/**
 * Resolve `road` for every step in a Routes-API step list. The
 * `reverseGeocode` callback is injected so this module stays free of
 * the host's network plumbing (and is unit-testable).
 *
 * Steps are resolved in parallel: parsed names land synchronously,
 * geocoded fallbacks fire concurrently. Order is preserved.
 */
export async function resolveStepRoads<S extends StepLike>(
  steps: S[],
  reverseGeocode: ReverseGeocode,
): Promise<Array<S & {road: string | null}>> {
  const probes = steps.map<Promise<string | null>>((s) => {
    const parsed = roadNameFromInstruction(s.instruction)
    if (parsed) return Promise.resolve(parsed)
    if (
      !Number.isFinite(s.lat) ||
      !Number.isFinite(s.lng) ||
      !Number.isFinite(s.endLat) ||
      !Number.isFinite(s.endLng)
    ) {
      return Promise.resolve(null)
    }
    const mid = {lat: (s.lat + s.endLat) / 2, lng: (s.lng + s.endLng) / 2}
    return reverseGeocode(mid)
      .then((r) => (r.ok ? r.road ?? null : null))
      .catch(() => null)
  })
  const roads = await Promise.all(probes)
  return steps.map((s, i) => ({...s, road: roads[i]}))
}
