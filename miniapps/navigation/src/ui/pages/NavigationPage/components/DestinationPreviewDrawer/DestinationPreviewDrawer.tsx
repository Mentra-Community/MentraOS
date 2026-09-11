import {Drawer} from "@/ui/components/Drawer/Drawer"
import {useNavStore} from "@/ui/store/navStore"
import {formatDistance} from "@/ui/lib/formatDistance"
import {haversineMeters} from "@/ui/lib/geometry"
import {parseAddress} from "@/ui/lib/parseAddress"
import {useToast} from "@/ui/components/Toast/Toast"
import {StarIcon, StarIconOutline} from "@/ui/components/icons"
import type {LatLng, PlaceDetails} from "@/shared/types"

type Props = {
  destination: PlaceDetails | null
  me: LatLng | null
  simulate: boolean
  speedMultiplier: number
  /** Route distance from the Routes API — follows the actual walking path. */
  routeDistanceMeters?: number | null
  /** Route duration from the Routes API — mode-aware (walking/driving/etc). */
  routeDurationSeconds?: number | null
  /** Whether this destination is already in the user's saved places. */
  saved?: boolean
  /** Toggle the saved-state. `shouldSave` is true to star, false to unstar. */
  onToggleSaved?: (place: PlaceDetails, shouldSave: boolean) => void | Promise<void>
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
  saved = false,
  onToggleSaved,
  onStart,
  onClose,
}: Props) {
  const toast = useToast()
  const unitSystem = useNavStore((s) => s.unitSystem)

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
  const distanceLabel = distanceMeters != null ? formatDistance(distanceMeters, unitSystem) : null
  const etaLabel = durationSeconds != null ? formatEta(durationSeconds) : null
  const arrivalLabel = durationSeconds != null ? formatArrival(durationSeconds) : null

  return (
    <Drawer
      open={!!destination}
      onClose={onClose}
      dismissOnSwipeDown
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] pb-8 gap-4 bg-[#FFFFFFB3] dark:bg-[#161619CC] border-t border-t-solid border-t-[#FFFFFF99] dark:border-t-[#FFFFFF1A] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-8px_28px] antialiased px-5">
      {destination ? (
        <>
          {/* Name + address. Dropped pins start with `isGeocoding: true`
              and placeholder strings (raw lat/lng); show a skeleton
              while the reverse-geocoder is in flight to avoid flashing
              the coords on screen for the 1-2s the API takes. */}
          <div className="flex flex-col pt-1 gap-1 mb-4">
            {destination.isGeocoding ? (
              <>
                <div className="h-7 w-3/5 rounded-md bg-[#00000014] dark:bg-[#FFFFFF1F] animate-pulse" />
                <div className="h-4.5 w-2/5 rounded-md bg-[#00000014] dark:bg-[#FFFFFF1F] animate-pulse mt-1.5" />
              </>
            ) : (
              <>
                <div className="flex items-start gap-2">
                  <div className="grow min-w-0">
                    <div className="tracking-[-0.02em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-[22px]/7 truncate">
                      {destination.name || "Unnamed place"}
                    </div>
                    {(() => {
                      const {street, locality, country} = parseAddress(destination.address)
                      // Drop the street line when it just repeats the
                      // name (common for dropped pins, where the name is
                      // derived from the street segment). Remaining lines
                      // step down in size for a clear visual hierarchy.
                      const showStreet = street && street !== destination.name
                      return (
                        <div className="text-[#00000099] dark:text-zinc-400 font-sans mt-1">
                          {showStreet ? (
                            <div className="text-[15px]/5 truncate">{street}</div>
                          ) : null}
                          {locality || country ? (
                            <div className="text-[13px]/4.5 truncate">
                              {locality}
                              {locality && country ? ", " : ""}
                              {country ? <span className="text-[#0000007A] dark:text-zinc-500">{country}</span> : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })()}
                  </div>
                  <button
                    type="button"
                    aria-label={saved ? "Remove from saved places" : "Save place"}
                    aria-pressed={saved}
                    onClick={async () => {
                      const next = !saved
                      try {
                        await onToggleSaved?.(destination, next)
                        toast(next ? "Saved" : "Removed from saved")
                      } catch {
                        toast(next ? "Couldn’t save place" : "Couldn’t remove place")
                      }
                    }}
                    className="shrink-0 flex items-center justify-center size-12 rounded-full bg-[#0000000A] dark:bg-[#FFFFFF14] active:bg-[#0000001A] dark:active:bg-[#FFFFFF26] mt-1">
                    {saved ? (
                      <StarIcon size={22} color="#1A1A1A" />
                    ) : (
                      <StarIconOutline size={22} color="#1A1A1A" strokeWidth={2} />
                    )}
                  </button>
                </div>
              </>
            )}
          </div>

          {/* ETA + distance + arrival */}
          <div className="flex items-baseline gap-3 mb-4">
            <div className="[letter-spacing:-0.025em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-[32px]/9">
              {etaLabel ?? "—"}
            </div>
            <div className="text-[#00000099] dark:text-zinc-400 font-sans text-sm/4.5">
              {distanceLabel && arrivalLabel ? `${distanceLabel} · arrive ${arrivalLabel}` : "—"}
              {simulate ? ` · sim ${speedMultiplier}×` : null}
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={onStart}
              className="h-13 flex items-center justify-center rounded-2xl px-4 bg-[#1A1A1A] dark:bg-zinc-100 [box-shadow:#00000033_0px_6px_18px] shrink-0">
              <div className="text-white dark:text-zinc-900 font-sans font-semibold text-base/5">
                Start Navigation
              </div>
            </button>
            <button
              type="button"
              onClick={onClose}
              className="[font-synthesis:none] h-13 flex items-center justify-center rounded-2xl shrink-0 [box-shadow:#FFFFFF99_0px_1px_0px_inset] bg-[#0000000F] dark:bg-[#FFFFFF14] border border-solid border-[#00000014] dark:border-[#FFFFFF1F] antialiased">
              <div className="[white-space-collapse:preserve] font-sans font-semibold text-[#1A1A1C] dark:text-zinc-50 text-base/5">
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
