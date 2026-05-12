import {Drawer} from "@/frontend/components/Drawer/Drawer"
import {formatDistance} from "@/backend/lib/formatDistance/formatDistance"
import {haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  simulate: boolean
  speedMultiplier: number
  /** Route distance from the Routes API — follows the actual walking path. */
  routeDistanceMeters?: number | null
  /** Route duration from the Routes API — mode-aware (walking/driving/etc). */
  routeDurationSeconds?: number | null
  onStart: () => void
  onClose: () => void
}

// Fallback only — used when the Routes API hasn't returned yet so the
// drawer can still show *something* instead of em-dashes. Once the route
// summary arrives we prefer those mode-correct values.
const FALLBACK_WALKING_M_PER_S = 1.4

export function DestinationPreviewDrawer({
  destination,
  me,
  simulate,
  speedMultiplier,
  routeDistanceMeters,
  routeDurationSeconds,
  onStart,
  onClose,
}: Props) {
  // Prefer real route totals from computeRoute; fall back to straight-line
  // haversine + walking-speed only while waiting for the API response.
  const haversineDistance = destination && me ? haversineMeters(me, destination) : null
  const distanceMeters =
    routeDistanceMeters != null && routeDistanceMeters > 0 ? routeDistanceMeters : haversineDistance
  const durationSeconds =
    routeDurationSeconds != null && routeDurationSeconds > 0
      ? routeDurationSeconds
      : haversineDistance != null
        ? haversineDistance / FALLBACK_WALKING_M_PER_S
        : null
  const distanceLabel = distanceMeters != null ? formatDistance(distanceMeters) : null
  const etaLabel = durationSeconds != null ? formatEta(durationSeconds) : null
  const arrivalLabel = durationSeconds != null ? formatArrival(durationSeconds) : null

  return (
    <Drawer
      open={!!destination}
      onClose={onClose}
      dismissOnSwipeDown
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] pb-8 gap-4 bg-[#FFFFFFB3] border-t border-t-solid border-t-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-8px_28px] antialiased px-5">
      {destination ? (
        <>
          {/* Name + address */}
          <div className="flex flex-col pt-1 gap-1 mb-4">
            <div className="tracking-[-0.02em] text-[#000000E6] font-sans font-semibold text-[22px]/7 truncate">
              {destination.name || "Unnamed place"}
            </div>
            <div className="text-[#00000099] font-sans text-sm/4.5 truncate">
              {destination.address}
            </div>
          </div>

          {/* ETA + distance + arrival */}
          <div className="flex items-baseline gap-3 mb-4">
            <div className="[letter-spacing:-0.025em] text-[#000000E6] font-sans font-semibold text-[32px]/9">
              {etaLabel ?? "—"}
            </div>
            <div className="text-[#00000099] font-sans text-sm/4.5">
              {distanceLabel && arrivalLabel ? `${distanceLabel} · arrive ${arrivalLabel}` : "—"}
              {simulate ? ` · sim ${speedMultiplier}×` : null}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onStart}
              className="h-13 flex items-center justify-center rounded-2xl px-4 bg-[#1A1A1A] [box-shadow:#00000033_0px_6px_18px] shrink-0">
              <div className="text-white font-sans font-semibold text-base/5">
                Start Navigation
              </div>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="[font-synthesis:none] h-13 flex items-center justify-center rounded-2xl shrink-0 [box-shadow:#FFFFFF99_0px_1px_0px_inset] bg-[#0000000F] border border-solid border-[#00000014] antialiased">
              <div className="[white-space-collapse:preserve] font-sans font-semibold text-[#1A1A1C] text-base/5">
                Cancel
              </div>
            </button>
          </div>
        </>
      ) : null}
    </Drawer>
  )
}

function formatEta(seconds: number): string {
  const minutes = seconds / 60
  if (minutes < 1) return "<1 min"
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes - hours * 60)
  return `${hours}h ${rem}m`
}

function formatArrival(seconds: number): string {
  const arrival = new Date(Date.now() + seconds * 1000)
  return arrival.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}
