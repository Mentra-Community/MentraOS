import {useEffect, useState} from "react"

import type {LatLng, PlaceDetails, SavedPlace} from "@/shared/types"
import {Drawer} from "@/ui/components/Drawer/Drawer"
import {ClockIcon, HomeIconFilled, PlusIcon, StarIcon, WorkIconFilled} from "@/ui/components/icons"

type Props = {
  me: LatLng | null
  onSelect: (place: PlaceDetails) => void
  /** Type-aware add — passing `"home"` / `"work"` opens AddPlacePage with
   *  the name pre-filled and stamps the resulting save with that type. */
  onAddPlace: (type?: "home" | "work") => void
  refreshKey?: number
}

export function IdleDrawer({onSelect, onAddPlace, refreshKey}: Props) {
  const [expanded, setExpanded] = useState(false)
  const [savedPlaces, setSavedPlaces] = useState<SavedPlace[]>([])
  const [recents, setRecents] = useState<PlaceDetails[]>([])

  useEffect(() => {
    mentra
      .request("storage:list-saved", undefined as never)
      .then(setSavedPlaces)
      .catch(() => {})
    mentra
      .request("storage:list-recent", undefined as never)
      .then(setRecents)
      .catch(() => {})
  }, [refreshKey])

  return (
    <Drawer
      open
      onClose={() => {}}
      dismissOnSwipeDown={false}
      peekHeight={163}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="[font-synthesis:none] pointer-events-auto w-full flex flex-col rounded-tl-[28px] rounded-tr-[28px] bg-[#FFFFFFB3] dark:bg-[#161619CC] border-t border-t-solid border-t-[#FFFFFF99] dark:border-t-[#FFFFFF1A] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-8px_28px] antialiased overflow-hidden">

      {/* Sticky top: Home + Work quick-access cards, then Add Place. */}
      <div className="flex gap-2.5 px-5 pb-6 shrink-0">
        {/* Home */}
        {(() => {
          const home = savedPlaces.find((p) => p.type === "home") ?? null
          return home ? (
            <button
              type="button"
              onClick={() => onSelect(home)}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] dark:bg-[#232327E6] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
              <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] dark:bg-zinc-700 [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
                <HomeIconFilled />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-sm/4.5">
                  {home.savedName || "Home"}
                </div>
                <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[11px]/3.5 truncate">{home.name || home.address}</div>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onAddPlace("home")}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] dark:bg-[#232327E6] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
              <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] dark:bg-zinc-700 [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
                <HomeIconFilled />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-sm/4.5">Home</div>
                <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[11px]/3.5">Add address</div>
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
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] dark:bg-[#232327E6] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
              <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] dark:bg-zinc-700 shrink-0 size-8">
                <WorkIconFilled />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-sm/4.5">
                  {work.savedName || "Work"}
                </div>
                <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[11px]/3.5 truncate">{work.name || work.address}</div>
              </div>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onAddPlace("work")}
              className="grow shrink basis-[0%] min-w-0 flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] dark:bg-[#232327E6] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
              <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] dark:bg-zinc-700 shrink-0 size-8">
                <WorkIconFilled />
              </div>
              <div className="min-w-0 w-full">
                <div className="tracking-[-0.005em] text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-sm/4.5">Work</div>
                <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[11px]/3.5">Add address</div>
              </div>
            </button>
          )
        })()}

        {/* Add place — stationary, never scrolls */}
        <button
          type="button"
          onClick={() => onAddPlace()}
          className="[font-synthesis:none] w-21 flex flex-col items-start gap-2 rounded-[18px] shrink-0 [box-shadow:#00000014_0px_0px_0px_1px_inset] bg-[#0000000A] dark:bg-[#FFFFFF14] antialiased p-3.5">
          <div className="flex items-center justify-center rounded-full shrink-0 bg-[#0000001A] dark:bg-[#FFFFFF26] size-8">
            <PlusIcon />
          </div>
          <div className="flex flex-col items-start tracking-[0.02em] [white-space-collapse:preserve] font-sans font-semibold text-[#1A1A1A] dark:text-zinc-50 text-[11px]/3.5">
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
              <div className="tracking-[0.16em] uppercase text-[#0000008C] dark:text-zinc-400 font-sans font-semibold text-[11px]/3.5">Saved</div>
              <div className="h-px grow shrink basis-[0%] bg-[#0000001A] dark:bg-[#FFFFFF26]" />
            </div>
            <div className="flex flex-col gap-1 mb-4">
              {otherSaved.map((place) => (
                <button
                  key={place.placeId}
                  type="button"
                  onClick={() => onSelect(place)}
                  className="flex items-center py-2.5 px-1 gap-3 w-full text-left">
                  <div className="flex items-center justify-center shrink-0 rounded-2xl bg-[#0000000F] dark:bg-[#FFFFFF1A] size-8">
                    <StarIcon />
                  </div>
                  <div className="grow shrink basis-[0%] min-w-0">
                    <div className="text-[#000000E6] dark:text-zinc-50 font-sans font-medium text-[15px]/4.5 truncate">
                      {place.savedName || place.name || place.address}
                    </div>
                    <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-xs/4 truncate">{place.address}</div>
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
              <div className="tracking-[0.16em] uppercase text-[#0000008C] dark:text-zinc-400 font-sans font-semibold text-[11px]/3.5">Recent</div>
              <div className="h-px grow shrink basis-[0%] bg-[#0000001A] dark:bg-[#FFFFFF26]" />
            </div>
            <div className="flex flex-col gap-1">
              {recents.map((place) => (
                <button
                  key={place.placeId}
                  type="button"
                  onClick={() => onSelect(place)}
                  className="flex items-center py-2.5 px-1 gap-3 w-full text-left">
                  <div className="flex items-center justify-center shrink-0 rounded-2xl bg-[#0000000F] dark:bg-[#FFFFFF1A] size-8">
                    <ClockIcon />
                  </div>
                  <div className="grow shrink basis-[0%] min-w-0">
                    <div className="text-[#000000E6] dark:text-zinc-50 font-sans font-medium text-[15px]/4.5 truncate">
                      {place.name || place.address}
                    </div>
                    <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-xs/4 truncate">{place.address}</div>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {savedPlaces.filter((p) => p.type !== "home" && p.type !== "work").length === 0 && recents.length === 0 && (
          <div className="flex items-center justify-center py-6">
            <span className="text-[13px] text-[#0000004D] dark:text-zinc-500">No saved places or recent searches</span>
          </div>
        )}
      </div>
    </Drawer>
  )
}


