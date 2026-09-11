import {useEffect, useRef, useState} from "react"
import {motion, useMotionValue, useTransform} from "motion/react"
import type {Map as MbMap, Marker as MbMarker} from "mapbox-gl"

import {useNavStore} from "@/ui/store/navStore"
import {bearingDeg, haversineMeters, rdpSmooth} from "@/ui/lib/geometry"
import {formatDistance} from "@/ui/lib/formatDistance"
import {RecenterIcon, SettingsIcon} from "@/ui/components/icons"

// Experiment toggle: render the route line with RDP smoothing applied or
// straight from the raw points the engine returned. Flip to false to see the
// unsmoothed path — useful for verifying turn-dot positions against the
// actual polyline vertices rather than the visually-smoothed line.
const SMOOTH_ROUTE_LINE = false
import type {LatLng} from "@/shared/types"
import {isDev} from "@/ui/lib/env"
import {useDevOverride} from "@/ui/lib/devOverride"
import {getMapbox, mapboxgl} from "@/ui/lib/mapbox"
import {useColorScheme} from "@mentra/miniapp/ui"

import {mapboxStyleUrl} from "./mapStyle"
import {useDrawerOffset} from "@/ui/components/Drawer/DrawerOffsetContext"

// GeoJSON helpers — Mapbox is [lng, lat] (GeoJSON order), the opposite of
// Google's {lat, lng}. Centralizing the conversion keeps the flip in one
// place so we can't accidentally feed lat-first coords to a Mapbox API.
const toLngLat = (p: LatLng): [number, number] => [p.lng, p.lat]
function lineFeature(points: LatLng[]): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    geometry: {type: "LineString", coordinates: points.map(toLngLat)},
    properties: {},
  }
}

