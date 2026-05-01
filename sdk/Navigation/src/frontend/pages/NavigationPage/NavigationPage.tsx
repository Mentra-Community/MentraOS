import {useEffect, useRef, useState} from "react"
import type {NavManeuver, NavRoute, NavUpdate} from "@mentra/miniapp"

import {FloatingDevPanel} from "@/frontend/components/FloatingDevPanel/FloatingDevPanel"
import {SimulationControls} from "@/frontend/pages/NavigationPage/components/Controls/Controls"
import {DestinationDrawer} from "@/frontend/pages/NavigationPage/components/DestinationDrawer/DestinationDrawer"
import {DeviateButton} from "@/frontend/pages/NavigationPage/components/DeviateButton/DeviateButton"
import {LiveLog} from "@/frontend/pages/NavigationPage/components/LiveLog/LiveLog"
import {LocationSearch} from "@/frontend/pages/NavigationPage/components/LocationSearch/LocationSearch"
import {MyLocationCard} from "@/frontend/pages/NavigationPage/components/MyLocationCard/MyLocationCard"
import {NavMap} from "@/frontend/pages/NavigationPage/components/NavMap/NavMap"
import {useUser} from "@/backend/hooks/useUser"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"
import {fetchPreviewRoute} from "@/backend/lib/places/places"

export type NavStatus = "idle" | "navigating" | "rerouting" | "arrived"
export type LogEntry = {id: number; ts: number; line: string}

let logIdSeq = 0

export function NavigationPage() {
  // Single React entry point — User holds reactive sensor state and the
  // imperative managers, all behind one hook. Reads of `user.coords` /
  // `user.heading` / `user.mapsReady` re-render automatically.
  const user = useUser()
  const {coords, navigation, display} = user

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
  const [previewRoutePoints, setPreviewRoutePoints] = useState<LatLng[] | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])

  // Fetch a preview route whenever destination changes and we're not navigating
  const previewAbortRef = useRef<AbortController | null>(null)
  useEffect(() => {
    if (running || !destination || !coords) {
      setPreviewRoutePoints(null)
      return
    }
    previewAbortRef.current?.abort()
    const ctrl = new AbortController()
    previewAbortRef.current = ctrl
    const origin = {lat: coords.lat, lng: coords.lng}
    fetchPreviewRoute(origin, {lat: destination.lat, lng: destination.lng}, ctrl.signal).then((pts) => {
      if (!ctrl.signal.aborted) setPreviewRoutePoints(pts)
    })
    return () => ctrl.abort()
    // coords intentionally omitted — only re-fetch when destination changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, destination?.lat, destination?.lng])

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
      console.log("[NAV-MINI] display.showText:", "hello world ")
      display.showText("hello world ")
      return
    }
    if (status === "rerouting" || !maneuver) {
      const msg = status === "rerouting" ? "Rebuilding route…" : "Starting navigation…"
      console.log("[NAV-MINI] display.showText:", msg)
      display.showText(msg)
      return
    }
    if (status === "arrived" || maneuver.maneuverType === "ARRIVE") {
      const dist = maneuver.distanceMeters
      const body = dist > 0 ? `In ${formatDistance(dist)}` : "You have arrived"
      console.log("[NAV-MINI] display.showCard:", "Arriving", body)
      display.showText(`Arriving ${body}` )
      return
    }
    const {now, next} = navigation.format.glassesLines(maneuver)
    if (next) {
      console.log("[NAV-MINI] display.showTwoLines:", now, next)
      display.showText(`${now}\n${next}`)

    } else {
      console.log("[NAV-MINI] display.showText:", now)
      display.showText(now)
    }
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
    setPreviewRoutePoints(null)
    setBreadcrumbs([])
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

  // Tracks how many pixels of the bottom of the viewport are covered by
  // the destination drawer, so floating map controls can ride up with it.
  // A RAF loop reads the drawer's live position (drawer animates via
  // motion's transform, so getBoundingClientRect reflects the in-flight
  // value). Loop only runs while the drawer is mounted to keep cost low.
  const drawerWrapRef = useRef<HTMLDivElement | null>(null)
  const [drawerInset, setDrawerInset] = useState(0)
  useEffect(() => {
    if (!destination) {
      setDrawerInset(0)
      return
    }
    let raf = 0
    const tick = () => {
      const node = drawerWrapRef.current?.firstElementChild as HTMLElement | null
      if (node) {
        const rect = node.getBoundingClientRect()
        const visible = Math.max(0, window.innerHeight - rect.top)
        setDrawerInset(visible)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [destination])

  return (
    <div className="fixed inset-0 overflow-hidden ">
      <NavMap
        me={me}
        destination={activeDestination}
        routePoints={running ? routePoints : previewRoutePoints}
        breadcrumbs={breadcrumbs}
        autoFollow={running}
        bottomInset={drawerInset}
      />

      {/* Top floating stack — search bar, then orientation card while running. */}
      <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
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
            running={running}
            me={me}
            maneuver={maneuver}
            routePoints={routePoints}
          />
        </div>
      </div>

      <div ref={drawerWrapRef}>
        <DestinationDrawer
          destination={destination}
          me={me}
          running={running}
          canStart={!!destination}
          simulate={simulate}
          speedMultiplier={speedMultiplier}
          onStart={handleStart}
          onStop={handleStop}
          onClose={() => {
            setDestination(null)
            if (!running) setActiveDestination(null)
          }}
        />
      </div>

      <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
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
        <SimulationControls
          simulate={simulate}
          setSimulate={setSimulate}
          speedMultiplier={speedMultiplier}
          setSpeedMultiplier={setSpeedMultiplier}
          running={running}
        />
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
