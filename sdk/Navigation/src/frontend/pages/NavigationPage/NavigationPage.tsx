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
    <div className="p-4 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-3">Navigation</h1>

      {running ? (
        <OrientationCard
          me={me}
          heading={heading}
          maneuver={maneuver}
          routePoints={routePoints}
        />
      ) : null}

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

      <div className="mb-3">
        <NavMap
          me={me}
          destination={activeDestination}
          routePoints={routePoints}
          breadcrumbs={breadcrumbs}
        />
      </div>

      <StartStopButton
        running={running}
        canStart={!!destination}
        simulate={simulate}
        speedMultiplier={speedMultiplier}
        onStart={handleStart}
        onStop={handleStop}
      />

      <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
        <MyLocationCard coords={coords} />
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

