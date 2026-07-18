import {useEffect, useRef, useState} from "react"
import type {NavManeuver, TravelMode} from "@mentra/miniapp"
import {useRpc} from "@mentra/miniapp/ui"

import "@/shared/channels"
import type {Channels} from "@/shared/channels"
import type {LatLng, LogEntry, NavStatus, PlaceDetails, SavedPlace} from "@/shared/types"
import {useRouter} from "@/ui/router"
import {useNavStore} from "@/ui/store/navStore"
import {reverseGeocode} from "@/ui/lib/reverseGeocode"
import {bearingDeg, haversineMeters, signedAngleDiff} from "@/ui/lib/geometry"
import {DrawerOffsetProvider} from "@/ui/components/Drawer/DrawerOffsetContext"
import {FloatingDevPanel} from "@/ui/components/FloatingDevPanel/FloatingDevPanel"
import {useToast} from "@/ui/components/Toast/Toast"
import {appVersion, isDev} from "@/ui/lib/env"
import {toggleDevOverride, useDevOverride} from "@/ui/lib/devOverride"
import {SimulationControls} from "@/ui/pages/NavigationPage/components/Controls/Controls"
import {ArrivalDrawer} from "@/ui/pages/NavigationPage/components/ArrivalDrawer/ArrivalDrawer"
import {DestinationPreviewDrawer} from "@/ui/pages/NavigationPage/components/DestinationPreviewDrawer/DestinationPreviewDrawer"
import {IdleDrawer} from "@/ui/pages/NavigationPage/components/IdleDrawer/IdleDrawer"
import {NavigationRunningDrawer} from "@/ui/pages/NavigationPage/components/NavigationRunningDrawer/NavigationRunningDrawer"
import {DeviateButton} from "@/ui/pages/NavigationPage/components/DeviateButton/DeviateButton"
import {LiveLog} from "@/ui/pages/NavigationPage/components/LiveLog/LiveLog"
import {LocationSearch} from "@/ui/pages/NavigationPage/components/LocationSearch/LocationSearch"
import {RawMapPage} from "@/ui/pages/RawMapPage/RawMapPage"
import {OrientationCard} from "@/ui/pages/NavigationPage/components/OrientationCard/OrientationCard"
import {MyLocationCard} from "@/ui/pages/NavigationPage/components/MyLocationCard/MyLocationCard"
import {NavMap} from "@/ui/pages/NavigationPage/components/NavMap/NavMap"
import {safeHeadingManuverCard} from "@/ui/components/SafeHeading/SafeHeading"

const DEV_DESTINATION: PlaceDetails = {
  placeId: "dev",
  name: "Ferry Building",
  address: "1 Ferry Building, San Francisco, CA",
  lat: 37.7955,
  lng: -122.3937,
}
// A previewed turn point: the road-name label for the dot, plus the
// coarse turn direction ("Turn left"/"Turn right") as metadata — the
// prompt we'd give the user within this dot's radius. `direction` is
// null when the maneuver wasn't directional.
type PreviewTurn = {
  lat: number
  lng: number
  label: string | null
  direction: "Turn left" | "Turn right" | null
}

// Build the "fromRoad → toRoad" label for a turn dot. Both sides are
// always present by the time we call this (the caller drops turns with a
// missing or same-road side), so this is just the join.
function joinRoads(fromRoad: string, toRoad: string): string {
  return `${fromRoad} → ${toRoad}`
}

