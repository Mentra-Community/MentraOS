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

  // One-time map init
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return
    const g = window.google
    mapRef.current = new g.maps.Map(containerRef.current, {
      center: me ?? destination ?? {lat: 37.7956, lng: -122.3933},
      zoom: 17,
      disableDefaultUI: true,
      zoomControl: true,
      gestureHandling: "greedy",
      mapTypeId: "roadmap",
      clickableIcons: false,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

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

    if (autoFollow) {
      mapRef.current.panTo(pos)
    }
  }, [ready, me?.lat, me?.lng, effectiveHeading, autoFollow])

  // Destination marker
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    if (!destination) {
      destMarkerRef.current?.setMap(null)
      destMarkerRef.current = null
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
        : me && destination
          ? [me, destination]
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
    <div className="relative h-80 rounded-xl overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 text-neutral-500 text-[13px]">
          loading map…
        </div>
      ) : null}

      {effectiveHeading != null ? (
        <div className="absolute right-2 bottom-2 bg-black/65 text-white px-2.5 py-1 rounded-lg text-xs font-mono">
          {Math.round(effectiveHeading)}° {cardinal(effectiveHeading)}{" "}
          <span className="opacity-60 text-[10px] ml-1">
            {headingSource === "compass" ? "compass" : "gps"}
          </span>
        </div>
      ) : null}
    </div>
  )
}
