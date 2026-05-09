import {useEffect, useRef, useState} from "react"
import {motion, useMotionValue, useTransform} from "motion/react"

import {useUser} from "@/backend/hooks/useUser"
import {useDrawerOffset} from "@/frontend/components/Drawer/DrawerOffsetContext"
import {bearingDeg, haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import {rdpSmooth} from "@/backend/lib/geometry/pivots"

/** Pixels between the bottom of the right-rail button stack and the top
 *  of the active drawer. Tweak as the design wants. */
const DRAWER_GAP_PX = 10

export function NavMap({
  me,
  destination,
  routePoints,
  autoFollow = true,
}: {
  me: LatLng | null
  destination: LatLng | null
  /** Full walking-route polyline emitted by Nav SDK. If null, falls back
   *  to a straight me→destination line so the map has *something*. */
  routePoints?: Array<LatLng> | null
  autoFollow?: boolean
}) {
  const user = useUser()
  const ready = user.mapsReady
  const error = user.mapsError
  const compassHeading = user.heading

  // Right-rail buttons follow the active drawer's top edge. Drawer
  // publishes its current visible-height into a shared MotionValue
  // (see DrawerOffsetContext); we bind the wrapper's `bottom` directly
  // to that value via a useTransform — pure GPU transform, no React
  // re-render per frame, no spring lag. Dropped the previous spring +
  // snap-on-jump scheme because it was generating a lot of subscriber
  // work during drawer transitions and visibly lagging behind the
  // drawer's own animation. When no provider is present we fall back
  // to a stable zero MotionValue so the buttons sit at the bottom edge.
  const drawerOffset = useDrawerOffset()
  const fallbackOffset = useMotionValue(0)
  const sourceOffset = drawerOffset ?? fallbackOffset
  const rightRailBottom = useTransform(sourceOffset, (v) => `${v + DRAWER_GAP_PX}px`)

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

  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<any | null>(null)
  const meDotRef = useRef<any | null>(null)        // OverlayView instance
  const meArrowElRef = useRef<HTMLElement | null>(null) // inner arrow div for CSS rotation
  const meArrowAngleRef = useRef<number>(0)             // unwrapped angle to avoid 360° spins
  const meConeRef = useRef<any | null>(null)
  const destMarkerRef = useRef<any | null>(null)
  const routeRef = useRef<any | null>(null)
  const pastRouteRef = useRef<any | null>(null)
  /** Debug: red dots at each detected pivot (turn point). */
  const pivotDotsRef = useRef<any[]>([])
  const isTouchingRef = useRef(false)

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

  // "Me" marker — OverlayView so the arrow rotation is a CSS transition
  // (smooth) instead of a full SVG-swap on every heading tick.
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    const g = window.google

    if (meConeRef.current) { meConeRef.current.setMap(null); meConeRef.current = null }

    if (!meDotRef.current) {
      class MeOverlay extends g.maps.OverlayView {
        private pos: any
        private div: HTMLDivElement | null = null
        constructor(pos: any) { super(); this.pos = pos }
        onAdd() {
          const div = document.createElement("div")
          div.style.cssText = "position:absolute;width:48px;height:48px;transform:translate(-50%,-50%);pointer-events:none"
          div.innerHTML = `
            <div style="position:absolute;inset:0;border-radius:50%;background:#00000029"></div>
            <div style="position:absolute;inset:6px;border-radius:50%;background:#1A1A1A;box-shadow:0 4px 14px #00000066;display:flex;align-items:center;justify-content:center">
              <div data-arrow style="display:flex;align-items:center;justify-content:center;transition:transform 0.15s linear">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 4L19 20L12 16L5 20L12 4Z" fill="#FFFFFF"/>
                </svg>
              </div>
            </div>`
          this.div = div
          meArrowElRef.current = div.querySelector("[data-arrow]") as HTMLElement
          this.getPanes()!.overlayMouseTarget.appendChild(div)
        }
        draw() {
          if (!this.div) return
          const proj = this.getProjection()
          const pt = proj.fromLatLngToDivPixel(this.pos)!
          this.div.style.left = `${pt.x}px`
          this.div.style.top = `${pt.y}px`
        }
        setPosition(pos: any) { this.pos = pos; this.draw() }
        onRemove() { this.div?.parentNode?.removeChild(this.div); this.div = null; meArrowElRef.current = null }
      }
      const overlay = new MeOverlay(new g.maps.LatLng(me.lat, me.lng))
      overlay.setMap(mapRef.current)
      meDotRef.current = overlay
    } else {
      meDotRef.current.setPosition(new g.maps.LatLng(me.lat, me.lng))
    }

    // Unwrap the angle so we always take the shortest arc (no 360° spins)
    if (meArrowElRef.current && effectiveHeading != null) {
      const prev = meArrowAngleRef.current
      let delta = (effectiveHeading - ((prev % 360) + 360) % 360)
      if (delta > 180) delta -= 360
      else if (delta < -180) delta += 360
      meArrowAngleRef.current = prev + delta
      meArrowElRef.current.style.transform = `rotate(${meArrowAngleRef.current}deg)`
    }

    if (followUser && !isTouchingRef.current) {
      mapRef.current.panTo(new g.maps.LatLng(me.lat, me.lng))
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
    const destIconSvg = `<svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 24 16 24s16-12 16-24C32 7.16 24.84 0 16 0z" fill="#1A1A1A"/><circle cx="16" cy="15" r="5" fill="#FFFFFF"/></svg>`
    const destIcon = {
      url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(destIconSvg)}`,
      scaledSize: new g.maps.Size(32, 40),
      anchor: new g.maps.Point(16, 40),
    }
    if (!destMarkerRef.current) {
      destMarkerRef.current = new g.maps.Marker({
        map: mapRef.current,
        position: pos,
        zIndex: 997,
        icon: destIcon,
      })
    } else {
      destMarkerRef.current.setPosition(pos)
      destMarkerRef.current.setIcon(destIcon)
    }

    const key = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`
    if (centeredDestRef.current !== key) {
      centeredDestRef.current = key
      mapRef.current.panTo(pos)
      mapRef.current.setZoom(16)
    }
  }, [ready, destination?.lat, destination?.lng])

  // Route polyline: grey for the traveled portion, black for the remaining.
  // Finds the closest route point to `me` to determine the split index.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google

    // Smooth out the squiggly raw polyline before rendering. The SDK returns
    // points every 1-3m which produces visible jitter on screen; RDP at 6m
    // collapses that into clean straight runs without losing real corners.
    const rawPath: LatLng[] = routePoints && routePoints.length > 1 ? routePoints : []
    const path: LatLng[] = rawPath.length > 1 ? rdpSmooth(rawPath, 6) : rawPath

    if (path.length < 2) {
      routeRef.current?.setMap(null)
      routeRef.current = null
      pastRouteRef.current?.setMap(null)
      pastRouteRef.current = null
      return
    }

    // Project `me` onto the nearest segment of the route to get a precise
    // split point. This gives metre-accurate grey/black boundary.
    let pastPath: any[]
    let aheadPath: any[]

    if (!me) {
      pastPath = []
      aheadPath = path.map((p) => new g.maps.LatLng(p.lat, p.lng))
    } else {
      let bestSegment = 0
      let bestT = 0
      let minDist = Infinity

      for (let i = 0; i < path.length - 1; i++) {
        const ax = path[i].lng, ay = path[i].lat
        const bx = path[i + 1].lng, by = path[i + 1].lat
        const px = me.lng, py = me.lat
        const dx = bx - ax, dy = by - ay
        const lenSq = dx * dx + dy * dy
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
        const cx = ax + t * dx, cy = ay + t * dy
        const dist = Math.hypot(px - cx, py - cy)
        if (dist < minDist) { minDist = dist; bestSegment = i; bestT = t }
      }

      const projected = {
        lat: path[bestSegment].lat + bestT * (path[bestSegment + 1].lat - path[bestSegment].lat),
        lng: path[bestSegment].lng + bestT * (path[bestSegment + 1].lng - path[bestSegment].lng),
      }

      pastPath = [
        ...path.slice(0, bestSegment + 1).map((p) => new g.maps.LatLng(p.lat, p.lng)),
        new g.maps.LatLng(projected.lat, projected.lng),
      ]
      aheadPath = [
        new g.maps.LatLng(projected.lat, projected.lng),
        ...path.slice(bestSegment + 1).map((p) => new g.maps.LatLng(p.lat, p.lng)),
      ]
    }

    // Past segment — grey
    if (pastPath.length >= 2) {
      if (!pastRouteRef.current) {
        pastRouteRef.current = new g.maps.Polyline({
          map: mapRef.current,
          path: pastPath,
          strokeColor: "#999999",
          strokeOpacity: 0.7,
          strokeWeight: 6,
          zIndex: 1,
        })
      } else {
        pastRouteRef.current.setPath(pastPath)
        pastRouteRef.current.setMap(mapRef.current)
      }
    } else {
      pastRouteRef.current?.setMap(null)
    }

    // Ahead segment — black
    if (aheadPath.length >= 2) {
      if (!routeRef.current) {
        routeRef.current = new g.maps.Polyline({
          map: mapRef.current,
          path: aheadPath,
          strokeColor: "#000000",
          strokeOpacity: 0.85,
          strokeWeight: 6,
          zIndex: 2,
        })
      } else {
        routeRef.current.setPath(aheadPath)
        routeRef.current.setMap(mapRef.current)
      }
    } else {
      routeRef.current?.setMap(null)
    }
  }, [ready, me?.lat, me?.lng, destination?.lat, destination?.lng, routePoints])

  // Debug overlay: render a red dot at each detected pivot. Lets us visually
  // verify that the geometry pipeline placed turn points where they belong.
  // The pivot list comes from `user.pivots` (PivotTracker), which extracts
  // pivots from the raw SDK polyline once per route.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    const pivots = user.pivots.getPivots()

    // Tear down previous markers
    for (const dot of pivotDotsRef.current) dot.setMap(null)
    pivotDotsRef.current = []

    for (const p of pivots) {
      const dot = new g.maps.Circle({
        map: mapRef.current,
        center: {lat: p.lat, lng: p.lng},
        radius: 3, // 3m visual marker
        fillColor: "#FF3030",
        fillOpacity: 1,
        strokeColor: "#FFFFFF",
        strokeOpacity: 1,
        strokeWeight: 1.5,
        clickable: false,
        zIndex: 5,
      })
      pivotDotsRef.current.push(dot)
    }
    return () => {
      for (const dot of pivotDotsRef.current) dot.setMap(null)
      pivotDotsRef.current = []
    }
  }, [ready, routePoints, user.pivots])

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
        <motion.div
          style={{bottom: rightRailBottom}}
          className="absolute right-3 flex flex-col gap-2">
          

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
        </motion.div>
      ) : null}
    </div>
  )
}