// Normalize a road name for equality checks so "Gough St" and "Gough
// Street" (or trailing punctuation/case) compare equal. Used to drop
// "stay on the same road" turns like "Turn right to stay on Gough St".
const ROAD_SUFFIXES =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|ter|terrace|hwy|highway)\b\.?/g
function normalizeRoad(road: string): string {
  return road.toLowerCase().replace(ROAD_SUFFIXES, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim()
}
function sameRoad(a: string, b: string): boolean {
  return normalizeRoad(a) === normalizeRoad(b)
}

// How sharply the drawn route actually bends at `junction`, in degrees
// [0, 180]. We trust the POLYLINE, not the step instructions: the Routes
// API names "turns" (Market → Gough → Market) at complex interchanges
// where the path is visually one straight line. Measuring the real bend
// lets us drop those phantom turns and keep only places the line clearly
// changes direction.
//
// Method: find the polyline point nearest the junction, then walk
// outward in each direction until we're ~PROBE_METERS away (so a dense
// cluster of points right at the junction doesn't make every tiny jog
// look like a turn). Compare the incoming bearing to the outgoing one.
// Returns null when the polyline is too short to measure.
//
// PROBE_METERS is deliberately wide (~22m): real street corners are
// often ROUNDED, spreading the directional change over a 20-30m arc. A
// tight probe (e.g. 12m) only sees part of that arc and under-reports
// the angle, so a genuine 90° turn onto a side street can read ~40° and
// (with a stricter threshold) get wrongly dropped. Sampling wider
// captures the full bend. Trade-off: too wide bleeds into adjacent
// turns — 22m stays well under a typical SF block (~80m).
const PROBE_METERS = 22

// Snap an arbitrary lat/lng to the closest vertex on the drawn polyline,
// but only if the nearest vertex is within MAX_SNAP_M of the target. The
// Routes API gives us step endpoints in raw road-network coordinates,
// but the polyline drawn on the map is road-SNAPPED by the host
// (snapPolylineToRoads). The two spaces drift by a few meters at
// intersections, so snapping fixes that. BUT some routes have sparse
// polylines — only vertices at major corners — and a step endpoint
// without a nearby vertex would snap to a far-away corner and land the
// dot in the wrong intersection. The cap rejects those snaps and falls
// back to the raw endpoint, which is at least on the right corner even
// if a few meters off the drawn line.
const MAX_SNAP_M = 25
function snapToPolyline(points: LatLng[], target: LatLng): LatLng {
  if (points.length === 0) return target
  let best = points[0]
  let bestDist = haversineMeters(best, target)
  for (let i = 1; i < points.length; i++) {
    const d = haversineMeters(points[i], target)
    if (d < bestDist) {
      bestDist = d
      best = points[i]
    }
  }
  return bestDist <= MAX_SNAP_M ? best : target
}

// Signed polyline bend at a junction: positive = right turn, negative =
// left turn, value is the [-180, 180] angle between incoming and outgoing
// bearings. Used to pick "Turn left"/"Turn right" from geometry instead
// of from the Routes API's first-step maneuver, which lies at junctions
// the API decomposes into micro-step jogs (e.g. a sidewalk-aligned
// "TURN_LEFT" jog right before the real right turn off Hayes onto
// Gough). Geometry doesn't lie. Callers needing the absolute bend (for
// the MIN_TURN_ANGLE_DEG filter) can `Math.abs(...)` the result.
function signedBendAt(points: LatLng[], junction: LatLng): number | null {
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

// Minimum bend (degrees) for a junction to count as a real turn worth a
// dot. Below this the route is effectively straight through the point.
// Kept moderate (30°) so a gradual/rounded corner onto a side street
// still qualifies, while the near-straight phantom jogs the Routes API
// reports at complex interchanges (Market → Gough → Market) stay out.
const MIN_TURN_ANGLE_DEG = 30

// Coarse left/right direction for a turn dot's metadata, from the
// maneuver of the step that BEGINS at the dot. Collapses all left
// variants (TURN_LEFT, TURN_SLIGHT_LEFT, TURN_SHARP_LEFT, UTURN_LEFT) to
// "Turn left" and the rights to "Turn right" — we don't surface slight/
// sharp. Returns null when the maneuver isn't directional.
function turnDirection(maneuver?: string): "Turn left" | "Turn right" | null {
  if (!maneuver) return null
  const m = maneuver.toUpperCase()
  if (m.includes("LEFT")) return "Turn left"
  if (m.includes("RIGHT")) return "Turn right"
  return null
}

let logIdSeq = 0

type Props = {
  savedPlacesVersion?: number
}

export function NavigationPage({savedPlacesVersion = 0}: Props) {
  // ---- dev override --------------------------------------------------------
  //
  // Production builds hide the FloatingDevPanel by default. Holding the
  // search bar for 5s toggles a persisted flag that re-enables it; see
  // the search-area wrapper below for the gesture handler. The hook
  // returns true in prod when the user has unlocked, and false
  // otherwise. Dev builds ignore this entirely — `isDev` is already
  // true there.
  const devOverride = useDevOverride()
  const devEnabled = isDev || devOverride

  // ---- store reads ---------------------------------------------------------
  //
  // Trip/sensor state is owned by the background NavigationController and
  // pushed to the UI via the typed channel registry. The local
  // `useNavStore` mirror exposes those values as React state.
  const coords = useNavStore((s) => s.coords)
  const heading = useNavStore((s) => s.heading)
  const trip = useNavStore((s) => s.trip)
  const running = trip.running
  const status = trip.status
  const maneuver = trip.maneuver
  const routePoints = trip.routePoints
  const routeSteps = trip.routeSteps
  const activeDestination = trip.activeDestination
  const activeDestinationName = trip.activeDestinationName
  const offRouteAt = trip.offRouteAt
  const voiceGuidanceMode = useNavStore((s) => s.voiceGuidanceMode)
  const capabilities = useNavStore((s) => s.capabilities)

  const computeRoute = useRpc<Channels, "nav:compute-route">("nav:compute-route")

  // Show a "Rerouting" toast when Mapbox decides to reroute. The native
  // engine flips trip.status to "rerouting" (via its RerouteStateObserver),
  // which arrives here through nav:trip-state. We fire the toast only on the
  // TRANSITION into rerouting (tracked via a ref) so it doesn't re-toast on
  // every render while the status stays "rerouting".
  const toast = useToast()
  const wasReroutingRef = useRef(false)
  useEffect(() => {
    const isRerouting = status === "rerouting"
    if (isRerouting && !wasReroutingRef.current) {
      toast("Rerouting")
    }
    wasReroutingRef.current = isRerouting
  }, [status, toast])

  // ---- page-local UI state -------------------------------------------------
  const {push} = useRouter()
  const [destination, setDestination] = useState<PlaceDetails | null>(null)
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  // Local refetch trigger — bumped when the preview drawer's star toggles
  // a save, so `savedPlaces` reflects the change without round-tripping
  // through App's savedPlacesVersion.
  const [localSavedVersion, setLocalSavedVersion] = useState(0)

  // Hydrate saved places so the map can drop home / work / starred
  // markers behind whatever destination is selected. Refetched on
  // savedPlacesVersion change (AddPlacePage onSave bumps it after a
  // successful `storage:add-saved`) or on a local star toggle.
  useEffect(() => {
    let cancelled = false
    mentra
      .request("storage:list-saved", undefined as never)
      .then((places) => {
        if (cancelled) return
        setSavedPlaces(places)
      })
      .catch(() => {
        if (cancelled) return
        setSavedPlaces([])
      })
    return () => {
      cancelled = true
    }
  }, [savedPlacesVersion, localSavedVersion])

  // Star toggle from the preview drawer: persist via storage RPC, then
  // refetch. Returns the new saved-state so the drawer can update its
  // icon optimistically.
  const handleToggleSaved = async (place: PlaceDetails, shouldSave: boolean) => {
    try {
      if (shouldSave) {
        await mentra.request("storage:add-saved", {...place})
      } else {
        await mentra.request("storage:remove-saved", {placeId: place.placeId})
      }
    } finally {
      setLocalSavedVersion((v) => v + 1)
    }
  }

  const [simulatorMode, setSimulatorMode] = useState(false)
  const [searchFrozen, setSearchFrozen] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  // Dynamic bitmap-size test inputs (dev panel).
  const [bmpWidth, setBmpWidth] = useState("200")
  const [bmpHeight, setBmpHeight] = useState("88")
  const [rawMapOpen, setRawMapOpen] = useState(false)
  const [showPivots, setShowPivots] = useState(false)
  const [showOffRouteLine, setShowOffRouteLine] = useState(false)
  const [showMinimap, setShowMinimap] = useState(true)
  const [devTab, setDevTab] = useState<"nav" | "display">("nav")

  // Swallow every long-press-derived `contextmenu` event app-wide
  // while the search drawer is open. Kills the map's drop-pin
  // gesture, the OS's copy/share callout, and any other long-press
  // behavior in one shot — no per-component plumbing needed.
  useEffect(() => {
    if (!isSearching) return
    const swallow = (e: Event) => e.preventDefault()
    window.addEventListener("contextmenu", swallow, {capture: true})
    return () => window.removeEventListener("contextmenu", swallow, {capture: true} as any)
  }, [isSearching])
  const [devDrawer, setDevDrawer] = useState<"auto" | "idle" | "preview" | "running" | "arrived">("auto")
  const [simulate, setSimulate] = useState(false)
  const [speedMultiplier, setSpeedMultiplier] = useState(5)
  const [wrongSidewalk, setWrongSidewalk] = useState(false)
  const [useRawInstructions, setUseRawInstructions] = useState(true)
  const [largeMapEnabled, setLargeMapEnabled] = useState(false)
  const [travelMode, setTravelMode] = useState<TravelMode>("walking")

  // Sticky off-route banner. The upstream `offRouteAt` flag only lives
  // for the ~100ms gap between the SDK's `off_route` event and the
  // controller flipping status to "rerouting" — too short to read.
  // Latch it on the rising edge so the user sees the recalculating notice
  // (plus spinner) while the route is being rebuilt.
  //
  // Dismissal is driven by route progress, NOT just a fixed timer: Mapbox
  // emits `off_route` on EVERY tick while you're off the path, so
  // `offRouteAt` keeps changing and a `[offRouteAt]`-keyed timeout would
  // restart forever — leaving the banner stuck. So we clear it the moment
  // the trip is back to live navigation (a fresh route was fetched), with
  // a max-duration safety timer as a backstop in case that signal is
  // missed.
  const OFF_ROUTE_STICKY_MS = 8_000
  const [offRouteSticky, setOffRouteSticky] = useState(false)
  useEffect(() => {
    if (offRouteAt == null) return
    setOffRouteSticky(true)
    // Backstop only — normal dismissal comes from the status effect below.
    const t = setTimeout(() => setOffRouteSticky(false), OFF_ROUTE_STICKY_MS)
    return () => clearTimeout(t)
  }, [offRouteAt])
  // Clear the banner as soon as navigation resumes on a fresh route. The
  // reroute lifecycle is: navigating → (off_route) → rerouting →
  // navigating. Once we're back to "navigating" the new route is in hand,
  // so the recalculating notice has served its purpose.
  useEffect(() => {
    if (status === "navigating") setOffRouteSticky(false)
  }, [status])

  const [previewRoutePoints, setPreviewRoutePoints] = useState<LatLng[] | null>(null)
  // Dev-only: turn points along the previewed route, used to draw red
  // debug dots (with a road-name label) on the map. Derived from the
  // computed route's step list (available at computeRoute time, before a
  // trip starts — unlike the SDK's getPivots(), which only populates
  // once navigation is running).
  const [previewTurns, setPreviewTurns] = useState<PreviewTurn[] | null>(null)
  // Live counterpart to previewTurns — rebuilt from the active trip's
  // route (routePoints + routeSteps from the nav:route channel) so the
  // same red "fromRoad → toRoad / Turn left|right" dots that appear in
  // preview also appear while navigating. Null when no trip is active
  // or when steps haven't arrived yet.
  const [liveTurns, setLiveTurns] = useState<PreviewTurn[] | null>(null)
  // Route-aware totals from computeRoute (mode-correct, follows the actual
  // walking path rather than crow-flies). Cleared when destination changes
  // or trip ends. Drawers prefer these over recomputing.
  const [previewRouteSummary, setPreviewRouteSummary] = useState<{
    distanceMeters: number
    durationSeconds: number
  } | null>(null)
  // Devloop local log — distinct from the background broadcast log
  // accessible via the store. Lives here so the FloatingDevPanel can
  // mutate it directly without round-tripping a channel.
  const [log, setLog] = useState<LogEntry[]>([])

  function append(line: string) {
    setLog((prev) => [{id: ++logIdSeq, ts: Date.now(), line}, ...prev].slice(0, 100))
  }

  // Fetch a preview route whenever destination changes and we're not navigating
  useEffect(() => {
    if (running || !destination || !coords) {
      setPreviewRoutePoints(null)
      setPreviewRouteSummary(null)
      setPreviewTurns(null)
      return
    }
    // Guards the async geocode fallback below: a newer preview (or trip
    // start) can land while reverse-geocoding is in flight, and we must
    // not let a stale result overwrite the current turns.
    let cancelled = false
    computeRoute.abort()
    const origin = {lat: coords.lat, lng: coords.lng}
    // Walking mode for the actual routing (correct pedestrian rules,
    // correct ETA, allows pedestrian-only paths). The host snaps the
    // returned polyline to road centerlines before sending it back so
    // the rendered line + pivot anchors are on roads, not sidewalks —
    // see snapPolylineToRoads on the host side.
    computeRoute({
      origin,
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
    })
      .then((result) => {
        if (cancelled) return
        const route = result.routes?.[0]
        const pts = route?.points ?? null
        setPreviewRoutePoints(pts)
        if (typeof route?.totalDistanceMeters === "number" && typeof route?.totalDurationSeconds === "number") {
          setPreviewRouteSummary({
            distanceMeters: route.totalDistanceMeters,
            durationSeconds: route.totalDurationSeconds,
          })
        } else {
          setPreviewRouteSummary(null)
        }
        if (!route?.steps || route.steps.length === 0) {
          setPreviewTurns(null)
          return
        }
        // Dev debug dots: a red dot at each real turn, labeled "fromRoad
        // → toRoad". A Routes-API step's `instruction` describes the
        // maneuver that BEGINS that step ("Turn left onto Guerrero St").
        // The dot sits at step[i].end — the junction where you leave
        // step[i]'s road and turn onto step[i+1]'s road. So:
        //   fromRoad = road parsed from THIS step's instruction
        //   toRoad   = road parsed from the NEXT step's instruction
        //
        // A dot survives THREE filters:
        //   1. Both roads named in the instruction. Roadless micro-turns
        //      ("Slight right") parse to null — nothing to label, skip.
        //   2. The roads differ. "Turn right to stay on Gough St" is
        //      Gough → Gough; not a road change a human would mark.
        //   3. The DRAWN POLYLINE actually bends ≥ MIN_TURN_ANGLE_DEG at
        //      the junction. This is the key one: at complex interchanges
        //      the API names turns (Market → Gough → Market) where the
        //      path is visually one straight line. We trust the geometry,
        //      not the instruction, and drop those phantom turns.
        // The LAST step (the destination) is dropped by slice(0, -1).
        const steps = route.steps
        const polyline = pts ?? []
        // Dev testing rig: log the ordered list of roads this previewed
        // route covers, then derive the turn-dot list from it. Fires
        // once per preview and never during a live trip (the `running`
        // guard at the top of the effect skips it).
        //
        // Road names come from `step.road`, filled by the host's
        // resolver — parsed "onto X" from the instruction when present,
        // midpoint reverse-geocoded otherwise. We just consume them.
        // Collapse "A → B → A" ping-pongs in the resolved road
        // sequence first. Routes API sometimes decomposes a single
        // crosswalk into 3-5 micro-steps ("Turn right toward X",
        // "Turn left toward X", ...) that briefly bounce onto an
        // intersecting road and back. If we see a single entry of a
        // different road sandwiched between two same-road entries
        // (A, B, A) we drop B. Repeated to catch A,B,A,B,A.
        const annotated = (() => {
          let cur = steps.map((s, i) => ({stepIdx: i, name: s.road ?? null}))
          for (let pass = 0; pass < 4; pass++) {
            const out: typeof cur = []
            for (let i = 0; i < cur.length; i++) {
              const prev = out[out.length - 1]
              const next = cur[i + 1]
              if (
                prev?.name &&
                next?.name &&
                cur[i].name &&
                !sameRoad(prev.name, cur[i].name!) &&
                sameRoad(prev.name, next.name)
              ) {
                continue
              }
              out.push(cur[i])
            }
            if (out.length === cur.length) break
            cur = out
          }
          return cur
        })()
        const roads: string[] = []
        for (const a of annotated) {
          if (!a.name) continue
          if (roads.length > 0 && sameRoad(roads[roads.length - 1], a.name)) continue
          roads.push(a.name)
        }
        console.log(`[NavPreview] roads: ${roads.join(" → ")}`)
        // Step trace — useful when a road in the list looks wrong, to
        // see which step contributed it.
        console.log(
          `[NavPreview] resolution:\n` +
            annotated
              .map((a) => `  step ${a.stepIdx} → ${a.name ?? "(none)"}`)
              .join("\n"),
        )
        console.log(
          `[NavPreview] step instructions:\n` +
            steps
              .map((s, i) => `  step ${i}: ${(s.instruction ?? "(no instruction)").replace(/\n/g, " | ")}`)
              .join("\n"),
        )
        const stride = Math.max(1, Math.ceil(polyline.length / 30))
        const sampled = polyline.filter((_, i) => i % stride === 0 || i === polyline.length - 1)
        console.log(
          `[NavPreview] polyline (${polyline.length} pts, showing ${sampled.length}):\n` +
            sampled.map((p, i) => `  ${i}: ${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`).join("\n"),
        )

        // Turn dots: one per road→road transition. A transition is
        // "real" when the resolved road actually changes — sequential
        // steps on the same road collapse into one dot at the change.
        // The dot sits at the END of the LAST step on the outgoing
        // road, which is the junction where the user actually turns.
        // Direction comes from the maneuver of the first step on the
        // incoming road.
        const dots: PreviewTurn[] = []
        for (let i = 0; i < annotated.length - 1; i++) {
          const here = annotated[i]
          const next = annotated[i + 1]
          if (!here.name || !next.name) continue
          if (sameRoad(here.name, next.name)) continue
          const junction = steps[here.stepIdx]
          if (!Number.isFinite(junction.endLat) || !Number.isFinite(junction.endLng)) continue
          const signedBend = signedBendAt(polyline, {lat: junction.endLat, lng: junction.endLng})
          if (signedBend != null && Math.abs(signedBend) < MIN_TURN_ANGLE_DEG) continue
          // Snap to the raw polyline so dots land on actual route
          // vertices; falls back to the raw endpoint when no vertex is
          // within MAX_SNAP_M.
          const snapped = snapToPolyline(polyline, {lat: junction.endLat, lng: junction.endLng})
          // Direction precedence: geometry first, maneuver fallback.
          // See the live builder for context.
          const geomDir = signedBend == null ? null : signedBend > 0 ? "Turn right" : "Turn left"
          dots.push({
            lat: snapped.lat,
            lng: snapped.lng,
            label: joinRoads(here.name, next.name),
            direction: (geomDir ?? turnDirection(steps[next.stepIdx].maneuver)) as PreviewTurn["direction"],
          })
        }
        // Coalesce dots that snapped to the same junction (roadless
        // connectors splitting a single perceived turn into two API
        // steps). The merged label spans the outer roads, skipping the
        // connector. 6m chosen so two distinct turns at opposite corners
        // of a narrow street (~20m apart) survive.
        const MERGE_RADIUS_M = 6
        const merged: PreviewTurn[] = []
        for (const d of dots) {
          const prev = merged[merged.length - 1]
          if (prev && haversineMeters(prev, d) < MERGE_RADIUS_M) {
            const prevFrom = prev.label?.split(" → ")[0] ?? null
            const dTo = d.label?.split(" → ")[1] ?? null
            merged[merged.length - 1] = {
              lat: d.lat,
              lng: d.lng,
              label: prevFrom && dTo ? `${prevFrom} → ${dTo}` : (d.label ?? prev.label),
              direction: d.direction ?? prev.direction,
            }
            continue
          }
          merged.push(d)
        }
        if (cancelled) return
        setPreviewTurns(merged)
        console.log(
          `[NavPreview] turns (${merged.length}, ${dots.length - merged.length} merged):\n` +
            merged
              .map(
                (d, i) =>
                  `  ${i}: ${d.label}${d.direction ? ` (${d.direction})` : ""} @ (${d.lat.toFixed(5)}, ${d.lng.toFixed(5)})`,
              )
              .join("\n"),
        )
      })
      .catch(() => {
        // Aborted or failed — preview just stays blank.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, destination?.lat, destination?.lng, coords?.lat, coords?.lng])

  // Live turn dots — same shape and logic as the preview block above,
  // but fed by the active trip's `routeSteps + routePoints` from the
  // store (populated by the nav:route channel). Mirroring preview's
  // ping-pong collapse + transition + snap + merge means the live and
  // preview dots use the exact same rules; if they ever disagree, the
  // bug is in the underlying steps, not in two divergent dot builders.
  useEffect(() => {
    if (!running || !routeSteps || routeSteps.length === 0 || !routePoints || routePoints.length === 0) {
      setLiveTurns(null)
      return
    }
    const steps = routeSteps
    const polyline = routePoints
    // Phantom A→B→A collapse pass (same as preview).
    const annotated = (() => {
      let cur = steps.map((s, i) => ({stepIdx: i, name: s.road ?? null}))
      for (let pass = 0; pass < 4; pass++) {
        const out: typeof cur = []
        for (let i = 0; i < cur.length; i++) {
          const prev = out[out.length - 1]
          const next = cur[i + 1]
          if (
            prev?.name &&
            next?.name &&
            cur[i].name &&
            !sameRoad(prev.name, cur[i].name!) &&
            sameRoad(prev.name, next.name)
          ) {
            continue
          }
          out.push(cur[i])
        }
        if (out.length === cur.length) break
        cur = out
      }
      return cur
    })()
    const dots: PreviewTurn[] = []
    for (let i = 0; i < annotated.length - 1; i++) {
      const here = annotated[i]
      const next = annotated[i + 1]
      if (!here.name || !next.name) continue
      if (sameRoad(here.name, next.name)) continue
      // NavRouteStep only has start coords. The "junction" between
      // step[i] and step[i+1] is step[i+1].lat/lng (which IS the end
      // of step[i] by definition).
      const junction = steps[next.stepIdx]
      if (!Number.isFinite(junction.lat) || !Number.isFinite(junction.lng)) continue
      const signedBend = signedBendAt(polyline, {lat: junction.lat, lng: junction.lng})
      if (signedBend != null && Math.abs(signedBend) < MIN_TURN_ANGLE_DEG) continue
      const snapped = snapToPolyline(polyline, {lat: junction.lat, lng: junction.lng})
      // Direction precedence: trust polyline geometry first (Routes API
      // sometimes labels the first micro-step on the new road with the
      // OPPOSITE direction of the human-perceived turn — see the Hayes →
      // Gough case where step[1].maneuver was TURN_LEFT for a right
      // turn). Fall back to the step maneuver only when geometry isn't
      // measurable (very short polylines).
      const geomDir = signedBend == null ? null : signedBend > 0 ? "Turn right" : "Turn left"
      dots.push({
        lat: snapped.lat,
        lng: snapped.lng,
        label: joinRoads(here.name, next.name),
        direction: (geomDir ?? turnDirection(steps[next.stepIdx].maneuver)) as PreviewTurn["direction"],
      })
    }
    const MERGE_RADIUS_M = 6
    const merged: PreviewTurn[] = []
    for (const d of dots) {
      const prev = merged[merged.length - 1]
      if (prev && haversineMeters(prev, d) < MERGE_RADIUS_M) {
        const prevFrom = prev.label?.split(" → ")[0] ?? null
        const dTo = d.label?.split(" → ")[1] ?? null
        merged[merged.length - 1] = {
          lat: d.lat,
          lng: d.lng,
          label: prevFrom && dTo ? `${prevFrom} → ${dTo}` : (d.label ?? prev.label),
          direction: d.direction ?? prev.direction,
        }
        continue
      }
      merged.push(d)
    }
    setLiveTurns(merged)
  }, [running, routeSteps, routePoints])

  // ---- trip lifecycle ------------------------------------------------------
  //
  // Background owns the live trip state. The UI fires-and-forgets the
  // user's intent via broadcasts; status/maneuver/routePoints come back
  // via `nav:trip-state` / `nav:route` subscriptions installed in the
  // store. There is no local trip-state hydration to do here.
  async function handleStart() {
    if (!destination) {
      append("ERROR: pick a destination first")
      return
    }
    setLog([])
    append(
      `start → ${destination.name || `${destination.lat}, ${destination.lng}`}${
        simulate ? ` (sim ${speedMultiplier}x)` : ""
      }`,
    )

    // Resolve the destination name. A dropped pin starts with the placeholder
    // "Dropped pin" (and `isGeocoding`) while its reverse-geocode is in flight;
    // if the user taps Start before that lands, the placeholder would become the
    // permanent trip name — that's the "You have arrived at Dropped pin" bug. So
    // when the name is still the placeholder / unresolved, reverse-geocode the
    // coordinate now (on demand) and use the real address. Falls back to the
    // existing name if geocoding yields nothing.
    let destinationName = destination.name || destination.address || undefined
    const isPlaceholder = destination.isGeocoding || destinationName === "Dropped pin" || !destinationName
    if (isPlaceholder) {
      try {
        const formatted = await reverseGeocode(destination.lat, destination.lng)
        if (formatted) {
          destinationName = formatted.split(",")[0]?.trim() || formatted
        }
      } catch {
        /* keep the existing name on failure */
      }
    }

    mentra.send("nav:start", {
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
      simulate,
      speedMultiplier,
      missedTurnRerouteMeters: 3,
      pivots: {radiusMeters: 14},
      destinationName,
    })
  }

  function handleStop() {
    append("stop sent")
    mentra.send("nav:stop", {})
    setPreviewRoutePoints(null)
    setPreviewRouteSummary(null)
    // Also clear the picked destination so the page returns to the
    // idle (no-destination) state — otherwise tapping Done after
    // arrival drops back into the destination preview drawer.
    setDestination(null)
  }

  function handleDeviate() {
    append("deviate → +50m off-route")
    mentra.send("nav:deviate", {})
  }

  // Dev: snap the map back to the device's real current location. Handy
  // after a simulated trip leaves the puck parked at the sim destination.
  function handleResetLocation() {
    append("reset → my location")
    mentra.send("nav:reset-location", {})
  }

  // Cancel the current trip and immediately re-start it to the same
  // destination. Useful in dev for re-triggering route build / initial
  // display logic without having to re-pick the destination.
  function handleRebuildRoute() {
    const dest = effectiveDestination
    if (!dest) {
      append("ERROR: no active destination to rebuild")
      return
    }
    append(`rebuild → ${dest.name || `${dest.lat}, ${dest.lng}`}`)
    mentra.send("nav:stop", {})
    mentra.send("nav:start", {
      stops: [{lat: dest.lat, lng: dest.lng}],
      mode: "walking",
      simulate,
      speedMultiplier,
      missedTurnRerouteMeters: 3,
      pivots: {radiusMeters: 14},
      destinationName: dest.name || dest.address || undefined,
    })
  }

  // Long-press on the map drops a destination pin at the pressed coord.
  // Mirrors Google Maps "drop pin" UX: the pin enters the same flow as
  // a search-result destination — preview drawer opens, route preview
  // computes from the user's current position, "Start Navigation"
  // button arms the trip. Reverse-geocoding upgrades the pin's name to
  // a real street address in the background; no-op if it fails.
  // Disabled during active trips: re-routing mid-trip via long-press
  // would be too easy to do by accident.
  // Google Maps-style POI tap: user tapped a built-in icon (Safeway, a
  // cafe, etc). Resolve the placeId via the same `places:details` RPC
  // search results use, then set it as the selected destination — the
  // existing preview drawer takes care of the rest. No-op during a live
  // trip (the parent gates this via the prop) so a mid-walk tap can't
  // accidentally swap destinations.
  function handleMapPoiTap(name: string, coord: LatLng) {
    if (running) return
    append(`POI tap → ${name}`)
    const pinId = `poi-pin-${Date.now()}`
    // Pin the landmark immediately using its NAME as the label, with a
    // geocoding skeleton for the address. The Mapbox POI feature only gives
    // us a name + coords — no place ID — so we reverse-geocode the POI's
    // coordinates to fill in the real street address (not raw lat/lng).
    const pin: PlaceDetails = {
      placeId: pinId,
      lat: coord.lat,
      lng: coord.lng,
      name,
      address: "",
      isGeocoding: true,
    }
    setDestination(pin)
    const finalize = (next: Partial<PlaceDetails>) => {
      setDestination((prev) => (prev && prev.placeId === pinId ? {...prev, ...next, isGeocoding: false} : prev))
    }
    void reverseGeocode(coord.lat, coord.lng).then((formatted) => {
      // Keep the POI's own name as the label; use the geocoded string as the
      // full address (fall back to coords only if geocoding returns nothing).
      finalize({address: formatted || `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}`})
    })
  }

  function handleMapLongPress(coord: LatLng) {
    if (running) return
    const coordStr = `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}`
    const pinId = `dropped-pin-${Date.now()}`
    const pin: PlaceDetails = {
      placeId: pinId,
      lat: coord.lat,
      lng: coord.lng,
      name: "Dropped pin",
      address: coordStr,
      // Flag the pin as awaiting geocoding so the preview drawer
      // renders a skeleton instead of the placeholder strings — avoids
      // the 1-2s flash of bare lat/lng coords before the real address
      // lands.
      isGeocoding: true,
    }
    append(`dropped pin @ ${coordStr}`)
    setDestination(pin)
    // Reverse-geocode in the background. When it lands, populate the
    // pin with the SAME field convention as a searched place — `name`
    // is a short label (the street line), `address` is the full
    // formatted address — so the preview drawer's grouped-address +
    // copy rendering works uniformly for both. If geocoding fails,
    // fall back to coords-as-name. Either way we clear `isGeocoding`
    // so the skeleton stops showing.
    const finalize = (next: Partial<PlaceDetails>) => {
      // Only apply the upgrade if the same pin is still selected —
      // user may have dropped another one in the meantime.
      setDestination((prev) => (prev && prev.placeId === pinId ? {...prev, ...next, isGeocoding: false} : prev))
    }
    void reverseGeocode(coord.lat, coord.lng).then((formatted) => {
      if (formatted) {
        // Use the first comma-segment (street) as the short name, the
        // full string as the address.
        const shortName = formatted.split(",")[0]?.trim() || formatted
        finalize({name: shortName, address: formatted})
      } else {
        finalize({})
      }
    })
  }

  const me = coords ? {lat: coords.lat, lng: coords.lng} : null

  // When a trip is running/arrived, the background's trip state is the
  // authority for the destination — the page-local `destination` is null
  // after a WebView remount (it isn't persisted, the trip is). Synthesize
  // a PlaceDetails from the live trip so the running/arrival drawers have
  // a destination to render. Without this, on re-entering the app
  // mid-trip the running drawer gets a null destination and renders
  // NOTHING (the bottom bar with time/distance disappears).
  const tripDestination: PlaceDetails | null =
    (running || status === "arrived") && activeDestination
      ? {
          placeId: "active-trip",
          name: activeDestinationName ?? "Destination",
          address: activeDestinationName ?? "",
          lat: activeDestination.lat,
          lng: activeDestination.lng,
        }
      : null
  // Live trip wins over the (possibly stale/absent) local selection.
  const effectiveDestination = tripDestination ?? destination

  return (
    <DrawerOffsetProvider>
      <div className="fixed inset-0 overflow-hidden ">
        <NavMap
          me={me}
          destination={activeDestination ?? (destination ? {lat: destination.lat, lng: destination.lng} : null)}
          routePoints={running ? routePoints : previewRoutePoints}
          // Red turn dots — same dots for preview and live, just sourced
          // differently. Preview builds them from a one-shot
          // `computeRoute` call. Live builds them from the active
          // trip's `routeSteps + routePoints` (post-Phase-2 these come
          // from the SAME Routes REST response, so the dots are
          // identical end-to-end).
          previewTurns={running ? liveTurns : previewTurns}
          showPivots={showPivots}
          showOffRouteLine={showOffRouteLine}
          // Idle map shows saved-place pins so the user can see their
          // home / work / starred locations at a glance. Hide them
          // while running so they don't compete with the active route.
          savedPlaces={running ? [] : savedPlaces}
          autoFollow={running}
          // Hide the floating zoom/recenter rail while the full-screen
          // search overlay is up — it would otherwise float on top of
          // the results list.
          hideControls={isSearching}
          // Suppress long-press-to-drop-pin while the search drawer is
          // open. Otherwise a press through the (semi-transparent) panel
          // edges or before the drawer animates in can drop a stray pin.
          onLongPress={isSearching ? undefined : handleMapLongPress}
          // POI tap → preview drawer. Gated on the search overlay (same
          // reason as long-press) and on a live trip (avoid swapping
          // destinations mid-walk).
          onPlaceTap={isSearching || running ? undefined : handleMapPoiTap}
          onOpenSettings={() => push({name: "settings"})}
        />

        {/* Top floating stack — search bar, then orientation card while running. */}
        <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
          {!running && devDrawer !== "running" && devDrawer !== "arrived" && (
            <div
              className="pointer-events-auto"
              onPointerDownCapture={(e) => {
                // 5-second hold on the search bar toggles the dev-panel
                // override. We listen in CAPTURE phase so the gesture
                // also arms when the press lands on the <input> child
                // (whose own handlers would otherwise stop propagation).
                // Significant movement or an early pointerup cancels —
                // see the matching handlers below. No visible feedback
                // during the hold by design.
                const startX = e.clientX
                const startY = e.clientY
                const target = e.currentTarget
                let cancelled = false
                const cleanup = () => {
                  clearTimeout(timer)
                  target.removeEventListener("pointermove", onMove)
                  target.removeEventListener("pointerup", onEnd)
                  target.removeEventListener("pointercancel", onEnd)
                }
                const onMove = (ev: PointerEvent) => {
                  const dx = ev.clientX - startX
                  const dy = ev.clientY - startY
                  // ~10px of slop accounts for finger jitter while
                  // holding still; anything beyond is intentional
                  // motion (scroll, drag) so we bail.
                  if (dx * dx + dy * dy > 100) {
                    cancelled = true
                    cleanup()
                  }
                }
                const onEnd = () => {
                  cancelled = true
                  cleanup()
                }
                const timer = setTimeout(() => {
                  cleanup()
                  if (cancelled) return
                  const next = toggleDevOverride()
                  append(`dev panel ${next ? "enabled" : "disabled"}`)
                }, 5000)
                target.addEventListener("pointermove", onMove)
                target.addEventListener("pointerup", onEnd)
                target.addEventListener("pointercancel", onEnd)
              }}>
              <LocationSearch
                selected={destination}
                onSelect={(place) => setDestination(place)}
                onClear={() => setDestination(null)}
                disabled={running}
                devFrozen={searchFrozen}
                onSearchingChange={setIsSearching}
                refreshKey={savedPlacesVersion}
              />
            </div>
          )}
          {(running || devDrawer === "running") && (
            <div className={`"pointer-events-auto ${safeHeadingManuverCard} px-1.5`}>
              <OrientationCard
                me={me}
                heading={heading}
                maneuver={maneuver}
                routePoints={routePoints}
                routeSteps={routeSteps}
                status={status}
              />
            </div>
          )}
          {offRouteSticky ? (
            <div className="pointer-events-none mx-3 px-3 py-2 rounded-lg bg-amber-500/95 text-white text-sm font-semibold shadow flex items-center gap-2">
              <svg
                className="size-4 animate-spin shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" />
                <path
                  d="M21 12 A9 9 0 0 0 12 3"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              <span>Off route — recalculating…</span>
            </div>
          ) : null}
        </div>

        {!isSearching &&
          status !== "arrived" &&
          devDrawer !== "arrived" &&
          (() => {
            const mode =
              devDrawer !== "auto"
                ? devDrawer
                : !running && !effectiveDestination
                  ? "idle"
                  : !running && effectiveDestination
                    ? "preview"
                    : "running"
            const devDestination = effectiveDestination ?? (devDrawer !== "auto" ? DEV_DESTINATION : null)
            if (mode === "idle")
              return (
                <IdleDrawer
                  me={me}
                  onSelect={(place) => setDestination(place)}
                  onAddPlace={(type) => push({name: "add-place", presetType: type})}
                  refreshKey={savedPlacesVersion}
                />
              )
            if (mode === "preview")
              return (
                <DestinationPreviewDrawer
                  destination={devDestination}
                  me={me}
                  simulate={simulate}
                  speedMultiplier={speedMultiplier}
                  routeDistanceMeters={previewRouteSummary?.distanceMeters ?? null}
                  routeDurationSeconds={previewRouteSummary?.durationSeconds ?? null}
                  saved={!!devDestination && savedPlaces.some((p) => p.placeId === devDestination.placeId)}
                  onToggleSaved={handleToggleSaved}
                  onStart={handleStart}
                  onClose={() => setDestination(null)}
                />
              )
            return (
              <NavigationRunningDrawer
                destination={devDestination}
                me={me}
                routeDistanceMeters={maneuver?.distanceToDestinationMeters ?? null}
                routeDurationSeconds={maneuver?.timeToDestinationSeconds ?? null}
                routePoints={running ? routePoints : null}
                canRepeatDirection={capabilities.hasSpeaker && voiceGuidanceMode !== "off"}
                onRepeatDirection={() => mentra.send("nav:repeat-direction", {})}
                onStop={handleStop}
                onClose={() => setDestination(null)}
              />
            )
          })()}

        <ArrivalDrawer
          open={!isSearching && (status === "arrived" || devDrawer === "arrived")}
          destinationName={activeDestinationName}
          destinationAddress={effectiveDestination?.address ?? null}
          onDone={handleStop}
        />

        {devEnabled && !isSearching ? (
          <FloatingDevPanel title="Navigation Dev" version={appVersion} storageKey="NavigationPage:dev">
            <div className="flex gap-1 p-1 mb-3 rounded-xl bg-[#0000000A] dark:bg-zinc-800">
              {(
                [
                  {id: "nav", label: "Nav"},
                  {id: "display", label: "Display tests"},
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setDevTab(tab.id)}
                  className={`flex-1 text-[12px] px-2.5 py-1.5 rounded-lg font-semibold transition-colors ${
                    devTab === tab.id
                      ? "bg-white dark:bg-zinc-600 text-neutral-900 dark:text-zinc-50 shadow-sm"
                      : "bg-transparent text-neutral-600 dark:text-zinc-400 hover:text-neutral-800 dark:hover:text-zinc-200"
                  }`}>
                  {tab.label}
                </button>
              ))}
            </div>
            {devTab === "display" ? (
              <>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Show test text on glasses</span>
                  <button
                    type="button"
                    onClick={() =>
                      mentra.request("test:show-text-test", {
                        text: "Hello from the UI",
                        durationMs: 3000,
                      })
                    }
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Send
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Send test bitmap to glasses</span>
                  <button
                    type="button"
                    onClick={() => mentra.request("test:show-bitmap-test", undefined)}
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Send
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200 shrink-0">Test bitmap (W×H)</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      value={bmpWidth}
                      onChange={(e) => setBmpWidth(e.target.value)}
                      placeholder="W"
                      className="w-12 text-[11px] px-1.5 py-1 rounded-lg border border-neutral-300 dark:border-zinc-700 text-center"
                    />
                    <span className="text-[11px] text-neutral-400 dark:text-zinc-500">×</span>
                    <input
                      type="number"
                      value={bmpHeight}
                      onChange={(e) => setBmpHeight(e.target.value)}
                      placeholder="H"
                      className="w-12 text-[11px] px-1.5 py-1 rounded-lg border border-neutral-300 dark:border-zinc-700 text-center"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const size = parseInt(bmpWidth, 10)
                        const height = parseInt(bmpHeight, 10)
                        if (!Number.isFinite(size) || !Number.isFinite(height)) return
                        mentra.request("test:show-bitmap-size", {size, height})
                      }}
                      className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white shrink-0">
                      Send
                    </button>
                  </div>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">OSM road map (Hayes Valley)</span>
                  <button
                    type="button"
                    onClick={async () => {
                      console.log("[OSM-MAP] 🖱️  Draw button clicked")
                      const res = await mentra.request("test:show-osm-map", undefined)
                      console.log("[OSM-MAP] result:", res?.ok ? "✅ ok" : `❌ ${res?.error}`)
                    }}
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Draw
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Explore map (pan)</span>
                  <div className="flex flex-col items-center gap-1">
                    {(
                      [
                        [null, "up", null],
                        ["left", null, "right"],
                        [null, "down", null],
                      ] as const
                    ).map((row, ri) => (
                      <div key={ri} className="flex gap-1">
                        {row.map((dir, ci) =>
                          dir ? (
                            <button
                              key={ci}
                              type="button"
                              onClick={async () => {
                                console.log(`[OSM-MAP] 🖱️  pan ${dir}`)
                                const res = await mentra.request("test:pan-osm-map", {dir})
                                console.log("[OSM-MAP] result:", res?.ok ? "✅ ok" : `❌ ${res?.error}`)
                              }}
                              className="w-7 h-7 rounded-lg font-bold bg-red-600 text-white flex items-center justify-center">
                              {dir === "up" ? "↑" : dir === "down" ? "↓" : dir === "left" ? "←" : "→"}
                            </button>
                          ) : (
                            <span key={ci} className="w-7 h-7" />
                          ),
                        )}
                      </div>
                    ))}
                  </div>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Test bitmap 200×100</span>
                  <button
                    type="button"
                    onClick={() => mentra.request("test:show-bitmap-size", {size: 200, height: 100})}
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Send
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Large map (center)</span>
                  <div className="flex gap-1.5">
                    {[200, 270].map((size) => (
                      <button
                        key={size}
                        type="button"
                        onClick={async () => {
                          const res = await mentra.request("test:show-large-map", {size})
                          console.log(`[LARGE-MAP] ${size}:`, res?.ok ? "✅ ok" : `❌ ${res?.error}`)
                        }}
                        className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                        {size}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Count 1→10 every 3s</span>
                  <button
                    type="button"
                    onClick={() => mentra.request("test:count-1-to-10", undefined)}
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Start
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">
                    Both boxes 100→0 (sync test)
                  </span>
                  <button
                    type="button"
                    onClick={() => mentra.request("test:count-both-boxes", undefined)}
                    className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-red-600 text-white">
                    Start
                  </button>
                </div>
                <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
                  <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Arrow glyph on glasses</span>
                  <div className="flex gap-1.5">
                    {(
                      [
                        {label: "←", glyph: "←"},
                        {label: "↑", glyph: "↑"},
                        {label: "→", glyph: "→"},
                      ] as const
                    ).map((arrow) => (
                      <button
                        key={arrow.glyph}
                        type="button"
                        onClick={() =>
                          mentra.request("test:show-text-test", {
                            text: arrow.glyph,
                            durationMs: 3000,
                          })
                        }
                        className="text-[14px] leading-none w-8 h-7 rounded-lg font-semibold bg-red-600 text-white">
                        {arrow.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}
            {devTab === "nav" ? <>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Raw map (no overlays)</span>
              <button
                type="button"
                onClick={() => setRawMapOpen(true)}
                className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-neutral-800 dark:bg-zinc-700 text-white">
                Open
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Rebuild current route</span>
              <button
                type="button"
                disabled={!effectiveDestination}
                onClick={handleRebuildRoute}
                className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-blue-600 text-white disabled:opacity-40">
                Rebuild
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Reset to my location</span>
              <button
                type="button"
                onClick={handleResetLocation}
                className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-emerald-600 text-white">
                Reset
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Turn pivot markers</span>
              <button
                type="button"
                onClick={() => setShowPivots((v) => !v)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  showPivots ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {showPivots ? "On" : "Off"}
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Off-route distance line</span>
              <button
                type="button"
                onClick={() => setShowOffRouteLine((v) => !v)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  showOffRouteLine ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {showOffRouteLine ? "On" : "Off"}
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Glasses minimap bitmap</span>
              <button
                type="button"
                onClick={() => {
                  const next = !showMinimap
                  setShowMinimap(next)
                  mentra.send("nav:set-show-minimap", next)
                }}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  showMinimap ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {showMinimap ? "On" : "Off"}
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Simulator Mode</span>
              <button
                type="button"
                onClick={() => {
                  setSimulatorMode((v) => {
                    if (v) {
                      setDevDrawer("auto")
                      setSearchFrozen(false)
                      setSimulate(false)
                    } else {
                      setSimulate(true)
                    }
                    return !v
                  })
                }}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  simulatorMode ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {simulatorMode ? "On" : "Off"}
              </button>
            </div>
            {simulatorMode && (
              <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3">
                <div className="text-[11px] font-bold tracking-wider text-neutral-500 dark:text-zinc-400 uppercase mb-2">Drawer</div>
                <div className="flex gap-1.5 flex-wrap">
                  {(["auto", "idle", "preview", "running", "arrived"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDevDrawer(mode)}
                      className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold capitalize ${
                        devDrawer === mode ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                      }`}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <MyLocationCard coords={coords} />
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 dark:text-zinc-400 uppercase">
                🎯 Selected destination
              </div>
              {destination ? (
                <>
                  <div className="text-[14px] text-neutral-900 dark:text-zinc-50 mt-1">
                    {destination.name || destination.address || "(unnamed)"}
                  </div>
                  <div className="font-mono text-[12px] text-neutral-500 dark:text-zinc-400 mt-0.5">
                    {destination.lat.toFixed(6)}, {destination.lng.toFixed(6)}
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-neutral-500 dark:text-zinc-400 italic mt-1">(none picked)</div>
              )}
            </div>
            {simulatorMode && (
              <>
                <SimulationControls
                  simulate={simulate}
                  setSimulate={setSimulate}
                  speedMultiplier={speedMultiplier}
                  setSpeedMultiplier={setSpeedMultiplier}
                  running={running}
                />
                {running && simulate ? <DeviateButton onDeviate={handleDeviate} /> : null}
                {simulate ? (
                  <button
                    onClick={() => {
                      const next = !wrongSidewalk
                      setWrongSidewalk(next)
                      mentra.send("nav:set-dev-settings", {wrongSidewalk: next})
                      append(`wrong-sidewalk offset → ${next ? "on" : "off"}`)
                    }}
                    className={`w-full mt-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed ${
                      wrongSidewalk
                        ? "border-amber-500 bg-amber-100 dark:bg-amber-500/25 text-amber-900 dark:text-amber-300"
                        : "border-amber-300 dark:border-amber-600 bg-amber-50 dark:bg-amber-500/10 text-amber-800 dark:text-amber-400"
                    }`}>
                    🚶‍♂️ Wrong sidewalk: {wrongSidewalk ? "ON" : "OFF"}
                  </button>
                ) : null}
              </>
            )}
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 dark:text-zinc-400 uppercase mb-2">🚶 Travel mode</div>
              <div className="grid grid-cols-2 gap-2">
                {(["walking", "driving", "cycling", "two_wheeler"] as const).map((m) => (
                  <button
                    key={m}
                    disabled={running}
                    onClick={() => setTravelMode(m)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                      travelMode === m
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-500/20 text-blue-900 dark:text-blue-300"
                        : "border-neutral-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-neutral-700 dark:text-zinc-200"
                    } disabled:opacity-50`}>
                    {m.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Freeze location search panel</span>
              <button
                type="button"
                onClick={() => setSearchFrozen((f) => !f)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  searchFrozen ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {searchFrozen ? "Frozen" : "Freeze"}
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Use raw Google instructions</span>
                <span className="text-[11px] text-neutral-500 dark:text-zinc-400">Maneuver card + glasses HUD</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !useRawInstructions
                  setUseRawInstructions(next)
                  mentra.send("nav:set-dev-settings", {useRawInstructions: next})
                  append(`raw-instructions → ${next ? "on" : "off"}`)
                }}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  useRawInstructions ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {useRawInstructions ? "ON" : "OFF"}
              </button>
            </div>
            <div className="bg-white dark:bg-zinc-900 border border-neutral-200 dark:border-zinc-800 rounded-xl p-3 mb-3 flex items-center justify-between">
              <div className="flex flex-col">
                <span className="text-[13px] font-medium text-neutral-700 dark:text-zinc-200">Large map (swipe) — WIP</span>
                <span className="text-[11px] text-neutral-500 dark:text-zinc-400">Swipe up/down to toggle full-screen map</span>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !largeMapEnabled
                  setLargeMapEnabled(next)
                  mentra.send("nav:set-dev-settings", {largeMapEnabled: next})
                  append(`large-map → ${next ? "on" : "off"}`)
                }}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  largeMapEnabled ? "bg-blue-600 text-white" : "bg-neutral-200 dark:bg-zinc-700 text-neutral-700 dark:text-zinc-200"
                }`}>
                {largeMapEnabled ? "ON" : "OFF"}
              </button>
            </div>
            <LiveLog log={log} running={running} status={status} maneuver={maneuver} />
            </> : null}
          </FloatingDevPanel>
        ) : null}
      </div>
      {rawMapOpen ? <RawMapPage onClose={() => setRawMapOpen(false)} /> : null}
    </DrawerOffsetProvider>
  )
}
