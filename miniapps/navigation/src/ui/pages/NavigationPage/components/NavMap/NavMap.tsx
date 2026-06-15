import {useEffect, useRef, useState} from "react"
import {motion, useMotionValue, useTransform} from "motion/react"

import {useNavStore} from "@/ui/store/navStore"
import {bearingDeg, haversineMeters, rdpSmooth} from "@/ui/lib/geometry"
import {formatDistance} from "@/ui/lib/formatDistance"
import {RecenterIcon, SettingsIcon} from "@/ui/components/icons"

// Experiment toggle: render the route line with RDP smoothing applied or
// straight from the raw points Google returned. Flip to false to see the
// unsmoothed path — useful for verifying turn-dot positions against the
// actual polyline vertices rather than the visually-smoothed line.
const SMOOTH_ROUTE_LINE = false
import type {LatLng} from "@/shared/types"
import {isDev} from "@/ui/lib/env"
import {useDevOverride} from "@/ui/lib/devOverride"
import {getGoogleMaps} from "@/ui/lib/googleMaps"
import {useDrawerOffset} from "@/ui/components/Drawer/DrawerOffsetContext"

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
  /** Full walking-route polyline emitted by Nav SDK. If null, falls back
   *  to a straight me→destination line so the map has *something*. */
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
   * Fires when the user holds a single finger on the map for ~2s
   * without panning. Receives the lat/lng under the pressed point.
   * Used to drop a destination pin (Google-Maps-style "long press to
   * search this location"). Parent decides what to do with it.
   */
  onLongPress?: (coord: LatLng) => void
  /**
   * Fires when the user taps a built-in Google Maps POI icon (a
   * Safeway, restaurant, etc). Receives the Google placeId. Parent
   * resolves it to a PlaceDetails (via the `places:details` RPC) and
   * decides what to do — typically set it as the selected destination
   * so the preview drawer opens. Omitted → POI taps fall through to
   * Google's default place card.
   */
  onPlaceTap?: (placeId: string) => void
  /** Fires when the user taps the settings gear in the right-rail.
   *  Parent navigates to the settings page. */
  onOpenSettings?: () => void
}) {
  // Map readiness is local — driven directly by the Google Maps script
  // load. Decoupled from `useNavStore` so a stalled background handshake
  // (no CONNECT_ACK, no snapshot push) can't keep the map grey.
  const [ready, setReady] = useState(false)

  // Dev-only debug chrome (pivot dots + labels rendered as map overlays)
  // shows when the build is dev OR when the user has unlocked the
  // override via the 5-second hold on the search bar. See lib/devOverride.
  const devOverride = useDevOverride()
  const devEnabled = isDev || devOverride

  // Anchor the floating right-rail (zoom / recenter buttons) just
  // above whichever drawer is currently mounted. `useDrawerOffset()`
  // publishes the drawer's visible height as a MotionValue, so we
  // can bind the rail's `bottom` directly without re-rendering each
  // drag frame. The 12px adds a small breathing gap between the rail
  // and the drawer's top edge.
  const drawerOffset = useDrawerOffset()
  const fallbackZero = useMotionValue(0)
  const railBottom = useTransform(drawerOffset ?? fallbackZero, (h: number) => h + 12)
  useEffect(() => {
    let alive = true
    getGoogleMaps()
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
  // mapsError is no longer tracked separately — ready=false covers
  // both "still-loading" and "failed"; the loading overlay handles both.
  const error: string | null = null

  // Right-rail buttons are pinned vertically near the middle of the
  // map. The drawer slides over them when it expands — z-index puts
  // the rail BELOW the drawer (drawer is z-40) so they hide behind
  // the panel rather than chasing its top edge. Previously the rail
  // tracked `drawerOffset` and rode up with the drawer, which made
  // the buttons feel attached to the panel rather than to the map.

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
  const meDotRef = useRef<any | null>(null) // OverlayView instance
  const meArrowElRef = useRef<HTMLElement | null>(null) // inner arrow div for CSS rotation
  const meArrowAngleRef = useRef<number>(0) // unwrapped angle to avoid 360° spins
  const meConeRef = useRef<any | null>(null)
  const destMarkerRef = useRef<any | null>(null)
  const routeRef = useRef<any | null>(null)
  const pastRouteRef = useRef<any | null>(null)
  // Dev: blue connector line from `me` to the closest point on the
  // route, with a midpoint label showing the distance. Active whenever
  // a route polyline is present (preview + live).
  const offRouteLineRef = useRef<any | null>(null)
  const offRouteLabelRef = useRef<any | null>(null)
  /** Debug: red dots at each detected pivot (turn point). */
  const pivotDotsRef = useRef<any[]>([])
  /** Debug: hovering road-name labels paired with the pivot dots. */
  const pivotLabelsRef = useRef<any[]>([])
  // Saved-place markers (home / work / starred) shown while idle.
  // Map keyed by placeId so we only churn markers whose payload changed.
  const savedMarkersRef = useRef<Map<string, any>>(new Map())
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
      // POI icons are tappable so the parent can hook them up as
      // "pick this Safeway as my destination" (Google-Maps style).
      // Set false to opt out and suppress the icon hit-area entirely.
      clickableIcons: true,
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

    // Skip GPS-driven panTo while the user is touching the map — otherwise
    // every coords update fights the in-flight gesture. `isTouching` ref
    // is read by the me-marker effect.
    const onTouchActive = () => {
      isTouchingRef.current = true
    }
    const onTouchInactive = (e: TouchEvent) => {
      if (e.touches.length === 0) isTouchingRef.current = false
    }
    container.addEventListener("touchstart", onTouchActive, {passive: true, capture: true})
    container.addEventListener("touchend", onTouchInactive, {passive: true, capture: true})
    container.addEventListener("touchcancel", onTouchInactive, {passive: true, capture: true})

    // POI taps: Google Maps fires `click` with an IconMouseEvent (carries
    // `placeId`) when the user taps a built-in icon (Safeway, a cafe,
    // etc). Suppress Google's default place card via e.stop() and let
    // the parent decide what to do — typically resolve the placeId via
    // `places:details` and open our own preview drawer.
    mapRef.current.addListener("click", (e: any) => {
      const placeId = e?.placeId
      if (!placeId) return
      if (typeof e.stop === "function") e.stop()
      const handler = onPlaceTapRef.current
      if (handler) handler(placeId)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  // Long-press to drop a destination pin. The Android WebView's own
  // long-press recognizer fires `contextmenu` after ~500-800ms and
  // then synthesizes a `pointerup` regardless of whether the finger
  // is still on screen — so a custom-duration timer past that point
  // can't work without disabling the system gesture at the native
  // layer. Instead we treat `contextmenu` itself as the canonical
  // "user long-pressed here" signal (mirrors what google.com/maps and
  // every other web-based map does). The duration matches the OS
  // long-press threshold, not an arbitrary in-app value.
  //
  // The latest handler is read via a ref so a parent re-render doesn't
  // tear down the listeners.
  const onLongPressRef = useRef(onLongPress)
  // Same ref pattern for POI taps — the parent typically gates this on
  // `running` and `isSearching`, both of which re-render often, and we
  // don't want to detach/reattach the Maps click listener every time.
  const onPlaceTapRef = useRef(onPlaceTap)
  useEffect(() => {
    onPlaceTapRef.current = onPlaceTap
  }, [onPlaceTap])
  useEffect(() => {
    onLongPressRef.current = onLongPress
  }, [onLongPress])
  useEffect(() => {
    if (!ready || !mapRef.current || !containerRef.current) return
    const g = window.google
    const container = containerRef.current
    // Cap on how far the user can drift between pointerdown and
    // contextmenu before we discount the gesture as a pan.
    const MAX_MOVE_PX = 12
    // The OS long-press recognizer typically fires `contextmenu`
    // around 500–800ms in. Above this gap we assume `contextmenu`
    // is unrelated to the press we tracked (e.g. a long-tap on a
    // map control). Keeps us from cross-firing.
    const MAX_CONTEXTMENU_DELAY_MS = 1500
    let downX = 0
    let downY = 0
    let downAt = 0
    let armed = false
    let cancelled = false
    // Lat/lng resolved from the touch point AT pointerdown time. We pin
    // to this rather than re-projecting `downX/downY` when the press
    // fires ~600ms later: the map can pan under a still finger (GPS
    // auto-follow recenters), and a re-projection would then convert the
    // same pixel against a moved map → a pin offset from where the user
    // actually pressed. Capturing the world coordinate up front freezes
    // the target to the spot under the finger at touch-down.
    let downCoord: LatLng | null = null
    // Project a client (viewport) pixel to a lat/lng using the overlay's
    // current map projection. Returns null when the projection isn't
    // ready yet.
    const projectClientPoint = (clientX: number, clientY: number): LatLng | null => {
      const rect = container.getBoundingClientRect()
      const point = new g.maps.Point(clientX - rect.left, clientY - rect.top)
      const proj =
        meDotRef.current && typeof meDotRef.current.getProjection === "function"
          ? meDotRef.current.getProjection()
          : null
      const ll = proj?.fromContainerPixelToLatLng?.(point)
      return ll ? {lat: ll.lat(), lng: ll.lng()} : null
    }
    // Long-press synthesis timer for iOS. WKWebView never dispatches
    // `contextmenu` for a finger long-press — the page sees pointerdown
    // → pointerup ~700ms later with no contextmenu in between. We fire
    // our own long-press signal after LONG_PRESS_MS without movement.
    // On Android the OS still fires contextmenu first; whichever path
    // reaches `fireLongPress(...)` first wins, the other is gated by
    // `armed = false`.
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
      // Prefer the coordinate captured at pointerdown so the pin lands
      // exactly under the finger even if the map panned during the press.
      // Fall back to a fresh projection only if the down-time capture
      // failed (projection wasn't ready yet at touch-down).
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
        // Second finger arrived (pinch). Disarm.
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
      // Freeze the target coordinate at touch-down so a map pan during
      // the press can't drag the pin off the spot under the finger.
      downCoord = projectClientPoint(e.clientX, e.clientY)
      // Start the iOS fallback timer.
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
        // User panned — kill the fallback timer so it doesn't fire
        // after they release.
        clearLongPressTimer()
      }
    }
    // pointerup before the timer fires = short tap; cancel the long
    // press so it doesn't trigger ~hundreds of ms later.
    const onUp = () => {
      clearLongPressTimer()
    }
    const onCancel = () => {
      armed = false
      cancelled = true
      clearLongPressTimer()
    }
    // Android still fires `contextmenu` at ~500ms; iOS never does.
    // Whichever path reaches `fireLongPress` first wins, and the second
    // is gated by `armed = false`. Keeping both means we get the
    // OS-native long-press feel on Android and a 600ms timer fallback
    // on iOS without conditional platform code.
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

    if (meConeRef.current) {
      meConeRef.current.setMap(null)
      meConeRef.current = null
    }

    if (!meDotRef.current) {
      class MeOverlay extends g.maps.OverlayView {
        private pos: any
        private div: HTMLDivElement | null = null
        constructor(pos: any) {
          super()
          this.pos = pos
        }
        onAdd() {
          const div = document.createElement("div")
          div.style.cssText =
            "position:absolute;width:48px;height:48px;transform:translate(-50%,-50%);pointer-events:none"
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
        setPosition(pos: any) {
          this.pos = pos
          this.draw()
        }
        onRemove() {
          this.div?.parentNode?.removeChild(this.div)
          this.div = null
          meArrowElRef.current = null
        }
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
      let delta = effectiveHeading - (((prev % 360) + 360) % 360)
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

  // Saved-place markers (home / work / starred). Diffed against the
  // current placeId set so we don't churn every render. Markers are
  // hidden when a destination is selected because the destination pin
  // visually overlaps and would compete; this keeps the idle map clean.
  //
  // Saved-place pins are currently disabled on the map entirely: the
  // effect still runs so any markers left over from a previous state get
  // cleaned up, but `showSaved` is forced false so none are drawn. Flip
  // SHOW_SAVED_PINS back to true to restore the green home/work/star tags.
  const SHOW_SAVED_PINS = false
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google
    const map = mapRef.current
    const showSaved = SHOW_SAVED_PINS && !destination && savedPlaces.length > 0
    const current = savedMarkersRef.current
    const wantedIds = new Set(showSaved ? savedPlaces.map((p) => p.placeId) : [])
    // Remove any markers no longer in the wanted set.
    for (const [id, marker] of current) {
      if (!wantedIds.has(id)) {
        marker.setMap(null)
        current.delete(id)
      }
    }
    if (!showSaved) return
    for (const place of savedPlaces) {
      const pos = new g.maps.LatLng(place.lat, place.lng)
      const existing = current.get(place.placeId)
      if (existing) {
        existing.setPosition(pos)
        continue
      }
      const iconSvg = renderSavedPlaceIconSvg(place.type)
      const icon = {
        url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(iconSvg)}`,
        scaledSize: new g.maps.Size(32, 40),
        anchor: new g.maps.Point(16, 40),
      }
      const marker = new g.maps.Marker({
        map,
        position: pos,
        icon,
        // Below the destination marker (zIndex:997) so a saved-place
        // that happens to match the active destination still renders
        // the destination on top.
        zIndex: 500,
        title: place.savedName ?? (place.type === "home" ? "Home" : place.type === "work" ? "Work" : ""),
      })
      current.set(place.placeId, marker)
    }
  }, [ready, destination, savedPlaces])

  // Route polyline: grey for the traveled portion, black for the remaining.
  // Finds the closest route point to `me` to determine the split index.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google

    // Smooth out the squiggly raw polyline before rendering. The SDK returns
    // points every 1-3m which produces visible jitter on screen; RDP at 14m
    // absorbs curb-cut zigzags and sidewalk-side flips so the rendered line
    // visually reads as following road centerlines, while preserving real
    // intersection corners. Was 6m — at that epsilon the polyline still
    // hugged sidewalk geometry and looked like it was stepping off curbs at
    // every intersection.
    const rawPath: LatLng[] = routePoints && routePoints.length > 1 ? routePoints : []
    const path: LatLng[] = SMOOTH_ROUTE_LINE && rawPath.length > 1 ? rdpSmooth(rawPath, 14) : rawPath

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

  // Dev: blue connector line from `me` → closest point on the route,
  // with a midpoint label showing the distance. Tears itself down when
  // there's no route to project onto. Uses the raw (unsmoothed)
  // polyline so the distance reflects the real route geometry, not the
  // visually smoothed rendering.
  useEffect(() => {
    if (!ready || !mapRef.current) return
    const g = window.google

    function teardown() {
      offRouteLineRef.current?.setMap(null)
      offRouteLineRef.current = null
      offRouteLabelRef.current?.setMap(null)
      offRouteLabelRef.current = null
    }

    // Dev-only and off by default — tear down if disabled or there's no
    // route to project onto.
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
    const midpoint: LatLng = {
      lat: (me.lat + projected.lat) / 2,
      lng: (me.lng + projected.lng) / 2,
    }

    const path = [new g.maps.LatLng(me.lat, me.lng), new g.maps.LatLng(projected.lat, projected.lng)]
    if (!offRouteLineRef.current) {
      offRouteLineRef.current = new g.maps.Polyline({
        map: mapRef.current,
        path,
        strokeColor: "#1E88FF",
        strokeOpacity: 0.95,
        strokeWeight: 3,
        zIndex: 4,
      })
    } else {
      offRouteLineRef.current.setPath(path)
      offRouteLineRef.current.setMap(mapRef.current)
    }

    class OffRouteLabelOverlay extends g.maps.OverlayView {
      private pos: any
      private text: string
      private div: HTMLDivElement | null = null
      constructor(pos: any, text: string) {
        super()
        this.pos = pos
        this.text = text
      }
      onAdd() {
        const div = document.createElement("div")
        div.style.cssText =
          "position:absolute;transform:translate(-50%,-50%);pointer-events:none;" +
          "padding:2px 6px;border-radius:6px;background:#1E88FF;color:#FFFFFF;" +
          "font:600 11px/1.2 system-ui,sans-serif;white-space:nowrap;" +
          "box-shadow:0 2px 6px #00000040;border:1px solid #FFFFFF99;z-index:5"
        div.textContent = this.text
        this.div = div
        this.getPanes()!.overlayMouseTarget.appendChild(div)
      }
      draw() {
        if (!this.div) return
        const proj = this.getProjection()
        const pt = proj?.fromLatLngToDivPixel(this.pos)
        if (!pt) return
        this.div.style.left = `${pt.x}px`
        this.div.style.top = `${pt.y}px`
      }
      setLabel(pos: any, text: string) {
        this.pos = pos
        if (this.div) this.div.textContent = text
        this.text = text
        this.draw()
      }
      onRemove() {
        this.div?.parentNode?.removeChild(this.div)
        this.div = null
      }
    }
    const labelText = formatDistance(distMeters, unitSystem)
    const labelPos = new g.maps.LatLng(midpoint.lat, midpoint.lng)
    if (!offRouteLabelRef.current) {
      const overlay = new OffRouteLabelOverlay(labelPos, labelText)
      overlay.setMap(mapRef.current)
      offRouteLabelRef.current = overlay
    } else {
      offRouteLabelRef.current.setLabel(labelPos, labelText)
    }

    return teardown
  }, [ready, me?.lat, me?.lng, routePoints, devEnabled, showOffRouteLine, unitSystem])

  // Debug overlay: render a red dot at each turn point. Lets us visually
  // verify that turns land where they belong.
  //
  // Two sources, depending on trip phase:
  //   - Previewing (not yet started): `previewTurns` carries turns the
  //     parent derived from the computed route's step list. The SDK's
  //     getPivots() is empty here because no trip is active.
  //   - Running: we pull the live pivot list via the `nav:get-pivots`
  //     RPC (the `nav:pivots` broadcast only ships active + upcoming).
  //
  // Refetch whenever the route or preview turns change. `cancelled`
  // guards against an async RPC resolve landing after teardown.
  useEffect(() => {
    if (!devEnabled || !showPivots) return
    if (!ready || !mapRef.current) return

    function teardown() {
      for (const dot of pivotDotsRef.current) dot.setMap(null)
      pivotDotsRef.current = []
      for (const label of pivotLabelsRef.current) label.setMap(null)
      pivotLabelsRef.current = []
    }

    // Tear down previous markers up front so a stale route's dots clear
    // immediately, before any new dots are drawn.
    teardown()

    // A small square badge anchored above a turn dot. Shows the turn
    // direction ("Turn left"/"Turn right") on top, then the road
    // transition ("Market St → Franklin St") below — both in one box.
    // Defined here (like MeOverlay) because OverlayView only exists once
    // the Maps script has loaded — which `ready` guarantees.
    const g = window.google
    class PivotLabelOverlay extends g.maps.OverlayView {
      private pos: any
      private text: string
      private direction: string | null
      private div: HTMLDivElement | null = null
      constructor(pos: any, text: string, direction: string | null) {
        super()
        this.pos = pos
        this.text = text
        this.direction = direction
      }
      onAdd() {
        const div = document.createElement("div")
        div.style.cssText =
          "position:absolute;transform:translate(-50%,calc(-100% - 8px));pointer-events:none;" +
          "padding:3px 7px;border-radius:6px;background:#FF3030;color:#FFFFFF;" +
          "font:600 11px/1.3 system-ui,sans-serif;white-space:nowrap;text-align:center;" +
          "box-shadow:0 2px 6px #00000040;border:1px solid #FFFFFF99;z-index:6"
        if (this.direction) {
          const dir = document.createElement("div")
          // Slightly bolder/brighter top line for the direction prompt.
          dir.style.cssText = "font-weight:700;letter-spacing:0.01em"
          dir.textContent = this.direction
          div.appendChild(dir)
        }
        const road = document.createElement("div")
        // De-emphasize the road line a touch when a direction sits above it.
        if (this.direction) road.style.cssText = "opacity:0.92;font-weight:600"
        road.textContent = this.text
        div.appendChild(road)
        this.div = div
        this.getPanes()!.overlayMouseTarget.appendChild(div)
      }
      draw() {
        if (!this.div) return
        const proj = this.getProjection()
        const pt = proj?.fromLatLngToDivPixel(this.pos)
        if (!pt) return
        this.div.style.left = `${pt.x}px`
        this.div.style.top = `${pt.y}px`
      }
      onRemove() {
        this.div?.parentNode?.removeChild(this.div)
        this.div = null
      }
    }

    function drawDots(turns: Array<{lat: number; lng: number; label?: string | null; direction?: string | null}>) {
      if (!mapRef.current) return
      for (const p of turns) {
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

        // Hovering badge above the dot: direction on top, road below.
        if (p.label) {
          const label = new PivotLabelOverlay(new g.maps.LatLng(p.lat, p.lng), p.label, p.direction ?? null)
          label.setMap(mapRef.current)
          pivotLabelsRef.current.push(label)
        }
      }
    }

    // Preview path: parent supplied turns synchronously, draw immediately.
    if (previewTurns && previewTurns.length > 0) {
      drawDots(previewTurns)
      return teardown
    }

    // Running path: fetch the live pivot list over the channel boundary.
    // The SDK's Pivot carries fromRoad/toRoad/direction separately; format
    // them into the same `{label, direction}` shape the preview uses so
    // the same red box (direction on top, "From → To" below) renders for
    // an active trip too. Pivots whose direction isn't a real left/right
    // (e.g. CROSS_STREET) fall back to a plain "Cross" prompt.
    //
    // We fetch TWICE: once immediately to render the geometry-derived
    // pivots the SDK builds on the synchronous `onRoute` event, then
    // again ~700ms later to pick up the instruction-derived pivots the
    // SDK swaps in once its async Routes-API computeRoute resolves
    // (typical REST + bridge round trip is 200-500ms). The second fetch
    // produces "Market St → Dolores St"-quality labels; the first
    // produces something less precise but immediately visible.
    let cancelled = false
    const fetchAndDraw = () => {
      mentra
        .request("nav:get-pivots", undefined)
        .then((pivots) => {
          if (cancelled) return
          // Clear any prior pass so we don't double-draw when the second
          // fetch arrives with a different anchor set.
          for (const dot of pivotDotsRef.current) dot.setMap(null)
          pivotDotsRef.current = []
          for (const label of pivotLabelsRef.current) label.setMap(null)
          pivotLabelsRef.current = []

          // CROSS_STREET pivots get their own label ("Cross to X") and
          // no left/right direction line — the user just needs to know
          // a crossing is coming up, not which way to turn.
          // Turn pivots get "Turn left/right" on top and "From → To"
          // beneath.
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
  }, [ready, routePoints, previewTurns, devEnabled, showPivots])

  if (error) {
    return <div className="p-3 text-red-700 text-[13px]">Map failed to load: {error}</div>
  }

  return (
    <div className="relative w-full h-full overflow-hidden">
      <div ref={containerRef} className="w-full h-full select-none touch-manipulation [-webkit-touch-callout:none]" />

      {!ready ? (
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100 text-neutral-500 text-[13px]">
          loading map…
        </div>
      ) : !me && !destination ? (
        // Map is ready but we have no real position yet — it would be
        // centered on the SF fallback coords for ~1s until the first GPS
        // fix arrives. Cover with a spinner so the user doesn't see the
        // jarring "wrong city" snap. Disappears once `me` lands; the
        // existing panTo effect has already moved the map underneath.
        <div className="absolute inset-0 flex items-center justify-center bg-neutral-100">
          <div
            className="w-8 h-8 rounded-full border-[3px] border-neutral-300 border-t-neutral-700 animate-spin"
            role="status"
            aria-label="Finding your location"
          />
        </div>
      ) : null}

      {ready && !hideControls ? (
        <motion.div
          // Anchored to the drawer's top edge via `bottom={railBottom}`
          // (a MotionValue that tracks drawer height + 12px gap). z-50
          // keeps the rail above every drawer (drawers are z-40) so
          // the buttons stay tappable no matter which drawer is open.
          style={{bottom: railBottom}}
          className="absolute right-3 z-50 flex flex-col gap-2">
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

/**
 * Build the SVG markup for a saved-place pin. The outer teardrop matches
 * the destination pin's silhouette (so all map pins read as the same
 * family) and the inner glyph branches on `type` so home + work read
 * differently from an untagged star.
 */
function renderSavedPlaceIconSvg(type?: "home" | "work"): string {
  // Teardrop body — same shape as the destination pin in this file,
  // but rendered in the saved-place accent color so the user can tell
  // saved pins apart from the "you're going here" destination at a
  // glance.
  const teardrop = `<path d="M16 0C7.16 0 0 7.16 0 16c0 12 16 24 16 24s16-12 16-24C32 7.16 24.84 0 16 0z" fill="#1A8754"/>`
  let glyph: string
  if (type === "home") {
    // House silhouette, scaled into the upper bulge of the teardrop.
    glyph = `<path d="M8 17 L16 9 L24 17 L24 23 H19 V18 H13 V23 H8 Z" fill="#FFFFFF"/>`
  } else if (type === "work") {
    // Briefcase outline.
    glyph = `<rect x="9" y="14" width="14" height="9" rx="1" fill="#FFFFFF"/><path d="M13 14 V11 H19 V14" stroke="#FFFFFF" stroke-width="1.6" fill="none"/>`
  } else {
    // Untagged saved place → 5-point star (matches the LocationSearch chip).
    glyph = `<path d="M16 7 L18.06 11.18 L22.6 11.84 L19.3 15.04 L20.12 19.55 L16 17.4 L11.88 19.55 L12.7 15.04 L9.4 11.84 L13.94 11.18 Z" fill="#FFFFFF"/>`
  }
  return `<svg width="32" height="40" viewBox="0 0 32 40" fill="none" xmlns="http://www.w3.org/2000/svg">${teardrop}${glyph}</svg>`
}