export function NavMap({
  me,
  destination,
  routePoints,
  previewTurns,
  showPivots = true,
  showOffRouteLine = false,
  savedPlaces = [],
  autoFollow = true,
  hideControls = false,
  onLongPress,
  onPlaceTap,
  onOpenSettings,
}: {
  me: LatLng | null
  destination: LatLng | null
  /** Full walking-route polyline emitted by the nav engine. If null, falls
   *  back to a straight me→destination line so the map has *something*. */
  routePoints?: Array<LatLng> | null
  /** Dev-only turn points for the previewed route, drawn as red debug
   *  dots with a hovering road-name label. Supplied while previewing
   *  (the SDK's live pivot list is empty until a trip starts). When
   *  null/running, NavMap fetches the live pivot list via the
   *  nav:get-pivots RPC instead (those have no label). */
  previewTurns?: Array<{
    lat: number
    lng: number
    label?: string | null
    /** Coarse turn direction ("Turn left"/"Turn right") metadata. */
    direction?: "Turn left" | "Turn right" | null
  }> | null
  /** Dev-toggle: when false, suppress the red turn-pivot dots + labels even
   *  if dev mode is on. Default true. */
  showPivots?: boolean
  /** Dev-toggle: when false, suppress the blue me→route connector line +
   *  distance label even if dev mode is on. Default false (off). */
  showOffRouteLine?: boolean
  /** Stars / home / work pins to drop while the map is idle. Empty while
   *  a trip is running so the route stays uncluttered. */
  savedPlaces?: Array<{lat: number; lng: number; placeId: string; type?: "home" | "work"; savedName?: string}>
  autoFollow?: boolean
  /** Hide the floating zoom/recenter rail — e.g. while a full-screen
   *  search overlay is covering the map. */
  hideControls?: boolean
  /**
   * Fires when the user holds a single finger on the map for ~600ms
   * without panning. Receives the lat/lng under the pressed point.
   * Used to drop a destination pin (Maps-style "long press to search
   * this location"). Parent decides what to do with it.
   */
  onLongPress?: (coord: LatLng) => void
  /**
   * Fires when the user taps a built-in Mapbox POI symbol. Receives the
   * feature's name/id (a synthetic placeId string). Parent resolves it
   * and decides what to do — typically set it as the selected
   * destination so the preview drawer opens. Omitted → POI taps are
   * ignored.
   */
  onPlaceTap?: (name: string, coord: LatLng) => void
  /** Fires when the user taps the settings gear in the right-rail.
   *  Parent navigates to the settings page. */
  onOpenSettings?: () => void
}) {
  // Map readiness is local — driven directly by the Mapbox token resolve +
  // first map `load`. Decoupled from `useNavStore` so a stalled background
  // handshake (no CONNECT_ACK, no snapshot push) can't keep the map grey.
  const [ready, setReady] = useState(false)

  // Dev-only debug chrome (pivot dots + labels rendered as map markers)
  // shows when the build is dev OR when the user has unlocked the
  // override via the 5-second hold on the search bar. See lib/devOverride.
  const devOverride = useDevOverride()
  const devEnabled = isDev || devOverride

  // Anchor the floating right-rail (zoom / recenter buttons) just above
  // whichever drawer is currently mounted.
  const drawerOffset = useDrawerOffset()
  const fallbackZero = useMotionValue(0)
  const railBottom = useTransform(drawerOffset ?? fallbackZero, (h: number) => h + 12)

  useEffect(() => {
    let alive = true
    getMapbox()
      .whenReady()
      .then(
        () => {
          if (alive) setReady(true)
        },
        () => {
          if (alive) setReady(false)
        },
      )
    return () => {
      alive = false
    }
  }, [])

  const compassHeading = useNavStore((s) => s.heading)
  const unitSystem = useNavStore((s) => s.unitSystem)
  const error: string | null = null

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
  const mapRef = useRef<MbMap | null>(null)
  // Map-style readiness as STATE (not a ref) so the route/marker effects below
  // re-run the moment the style is parsed and draw immediately. Set on the
  // Mapbox `style.load` event, which fires EARLIER than the full `load` event —
  // sources/layers (ensureRouteLayers) are valid once the style is parsed, so
  // gating on style.load lets the polyline paint without waiting for every tile
  // to download. This is what cuts the 8-9s "blank route on WebView reopen":
  // on reopen the map rebuilds from scratch, and the route data (already in the
  // store via the snapshot) was previously blocked behind the slow `load`.
  const [mapLoaded, setMapLoaded] = useState(false)
  const mapLoadedRef = useRef(false)
  // "Me" marker is a Mapbox Marker with a custom DOM element. The inner
  // arrow div rotates via CSS; rotationAlignment:'map' keeps the marker
  // body aligned to compass north as the map twists.
  const meMarkerRef = useRef<MbMarker | null>(null)
  const meArrowElRef = useRef<HTMLElement | null>(null) // inner arrow div for CSS rotation
  const meArrowAngleRef = useRef<number>(0) // unwrapped angle to avoid 360° spins
  const destMarkerRef = useRef<MbMarker | null>(null)
  // Off-route blue connector + its distance label (a DOM-element Marker).
  const offRouteLabelRef = useRef<MbMarker | null>(null)
  /** Debug: hovering road-name label markers paired with the pivot dots. */
  const pivotLabelsRef = useRef<MbMarker[]>([])
  // Saved-place markers (home / work / starred) shown while idle.
  const savedMarkersRef = useRef<Map<string, MbMarker>>(new Map())
  const isTouchingRef = useRef(false)

  // Follow-user mode: starts from the `autoFollow` prop, breaks when the
  // user pans, re-engaged by the recenter button.
  const [followUser, setFollowUser] = useState(autoFollow)
  useEffect(() => {
    setFollowUser(autoFollow)
  }, [autoFollow])

  // Live map heading (0 = north-up). Mirrors `map.getBearing()` so the
  // compass badge can rotate counter to it.
  const [mapHeading, setMapHeading] = useState(0)

  // Basemap follows the host color scheme (read once; the host reloads the
  // WebView on theme flips, so no live restyle is needed).
  const scheme = useColorScheme()

  // One-time map init
  useEffect(() => {
    if (!ready || !containerRef.current || mapRef.current) return
    const center = me ?? destination ?? {lat: 37.7956, lng: -122.3933}
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: mapboxStyleUrl(scheme),
      center: toLngLat(center),
      zoom: 17,
      minZoom: 3,
      attributionControl: false,
      // greedy-equivalent: GL JS pans/zooms with one finger by default;
      // we just don't enable cooperativeGestures.
      pitchWithRotate: false,
      dragRotate: true,
    })
    mapRef.current = map

    // Mark the map ready as soon as the STYLE is parsed (style.load fires
    // before the full `load`). Adding sources/layers is valid here, so the
    // route polyline can paint immediately instead of waiting for every tile
    // to finish downloading — this is the fix for the slow route paint on
    // WebView reopen. `load` is kept as a backstop (covers the rare case where
    // the style was already loaded before this handler attached).
    const markLoaded = () => {
      if (mapLoadedRef.current) return
      mapLoadedRef.current = true
      // Pre-create the route sources/layers (empty) so the route effect
      // can just setData without races on first paint.
      ensureRouteLayers(map)
      setMapLoaded(true) // re-runs the route/marker effects to draw now
    }
    map.on("style.load", markLoaded)
    map.on("load", markLoaded)

    // User drag breaks follow-mode. `originalEvent` is present only for
    // user-initiated moves (absent for our programmatic easeTo/panTo).
    map.on("movestart", (e: {originalEvent?: unknown}) => {
      if (e.originalEvent) setFollowUser(false)
    })

    // Mirror map bearing into React state so the compass badge can rotate
    // counter to it. Unwrap the angle (carry past ±360) so the badge takes
    // the short way across the 0/360 seam.
    map.on("rotate", () => {
      const h = ((map.getBearing() % 360) + 360) % 360
      setMapHeading((prev) => {
        let delta = h - (((prev % 360) + 360) % 360)
        if (delta > 180) delta -= 360
        else if (delta < -180) delta += 360
        return prev + delta
      })
    })

    // Skip GPS-driven recenter while the user is touching the map.
    const container = containerRef.current
    const onTouchActive = () => {
      isTouchingRef.current = true
    }
    const onTouchInactive = (e: TouchEvent) => {
      if (e.touches.length === 0) isTouchingRef.current = false
    }
    container.addEventListener("touchstart", onTouchActive, {passive: true, capture: true})
    container.addEventListener("touchend", onTouchInactive, {passive: true, capture: true})
    container.addEventListener("touchcancel", onTouchInactive, {passive: true, capture: true})

    // POI taps: query the symbol layers under the tap point. Mapbox has no
    // single "clickableIcons" flag, so we read rendered POI-label features
    // and surface the feature name as a synthetic placeId. Parent resolves
    // it (places search) and opens the preview drawer.
    map.on("click", (e) => {
      const placeHandler = onPlaceTapRef.current
      if (!placeHandler) return
      // ONLY react to taps on an actual landmark/POI label (a cafe, store,
      // park, etc.) — taps on empty map do nothing. Read the rendered POI
      // symbol features under the tap point.
      const feats = map.queryRenderedFeatures(e.point)
      const poi = feats.find(
        (f) => typeof f.layer?.id === "string" && /poi|place-label/i.test(f.layer.id) && f.properties?.name,
      )
      if (!poi?.properties?.name) return
      // Pass the POI's NAME plus ITS OWN coordinates (the label's geometry,
      // not the raw tap point) so the parent can pin-point the landmark and
      // reverse-geocode that exact spot for the real address.
      const geom = poi.geometry
      const coord =
        geom?.type === "Point"
          ? {lng: geom.coordinates[0] as number, lat: geom.coordinates[1] as number}
          : {lng: e.lngLat.lng, lat: e.lngLat.lat}
      placeHandler(String(poi.properties.name), coord)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Long-press to drop a destination pin. We treat `contextmenu` (Android
  // OS long-press) as the canonical signal, with a 600ms pointer timer
  // fallback for iOS WKWebView (which never fires contextmenu).
  const onLongPressRef = useRef(onLongPress)
  const onPlaceTapRef = useRef(onPlaceTap)
  useEffect(() => {
    onPlaceTapRef.current = onPlaceTap
  }, [onPlaceTap])
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])
  useEffect(() => {
    if (!ready || !mapRef.current || !containerRef.current) return
    const map = mapRef.current
    const container = containerRef.current
    const MAX_MOVE_PX = 12
    const MAX_CONTEXTMENU_DELAY_MS = 1500
    let downX = 0
    let downY = 0
    let downAt = 0
    let armed = false
    let cancelled = false
    // Lat/lng resolved from the touch point AT pointerdown time. Pin to
    // this rather than re-projecting later: the map can pan under a still
    // finger (auto-follow recenters), and a re-projection would convert the
    // same pixel against a moved map → an offset pin.
    let downCoord: LatLng | null = null
    // Project a client (viewport) pixel to a lat/lng via map.unproject —
    // the Mapbox analog of OverlayView.fromContainerPixelToLatLng.
    const projectClientPoint = (clientX: number, clientY: number): LatLng | null => {
      const rect = container.getBoundingClientRect()
      try {
        const ll = map.unproject([clientX - rect.left, clientY - rect.top])
        return {lat: ll.lat, lng: ll.lng}
      } catch {
        return null
      }
    }
    const LONG_PRESS_MS = 600
    let longPressTimer: ReturnType<typeof setTimeout> | null = null
    const clearLongPressTimer = () => {
      if (longPressTimer != null) {
        clearTimeout(longPressTimer)
        longPressTimer = null
      }
    }
    const fireLongPress = (source: "timer" | "contextmenu") => {
      if (!armed || cancelled) return
      armed = false
      clearLongPressTimer()
      const coord = downCoord ?? projectClientPoint(downX, downY)
      if (!coord) {
        console.warn("[NavMap] long-press: no projection available; pin not dropped")
        return
      }
      console.log(`[NavMap] long-press @`, coord.lat.toFixed(6), coord.lng.toFixed(6), `(via ${source})`)
      onLongPressRef.current?.(coord)
    }
    const onDown = (e: PointerEvent) => {
      if (!e.isPrimary) {
        armed = false
        cancelled = true
        clearLongPressTimer()
        return
      }
      downX = e.clientX
      downY = e.clientY
      downAt = Date.now()
      armed = true
      cancelled = false
      downCoord = projectClientPoint(e.clientX, e.clientY)
      clearLongPressTimer()
      longPressTimer = setTimeout(() => fireLongPress("timer"), LONG_PRESS_MS)
    }
    const onMove = (e: PointerEvent) => {
      if (!armed) return
      const dx = e.clientX - downX
      const dy = e.clientY - downY
      if (dx * dx + dy * dy > MAX_MOVE_PX * MAX_MOVE_PX) {
        armed = false
        cancelled = true
        clearLongPressTimer()
      }
    }
    const onUp = () => {
      clearLongPressTimer()
    }
    const onCancel = () => {
      armed = false
      cancelled = true
      clearLongPressTimer()
    }
    const onContextMenu = (e: Event) => {
      e.preventDefault()
      if (!armed || cancelled) return
      if (Date.now() - downAt > MAX_CONTEXTMENU_DELAY_MS) return
      fireLongPress("contextmenu")
    }
    container.addEventListener("pointerdown", onDown, {capture: true})
    container.addEventListener("pointermove", onMove, {capture: true})
    container.addEventListener("pointerup", onUp, {capture: true})
    container.addEventListener("pointercancel", onCancel, {capture: true})
    container.addEventListener("contextmenu", onContextMenu)
    return () => {
      clearLongPressTimer()
      container.removeEventListener("pointerdown", onDown, {capture: true} as any)
      container.removeEventListener("pointermove", onMove, {capture: true} as any)
      container.removeEventListener("pointerup", onUp, {capture: true} as any)
      container.removeEventListener("pointercancel", onCancel, {capture: true} as any)
      container.removeEventListener("contextmenu", onContextMenu)
    }
  }, [ready])

  // Re-center on the user the first time their position arrives.
  const initialCenteredRef = useRef(false)
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    if (initialCenteredRef.current) return
    if (destination) return
    initialCenteredRef.current = true
    mapRef.current.panTo(toLngLat(me))
  }, [ready, me?.lat, me?.lng, destination])

  // "Me" marker — Marker with a custom DOM element so the arrow rotation is
  // a CSS transition (smooth) instead of a full element swap on every tick.
  useEffect(() => {
    if (!ready || !mapRef.current || !me) return
    const map = mapRef.current

    if (!meMarkerRef.current) {
      const el = document.createElement("div")
      el.style.cssText = "width:48px;height:48px;pointer-events:none"
      el.innerHTML = `
        <div style="position:absolute;inset:0;border-radius:50%;background:#00000029"></div>
        <div style="position:absolute;inset:6px;border-radius:50%;background:#1A1A1A;box-shadow:0 4px 14px #00000066;display:flex;align-items:center;justify-content:center">
          <div data-arrow style="display:flex;align-items:center;justify-content:center;transition:transform 0.15s linear">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 4L19 20L12 16L5 20L12 4Z" fill="#FFFFFF"/>
            </svg>
          </div>
        </div>`
      meArrowElRef.current = el.querySelector("[data-arrow]") as HTMLElement
      meMarkerRef.current = new mapboxgl.Marker({element: el, anchor: "center"})
        .setLngLat(toLngLat(me))
        .addTo(map)
    } else {
      meMarkerRef.current.setLngLat(toLngLat(me))
    }

    // Unwrap the angle so we always take the shortest arc (no 360° spins).
    if (meArrowElRef.current && effectiveHeading != null) {
      const prev = meArrowAngleRef.current
      let delta = effectiveHeading - (((prev % 360) + 360) % 360)
      if (delta > 180) delta -= 360
      else if (delta < -180) delta += 360
      meArrowAngleRef.current = prev + delta
      meArrowElRef.current.style.transform = `rotate(${meArrowAngleRef.current}deg)`
    }

    if (followUser && !isTouchingRef.current) {
      map.panTo(toLngLat(me))
    }
  }, [ready, me?.lat, me?.lng, effectiveHeading, followUser])

  // Destination marker — also pan/zoom to it the first time it appears (or
  // whenever it changes), so picking a search result re-centers the map.
  const centeredDestRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const map = mapRef.current
    if (!destination) {
      destMarkerRef.current?.remove()
      destMarkerRef.current = null
      centeredDestRef.current = null
      return
    }
    const destIconSvg = `<svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 24 16 24s16-12 16-24C32 7.16 24.84 0 16 0z" fill="#1A1A1A"/><circle cx="16" cy="15" r="5" fill="#FFFFFF"/></svg>`
    if (!destMarkerRef.current) {
      const el = document.createElement("div")
      el.style.cssText = "width:32px;height:40px;pointer-events:none"
      el.innerHTML = destIconSvg
      // anchor 'bottom' so the teardrop tip sits on the coordinate.
      destMarkerRef.current = new mapboxgl.Marker({element: el, anchor: "bottom"})
        .setLngLat(toLngLat(destination))
        .addTo(map)
    } else {
      destMarkerRef.current.setLngLat(toLngLat(destination))
    }

    const key = `${destination.lat.toFixed(6)},${destination.lng.toFixed(6)}`
    if (centeredDestRef.current !== key) {
      centeredDestRef.current = key
      map.easeTo({center: toLngLat(destination), zoom: 16})
    }
  }, [ready, destination?.lat, destination?.lng])

  // Saved-place markers (home / work / starred). Diffed against the current
  // placeId set so we don't churn every render. Currently disabled on the
  // map entirely (SHOW_SAVED_PINS=false) but the effect still runs to clean
  // up any leftover markers.
  const SHOW_SAVED_PINS = false
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const map = mapRef.current
    const showSaved = SHOW_SAVED_PINS && !destination && savedPlaces.length > 0
    const current = savedMarkersRef.current
    const wantedIds = new Set(showSaved ? savedPlaces.map((p) => p.placeId) : [])
    for (const [id, marker] of current) {
      if (!wantedIds.has(id)) {
        marker.remove()
        current.delete(id)
      }
    }
    if (!showSaved) return
    for (const place of savedPlaces) {
      const existing = current.get(place.placeId)
      if (existing) {
        existing.setLngLat(toLngLat(place))
        continue
      }
      const el = document.createElement("div")
      el.style.cssText = "width:32px;height:40px;pointer-events:none"
      el.innerHTML = renderSavedPlaceIconSvg(place.type)
      el.title = place.savedName ?? (place.type === "home" ? "Home" : place.type === "work" ? "Work" : "")
      const marker = new mapboxgl.Marker({element: el, anchor: "bottom"}).setLngLat(toLngLat(place)).addTo(map)
      current.set(place.placeId, marker)
    }
  }, [ready, destination, savedPlaces])

  // Route polyline: grey for the traveled portion, black for the remaining.
  // Two GeoJSON line layers (past + ahead); we setData on each.
  useEffect(() => {
    if (!ready || !mapRef.current || !mapLoadedRef.current) return
    const map = mapRef.current
    ensureRouteLayers(map)

    const rawPath: LatLng[] = routePoints && routePoints.length > 1 ? routePoints : []
    const path: LatLng[] = SMOOTH_ROUTE_LINE && rawPath.length > 1 ? rdpSmooth(rawPath, 14) : rawPath

    const pastSrc = map.getSource("nav-route-past") as mapboxgl.GeoJSONSource | undefined
    const aheadSrc = map.getSource("nav-route-ahead") as mapboxgl.GeoJSONSource | undefined
    const endSrc = map.getSource("nav-route-end") as mapboxgl.GeoJSONSource | undefined
    if (!pastSrc || !aheadSrc) return

    if (path.length < 2) {
      pastSrc.setData(emptyFC())
      aheadSrc.setData(emptyFC())
      endSrc?.setData(emptyFC())
      return
    }

    // Black circle at the GEOMETRIC end of the route line (its last point) —
    // marks where the route terminates, independent of the destination pin.
    const end = path[path.length - 1]
    endSrc?.setData({
      type: "FeatureCollection",
      features: [{type: "Feature", geometry: {type: "Point", coordinates: [end.lng, end.lat]}, properties: {}}],
    })

    let pastPath: LatLng[]
    let aheadPath: LatLng[]
    if (!me) {
      pastPath = []
      aheadPath = path
    } else {
      // Project `me` onto the nearest segment to get a metre-accurate split.
      let bestSegment = 0
      let bestT = 0
      let minDist = Infinity
      for (let i = 0; i < path.length - 1; i++) {
        const ax = path[i].lng,
          ay = path[i].lat
        const bx = path[i + 1].lng,
          by = path[i + 1].lat
        const px = me.lng,
          py = me.lat
        const dx = bx - ax,
          dy = by - ay
        const lenSq = dx * dx + dy * dy
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
        const cx = ax + t * dx,
          cy = ay + t * dy
        const dist = Math.hypot(px - cx, py - cy)
        if (dist < minDist) {
          minDist = dist
          bestSegment = i
          bestT = t
        }
      }
      const projected: LatLng = {
        lat: path[bestSegment].lat + bestT * (path[bestSegment + 1].lat - path[bestSegment].lat),
        lng: path[bestSegment].lng + bestT * (path[bestSegment + 1].lng - path[bestSegment].lng),
      }
      pastPath = [...path.slice(0, bestSegment + 1), projected]
      aheadPath = [projected, ...path.slice(bestSegment + 1)]
    }

    pastSrc.setData(pastPath.length >= 2 ? lineFeature(pastPath) : emptyFC())
    aheadSrc.setData(aheadPath.length >= 2 ? lineFeature(aheadPath) : emptyFC())
  }, [ready, mapLoaded, me?.lat, me?.lng, destination?.lat, destination?.lng, routePoints])

  // Dev: blue connector line from `me` → closest point on the route, with a
  // midpoint distance label. Uses the raw (unsmoothed) polyline.
  useEffect(() => {
    if (!ready || !mapRef.current || !mapLoadedRef.current) return
    const map = mapRef.current
    ensureRouteLayers(map)
    const offRouteSrc = map.getSource("nav-offroute") as mapboxgl.GeoJSONSource | undefined

    function teardown() {
      offRouteSrc?.setData(emptyFC())
      offRouteLabelRef.current?.remove()
      offRouteLabelRef.current = null
    }

    if (!devEnabled || !showOffRouteLine || !me || !routePoints || routePoints.length < 2) {
      teardown()
      return
    }

    let bestSegment = 0
    let bestT = 0
    let minDist = Infinity
    for (let i = 0; i < routePoints.length - 1; i++) {
      const ax = routePoints[i].lng,
        ay = routePoints[i].lat
      const bx = routePoints[i + 1].lng,
        by = routePoints[i + 1].lat
      const px = me.lng,
        py = me.lat
      const dx = bx - ax,
        dy = by - ay
      const lenSq = dx * dx + dy * dy
      const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq))
      const cx = ax + t * dx,
        cy = ay + t * dy
      const d = Math.hypot(px - cx, py - cy)
      if (d < minDist) {
        minDist = d
        bestSegment = i
        bestT = t
      }
    }
    const projected: LatLng = {
      lat: routePoints[bestSegment].lat + bestT * (routePoints[bestSegment + 1].lat - routePoints[bestSegment].lat),
      lng: routePoints[bestSegment].lng + bestT * (routePoints[bestSegment + 1].lng - routePoints[bestSegment].lng),
    }
    const distMeters = haversineMeters(me, projected)
    const midpoint: LatLng = {lat: (me.lat + projected.lat) / 2, lng: (me.lng + projected.lng) / 2}

    offRouteSrc?.setData(lineFeature([me, projected]))

    const labelText = formatDistance(distMeters, unitSystem)
    if (!offRouteLabelRef.current) {
      const el = document.createElement("div")
      el.style.cssText =
        "transform:translate(-50%,-50%);pointer-events:none;padding:2px 6px;border-radius:6px;" +
        "background:#1E88FF;color:#FFFFFF;font:600 11px/1.2 system-ui,sans-serif;white-space:nowrap;" +
        "box-shadow:0 2px 6px #00000040;border:1px solid #FFFFFF99"
      el.textContent = labelText
      offRouteLabelRef.current = new mapboxgl.Marker({element: el, anchor: "center"})
        .setLngLat(toLngLat(midpoint))
        .addTo(map)
    } else {
      offRouteLabelRef.current.setLngLat(toLngLat(midpoint))
      const el = offRouteLabelRef.current.getElement()
      el.textContent = labelText
    }

    return teardown
  }, [ready, mapLoaded, me?.lat, me?.lng, routePoints, devEnabled, showOffRouteLine, unitSystem])

  // Debug overlay: a red dot at each turn point + a hovering road-name
  // badge. Dots are a GeoJSON circle layer; badges are DOM-element markers.
  useEffect(() => {
    if (!devEnabled || !showPivots) return
    if (!ready || !mapRef.current || !mapLoadedRef.current) return
    const map = mapRef.current
    ensureRouteLayers(map)
    const dotsSrc = map.getSource("nav-pivots") as mapboxgl.GeoJSONSource | undefined

    function teardown() {
      dotsSrc?.setData(emptyFC())
      for (const label of pivotLabelsRef.current) label.remove()
      pivotLabelsRef.current = []
    }

    teardown()

    function drawDots(turns: Array<{lat: number; lng: number; label?: string | null; direction?: string | null}>) {
      if (!mapRef.current) return
      const features: GeoJSON.Feature<GeoJSON.Point>[] = turns.map((p) => ({
        type: "Feature",
        geometry: {type: "Point", coordinates: [p.lng, p.lat]},
        properties: {},
      }))
      dotsSrc?.setData({type: "FeatureCollection", features})
      for (const p of turns) {
        if (!p.label) continue
        const el = document.createElement("div")
        el.style.cssText =
          "transform:translate(-50%,calc(-100% - 8px));pointer-events:none;padding:3px 7px;border-radius:6px;" +
          "background:#FF3030;color:#FFFFFF;font:600 11px/1.3 system-ui,sans-serif;white-space:nowrap;" +
          "text-align:center;box-shadow:0 2px 6px #00000040;border:1px solid #FFFFFF99"
        if (p.direction) {
          const dir = document.createElement("div")
          dir.style.cssText = "font-weight:700;letter-spacing:0.01em"
          dir.textContent = p.direction
          el.appendChild(dir)
        }
        const road = document.createElement("div")
        if (p.direction) road.style.cssText = "opacity:0.92;font-weight:600"
        road.textContent = p.label
        el.appendChild(road)
        const marker = new mapboxgl.Marker({element: el, anchor: "bottom"})
          .setLngLat([p.lng, p.lat])
          .addTo(map)
        pivotLabelsRef.current.push(marker)
      }
    }

    if (previewTurns && previewTurns.length > 0) {
      drawDots(previewTurns)
      return teardown
    }

    // Running path: fetch the live pivot list over the channel boundary.
    // Two fetches: immediate (geometry pivots) + ~700ms later (instruction
    // pivots once the SDK's async computeRoute resolves).
    let cancelled = false
    const fetchAndDraw = () => {
      mentra
        .request("nav:get-pivots", undefined)
        .then((pivots) => {
          if (cancelled) return
          dotsSrc?.setData(emptyFC())
          for (const label of pivotLabelsRef.current) label.remove()
          pivotLabelsRef.current = []
          const formatted = pivots.map((p) => {
            if (p.maneuver === "CROSS_STREET") {
              return {
                lat: p.lat,
                lng: p.lng,
                label: p.toRoad ? `Cross to ${p.toRoad}` : "Cross the street",
                direction: null,
              }
            }
            const direction: "Turn left" | "Turn right" | null =
              p.direction === "left" ? "Turn left" : p.direction === "right" ? "Turn right" : null
            const label = p.fromRoad && p.toRoad ? `${p.fromRoad} → ${p.toRoad}` : (p.toRoad ?? p.fromRoad ?? null)
            return {lat: p.lat, lng: p.lng, label, direction}
          })
          drawDots(formatted)
        })
        .catch((err) => {
          console.warn("[NavMap] nav:get-pivots failed:", err)
        })
    }
    fetchAndDraw()
    const refetchHandle = setTimeout(fetchAndDraw, 700)

    return () => {
      cancelled = true
      clearTimeout(refetchHandle)
      teardown()
    }
  }, [ready, mapLoaded, routePoints, previewTurns, devEnabled, showPivots])

  if (error) {
    return <div className="p-3 text-red-700 text-[13px]">Map failed to load: {error}</div>
  }

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div ref={containerRef} className="w-full h-full select-none touch-manipulation [-webkit-touch-callout:none]" />

      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 dark:bg-zinc-900 text-neutral-500 dark:text-zinc-400 text-[13px]">
          loading map…
        </div>
      ) : !me && !destination ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 dark:bg-zinc-900">
          <div
            className="w-8 h-8 rounded-full border-[3px] border-neutral-300 dark:border-zinc-700 border-t-neutral-700 dark:border-t-zinc-200 animate-spin"
            role="status"
            aria-label="Finding your location"
          />
        </div>
      ) : null}

      {ready && !hideControls ? (
        <motion.div style={{bottom: railBottom}} className="absolute right-3 z-50 flex flex-col gap-2">
          <button
            type="button"
            aria-label="Recenter on me"
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70"
            onClick={() => {
              const m = mapRef.current
              if (!m || !me) return
              m.panTo(toLngLat(me))
              setFollowUser(true)
            }}>
            <RecenterIcon active={followUser} />
          </button>

          <button
            type="button"
            aria-label="Settings"
            className="flex items-center justify-center rounded-[22px] bg-white [box-shadow:#0000001F_0px_4px_14px] w-11 h-11 shrink-0 active:opacity-70"
            onClick={() => {
              console.log("[NavMap] settings button tapped")
              onOpenSettings?.()
            }}>
            <SettingsIcon size={20} color="#000000D9" />
          </button>
        </motion.div>
      ) : null}
    </div>
  )
}

