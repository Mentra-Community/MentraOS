import {useEffect, useRef, useState} from "react"
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
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"
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
        console.log("[PREVIEW] computeRoute result:", JSON.stringify(result).slice(0, 200))
        if (ctrl.signal.aborted) return
        const pts = result.routes?.[0]?.points ?? null
        console.log("[PREVIEW] setting previewRoutePoints, count:", pts?.length ?? 0)
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
  // Drive the glasses display straight off the PivotTracker — same source
  // of truth as the OrientationCard. The HUD mirrors the phone card's
  // layout: distance line, verb, and road context joined with newlines.
  const pivotSnap = user.pivots.getSnapshot()
  const roadSnap = user.road.getSnapshot()
  useEffect(() => {
    // Arrival takes priority: when the trip ends `running` flips to false,
    // but we still want to show "You have arrived at <name>" instead of the
    // welcome idle message.
    if (pivotSnap.arrived || status === "arrived") {
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
    if (pivotSnap.direction === "right" || pivotSnap.direction === "left") {
      const verb = pivotSnap.direction === "right" ? "Turn right" : "Turn left"
      const namedRoad = isRealRoadName(maneuver?.toRoad)
      const onto = namedRoad ? `onto ${namedRoad}` : null
      display.showText([verb, onto].filter(Boolean).join("\n"))
      return
    }

    // Continue — show the upcoming verb without the distance preamble
    // (the glasses are too small to be useful as a countdown), then the
    // current road. No "In Xm" line.
    const upcomingVerb = pivotSnap.nextPivotDirection === "right"
      ? "Turn right"
      : pivotSnap.nextPivotDirection === "left"
      ? "Turn left"
      : "Continue"
    const road = isRealRoadName(maneuver?.fromRoad) ?? roadSnap.road
    display.showText([upcomingVerb, road].filter(Boolean).join("\n"))
  }, [
    display,
    running,
    status,
    pivotSnap.direction,
    pivotSnap.arrived,
    pivotSnap.distanceToNextPivotMeters,
    pivotSnap.distanceToDestinationMeters,
    pivotSnap.nextPivotDirection,
    pivotSnap.nextPivotIndex,
    roadSnap.road,
    maneuver,
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
