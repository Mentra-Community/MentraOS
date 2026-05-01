import {useEffect, useRef, useState} from "react"

import {useUser} from "@/backend/hooks/useUser"
import {bearingDeg, cardinal, haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"

export function NavMap({
  me,
  destination,
  routePoints,
  breadcrumbs,
  autoFollow = true,
  bottomInset = 0,
}: {
  me: LatLng | null
  destination: LatLng | null
  /** Full walking-route polyline emitted by Nav SDK. If null, falls back
   *  to a straight me→destination line so the map has *something*. */
  routePoints?: Array<LatLng> | null
  /** Where the user has actually been since the trip started. Drawn as
   *  small dots behind the position marker. */
  breadcrumbs?: Array<LatLng>
  autoFollow?: boolean
  /** Pixels of the bottom of the viewport occluded by overlay UI (e.g.
   *  the destination drawer). Floating map controls offset themselves
   *  by this so they ride up with the drawer instead of being hidden. */
  bottomInset?: number
}) {
  const user = useUser()
  const ready = user.mapsReady
  const error = user.mapsError
  const compassHeading = user.heading

  // Fallback: derive heading from successive GPS positions while moving.
  const [gpsBearing, setGpsBearing] = useState<number | null>(null)
  const lastMeRef = useRef<LatLng | null>(null)
  useEffect(() => {
    if (!me) return
    const prev = lastMeRef.current
    lastMeRef.current = me
    if (!prev) return
    const dist = haversineMeters(prev, me)
    if (dist < 3) return
    setGpsBearing(bearingDeg(prev, me))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.lat, me?.lng])

  const effectiveHeading = compassHeading != null ? compassHeading : gpsBearing
  const headingSource: "compass" | "gps" | null =
    compassHeading != null ? "compass" : gpsBearing != null ? "gps" : null

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any | null>(null)
  const meDotRef = useRef<any | null>(null)
  const meConeRef = useRef<any | null>(null)
  const destMarkerRef = useRef<any | null>(null)
  const routeRef = useRef<any | null>(null)
  const crumbMarkersRef = useRef<any[]>([])

  // Follow-user mode: starts from the `autoFollow` prop, breaks when the
  // user pans, and is re-engaged by the recenter button. Once broken, it
  // stays broken until the user explicitly taps recenter.
  const [followUser, setFollowUser] = useState(autoFollow)
  useEffect(() => {
    setFollowUser(autoFollow)
  }, [autoFollow])

  // One-time map init
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return
    const g = window.google
    const container = containerRef.current
    mapRef.current = new g.maps.Map(container, {
      center: me ?? destination ?? {lat: 37.7956, lng: -122.3933},
      zoom: 17,
      minZoom: 3,
      disableDefaultUI: true,
      zoomControl: false,
      gestureHandling: "greedy",
      mapTypeId: "roadmap",
      clickableIcons: false,
      mapId: "e21e99f3286922559250c28e",
    })

    // User drag breaks follow-mode. Recenter button re-engages it.
    mapRef.current.addListener("dragstart", () => setFollowUser(false))

    // Pinch-leak fix: when a 2-finger pinch ends and one finger remains,
    // Google Maps' gesture state can keep zooming on the surviving finger's
    // movement. We detect the pinch with a flag, and on touchend we
    // suppress the next single-finger gesture by capturing/preventing
    // touchmove until all fingers lift. This severs the pinch state.
    let pinching = false
    let suppressUntilLift = false
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) pinching = true
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (pinching && e.touches.length === 1) {
        suppressUntilLift = true
      }
      if (e.touches.length === 0) {
        pinching = false
        suppressUntilLift = false
      }
    }
    const onTouchMove = (e: TouchEvent) => {
      if (suppressUntilLift && e.touches.length === 1) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    container.addEventListener("touchstart", onTouchStart, {passive: true, capture: true})
    container.addEventListener("touchend", onTouchEnd, {passive: true, capture: true})
    container.addEventListener("touchcancel", onTouchEnd, {passive: true, capture: true})
    container.addEventListener("touchmove", onTouchMove, {passive: false, capture: true})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Re-center on the user the first time their position arrives — handles
  // the case where the map initialized before the GPS fix landed. After
  // this initial centering, the user's manual panning is respected
  // (subsequent updates only pan when autoFollow is on or a destination
  // changes).
  const initialCenteredRef = useRef(false)
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    if (initialCenteredRef.current) return
    if (destination) return // a destination drives centering instead
    initialCenteredRef.current = true
    mapRef.current.panTo(new window.google.maps.LatLng(me.lat, me.lng))
  }, [ready, me?.lat, me?.lng, destination])

  // "Me" cone (rotates with heading) + dot (always upright, drawn on top).
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    const g = window.google
    const pos = new g.maps.LatLng(me.lat, me.lng)

    if (effectiveHeading != null) {
      const coneIcon = {
        path: "M 0,-32 L 18,4 L 0,-2 L -18,4 Z",
        fillColor: "#1a73e8",
        fillOpacity: 0.55,
        strokeColor: "#1a73e8",
        strokeOpacity: 0.95,
        strokeWeight: 2,
        scale: 1,
        rotation: effectiveHeading,
        anchor: new g.maps.Point(0, 0),
      }
      if (!meConeRef.current) {
        meConeRef.current = new g.maps.Marker({
          map: mapRef.current,
          position: pos,
          zIndex: 998,
          icon: coneIcon,
          clickable: false,
        })
      } else {
        meConeRef.current.setPosition(pos)
        meConeRef.current.setIcon(coneIcon)
      }
    } else if (meConeRef.current) {
      meConeRef.current.setMap(null)
      meConeRef.current = null
    }

    const dotIcon = {
      path: g.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: "#1a73e8",
      fillOpacity: 1,
      strokeColor: "white",
      strokeWeight: 3,
    }
    if (!meDotRef.current) {
      meDotRef.current = new g.maps.Marker({
        map: mapRef.current,
        position: pos,
        zIndex: 999,
        icon: dotIcon,
        clickable: false,
      })
    } else {
      meDotRef.current.setPosition(pos)
    }

    if (followUser) {
      mapRef.current.panTo(pos)
    }
  }, [ready, me?.lat, me?.lng, effectiveHeading, followUser])

  // Destination marker — also pan/zoom the map to the destination the
  // first time it appears (or whenever it changes to a new place), so
  // picking a search result re-centers the map on it.
  const centeredDestRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    if (!destination) {
      destMarkerRef.current?.setMap(null)
      destMarkerRef.current = null
      centeredDestRef.current = null
      return
    }
    const pos = new g.maps.LatLng(destination.lat, destination.lng)
    if (!destMarkerRef.current) {
      destMarkerRef.current = new g.maps.Marker({
        map: mapRef.current,
        position: pos,
        zIndex: 997,
        icon: {
          path: g.maps.SymbolPath.CIRCLE,
          scale: 9,
          fillColor: "#ff3b30",
          fillOpacity: 1,
          strokeColor: "white",
          strokeWeight: 3,
        },
      })
    } else {
      destMarkerRef.current.setPosition(pos)
    }

    const key = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`
    if (centeredDestRef.current !== key) {
      centeredDestRef.current = key
      mapRef.current.panTo(pos)
      mapRef.current.setZoom(16)
    }
  }, [ready, destination?.lat, destination?.lng])

  // Breadcrumb dots — diff vs previous render so we only ADD markers
  // (cheap), and clear everything when the array shrinks (start/stop).
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    const trail = breadcrumbs ?? []

    if (trail.length < crumbMarkersRef.current.length) {
      crumbMarkersRef.current.forEach((m) => m.setMap(null))
      crumbMarkersRef.current = []
    }

    const dotIcon = {
      path: g.maps.SymbolPath.CIRCLE,
      scale: 4,
      fillColor: "#1a73e8",
      fillOpacity: 0.55,
      strokeColor: "white",
      strokeWeight: 1,
    }

    for (let i = crumbMarkersRef.current.length; i < trail.length; i++) {
      const p = trail[i]
      const m = new g.maps.Marker({
        map: mapRef.current,
        position: new g.maps.LatLng(p.lat, p.lng),
        icon: dotIcon,
        clickable: false,
        zIndex: 50,
      })
      crumbMarkersRef.current.push(m)
    }
  }, [ready, breadcrumbs])

  // Polyline: prefer the real walking route from Nav SDK. Fall back to a
  // straight me → destination line so the map shows *something* while
  // the route is still being computed.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google

    const path: LatLng[] =
      routePoints && routePoints.length > 1
        ? routePoints
        : []

    if (path.length < 2) {
      routeRef.current?.setMap(null)
      routeRef.current = null
      return
    }

    const gPath = path.map((p) => new g.maps.LatLng(p.lat, p.lng))
    if (!routeRef.current) {
      routeRef.current = new g.maps.Polyline({
        map: mapRef.current,
        path: gPath,
        strokeColor: "#2e7d5b",
        strokeOpacity: 0.85,
        strokeWeight: 6,
      })
    } else {
      routeRef.current.setPath(gPath)
    }
  }, [ready, me?.lat, me?.lng, destination?.lat, destination?.lng, routePoints])

  if (error) {
    return <div className="p-3 text-red-700 text-[13px]">Map failed to load: {error}</div>
  }

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 text-neutral-500 text-[13px]">
          loading map…
        </div>
      ) : null}



      {ready ? (
        <div
          className="absolute right-3 flex flex-col gap-2"
          style={{bottom: bottomInset + 12}}>
          <button
            type="button"
            aria-label="Zoom in"
            className="w-11 h-11 rounded-full bg-white shadow-md border border-neutral-200 text-neutral-800 text-xl font-semibold active:bg-neutral-100"
            onClick={() => {
              const m = mapRef.current
              if (!m) return
              m.setZoom(Math.min((m.getZoom() ?? 17) + 1, 21))
            }}>
            +
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            className="w-11 h-11 rounded-full bg-white shadow-md border border-neutral-200 text-neutral-800 text-xl font-semibold active:bg-neutral-100"
            onClick={() => {
              const m = mapRef.current
              if (!m) return
              m.setZoom(Math.max((m.getZoom() ?? 17) - 1, 3))
            }}>
            −
          </button>
          <button
            type="button"
            aria-label="Recenter on me"
            className={
              "w-11 h-11 rounded-full shadow-md border flex items-center justify-center active:opacity-80 " +
              (followUser
                ? "bg-blue-600 border-blue-600 text-white"
                : "bg-white border-neutral-200 text-neutral-800")
            }
            onClick={() => {
              const m = mapRef.current
              if (!m || !me) return
              m.panTo(new window.google.maps.LatLng(me.lat, me.lng))
              setFollowUser(true)
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  )
}
