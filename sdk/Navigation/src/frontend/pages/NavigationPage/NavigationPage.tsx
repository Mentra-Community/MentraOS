import {useEffect, useMemo, useRef, useState} from "react"
import type {NavManeuver, NavRoute, NavUpdate, TravelMode} from "@mentra/miniapp"

import {useRouter} from "@/frontend/router"
import {DrawerOffsetProvider} from "@/frontend/components/Drawer/DrawerOffsetContext"
import {FloatingDevPanel} from "@/frontend/components/FloatingDevPanel/FloatingDevPanel"
import {SimulationControls} from "@/frontend/pages/NavigationPage/components/Controls/Controls"
import {ArrivalDrawer} from "@/frontend/pages/NavigationPage/components/ArrivalDrawer/ArrivalDrawer"
import {DestinationPreviewDrawer} from "@/frontend/pages/NavigationPage/components/DestinationPreviewDrawer/DestinationPreviewDrawer"
import {IdleDrawer} from "@/frontend/pages/NavigationPage/components/IdleDrawer/IdleDrawer"
import {NavigationRunningDrawer} from "@/frontend/pages/NavigationPage/components/NavigationRunningDrawer/NavigationRunningDrawer"
import {DeviateButton} from "@/frontend/pages/NavigationPage/components/DeviateButton/DeviateButton"
import {LiveLog} from "@/frontend/pages/NavigationPage/components/LiveLog/LiveLog"
import {LocationSearch} from "@/frontend/pages/NavigationPage/components/LocationSearch/LocationSearch"
import {OrientationCard} from "@/frontend/pages/NavigationPage/components/OrientationCard/OrientationCard"
import {MyLocationCard} from "@/frontend/pages/NavigationPage/components/MyLocationCard/MyLocationCard"
import {NavMap} from "@/frontend/pages/NavigationPage/components/NavMap/NavMap"
import {useUser} from "@/backend/hooks/useUser"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import {haversineMeters, type LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"
import type {NavigationManager as LocalNavigationManager} from "@/backend/session/managers/navigation/NavigationManager"
import { safeHeadingManuverCard } from "@/frontend/components/SafeHeading/SafeHeading"

export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"
export type LogEntry = {id: number; ts: number; line: string}

const DEV_DESTINATION = {placeId: "dev", name: "Ferry Building", address: "1 Ferry Building, San Francisco, CA", lat: 37.7955, lng: -122.3937}

let logIdSeq = 0

type Props = {
  savedPlacesVersion?: number
}

export function NavigationPage({savedPlacesVersion = 0}: Props) {
  // Single React entry point — User holds reactive sensor state and the
  // imperative managers, all behind one hook. Reads of `user.coords` /
  // `user.heading` / `user.mapsReady` re-render automatically.
  const user = useUser()
  const {coords, navigation, display} = user

  // Destination chosen via Places search. `null` until the user picks one;
  // setting it shows the pin on the map immediately, before Start.
  const {push} = useRouter()
  const [destination, setDestination] = useState<PlaceDetails | null>(null)
  const [simulatorMode, setSimulatorMode] = useState(false)
  const [searchFrozen, setSearchFrozen] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [devDrawer, setDevDrawer] = useState<"auto" | "idle" | "preview" | "running" | "arrived">("auto")
  const [simulate, setSimulate] = useState(false)
  const [speedMultiplier, setSpeedMultiplier] = useState(5)
  const [travelMode, setTravelMode] = useState<TravelMode>("walking")

  // Trip state — owned by the page; navigation manager is just an SDK wrapper.
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<NavStatus>("idle")
  const [maneuver, setManeuver] = useState<NavManeuver | null>(null)
  const [offRouteAt, setOffRouteAt] = useState<number | null>(null)
  const [activeDestination, setActiveDestination] = useState<LatLng | null>(null)
  /**
   * Friendly name of the active destination, captured at trip start. Persists
   * past arrival (when activeDestination is cleared) so the "You have arrived
   * at X" HUD message can reference it.
   */
  const [activeDestinationName, setActiveDestinationName] = useState<string | null>(null)
  const [routePoints, setRoutePoints] = useState<NavRoute["points"] | null>(null)
  const [previewRoutePoints, setPreviewRoutePoints] = useState<LatLng[] | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  // Fetch a preview route whenever destination changes and we're not navigating
  const previewAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    console.log("[PREVIEW] effect fired — running:", running, "destination:", destination?.name, "coords:", coords?.lat, coords?.lng)
    if (running || !destination || !coords) {
      setPreviewRoutePoints(null)
      return
    }
    previewAbortRef.current?.abort()
    const ctrl = new AbortController()
    previewAbortRef.current = ctrl
    const origin = {lat: coords.lat, lng: coords.lng}
    console.log("[PREVIEW] calling computeRoute origin:", origin, "dest:", destination.lat, destination.lng)
    navigation
      .computeRoute({
        origin,
        stops: [{lat: destination.lat, lng: destination.lng}],
        mode: "walking",
      })
      .then((result) => {
        if (ctrl.signal.aborted) return
        const route = result.routes?.[0]
        const pts = route?.points ?? null
        console.log("[PREVIEW] computeRoute ok — points:", pts?.length ?? 0,
          "totalDistanceMeters:", route?.totalDistanceMeters,
          "totalDurationSeconds:", route?.totalDurationSeconds)
        if (pts && pts.length > 0) {
          console.log("[PREVIEW] polyline start:", pts[0], "end:", pts[pts.length - 1])
        }
        // Turn-by-turn preview: dump every step the Routes API returned
        // with its full metadata. Roads are parsed out of the natural
        // language instruction ("Turn left onto Gough St" → "Gough St")
        // and chained: toRoad of step N becomes fromRoad of step N+1.
        // Pivots = the steps whose maneuver is a real turn (not
        // STRAIGHT / DEPART / DESTINATION / NAME_CHANGE).
        const steps = route?.steps ?? []
        if (steps.length > 0) {
          const enriched = steps.map((s, i) => {
            const toRoad = extractRoadFromInstruction(s.instruction)
            return {...s, idx: i, toRoad}
          })
          // Chain: step[i].fromRoad = step[i-1].toRoad (or the departure
          // road for step 0, which we pull out of "Head ... on Road St").
          let prevToRoad: string | null = extractDepartureRoad(steps[0]?.instruction) ?? null
          const withRoads = enriched.map((s) => {
            const fromRoad = prevToRoad
            if (s.toRoad) prevToRoad = s.toRoad
            return {...s, fromRoad}
          })

          console.log(`[PREVIEW] steps — ${withRoads.length} total`)
          withRoads.forEach((s) => {
            console.log(
              `[PREVIEW] step[${s.idx}] maneuver=${s.maneuver ?? "—"} dist=${s.distanceMeters}m ` +
                `from="${s.fromRoad ?? "∅"}" to="${s.toRoad ?? "∅"}" ` +
                `start=(${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}) ` +
                `end=(${s.endLat.toFixed(6)}, ${s.endLng.toFixed(6)}) ` +
                `instruction="${s.instruction ?? ""}"`,
            )
          })
          // Pivot filter:
          //   1. Drop trip-boundary maneuvers (DEPART / DESTINATION / NAME_CHANGE / STRAIGHT)
          //   2. Collapse consecutive turns within INTERSECTION_CLUSTER_M
          //      of each other into a single pivot — Routes API often
          //      splits one intersection crossing into multiple bare
          //      "Turn left / Turn right / Slight left" sub-steps; the
          //      user perceives it as one turn onto the destination road.
          //   3. Drop any remaining sub-step crosswalk fragments
          //      (no toRoad AND short).
          const INTERSECTION_CLUSTER_M = 30
          const PIVOT_MIN_METERS_WITHOUT_ROAD = 25
          const turnCandidates = withRoads.filter(
            (s) =>
              s.maneuver != null &&
              !["STRAIGHT", "DEPART", "DESTINATION", "NAME_CHANGE"].includes(s.maneuver),
          )
          const clustered: typeof turnCandidates = []
          for (const c of turnCandidates) {
            const last = clustered[clustered.length - 1]
            if (
              last &&
              haversineMeters({lat: last.lat, lng: last.lng}, {lat: c.lat, lng: c.lng}) <
                INTERSECTION_CLUSTER_M
            ) {
              // Inherit the destination road from whichever sub-step has
              // one — the named segment is the one the user thinks of as
              // the turn target.
              const toRoad = last.toRoad ?? c.toRoad
              clustered[clustered.length - 1] = {
                ...last,
                toRoad,
                // Sum distances so the merged pivot reflects the full
                // intersection-crossing path.
                distanceMeters: last.distanceMeters + c.distanceMeters,
                // Prefer the instruction that names the destination road.
                instruction: last.toRoad ? last.instruction : c.instruction ?? last.instruction,
              }
              continue
            }
            clustered.push(c)
          }
          const pivots = clustered.filter((s) => {
            if (s.toRoad && s.toRoad !== s.fromRoad) return true
            return s.distanceMeters >= PIVOT_MIN_METERS_WITHOUT_ROAD
          })
          console.log(`[PREVIEW] pivots — ${pivots.length} turning point(s)`)
          pivots.forEach((s, i) => {
            console.log(
              `[PREVIEW] pivot[${i}] ${s.maneuver} from="${s.fromRoad ?? "∅"}" to="${s.toRoad ?? "∅"}" ` +
                `at=(${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}) dist=${s.distanceMeters}m ` +
                `instruction="${s.instruction ?? ""}"`,
            )
          })
        } else {
          console.log("[PREVIEW] no steps returned by Routes API")
        }
        setPreviewRoutePoints(pts)
      })
      .catch((err) => {
        console.warn("[PREVIEW] computeRoute failed:", err)
      })
    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, destination?.lat, destination?.lng, coords?.lat, coords?.lng])

  const navUpdateUnsubRef = useRef<(() => void) | null>(null)
  const navRouteUnsubRef = useRef<(() => void) | null>(null)

  function append(line: string) {
    setLog((prev) => [{id: ++logIdSeq, ts: Date.now(), line}, ...prev].slice(0, 100))
  }

  // ---- glasses HUD mirror ------------------------------------------------
  //
  // Drive the glasses display straight off the SDK's pivot state — same
  // source of truth as the OrientationCard. The HUD mirrors the phone
  // card's layout: distance line, verb, and road context joined with
  // newlines.
  const activePivot = user.navigation.getActivePivot()
  const upcomingPivot = user.navigation.getUpcomingPivot()
  const distanceToUpcomingPivot = useMemo(() => {
    if (!upcomingPivot || !coords) return null
    return haversineMeters({lat: coords.lat, lng: coords.lng}, {lat: upcomingPivot.lat, lng: upcomingPivot.lng})
  }, [upcomingPivot, coords?.lat, coords?.lng])
  const distanceToDestination =
    maneuver?.distanceToDestinationMeters != null && maneuver.distanceToDestinationMeters >= 0
      ? maneuver.distanceToDestinationMeters
      : null
  useEffect(() => {
    // Arrival takes priority: when the trip ends `running` flips to false,
    // but we still want to show "You have arrived at <name>" instead of the
    // welcome idle message.
    if (status === "arrived") {
      const at = activeDestinationName ? ` at ${activeDestinationName}` : ""
      display.showText(`You have arrived${at}`, 10000)
      return
    }
    if (!running) {
      // Idle welcome — auto-clears after 5s so the glasses don't stay
      // pinned to it forever before navigation starts.
      display.showText(
        "Welcome to Mentra Navigation!\nPick a destination to get started.",
        5000,
      )
      return
    }
    if (status === "rerouting") {
      display.showText("Rebuilding route…")
      return
    }

    // Mid-turn — the verb is the headline, no distance countdown.
    // Road name comes from the active pivot ONLY — no NavManeuver
    // fallback. If the SDK didn't supply a road label, we render the
    // verb alone.
    if (activePivot) {
      const verb = activePivot.direction === "right" ? "Turn right" : "Turn left"
      const namedRoad = isRealRoadName(activePivot.toRoad)
      const onto = namedRoad ? `onto ${namedRoad}` : null
      display.showText([verb, onto].filter(Boolean).join("\n"))
      return
    }

    // Continue layout: mirrors the phone OrientationCard's two visible lines.
    //   Onto <nextRoad>          ← upcomingPivot.fromRoad
    //   Turn right in 500 m      ← verb + distance
    // Top line is rendered only when the pivot supplied a road name —
    // no geocoder/maneuver fallback.
    if (upcomingPivot && distanceToUpcomingPivot != null) {
      const verb = upcomingPivot.direction === "right" ? "Turn right" : "Turn left"
      const distStr = formatDistance(distanceToUpcomingPivot)
      const nextRoad = isRealRoadName(upcomingPivot.fromRoad)
      const topLine = nextRoad ? `Onto ${nextRoad}` : null
      display.showText([topLine, `${verb} in ${distStr}`].filter(Boolean).join("\n"))
      return
    }
    if (distanceToDestination != null) {
      const distStr = formatDistance(distanceToDestination)
      display.showText(`Arriving in ${distStr}`)
      return
    }
    display.showText("Arriving")
  }, [
    display,
    running,
    status,
    activePivot,
    upcomingPivot,
    distanceToUpcomingPivot,
    distanceToDestination,
    activeDestinationName,
  ])

  // ---- mid-trip hydration ------------------------------------------------

  // On first mount, ask the host whether there's already a trip running.
  // If so, populate state from the snapshot AND attach the streams so the
  // page picks up new events from this point forward.
  useEffect(() => {
    let cancelled = false
    navigation.getState().then((state) => {
      if (cancelled || !state || !state.active) return
      if (state.maneuver) setManeuver(state.maneuver as NavManeuver)
      if (state.route) setRoutePoints(state.route.points)
      const finalStop = state.stops?.[state.stops.length - 1]
      if (finalStop) setActiveDestination({lat: finalStop.lat, lng: finalStop.lng})
      setStatus("navigating")
      setRunning(true)
      if (!navUpdateUnsubRef.current) navUpdateUnsubRef.current = navigation.onUpdate(handleNavUpdate)
      if (!navRouteUnsubRef.current) {
        navRouteUnsubRef.current = navigation.onRoute((route: NavRoute) => {
          setRoutePoints(route.points)
          logPivotsAfterRoute(navigation, route, "[ROUTE:hydrate]")
        })
      }
    }).catch(() => {
      // No active trip or host not reachable — stay in idle state
    })
    return () => {
      cancelled = true
    }
    // Hydration is a one-shot mount effect; intentionally not re-run on
    // identity changes of `navigation` (it's stable for the User singleton).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- subscription cleanup on unmount -----------------------------------

  useEffect(() => {
    return () => {
      navUpdateUnsubRef.current?.()
      navUpdateUnsubRef.current = null
      navRouteUnsubRef.current?.()
      navRouteUnsubRef.current = null
    }
  }, [])

  // ---- trip lifecycle ----------------------------------------------------

  function handleNavUpdate(u: NavUpdate) {
    append(formatUpdate(u))
    switch (u.kind) {
      case "maneuver":
        setStatus("navigating")
        setManeuver(u)
        setOffRouteAt(null)
        break
      case "off_route":
        setOffRouteAt(Date.now())
        break
      case "rerouting":
        setStatus("rerouting")
        break
      case "arrived":
        setStatus("arrived")
        setManeuver(null)
        setRunning(false)
        setActiveDestination(null)
        setRoutePoints(null)
            setOffRouteAt(null)
        navUpdateUnsubRef.current?.()
        navUpdateUnsubRef.current = null
        navRouteUnsubRef.current?.()
        navRouteUnsubRef.current = null
        break
      case "error":
        setStatus("idle")
        break
    }
  }

  async function handleStart() {
    if (!destination) {
      append("ERROR: pick a destination first")
      return
    }
    const {lat: latNum, lng: lngNum} = destination

    setLog([])
    setManeuver(null)
    setStatus("navigating")
    setActiveDestination({lat: latNum, lng: lngNum})
    setActiveDestinationName(destination.name || destination.address || null)
    setRoutePoints(null)
    setPreviewRoutePoints(null)
    append(`start → ${destination.name || `${latNum}, ${lngNum}`}${simulate ? ` (sim ${speedMultiplier}x)` : ""}`)

    if (!navUpdateUnsubRef.current) {
      navUpdateUnsubRef.current = navigation.onUpdate(handleNavUpdate)
    }
    if (!navRouteUnsubRef.current) {
      navRouteUnsubRef.current = navigation.onRoute((route: NavRoute) => {
        setRoutePoints(route.points)
        append(`route: ${route.points.length} points`)
        logPivotsAfterRoute(navigation, route, "[ROUTE:start]")
      })
    }

    const result = await navigation.start({
      stops: [{lat: latNum, lng: lngNum}],
      mode: "walking",
      simulate,
      speedMultiplier,
    })
    append(`start ack: ${JSON.stringify(result)}`)
    if (result.ok) {
      setRunning(true)
    } else {
      setStatus("idle")
      setActiveDestination(null)
      setRoutePoints(null)
        navUpdateUnsubRef.current?.()
      navUpdateUnsubRef.current = null
      navRouteUnsubRef.current?.()
      navRouteUnsubRef.current = null
    }
  }

  function handleStop() {
    navigation.stop()
    append("stop sent")
    navUpdateUnsubRef.current?.()
    navUpdateUnsubRef.current = null
    navRouteUnsubRef.current?.()
    navRouteUnsubRef.current = null
    setRunning(false)
    setStatus("idle")
    setManeuver(null)
    setActiveDestination(null)
    setActiveDestinationName(null)
    setRoutePoints(null)
    setPreviewRoutePoints(null)
    setOffRouteAt(null)
    // Also clear the picked destination so the page returns to the
    // idle (no-destination) state — otherwise tapping Done after
    // arrival drops back into the destination preview drawer.
    setDestination(null)
  }

  function handleDeviate() {
    append("deviate → +20m off-route")
    navigation.deviate(20)
  }

  const me = coords ? {lat: coords.lat, lng: coords.lng} : null

  return (
    <DrawerOffsetProvider>
    <div className="fixed inset-0 overflow-hidden ">
      <NavMap
        me={me}
        destination={activeDestination}
        routePoints={running ? routePoints : previewRoutePoints}
        autoFollow={running}
      />

      {/* Top floating stack — search bar, then orientation card while running. */}
      <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
        {!running && devDrawer !== "running" && devDrawer !== "arrived" && (
        <div className="pointer-events-auto">
          <LocationSearch
            selected={destination}
            onSelect={(place) => {
              setDestination(place)
              if (!running) setActiveDestination({lat: place.lat, lng: place.lng})
            }}
            onClear={() => {
              setDestination(null)
              if (!running) setActiveDestination(null)
            }}
            disabled={running}
            devFrozen={simulatorMode && searchFrozen}
            onSearchingChange={setIsSearching}
            refreshKey={savedPlacesVersion}
          />
        </div>
        )}
        {(running || devDrawer === "running") && (
          <div className={`"pointer-events-auto ${safeHeadingManuverCard}`}>
            <OrientationCard
              me={me}
              heading={user.heading}
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

      {!isSearching && status !== "arrived" && devDrawer !== "arrived" && (() => {
        const mode = devDrawer !== "auto" ? devDrawer : !running && !destination ? "idle" : !running && destination ? "preview" : "running"
        const devDestination = destination ?? (devDrawer !== "auto" ? DEV_DESTINATION : null)
        if (mode === "idle") return (
          <IdleDrawer
            me={me}
            onSelect={(place) => { setDestination(place); setActiveDestination({lat: place.lat, lng: place.lng}) }}
            onAddPlace={(type) => push({name: "add-place", presetType: type})}
            refreshKey={savedPlacesVersion}
          />
        )
        if (mode === "preview") return (
          <DestinationPreviewDrawer
            destination={devDestination}
            me={me}
            simulate={simulate}
            speedMultiplier={speedMultiplier}
            onStart={handleStart}
            onClose={() => { setDestination(null); setActiveDestination(null) }}
          />
        )
        return (
          <NavigationRunningDrawer
            destination={devDestination}
            me={me}
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

      <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
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
            className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${simulatorMode ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"}`}>
            {simulatorMode ? "On" : "Off"}
          </button>
        </div>
        {simulatorMode && (
          <>
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Freeze location search panel</span>
              <button
                type="button"
                onClick={() => setSearchFrozen((f) => !f)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${searchFrozen ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"}`}>
                {searchFrozen ? "Frozen" : "Freeze"}
              </button>
            </div>
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">Drawer</div>
              <div className="flex gap-1.5 flex-wrap">
                {(["auto", "idle", "preview", "running", "arrived"] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setDevDrawer(mode)}
                    className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold capitalize ${devDrawer === mode ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"}`}>
                    {mode}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        <MyLocationCard coords={coords} />
        <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
          <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase">🎯 Selected destination</div>
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
          <SimulationControls
            simulate={simulate}
            setSimulate={setSimulate}
            speedMultiplier={speedMultiplier}
            setSpeedMultiplier={setSpeedMultiplier}
            running={running}
          />
        )}
        <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
          <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">
            🚶 Travel mode
          </div>
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
        <button
          onClick={() => {
            console.log("[NAV-MINI] display.showText:", "go left")
            display.showText("go left")
          }}
          className="w-full mt-2 mb-1 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed border-blue-300 bg-blue-50 text-blue-900">
          🧪 Send "go left" to glasses
        </button>
        <button
          onClick={() => {
            // If no destination is picked yet, inject a fake one so the
            // drawer becomes visible. Toggling `running` after that
            // flips the drawer between preview and running layouts.
            if (!destination) {
              setDestination({
                placeId: "dev-fake",
                lat: 37.7956,
                lng: -122.3933,
                name: "Dev Test Destination",
                address: "1 Embarcadero Center, San Francisco, CA",
              })
              setManeuver({
                kind: "maneuver",
                maneuverType: "TURN_RIGHT",
                fromRoad: "Market St",
                toRoad: "3rd St",
                distanceMeters: 320,
              } as NavManeuver)
              setRunning(true)
              return
            }
            setRunning((r) => {
              if (r) setManeuver(null)
              else
                setManeuver({
                  kind: "maneuver",
                  maneuverType: "TURN_RIGHT",
                  fromRoad: "Market St",
                  toRoad: "3rd St",
                  distanceMeters: 320,
                } as NavManeuver)
              return !r
            })
          }}
          className="w-full mt-2 mb-1 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed border-purple-300 bg-purple-50 text-purple-900">
          🧪 Toggle drawer mode (running={String(running)})
        </button>
        {running && simulate ? <DeviateButton onDeviate={handleDeviate} /> : null}
        <LiveLog log={log} running={running} status={status} maneuver={maneuver} />
      </FloatingDevPanel>
    </div>
    </DrawerOffsetProvider>
  )
}

/* -------------------------------------------------------------------------- */

/**
 * Dump the full pivot list to the console right after a route lands.
 * The SDK's pivot engine subscribes to `onRoute` internally and
 * rebuilds the list synchronously inside its own handler — but the
 * subscriber order isn't guaranteed across consumers. We defer the
 * read by one microtask so the SDK's handler has definitely run by
 * the time we call `getPivots()`. Also re-reads ~500ms later in case
 * the host queued an atomic re-emit (Android does this when steps
 * aren't yet available at `onRoute` time).
 *
 * `tag` lets you tell apart the two callsites (start vs hydrate).
 */
function logPivotsAfterRoute(navigation: LocalNavigationManager, route: NavRoute, tag: string): void {
  const dump = (label: string) => {
    const pivots = navigation.getPivots()
    console.log(
      `${tag} ${label} — ${pivots.length} pivot(s) over ${route.points.length} polyline points` +
      (route.steps != null ? ` (steps: ${route.steps.length})` : " (steps: none)"),
    )
    if (pivots.length === 0) {
      console.log(`${tag} ${label} — no pivots yet (geometry produced nothing OR steps still loading)`)
      return
    }
    for (const p of pivots) {
      console.log(
        `${tag} ${label} pivot[${p.index}] ${p.direction.toUpperCase()} ` +
        `from="${p.fromRoad ?? "∅"}" to="${p.toRoad ?? "∅"}" ` +
        `at=(${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}) ` +
        `distAlongRoute=${Math.round(p.distanceAlongRouteMeters)}m ` +
        `radius=${p.radiusMeters}m maneuver=${p.maneuver}`,
      )
    }
  }
  // First pass — after SDK's own onRoute handler runs in this tick.
  queueMicrotask(() => dump("initial"))
  // Second pass — after the host's atomic re-emit lands (if any).
  // Android emits route twice when steps weren't ready at first
  // onRoute: once without steps, once ~50–500ms later with steps
  // folded in. The second emit triggers a fresh `getPivots()` build
  // with full from/to road metadata.
  setTimeout(() => dump("settled"), 1500)
}

/**
 * The Nav SDK sometimes returns placeholder road labels like "toward Fell St"
 * when no confirmed road name is available. Strip those — they read as
 * "onto toward Fell St" / "Continue toward Fell St", which is gibberish.
 */
function isRealRoadName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  // See OrientationCard.realRoadName for the rationale. Keep both regexes
  // in sync — the glasses HUD and the phone card need to filter the same
  // SDK-instruction-as-road-name leaks.
  if (/^(toward|turn|continue|destination|head|cross|slight|sharp|keep|merge|fork|exit|take|roundabout|u[\s-]?turn|arrive|arriving|depart|enter|leave|stay)\b/i.test(trimmed)) return null
  return trimmed
}

/**
 * Pull the road name out of a Routes API turn instruction. The API
 * returns natural language like "Turn left onto Gough St" or "Turn
 * right onto Market St / Highway 1". Returns null when the instruction
 * doesn't follow the "<verb> onto <road>" shape (e.g. bare "Turn left"
 * with no road, or destination instructions).
 */
function extractRoadFromInstruction(instruction: string | undefined): string | null {
  if (!instruction) return null
  // Strip the "Destination will be on the right" trailer that Google
  // sometimes appends to the final instruction.
  const firstLine = instruction.split("\n")[0]
  const m = firstLine.match(/\bonto\s+(.+?)(?:\s+toward\b|$)/i)
  if (!m) return null
  return m[1].trim() || null
}

/**
 * Pull the departure road out of the first step's instruction, e.g.
 * "Head northeast on Market St toward Octavia St" → "Market St".
 * Returns null when the instruction doesn't match.
 */
function extractDepartureRoad(instruction: string | undefined): string | null {
  if (!instruction) return null
  const firstLine = instruction.split("\n")[0]
  const m = firstLine.match(/\bon\s+(.+?)(?:\s+toward\b|$)/i)
  if (!m) return null
  return m[1].trim() || null
}

function formatUpdate(u: NavUpdate): string {
  switch (u.kind) {
    case "maneuver":
      return `MANEUVER: ${u.maneuverType} in ${u.distanceMeters}m`
    case "off_route":
      return `OFF_ROUTE: ${Math.round(u.offRouteDistanceMeters)}m off`
    case "rerouting":
      return "REROUTING"
    case "arrived":
      return "ARRIVED"
    case "error":
      return `ERROR: ${u.message}`
    default:
      return JSON.stringify(u)
  }
}
