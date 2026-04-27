import {useEffect, useRef, useState} from "react"
import {useSession} from "@mentra/miniapp/react"
import type {HeadingData} from "@mentra/miniapp"
import {useGoogleMaps} from "./useGoogleMaps"

type LatLng = {lat: number; lng: number}

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
  const {ready, error} = useGoogleMaps()
  const session = useSession()

  // Subscribe to native compass heading (TYPE_ROTATION_VECTOR fused
  // through SensorManager on Android). The WebView's
  // DeviceOrientationEvent doesn't work in this WebView build, so we
  // get heading from the phone over the bridge instead.
  const [compassHeading, setCompassHeading] = useState<number | null>(null)
  useEffect(() => {
    return session.heading.onUpdate((d: HeadingData) => {
      setCompassHeading(d.degrees)
    })
  }, [session])

  // Fallback: derive heading from successive GPS positions while moving.
  // Used only if the native compass never reports.
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
  }, [me?.lat, me?.lng])

  // Prefer compass; fall back to GPS bearing.
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
  }, [ready])

  // "Me" cone (rotates with heading) + dot (always upright, drawn on top).
  // We use two separate markers so the cone can rotate while the dot stays
  // a clean circle — single-marker icons in google maps don't compose well.
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    const g = window.google
    const pos = new g.maps.LatLng(me.lat, me.lng)

    // Cone (rotates with heading; hidden when no heading)
    if (effectiveHeading != null) {
      const coneIcon = {
        // Wide cone pointing UP (negative y). Big and bright so it's
        // unambiguous which way the phone is facing.
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

    // Dot (always present, drawn on top of cone)
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

  // Breadcrumb dots — where the user has actually been. We diff against
  // the previous render so we only ever ADD markers (cheap), and clear
  // everything when the array shrinks (start/stop/arrived).
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    const trail = breadcrumbs ?? []

    // Reset condition: array shrank or was emptied
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
    return <div style={{padding: 12, color: "#b00", fontSize: 13}}>Map failed to load: {error}</div>
  }

  return (
    <div style={{position: "relative", height: 320, borderRadius: 12, overflow: "hidden"}}>
      <div ref={containerRef} style={{width: "100%", height: "100%"}} />

      {!ready ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f4f4f4",
            color: "#888",
            fontSize: 13,
          }}>
          loading map…
        </div>
      ) : null}

      {/* Heading readout */}
      {effectiveHeading != null ? (
        <div style={overlayStyles.heading}>
          {Math.round(effectiveHeading)}° {cardinal(effectiveHeading)}{" "}
          <span style={overlayStyles.headingSource}>
            {headingSource === "compass" ? "compass" : "gps"}
          </span>
        </div>
      ) : null}

    </div>
  )
}

const overlayStyles = {
  heading: {
    position: "absolute",
    right: 8,
    bottom: 8,
    background: "rgba(0,0,0,0.65)",
    color: "white",
    padding: "4px 10px",
    borderRadius: 8,
    fontSize: 12,
    fontFamily: "ui-monospace, monospace",
  } as React.CSSProperties,
  headingSource: {opacity: 0.6, fontSize: 10, marginLeft: 4} as React.CSSProperties,
}

function cardinal(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
  const idx = Math.round(((deg % 360) + 360) / 45) % 8
  return dirs[idx]
}

function haversineMeters(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2)
  return 2 * R * Math.asin(Math.sqrt(h))
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const toDeg = (r: number) => (r * 180) / Math.PI
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const dLng = toRad(b.lng - a.lng)
  const y = Math.sin(dLng) * Math.cos(lat2)
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
  return (toDeg(Math.atan2(y, x)) + 360) % 360
}
