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
  const isTouchingRef = useRef(false)
  // Last rotation we pushed to the cone marker. Used to skip setIcon calls
  // when the heading hasn't moved meaningfully (≥1°), since setIcon on a
  // vector map re-tessellates the SVG path each call.
  const lastConeRotationRef = useRef<number | null>(null)

  // Follow-user mode: starts from the `autoFollow` prop, breaks when the
  // user pans, and is re-engaged by the recenter button. Once broken, it
  // stays broken until the user explicitly taps recenter.
  const [followUser, setFollowUser] = useState(autoFollow)
  useEffect(() => {
    setFollowUser(autoFollow)
  }, [autoFollow])

  // Live map heading (0 = north-up). Mirrors `map.getHeading()` so the
  // compass badge can rotate counter to it. Vector maps emit
  // `heading_changed` whenever the user twists with two fingers.
  const [mapHeading, setMapHeading] = useState(0)

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

    // Mirror map heading into React state so the compass badge can
    // rotate counter to it. Vector maps emit `heading_changed` on
    // every two-finger twist tick. We unwrap the angle (carry it past
    // ±360 instead of resetting) so the badge takes the short way
    // across the 0/360 seam — otherwise crossing north visually spins
    // the needle the long way around.
    mapRef.current.addListener("heading_changed", () => {
      const h = mapRef.current?.getHeading?.() ?? 0
      setMapHeading((prev) => {
        let delta = h - (((prev % 360) + 360) % 360)
        if (delta > 180) delta -= 360
        else if (delta < -180) delta += 360
        return prev + delta
      })
    })
    console.log("[NavMap] map init complete, initial heading:", mapRef.current.getHeading?.())

    // Pinch-leak fix: Google Maps' gesture recognizer can stay in zoom mode
    // after one finger lifts from a 2-finger pinch, so the surviving
    // finger's pan keeps zooming. Suppressing events doesn't reset the
    // recognizer — it just delays the bug. The reliable fix is to dispatch
    // a synthetic `touchcancel` to the map's deepest touch target so the
    // recognizer fully resets, then let the next touchstart begin a fresh
    // gesture cleanly.
    let pinching = false
    const cancelGesture = (e: TouchEvent) => {
      const target = (e.target as Element | null) ?? container
      try {
        const synthetic = new TouchEvent("touchcancel", {
          bubbles: true,
          cancelable: false,
          touches: [],
          targetTouches: [],
          changedTouches: [],
        })
        target.dispatchEvent(synthetic)
      } catch {
        // Some WebViews disallow synthetic TouchEvent construction. Fall
        // back to a CustomEvent — Google Maps' recognizer treats any
        // touchcancel-shaped event as a reset signal.
        target.dispatchEvent(new Event("touchcancel", {bubbles: true}))
      }
    }
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length >= 2) pinching = true
    }
    const onTouchEnd = (e: TouchEvent) => {
      if (pinching && e.touches.length === 1) {
        // Pinch ended but a finger remains. Reset the recognizer so the
        // surviving finger starts a fresh single-touch gesture.
        cancelGesture(e)
        pinching = false
      } else if (e.touches.length === 0) {
        pinching = false
      }
    }
    container.addEventListener("touchstart", onTouchStart, {passive: true, capture: true})
    container.addEventListener("touchend", onTouchEnd, {passive: true, capture: true})
    container.addEventListener("touchcancel", onTouchEnd, {passive: true, capture: true})

    // Skip GPS-driven panTo while the user is touching the map — otherwise
    // every coords update fights the in-flight gesture. `isTouching` ref
    // is read by the me-marker effect.
    const onTouchActive = () => { isTouchingRef.current = true }
    const onTouchInactive = (e: TouchEvent) => {
      if (e.touches.length === 0) isTouchingRef.current = false
    }
    container.addEventListener("touchstart", onTouchActive, {passive: true, capture: true})
    container.addEventListener("touchend", onTouchInactive, {passive: true, capture: true})
    container.addEventListener("touchcancel", onTouchInactive, {passive: true, capture: true})
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
      const last = lastConeRotationRef.current
      const rotationChanged = last == null || Math.abs(effectiveHeading - last) >= 1
      if (!meConeRef.current) {
        meConeRef.current = new g.maps.Marker({
          map: mapRef.current,
          position: pos,
          zIndex: 998,
          icon: {
            path: "M 0,-32 L 18,4 L 0,-2 L -18,4 Z",
            fillColor: "#1a73e8",
            fillOpacity: 0.55,
            strokeColor: "#1a73e8",
            strokeOpacity: 0.95,
            strokeWeight: 2,
            scale: 1,
            rotation: effectiveHeading,
            anchor: new g.maps.Point(0, 0),
          },
          clickable: false,
        })
        lastConeRotationRef.current = effectiveHeading
      } else {
        meConeRef.current.setPosition(pos)
        if (rotationChanged) {
          meConeRef.current.setIcon({
            path: "M 0,-32 L 18,4 L 0,-2 L -18,4 Z",
            fillColor: "#1a73e8",
            fillOpacity: 0.55,
            strokeColor: "#1a73e8",
            strokeOpacity: 0.95,
            strokeWeight: 2,
            scale: 1,
            rotation: effectiveHeading,
            anchor: new g.maps.Point(0, 0),
          })
          lastConeRotationRef.current = effectiveHeading
        }
      }
    } else if (meConeRef.current) {
      meConeRef.current.setMap(null)
      meConeRef.current = null
      lastConeRotationRef.current = null
    }

    const meDotSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
      <circle cx="20" cy="20" r="20" fill="#00000029"/>
      <circle cx="20" cy="20" r="9"
        fill="#1A1A1A"
        stroke="white" stroke-width="3"
        filter="url(#glow)"/>
      <defs>
        <filter id="glow" x="-80%" y="-80%" width="260%" height="260%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#0A84FF" flood-opacity="0.4"/>
        </filter>
      </defs>
    </svg>`
    const meDotUrl = `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(meDotSvg)}`
    const dotIcon = {
      url: meDotUrl,
      scaledSize: new g.maps.Size(40, 40),
      anchor: new g.maps.Point(20, 20),
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

    // Don't fight the user — skip GPS-driven panTo while a finger is on
    // the map. The next GPS update after they lift will catch us up.
    if (followUser && !isTouchingRef.current) {
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
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col gap-2">
          <button
            type="button"
            aria-label="Reset bearing to north"
            onClick={() => {
              mapRef.current?.setHeading?.(0)
              setMapHeading(0)
            }}
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0, transform: `rotate(${-mapHeading}deg)`}}>
              <path d="M12 3 L14.5 12 L12 11 L9.5 12 Z" fill="#E8302E" />
              <path d="M12 13 L9.5 21 L12 20 L14.5 21 Z" fill="#000000D9" />
            </svg>
          </button>

          <button
            type="button"
            aria-label="Zoom in"
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70"
            onClick={() => {
              const m = mapRef.current
              if (!m) return
              m.setZoom(Math.min((m.getZoom() ?? 17) + 1, 21))
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <path d="M12 5V19M5 12H19" stroke="#000000D9" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            aria-label="Zoom out"
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70"
            onClick={() => {
              const m = mapRef.current
              if (!m) return
              m.setZoom(Math.max((m.getZoom() ?? 17) - 1, 3))
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <path d="M5 12H19" stroke="#000000D9" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>

          <button
            type="button"
            aria-label="Recenter on me"
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70"
            onClick={() => {
              const m = mapRef.current
              if (!m || !me) return
              m.panTo(new window.google.maps.LatLng(me.lat, me.lng))
              setFollowUser(true)
            }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <circle cx="12" cy="12" r="3" fill={followUser ? "#0A84FF" : "#1a1a1a"} />
              <circle cx="12" cy="12" r="7" stroke="#000000D9" strokeWidth="1.6" />
              <path d="M12 1V4M12 20V23M1 12H4M20 12H23" stroke="#000000D9" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}
    </div>
  )
}