/** Empty GeoJSON FeatureCollection — used to clear a source. */
function emptyFC(): GeoJSON.FeatureCollection {
  return {type: "FeatureCollection", features: []}
}

/**
 * Idempotently create the route sources + layers. Mapbox needs sources and
 * layers added once after the style loads; the per-render effects then just
 * `setData`. Order matters for z-stacking — past (grey) below ahead (black)
 * below the off-route connector below the pivot dots.
 */
function ensureRouteLayers(map: MbMap): void {
  const addLine = (id: string, color: string, width: number, opacity: number) => {
    if (!map.getSource(id)) map.addSource(id, {type: "geojson", data: emptyFC()})
    if (!map.getLayer(`${id}-layer`)) {
      map.addLayer({
        id: `${id}-layer`,
        type: "line",
        source: id,
        layout: {"line-cap": "round", "line-join": "round"},
        paint: {"line-color": color, "line-width": width, "line-opacity": opacity},
      })
    }
  }
  addLine("nav-route-past", "#999999", 6, 0.7)
  addLine("nav-route-ahead", "#000000", 6, 0.85)
  addLine("nav-offroute", "#1E88FF", 3, 0.95)
  // Route-end marker — a larger black filled circle at the LAST point of the
  // route polyline (the geometric end of the line), marking where the route
  // terminates. Distinct from the teardrop destination pin (which sits at the
  // chosen destination, possibly set back from the path). Added after the route
  // lines so it draws on top of the line's end cap.
  if (!map.getSource("nav-route-end")) map.addSource("nav-route-end", {type: "geojson", data: emptyFC()})
  if (!map.getLayer("nav-route-end-layer")) {
    map.addLayer({
      id: "nav-route-end-layer",
      type: "circle",
      source: "nav-route-end",
      paint: {
        "circle-radius": 7,
        "circle-color": "#000000",
        "circle-stroke-color": "#FFFFFF",
        "circle-stroke-width": 2,
      },
    })
  }
  // Pivot dots — a circle layer.
  if (!map.getSource("nav-pivots")) map.addSource("nav-pivots", {type: "geojson", data: emptyFC()})
  if (!map.getLayer("nav-pivots-layer")) {
    map.addLayer({
      id: "nav-pivots-layer",
      type: "circle",
      source: "nav-pivots",
      paint: {
        "circle-radius": 4,
        "circle-color": "#FF3030",
        "circle-stroke-color": "#FFFFFF",
        "circle-stroke-width": 1.5,
      },
    })
  }
}

/**
 * Build the SVG markup for a saved-place pin. The outer teardrop matches the
 * destination pin's silhouette (so all map pins read as the same family) and
 * the inner glyph branches on `type`.
 */
function renderSavedPlaceIconSvg(type?: "home" | "work"): string {
  const teardrop = `<path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 24 16 24s16-12 16-24C32 7.16 24.84 0 16 0z" fill="#1A8754"/>`
  let glyph: string
  if (type === "home") {
    glyph = `<path d="M8 17 L16 9 L24 17 L24 23 H19 V18 H13 V23 H8 Z" fill="#FFFFFF"/>`
  } else if (type === "work") {
    glyph = `<rect x="9" y="14" width="14" height="9" rx="1" fill="#FFFFFF"/><path d="M13 14 V11 H19 V14" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>`
  } else {
    glyph = `<path d="M16 7 L18.06 11.18 L22.6 11.84 L19.3 15.04 L20.12 19.55 L16 17.4 L11.88 19.55 L12.7 15.04 L9.4 11.84 L13.94 11.18 Z" fill="#FFFFFF"/>`
  }
  return `<svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">${teardrop}${glyph}</svg>`
}
