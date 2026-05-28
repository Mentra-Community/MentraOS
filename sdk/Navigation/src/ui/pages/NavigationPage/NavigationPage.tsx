import {useEffect, useState} from "react"
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
import {isDev} from "@/ui/lib/env"
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

// A previewed turn point plus the road name to label it with (dev dots).
type PreviewTurn = {lat: number; lng: number; label: string | null}

// Pull a short road name out of a Routes-API instruction for the dev
// turn labels. Instructions look like:
//   "Turn left onto Octavia Blvd"
//   "Slight right onto Octavia St"
//   "Head northeast on Market St toward Octavia St"
//   "Turn right onto Haight St\nDestination will be on the right"
//
// Pitfalls this guards against (seen in real data):
//   - Multi-line: the API appends a second line like "Destination will
//     be on the right". We ONLY look at the first line, otherwise the
//     greedy match grabs "on the right" → "the right".
//   - Trailing clauses on the first line ("… toward Octavia St",
//     "… and continue"): cut at the first such keyword.
//   - Unit suffixes: "Hayes St #116" → "Hayes St".
//   - Direction-only leftovers ("the right", "right", "left"): rejected
//     so a parse miss returns null (caller hides the label / geocodes)
//     instead of showing a direction word.
const DIRECTION_WORDS = new Set(["right", "left", "the right", "the left", "north", "south", "east", "west"])
function roadNameFromInstruction(instruction?: string): string | null {
  if (!instruction) return null
  // Only the first line — drop "Destination will be on the right" etc.
  const firstLine = instruction.split("\n")[0] ?? ""
  // Prefer "onto" (always immediately precedes the road); fall back to
  // "on" for depart steps ("Head north on Market St").
  const m = firstLine.match(/\bonto\s+(.+)$/i) ?? firstLine.match(/\bon\s+(.+)$/i)
  let raw = (m ? m[1] : "").trim()
  if (!raw) return null
  // Cut trailing direction/continuation clauses the API appends.
  raw = raw.split(/\s+(?:toward|towards|to|and|then|for)\b/i)[0]?.trim() ?? ""
  // Strip a unit/suite suffix ("Hayes St #116" → "Hayes St").
  raw = raw.replace(/\s+#.*$/, "").trim()
  if (!raw) return null
  // Reject a bare direction word that slipped through.
  if (DIRECTION_WORDS.has(raw.toLowerCase())) return null
  return raw
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
const PROBE_METERS = 12
function bendAngleAt(points: LatLng[], junction: LatLng): number | null {
  if (points.length < 3) return null
  // Nearest point to the junction.
  let mid = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = haversineMeters(points[i], junction)
    if (d < bestDist) {
      bestDist = d
      mid = i
    }
  }
  // Walk back until ~PROBE_METERS before the junction.
  let before = mid
  while (before > 0 && haversineMeters(points[before], points[mid]) < PROBE_METERS) before--
  // Walk forward until ~PROBE_METERS after.
  let after = mid
  while (after < points.length - 1 && haversineMeters(points[after], points[mid]) < PROBE_METERS) after++
  if (before === mid || after === mid) return null
  const incoming = bearingDeg(points[before], points[mid])
  const outgoing = bearingDeg(points[mid], points[after])
  return Math.abs(signedAngleDiff(outgoing, incoming))
}

// Minimum bend (degrees) for a junction to count as a real turn worth a
// dot. Below this the route is effectively straight through the point.
const MIN_TURN_ANGLE_DEG = 35

let logIdSeq = 0

type Props = {
  savedPlacesVersion?: number
}

export function NavigationPage({savedPlacesVersion = 0}: Props) {
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
  const activeDestination = trip.activeDestination
  const activeDestinationName = trip.activeDestinationName
  const offRouteAt = trip.offRouteAt

  const computeRoute = useRpc<Channels, "nav:compute-route">("nav:compute-route")

  // ---- page-local UI state -------------------------------------------------
  const {push} = useRouter()
  const [destination, setDestination] = useState<PlaceDetails | null>(null)
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])

  // Hydrate saved places so the map can drop home / work / starred
  // markers behind whatever destination is selected. Refetched on
  // savedPlacesVersion change (AddPlacePage onSave bumps it after a
  // successful `storage:add-saved`).
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
  }, [savedPlacesVersion])

  const [simulatorMode, setSimulatorMode] = useState(false)
  const [searchFrozen, setSearchFrozen] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [rawMapOpen, setRawMapOpen] = useState(false)

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
  const [skipCrossings, setSkipCrossings] = useState(false)
  const [travelMode, setTravelMode] = useState<TravelMode>("walking")

  const [previewRoutePoints, setPreviewRoutePoints] = useState<LatLng[] | null>(null)
  // Dev-only: turn points along the previewed route, used to draw red
  // debug dots (with a road-name label) on the map. Derived from the
  // computed route's step list (available at computeRoute time, before a
  // trip starts — unlike the SDK's getPivots(), which only populates
  // once navigation is running).
  const [previewTurns, setPreviewTurns] = useState<PreviewTurn[] | null>(null)
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
        const turns = steps
          .slice(0, -1)
          .map((s, i) => {
            const fromRoad = roadNameFromInstruction(s.instruction)
            const toRoad = roadNameFromInstruction(steps[i + 1].instruction)
            return {s, fromRoad, toRoad}
          })
          .filter(
            (
              t,
            ): t is {s: (typeof steps)[number]; fromRoad: string; toRoad: string} =>
              t.fromRoad != null &&
              t.toRoad != null &&
              !sameRoad(t.fromRoad, t.toRoad) &&
              Number.isFinite(t.s.endLat) &&
              Number.isFinite(t.s.endLng),
          )
          .filter((t) => {
            const bend = bendAngleAt(polyline, {lat: t.s.endLat, lng: t.s.endLng})
            // No polyline to measure → keep (don't hide a labeled turn
            // just because geometry was unavailable).
            return bend == null || bend >= MIN_TURN_ANGLE_DEG
          })
          .map((t) => ({
            lat: t.s.endLat,
            lng: t.s.endLng,
            label: joinRoads(t.fromRoad, t.toRoad),
          }))
        if (cancelled) return
        setPreviewTurns(turns)
      })
      .catch(() => {
        // Aborted or failed — preview just stays blank.
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, destination?.lat, destination?.lng, coords?.lat, coords?.lng])

  // ---- trip lifecycle ------------------------------------------------------
  //
  // Background owns the live trip state. The UI fires-and-forgets the
  // user's intent via broadcasts; status/maneuver/routePoints come back
  // via `nav:trip-state` / `nav:route` subscriptions installed in the
  // store. There is no local trip-state hydration to do here.
  function handleStart() {
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
    mentra.send("nav:start", {
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
      simulate,
      speedMultiplier,
      missedTurnRerouteMeters: 3,
      destinationName: destination.name || destination.address || undefined,
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

  // Long-press on the map drops a destination pin at the pressed coord.
  // Mirrors Google Maps "drop pin" UX: the pin enters the same flow as
  // a search-result destination — preview drawer opens, route preview
  // computes from the user's current position, "Start Navigation"
  // button arms the trip. Reverse-geocoding upgrades the pin's name to
  // a real street address in the background; no-op if it fails.
  // Disabled during active trips: re-routing mid-trip via long-press
  // would be too easy to do by accident.
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

  return (
    <DrawerOffsetProvider>
      <div className="fixed inset-0 overflow-hidden ">
        <NavMap
          me={me}
          destination={activeDestination ?? (destination ? {lat: destination.lat, lng: destination.lng} : null)}
          routePoints={running ? routePoints : previewRoutePoints}
          // Dev-only red turn dots. While previewing, the SDK's pivot
          // list is empty (no active trip), so we feed turns derived
          // from the computed route's steps. While running, NavMap pulls
          // the live pivot list via the nav:get-pivots RPC.
          previewTurns={running ? null : previewTurns}
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
        />

        {/* Top floating stack — search bar, then orientation card while running. */}
        <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
          {!running && devDrawer !== "running" && devDrawer !== "arrived" && (
            <div className="pointer-events-auto">
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
            <div className={`"pointer-events-auto ${safeHeadingManuverCard}`}>
              <OrientationCard
                me={me}
                heading={heading}
                maneuver={maneuver}
                routePoints={routePoints}
                status={status}
              />
            </div>
          )}
          {offRouteAt != null && status !== "rerouting" ? (
            <div className="pointer-events-none mx-3 px-3 py-2 rounded-lg bg-amber-500/95 text-white text-sm font-semibold shadow">
              Off route — recalculating…
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
                : !running && !destination
                  ? "idle"
                  : !running && destination
                    ? "preview"
                    : "running"
            const devDestination = destination ?? (devDrawer !== "auto" ? DEV_DESTINATION : null)
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
                onStop={handleStop}
                onClose={() => setDestination(null)}
              />
            )
          })()}

        <ArrivalDrawer
          open={!isSearching && (status === "arrived" || devDrawer === "arrived")}
          destinationName={activeDestinationName}
          destinationAddress={destination?.address ?? null}
          onDone={handleStop}
        />

        {isDev && !isSearching ? (
          <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Show test text on glasses</span>
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
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Raw map (no overlays)</span>
              <button
                type="button"
                onClick={() => setRawMapOpen(true)}
                className="text-[11px] px-2.5 py-1 rounded-lg font-semibold bg-neutral-800 text-white">
                Open
              </button>
            </div>
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Simulator Mode</span>
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
                  simulatorMode ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"
                }`}>
                {simulatorMode ? "On" : "Off"}
              </button>
            </div>
            {simulatorMode && (
              <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
                <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">Drawer</div>
                <div className="flex gap-1.5 flex-wrap">
                  {(["auto", "idle", "preview", "running", "arrived"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDevDrawer(mode)}
                      className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold capitalize ${
                        devDrawer === mode ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"
                      }`}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <MyLocationCard coords={coords} />
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase">
                🎯 Selected destination
              </div>
              {destination ? (
                <>
                  <div className="text-[14px] text-neutral-900 mt-1">
                    {destination.name || destination.address || "(unnamed)"}
                  </div>
                  <div className="font-mono text-[12px] text-neutral-500 mt-0.5">
                    {destination.lat.toFixed(6)}, {destination.lng.toFixed(6)}
                  </div>
                </>
              ) : (
                <div className="text-[13px] text-neutral-500 italic mt-1">(none picked)</div>
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
                        ? "border-amber-500 bg-amber-100 text-amber-900"
                        : "border-amber-300 bg-amber-50 text-amber-800"
                    }`}>
                    🚶‍♂️ Wrong sidewalk: {wrongSidewalk ? "ON" : "OFF"}
                  </button>
                ) : null}
                {simulate ? (
                  <button
                    onClick={() => {
                      const next = !skipCrossings
                      setSkipCrossings(next)
                      mentra.send("nav:set-dev-settings", {skipCrossings: next})
                      append(`skip-crossings → ${next ? "on" : "off"}`)
                    }}
                    className={`w-full mt-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed ${
                      skipCrossings
                        ? "border-rose-500 bg-rose-100 text-rose-900"
                        : "border-rose-300 bg-rose-50 text-rose-800"
                    }`}>
                    🚷 Skip crossings: {skipCrossings ? "ON" : "OFF"}
                  </button>
                ) : null}
              </>
            )}
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">🚶 Travel mode</div>
              <div className="grid grid-cols-2 gap-2">
                {(["walking", "driving", "cycling", "two_wheeler"] as const).map((m) => (
                  <button
                    key={m}
                    disabled={running}
                    onClick={() => setTravelMode(m)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                      travelMode === m
                        ? "border-blue-500 bg-blue-50 text-blue-900"
                        : "border-neutral-200 bg-white text-neutral-700"
                    } disabled:opacity-50`}>
                    {m.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Freeze location search panel</span>
              <button
                type="button"
                onClick={() => setSearchFrozen((f) => !f)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  searchFrozen ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"
                }`}>
                {searchFrozen ? "Frozen" : "Freeze"}
              </button>
            </div>
            <LiveLog log={log} running={running} status={status} maneuver={maneuver} />
          </FloatingDevPanel>
        ) : null}
      </div>
      {rawMapOpen ? <RawMapPage onClose={() => setRawMapOpen(false)} /> : null}
    </DrawerOffsetProvider>
  )
}
