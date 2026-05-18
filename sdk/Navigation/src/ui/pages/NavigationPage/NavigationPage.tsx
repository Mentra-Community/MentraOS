import {useEffect, useState} from "react"
import type {NavManeuver, TravelMode} from "@mentra/miniapp"
import {useRpc} from "@mentra/miniapp/ui"

import "@/shared/channels"
import type {Channels} from "@/shared/channels"
import type {LatLng, LogEntry, NavStatus, PlaceDetails, SavedPlace} from "@/shared/types"
import {useRouter} from "@/ui/router"
import {useNavStore} from "@/ui/store/navStore"
import {DrawerOffsetProvider} from "@/ui/components/Drawer/DrawerOffsetContext"
import {FloatingDevPanel} from "@/ui/components/FloatingDevPanel/FloatingDevPanel"
import {isDev} from "@/ui/lib/env"
import {SimulationControls} from "@/ui/pages/NavigationPage/components/Controls/Controls"
import {ArrivalDrawer} from "@/ui/pages/NavigationPage/components/ArrivalDrawer/ArrivalDrawer"
import {DestinationPreviewDrawer} from "@/ui/pages/NavigationPage/components/DestinationPreviewDrawer/DestinationPreviewDrawer"
import {IdleDrawer} from "@/ui/pages/NavigationPage/components/IdleDrawer/IdleDrawer"
import {NavigationRunningDrawer} from "@/ui/pages/NavigationPage/components/NavigationRunningDrawer/NavigationRunningDrawer"
import {DeviateButton} from "@/ui/pages/NavigationPage/components/DeviateButton/DeviateButton"
import {LiveLog} from "@/ui/pages/NavigationPage/components/LiveLog/LiveLog"
import {LocationSearch} from "@/ui/pages/NavigationPage/components/LocationSearch/LocationSearch"
import {OrientationCard} from "@/ui/pages/NavigationPage/components/OrientationCard/OrientationCard"
import {MyLocationCard} from "@/ui/pages/NavigationPage/components/MyLocationCard/MyLocationCard"
import {NavMap} from "@/ui/pages/NavigationPage/components/NavMap/NavMap"
import {safeHeadingManuverCard} from "@/ui/components/SafeHeading/SafeHeading"

const DEV_DESTINATION: PlaceDetails = {
  placeId: "dev",
  name: "Ferry Building",
  address: "1 Ferry Building, San Francisco, CA",
  lat: 37.7955,
  lng: -122.3937,
}

let logIdSeq = 0

type Props = {
  savedPlacesVersion?: number
}

