import {Drawer} from "@/frontend/components/Drawer/Drawer"
import {haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  simulate: boolean
  speedMultiplier: number
  onStart: () => void
  onClose: () => void
}

const WALKING_M_PER_S = 1.4

export function DestinationPreviewDrawer({destination, me, simulate, speedMultiplier, onStart, onClose}: Props) {
  const distanceMeters = destination && me ? haversineMeters(me, destination) : null
  const distanceLabel = distanceMeters != null ? formatMiles(distanceMeters) : null
  const etaMinutes = distanceMeters != null ? Math.round(distanceMeters / WALKING_M_PER_S / 60) : null
  const etaLabel = etaMinutes != null ? formatEta(distanceMeters!) : null
  const arrivalLabel = etaMinutes != null ? formatArrival(etaMinutes) : null

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
          <div className="flex flex-col gap-1">
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
              className="h-11 flex items-center justify-center shrink-0">
              <div className="[white-space-collapse:preserve] text-[#000000A6] font-sans text-base/5">
                Cancel
              </div>
            </button>
          </div>
        </>
      ) : null}
    </Drawer>
  )
}

function formatMiles(meters: number): string {
  const miles = meters / 1609.344
  if (miles < 0.1) return `${Math.round(meters * 3.28084)} ft`
  if (miles < 10) return `${miles.toFixed(1)} mi`
  return `${Math.round(miles)} mi`
}

function formatEta(meters: number): string {
  const minutes = meters / WALKING_M_PER_S / 60
  if (minutes < 1) return "<1 min"
  if (minutes < 60) return `${Math.round(minutes)} min`
  const hours = Math.floor(minutes / 60)
  const rem = Math.round(minutes - hours * 60)
  return `${hours}h ${rem}m`
}

function formatArrival(etaMinutes: number): string {
  const arrival = new Date(Date.now() + etaMinutes * 60 * 1000)
  return arrival.toLocaleTimeString([], {hour: "numeric", minute: "2-digit"})
}
