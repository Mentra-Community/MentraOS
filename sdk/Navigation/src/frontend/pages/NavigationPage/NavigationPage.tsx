import {useEffect, useRef, useState} from "react"
import type {NavManeuver, NavRoute, NavUpdate} from "@mentra/miniapp"

import {FloatingDevPanel} from "@/frontend/components/FloatingDevPanel/FloatingDevPanel"
import {
  SimulationControls,
  StartStopButton,
} from "@/frontend/pages/NavigationPage/components/Controls/Controls"
import {DeviateButton} from "@/frontend/pages/NavigationPage/components/DeviateButton/DeviateButton"
import {LiveLog} from "@/frontend/pages/NavigationPage/components/LiveLog/LiveLog"
import {LocationSearch} from "@/frontend/pages/NavigationPage/components/LocationSearch/LocationSearch"
import {MyLocationCard} from "@/frontend/pages/NavigationPage/components/MyLocationCard/MyLocationCard"
import {NavMap} from "@/frontend/pages/NavigationPage/components/NavMap/NavMap"
import {OrientationCard} from "@/frontend/pages/NavigationPage/components/OrientationCard/OrientationCard"
import {useUser} from "@/backend/hooks/useUser"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"

export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"
export type LogEntry = {id: number; ts: number; line: string}

let logIdSeq = 0

export function NavigationPage() {
  // Single React entry point — User holds reactive sensor state and the
  // imperative managers, all behind one hook. Reads of `user.coords` /
  // `user.heading` / `user.mapsReady` re-render automatically.
  const user = useUser()
  const {coords, heading, navigation, display} = user

  // Destination chosen via Places search. `null` until the user picks one;
  // setting it shows the pin on the map immediately, before Start.
  const [destination, setDestination] = useState<PlaceDetails | null>(null)
  const [simulate, setSimulate] = useState(true)
  const [speedMultiplier, setSpeedMultiplier] = useState(5)

  // Trip state — owned by the page; navigation manager is just an SDK wrapper.
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState<NavStatus>("idle")
  const [maneuver, setManeuver] = useState<NavManeuver | null>(null)
  const [activeDestination, setActiveDestination] = useState<LatLng | null>(null)
  const [routePoints, setRoutePoints] = useState<NavRoute["points"] | null>(null)
  const [breadcrumbs, setBreadcrumbs] = useState<LatLng[]>([])
  const [log, setLog] = useState<LogEntry[]>([])

  const navUpdateUnsubRef = useRef<(() => void) | null>(null)
  const navRouteUnsubRef = useRef<(() => void) | null>(null)

  function append(line: string) {
    setLog((prev) => [{id: ++logIdSeq, ts: Date.now(), line}, ...prev].slice(0, 100))
  }

  // ---- breadcrumb sampling -----------------------------------------------

  useEffect(() => {
    if (!running || !coords) return
    setBreadcrumbs((prev) => {
      const last = prev[prev.length - 1]
      if (last) {
        const dLat = (coords.lat - last.lat) * 111_320
        const dLng = (coords.lng - last.lng) * 111_320 * Math.cos((coords.lat * Math.PI) / 180)
        const meters = Math.sqrt(dLat * dLat + dLng * dLng)
        if (meters < 3) return prev
      }
      const next = [...prev, {lat: coords.lat, lng: coords.lng}]
      return next.length > 500 ? next.slice(-500) : next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, coords?.lat, coords?.lng])

  // ---- glasses HUD mirror ------------------------------------------------

  useEffect(() => {
    if (!running) {
      display.clear()
      return
    }
    if (status === "rerouting" || !maneuver) {
      display.showText(status === "rerouting" ? "Rebuilding route…" : "Starting navigation…")
      return
    }
    if (status === "arrived" || maneuver.maneuverType === "ARRIVE") {
      const dist = maneuver.distanceMeters
      display.showCard("Arriving", dist > 0 ? `In ${formatDistance(dist)}` : "You have arrived")
      return
    }
    const {now, next} = navigation.format.glassesLines(maneuver)
    if (next) display.showTwoLines(now, next)
    else display.showText(now)
  }, [display, navigation, running, status, maneuver])

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
        setBreadcrumbs([])
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
    setRoutePoints(null)
    setBreadcrumbs([])
    append(
      `start → ${destination.name || `${latNum}, ${lngNum}`}${simulate ? ` (sim ${speedMultiplier}x)` : ""}`,
    )

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
      lat: latNum,
      lng: lngNum,
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
      setBreadcrumbs([])
      navUpdateUnsubRef.current?.()
      navUpdateUnsubRef.current = null
      navRouteUnsubRef.current?.()
      navRouteUnsubRef.current = null
    }
  }

  async function handleStop() {
    const result = await navigation.stop()
    append(`stop ack: ${JSON.stringify(result)}`)
    navUpdateUnsubRef.current?.()
    navUpdateUnsubRef.current = null
    navRouteUnsubRef.current?.()
    navRouteUnsubRef.current = null
    setRunning(false)
    setStatus("idle")
    setManeuver(null)
    setActiveDestination(null)
    setRoutePoints(null)
    setBreadcrumbs([])
  }

  async function handleDeviate() {
    append("deviate → +20m off-route")
    const result = await navigation.deviate(20)
    append(`deviate ack: ${JSON.stringify(result)}`)
  }

  const me = coords ? {lat: coords.lat, lng: coords.lng} : null

  return (
    <div className="fixed inset-0 overflow-hidden ">
      <NavMap
        me={me}
        destination={activeDestination}
        routePoints={routePoints}
        breadcrumbs={breadcrumbs}
      />

      {/* Top floating stack — search bar, then orientation card while running. */}
      <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
        <div className="pointer-events-auto ">
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
          />
        </div>

        {running ? (
          <div className="pointer-events-auto shadow-lg rounded-xl">
            <OrientationCard
              me={me}
              heading={heading}
              maneuver={maneuver}
              routePoints={routePoints}
            />
          </div>
        ) : null}
      </div>

      {/* Bottom floating Start/Stop pill. */}
      <div className="absolute bottom-6 left-0 right-0 px-6 flex justify-center pointer-events-none">
        <div className="pointer-events-auto w-full max-w-sm">
          <StartStopButton
            running={running}
            canStart={!!destination}
            simulate={simulate}
            speedMultiplier={speedMultiplier}
            onStart={handleStart}
            onStop={handleStop}
          />
        </div>
      </div>

      <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
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
        <SimulationControls
          simulate={simulate}
          setSimulate={setSimulate}
          speedMultiplier={speedMultiplier}
          setSpeedMultiplier={setSpeedMultiplier}
          running={running}
        />
        {running && simulate ? <DeviateButton onDeviate={handleDeviate} /> : null}
        <LiveLog log={log} running={running} status={status} maneuver={maneuver} />
      </FloatingDevPanel>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

function formatUpdate(u: NavUpdate): string {
  switch (u.kind) {
    case "maneuver":
      return `MANEUVER: ${u.maneuverType} in ${u.distanceMeters}m`
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

