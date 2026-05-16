import {useEffect, useState} from "react"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails, SavedPlace} from "@/backend/lib/places/places"
import {useUser} from "@/backend/hooks/useUser"
import {Drawer} from "@/frontend/components/Drawer/Drawer"

type Props = {
  me: LatLng | null
  onSelect: (place: PlaceDetails) => void
  /** Type-aware add — passing `"home"` / `"work"` opens AddPlacePage with
   *  the name pre-filled and stamps the resulting save with that type. */
  onAddPlace: (type?: "home" | "work") => void
  refreshKey?: number
}

export function IdleDrawer({onSelect, onAddPlace, refreshKey}: Props) {
  const user = useUser()
  const [expanded, setExpanded] = useState(false)
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  const [recents, setRecents] = useState<PlaceDetails[]>([])

  useEffect(() => {
    user.storage.getAllSavedPlaces().then(setSavedPlaces)
    user.storage.getRecentSearches().then(setRecents)
  }, [user.storage, refreshKey])

  return (
    <Drawer
      open
      onClose={() => {}}
      dismissOnSwipeDown={false}
      peekHeight={163}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] bg-[#FFFFFFB3] border-t border-t-solid border-t-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-8px_28px] antialiased overflow-hidden">

      {/* Sticky top: Home + Work quick-access cards, then Add Place. */}
      <div className="flex gap-2.5 px-5 pb-3 shrink-0">
        {/* Home */}
        {(() => {
          const home = savedPlaces.find((p) => p.type === "home") ?? null
          return home ? (
            <button
              type="button"
              onClick={() => onSelect(home)}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
              <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
                <HomeIcon />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">
                  {home.savedName || "Home"}
                </div>
                <div className="text-[#0000008C] font-sans text-[11px]/3.5 truncate">{home.name || home.address}</div>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onAddPlace("home")}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
              <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
                <HomeIcon />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Home</div>
                <div className="text-[#0000008C] font-sans text-[11px]/3.5">Add address</div>
              </div>
            </button>
          )
        })()}

        {/* Work */}
        {(() => {
          const work = savedPlaces.find((p) => p.type === "work") ?? null
          return work ? (
            <button
              type="button"
              onClick={() => onSelect(work)}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
              <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] shrink-0 size-8">
                <WorkIcon />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">
                  {work.savedName || "Work"}
                </div>
                <div className="text-[#0000008C] font-sans text-[11px]/3.5 truncate">{work.name || work.address}</div>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onAddPlace("work")}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
              <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] shrink-0 size-8">
                <WorkIcon />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Work</div>
                <div className="text-[#0000008C] font-sans text-[11px]/3.5">Add address</div>
              </div>
            </button>
          )
        })()}

        {/* Add place — stationary, never scrolls */}
        <button
          type="button"
          onClick={() => onAddPlace()}
          className="[font-synthesis:none] w-21 flex flex-col items-start gap-2 rounded-[18px] shrink-0 [box-shadow:#00000014_0px_0px_0px_1px_inset] bg-[#0000000A] antialiased p-3.5">
          <div className="flex items-center justify-center rounded-full shrink-0 bg-[#0000001A] size-8">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <path d="M12 5V19M5 12H19" stroke="#000000" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </div>
          <div className="flex flex-col items-start tracking-[0.02em] [white-space-collapse:preserve] font-sans font-semibold text-[#1A1A1A] text-[11px]/3.5">
            <span>Add</span>
            <span>place</span>
          </div>
        </button>
      </div>

      {/* Scrollable area: saved places + recents. Home/Work are
          surfaced via the sticky-top quick-access cards above, so we
          filter them out of the flat list to avoid showing them twice. */}
      <div
        className="max-h-55 overflow-y-auto px-5 pb-8"
        onPointerDownCapture={(e) => e.stopPropagation()}>
        {(() => {
          const otherSaved = savedPlaces.filter((p) => p.type !== "home" && p.type !== "work")
          return otherSaved.length > 0 ? (
          <>
            <div className="flex items-center gap-2 mb-3">
              <div className="tracking-[0.16em] uppercase text-[#0000008C] font-sans font-semibold text-[11px]/3.5">Saved</div>
              <div className="h-px grow shrink basis-[0%] bg-[#0000001A]" />
            </div>
            <div className="flex flex-col gap-1 mb-4">
              {otherSaved.map((place) => (
                <button
                  key={place.placeId}
                  type="button"
                  onClick={() => onSelect(place)}
                  className="flex items-center py-2.5 px-1 gap-3 w-full text-left">
                  <div className="flex items-center justify-center shrink-0 rounded-2xl bg-[#0000000F] size-8">
                    <StarIcon />
                  </div>
                  <div className="grow shrink basis-[0%] min-w-0">
                    <div className="text-[#000000E6] font-sans font-medium text-[15px]/4.5 truncate">
                      {place.savedName || place.name || place.address}
                    </div>
                    <div className="text-[#0000008C] font-sans text-xs/4 truncate">{place.address}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
          ) : null
        })()}

        {/* Recent searches */}
        {recents.length > 0 && (
          <>
            <div className="flex items-center gap-2 mb-3 mt-5">
              <div className="tracking-[0.16em] uppercase text-[#0000008C] font-sans font-semibold text-[11px]/3.5">Recent</div>
              <div className="h-px grow shrink basis-[0%] bg-[#0000001A]" />
            </div>
            <div className="flex flex-col gap-1">
              {recents.map((place) => (
                <button
                  key={place.placeId}
                  type="button"
                  onClick={() => onSelect(place)}
                  className="flex items-center py-2.5 px-1 gap-3 w-full text-left">
                  <div className="flex items-center justify-center shrink-0 rounded-2xl bg-[#0000000F] size-8">
                    <ClockIcon />
                  </div>
                  <div className="grow shrink basis-[0%] min-w-0">
                    <div className="text-[#000000E6] font-sans font-medium text-[15px]/4.5 truncate">
                      {place.name || place.address}
                    </div>
                    <div className="text-[#0000008C] font-sans text-xs/4 truncate">{place.address}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {savedPlaces.filter((p) => p.type !== "home" && p.type !== "work").length === 0 && recents.length === 0 && (
          <div className="flex items-center justify-center py-6">
            <span className="text-[13px] text-[#0000004D]">No saved places or recent searches</span>
          </div>
        )}
      </div>
    </Drawer>
  )
}


function HomeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M3 12 L12 4 L21 12 L21 20 H14 V14 H10 V20 H3 Z" fill="#FFFFFF" />
    </svg>
  )
}

function WorkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <rect x="3" y="8" width="18" height="13" rx="1.5" fill="#FFFFFF" />
      <path d="M9 8 V5 H15 V8" stroke="#FFFFFF" strokeWidth="2" fill="none" />
    </svg>
  )
}

function StarIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="#000000D9" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="9" stroke="#000000D9" strokeWidth="2" fill="none" />
      <path d="M12 7V12L15 14" stroke="#000000D9" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