export function NavigationPage({savedPlacesVersion = 0}: Props) {
  // ---- store reads ---------------------------------------------------------
  //
  // Trip/sensor state is owned by the background NavigationController and
  // pushed to the UI via the typed channel registry. The local
  // `useNavStore` mirror exposes those values as React state.
  const coords = useNavStore((s) => s.coords)
  const heading = useNavStore((s) => s.heading)
  const trip = useNavStore((s) => s.trip)
  const running = trip.running
  const status = trip.status
  const maneuver = trip.maneuver
  const routePoints = trip.routePoints
  const activeDestination = trip.activeDestination
  const activeDestinationName = trip.activeDestinationName
  const offRouteAt = trip.offRouteAt

  const computeRoute = useRpc<Channels, "nav:compute-route">("nav:compute-route")

  // ---- page-local UI state -------------------------------------------------
  const {push} = useRouter()
  const [destination, setDestination] = useState<PlaceDetails | null>(null)
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])

  // Hydrate saved places so the map can drop home / work / starred
  // markers behind whatever destination is selected. Refetched on
  // savedPlacesVersion change (AddPlacePage onSave bumps it after a
  // successful `storage:add-saved`).
  useEffect(() => {
    let cancelled = false
    mentra
      .request("storage:list-saved", undefined as never)
      .then((places) => {
        if (cancelled) return
        setSavedPlaces(places)
      })
      .catch(() => {
        if (cancelled) return
        setSavedPlaces([])
      })
    return () => {
      cancelled = true
    }
  }, [savedPlacesVersion])

  const [simulatorMode, setSimulatorMode] = useState(false)
  const [searchFrozen, setSearchFrozen] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [devDrawer, setDevDrawer] = useState<"auto" | "idle" | "preview" | "running" | "arrived">(
    "auto",
  )
  const [simulate, setSimulate] = useState(false)
  const [speedMultiplier, setSpeedMultiplier] = useState(5)
  const [wrongSidewalk, setWrongSidewalk] = useState(false)
  const [skipCrossings, setSkipCrossings] = useState(false)
  const [travelMode, setTravelMode] = useState<TravelMode>("walking")

  const [previewRoutePoints, setPreviewRoutePoints] = useState<LatLng[] | null>(null)
  // Route-aware totals from computeRoute (mode-correct, follows the actual
  // walking path rather than crow-flies). Cleared when destination changes
  // or trip ends. Drawers prefer these over recomputing.
  const [previewRouteSummary, setPreviewRouteSummary] = useState<
    {distanceMeters: number; durationSeconds: number} | null
  >(null)
  // Devloop local log — distinct from the background broadcast log
  // accessible via the store. Lives here so the FloatingDevPanel can
  // mutate it directly without round-tripping a channel.
  const [log, setLog] = useState<LogEntry[]>([])

  function append(line: string) {
    setLog((prev) => [{id: ++logIdSeq, ts: Date.now(), line}, ...prev].slice(0, 100))
  }

  // Fetch a preview route whenever destination changes and we're not navigating
  useEffect(() => {
    if (running || !destination || !coords) {
      setPreviewRoutePoints(null)
      setPreviewRouteSummary(null)
      return
    }
    computeRoute.abort()
    const origin = {lat: coords.lat, lng: coords.lng}
    computeRoute({
      origin,
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
    })
      .then((result) => {
        const route = result.routes?.[0]
        const pts = route?.points ?? null
        setPreviewRoutePoints(pts)
        if (
          typeof route?.totalDistanceMeters === "number" &&
          typeof route?.totalDurationSeconds === "number"
        ) {
          setPreviewRouteSummary({
            distanceMeters: route.totalDistanceMeters,
            durationSeconds: route.totalDurationSeconds,
          })
        } else {
          setPreviewRouteSummary(null)
        }
      })
      .catch(() => {
        // Aborted or failed — preview just stays blank.
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, destination?.lat, destination?.lng, coords?.lat, coords?.lng])

  // ---- trip lifecycle ------------------------------------------------------
  //
  // Background owns the live trip state. The UI fires-and-forgets the
  // user's intent via broadcasts; status/maneuver/routePoints come back
  // via `nav:trip-state` / `nav:route` subscriptions installed in the
  // store. There is no local trip-state hydration to do here.
  function handleStart() {
    if (!destination) {
      append("ERROR: pick a destination first")
      return
    }
    setLog([])
    append(
      `start → ${destination.name || `${destination.lat}, ${destination.lng}`}${
        simulate ? ` (sim ${speedMultiplier}x)` : ""
      }`,
    )
    mentra.send("nav:start", {
      stops: [{lat: destination.lat, lng: destination.lng}],
      mode: "walking",
      simulate,
      speedMultiplier,
      missedTurnRerouteMeters: 3,
      destinationName: destination.name || destination.address || undefined,
    })
  }

  function handleStop() {
    append("stop sent")
    mentra.send("nav:stop", {})
    setPreviewRoutePoints(null)
    setPreviewRouteSummary(null)
    // Also clear the picked destination so the page returns to the
    // idle (no-destination) state — otherwise tapping Done after
    // arrival drops back into the destination preview drawer.
    setDestination(null)
  }

  function handleDeviate() {
    append("deviate → +50m off-route")
    mentra.send("nav:deviate", {})
  }

  // Long-press on the map drops a destination pin at the pressed coord.
  // Mirrors Google Maps "drop pin" UX: the pin enters the same flow as
  // a search-result destination — preview drawer opens, route preview
  // computes from the user's current position, "Start Navigation"
  // button arms the trip. Reverse-geocoding upgrades the pin's name to
  // a real street address in the background; no-op if it fails.
  // Disabled during active trips: re-routing mid-trip via long-press
  // would be too easy to do by accident.
  function handleMapLongPress(coord: LatLng) {
    if (running) return
    const coordStr = `${coord.lat.toFixed(6)}, ${coord.lng.toFixed(6)}`
    const pinId = `dropped-pin-${Date.now()}`
    const pin: PlaceDetails = {
      placeId: pinId,
      lat: coord.lat,
      lng: coord.lng,
      name: coordStr,
      address: "Dropped pin",
      // Flag the pin as awaiting geocoding so the preview drawer
      // renders a skeleton instead of the placeholder strings — avoids
      // the 1-2s flash of bare lat/lng coords before the real address
      // lands.
      isGeocoding: true,
    }
    append(`dropped pin @ ${coordStr}`)
    setDestination(pin)
    // Reverse-geocode in the background. Upgrade the pin's name to the
    // formatted address when it lands; demote the coords to the
    // subtitle (address) so the preview card reads like
    //   100 Van Ness Ave
    //   37.795600, -122.393300
    // If geocoding fails or returns nothing, fall back to coord-as-name.
    // Either way we clear `isGeocoding` so the skeleton stops showing.
    const finalize = (next: Partial<PlaceDetails>) => {
      // Only apply the upgrade if the same pin is still selected —
      // user may have dropped another one in the meantime.
      setDestination((prev) =>
        prev && prev.placeId === pinId ? {...prev, ...next, isGeocoding: false} : prev,
      )
    }
    const g = (window as unknown as {google?: {maps?: {Geocoder?: new () => GeocoderLike}}}).google
    if (g?.maps?.Geocoder) {
      try {
        const geocoder = new g.maps.Geocoder()
        geocoder.geocode(
          {location: {lat: coord.lat, lng: coord.lng}},
          (results: GeocoderResultLike[] | null, statusStr: string) => {
            const formatted = statusStr === "OK" && results?.[0]?.formatted_address
            if (formatted) {
              finalize({name: formatted, address: coordStr})
            } else {
              finalize({})
            }
          },
        )
      } catch (err) {
        console.warn("[NAV-MINI] reverse-geocode failed:", err)
        finalize({})
      }
    } else {
      finalize({})
    }
  }

  const me = coords ? {lat: coords.lat, lng: coords.lng} : null

  return (
    <DrawerOffsetProvider>
      <div className="fixed inset-0 overflow-hidden ">
        <NavMap
          me={me}
          destination={activeDestination ?? (destination ? {lat: destination.lat, lng: destination.lng} : null)}
          routePoints={running ? routePoints : previewRoutePoints}
          // Idle map shows saved-place pins so the user can see their
          // home / work / starred locations at a glance. Hide them
          // while running so they don't compete with the active route.
          savedPlaces={running ? [] : savedPlaces}
          autoFollow={running}
          onLongPress={handleMapLongPress}
        />

        {/* Top floating stack — search bar, then orientation card while running. */}
        <div className="absolute top-0 left-0 right-0  pt-3 flex flex-col gap-2 pointer-events-none bg-r">
          {!running && devDrawer !== "running" && devDrawer !== "arrived" && (
            <div className="pointer-events-auto">
              <LocationSearch
                selected={destination}
                onSelect={(place) => setDestination(place)}
                onClear={() => setDestination(null)}
                disabled={running}
                devFrozen={searchFrozen}
                onSearchingChange={setIsSearching}
                refreshKey={savedPlacesVersion}
              />
            </div>
          )}
          {(running || devDrawer === "running") && (
            <div className={`"pointer-events-auto ${safeHeadingManuverCard}`}>
              <OrientationCard
                me={me}
                heading={heading}
                maneuver={maneuver}
                routePoints={routePoints}
                status={status}
              />
            </div>
          )}
          {offRouteAt != null && status !== "rerouting" ? (
            <div className="pointer-events-none mx-3 px-3 py-2 rounded-lg bg-amber-500/95 text-white text-sm font-semibold shadow">
              Off route — recalculating…
            </div>
          ) : null}
        </div>

        {!isSearching &&
          status !== "arrived" &&
          devDrawer !== "arrived" &&
          (() => {
            const mode =
              devDrawer !== "auto"
                ? devDrawer
                : !running && !destination
                  ? "idle"
                  : !running && destination
                    ? "preview"
                    : "running"
            const devDestination = destination ?? (devDrawer !== "auto" ? DEV_DESTINATION : null)
            if (mode === "idle")
              return (
                <IdleDrawer
                  me={me}
                  onSelect={(place) => setDestination(place)}
                  onAddPlace={(type) => push({name: "add-place", presetType: type})}
                  refreshKey={savedPlacesVersion}
                />
              )
            if (mode === "preview")
              return (
                <DestinationPreviewDrawer
                  destination={devDestination}
                  me={me}
                  simulate={simulate}
                  speedMultiplier={speedMultiplier}
                  routeDistanceMeters={previewRouteSummary?.distanceMeters ?? null}
                  routeDurationSeconds={previewRouteSummary?.durationSeconds ?? null}
                  onStart={handleStart}
                  onClose={() => setDestination(null)}
                />
              )
            return (
              <NavigationRunningDrawer
                destination={devDestination}
                me={me}
                routeDistanceMeters={maneuver?.distanceToDestinationMeters ?? null}
                routeDurationSeconds={maneuver?.timeToDestinationSeconds ?? null}
                onStop={handleStop}
                onClose={() => setDestination(null)}
              />
            )
          })()}

        <ArrivalDrawer
          open={!isSearching && (status === "arrived" || devDrawer === "arrived")}
          destinationName={activeDestinationName}
          destinationAddress={destination?.address ?? null}
          onDone={handleStop}
        />

        {isDev ? (
          <FloatingDevPanel title="Navigation Dev" storageKey="NavigationPage:dev">
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">Simulator Mode</span>
              <button
                type="button"
                onClick={() => {
                  setSimulatorMode((v) => {
                    if (v) {
                      setDevDrawer("auto")
                      setSearchFrozen(false)
                      setSimulate(false)
                    } else {
                      setSimulate(true)
                    }
                    return !v
                  })
                }}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  simulatorMode ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"
                }`}>
                {simulatorMode ? "On" : "Off"}
              </button>
            </div>
            {simulatorMode && (
              <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
                <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">
                  Drawer
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {(["auto", "idle", "preview", "running", "arrived"] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setDevDrawer(mode)}
                      className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold capitalize ${
                        devDrawer === mode
                          ? "bg-blue-600 text-white"
                          : "bg-neutral-200 text-neutral-700"
                      }`}>
                      {mode}
                    </button>
                  ))}
                </div>
              </div>
            )}
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
            {simulatorMode && (
              <>
                <SimulationControls
                  simulate={simulate}
                  setSimulate={setSimulate}
                  speedMultiplier={speedMultiplier}
                  setSpeedMultiplier={setSpeedMultiplier}
                  running={running}
                />
                {running && simulate ? <DeviateButton onDeviate={handleDeviate} /> : null}
                {simulate ? (
                  <button
                    onClick={() => {
                      const next = !wrongSidewalk
                      setWrongSidewalk(next)
                      mentra.send("nav:set-dev-settings", {wrongSidewalk: next})
                      append(`wrong-sidewalk offset → ${next ? "on" : "off"}`)
                    }}
                    className={`w-full mt-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed ${
                      wrongSidewalk
                        ? "border-amber-500 bg-amber-100 text-amber-900"
                        : "border-amber-300 bg-amber-50 text-amber-800"
                    }`}>
                    🚶‍♂️ Wrong sidewalk: {wrongSidewalk ? "ON" : "OFF"}
                  </button>
                ) : null}
                {simulate ? (
                  <button
                    onClick={() => {
                      const next = !skipCrossings
                      setSkipCrossings(next)
                      mentra.send("nav:set-dev-settings", {skipCrossings: next})
                      append(`skip-crossings → ${next ? "on" : "off"}`)
                    }}
                    className={`w-full mt-2 px-3 py-2.5 rounded-xl text-sm font-semibold border border-dashed ${
                      skipCrossings
                        ? "border-rose-500 bg-rose-100 text-rose-900"
                        : "border-rose-300 bg-rose-50 text-rose-800"
                    }`}>
                    🚷 Skip crossings: {skipCrossings ? "ON" : "OFF"}
                  </button>
                ) : null}
              </>
            )}
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3">
              <div className="text-[11px] font-bold tracking-wider text-neutral-500 uppercase mb-2">
                🚶 Travel mode
              </div>
              <div className="grid grid-cols-2 gap-2">
                {(["walking", "driving", "cycling", "two_wheeler"] as const).map((m) => (
                  <button
                    key={m}
                    disabled={running}
                    onClick={() => setTravelMode(m)}
                    className={`px-3 py-2 rounded-lg text-sm font-medium border ${
                      travelMode === m
                        ? "border-blue-500 bg-blue-50 text-blue-900"
                        : "border-neutral-200 bg-white text-neutral-700"
                    } disabled:opacity-50`}>
                    {m.replace("_", " ")}
                  </button>
                ))}
              </div>
            </div>
            <div className="bg-white border border-neutral-200 rounded-xl p-3 mb-3 flex items-center justify-between">
              <span className="text-[13px] font-medium text-neutral-700">
                Freeze location search panel
              </span>
              <button
                type="button"
                onClick={() => setSearchFrozen((f) => !f)}
                className={`text-[11px] px-2.5 py-1 rounded-lg font-semibold ${
                  searchFrozen ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-700"
                }`}>
                {searchFrozen ? "Frozen" : "Freeze"}
              </button>
            </div>
            <LiveLog log={log} running={running} status={status} maneuver={maneuver} />
          </FloatingDevPanel>
        ) : null}
      </div>
    </DrawerOffsetProvider>
  )
}

/* -------------------------------------------------------------------------- */
/* Minimal structural shims for the global google.maps.Geocoder API used by
 * the drop-pin reverse-geocode path. The real types live in
 * @types/google.maps; mirroring just the shape we touch here keeps this
 * file standalone without pulling that dependency into the WebView bundle. */

type GeocoderResultLike = {formatted_address?: string}
type GeocoderRequestLike = {location: {lat: number; lng: number}}
type GeocoderLike = {
  geocode(
    request: GeocoderRequestLike,
    callback: (results: GeocoderResultLike[] | null, status: string) => void,
  ): void
}
