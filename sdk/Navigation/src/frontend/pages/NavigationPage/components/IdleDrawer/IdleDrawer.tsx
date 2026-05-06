import {useEffect, useState} from "react"
import {haversineMeters} from "@/backend/lib/geometry/geometry"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import type {PlaceDetails} from "@/backend/lib/places/places"
import {useUser} from "@/backend/hooks/useUser"
import {Drawer} from "@/frontend/components/Drawer/Drawer"

type Props = {
  me: LatLng | null
  onSelect: (place: PlaceDetails) => void
  onAddPlace: (type: "home" | "work") => void
}

const WALKING_M_PER_S = 1.4

export function IdleDrawer({me, onSelect, onAddPlace}: Props) {
  const user = useUser()
  const [expanded, setExpanded] = useState(false)
  const [home, setHome] = useState<PlaceDetails | null>(null)
  const [work, setWork] = useState<PlaceDetails | null>(null)
  const [recents, setRecents] = useState<PlaceDetails[]>([])

  useEffect(() => {
    user.storage.getHome().then(setHome)
    user.storage.getWork().then(setWork)
    user.storage.getRecentSearches().then(setRecents)
  }, [user.storage])

  return (
    <Drawer
      open
      onClose={() => {}}
      dismissOnSwipeDown={false}
      peekHeight={40}
      expanded={expanded}
      onExpandedChange={setExpanded}
      className="[font-synthesis:none] pointer-events-auto mx-auto max-w-md flex flex-col rounded-tl-[28px] rounded-tr-[28px] pb-8 gap-4 bg-[#FFFFFFB3] border-t border-t-solid border-t-[#FFFFFF99] [backdrop-filter:blur(40px)_saturate(180%)] [box-shadow:#0000001A_0px_-8px_28px] antialiased px-5">
      {/* Quick-access cards: Home, Work, Add */}
      <div className="flex gap-2.5">
        {/* Home */}
        {home ? (
          <button
            type="button"
            onClick={() => onSelect(home)}
            className="grow shrink basis-[0%] flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
            <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
              <HomeIcon />
            </div>
            <div className="">
              <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Home</div>
              <div className="text-[#0000008C] font-sans text-[11px]/3.5">{quickStats(home, me)}</div>
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onAddPlace("home")}
            className="grow shrink basis-[0%] flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
            <div className="flex items-center justify-center rounded-2xl bg-[#1A1A1A] [box-shadow:#00000033_0px_2px_6px] shrink-0 size-8">
              <HomeIcon />
            </div>
            <div className="">
              <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Home</div>
              <div className="text-[#0000008C] font-sans text-[11px]/3.5">Add address</div>
            </div>
          </button>
        )}

        {/* Work */}
        {work ? (
          <button
            type="button"
            onClick={() => onSelect(work)}
            className="grow shrink basis-[0%] flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left">
            <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] shrink-0 size-8">
              <WorkIcon />
            </div>
            <div className="">
              <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Work</div>
              <div className="text-[#0000008C] font-sans text-[11px]/3.5">{quickStats(work, me)}</div>
            </div>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onAddPlace("work")}
            className="grow shrink basis-[0%] flex flex-col rounded-[18px] gap-2 bg-[#FFFFFFD9] [box-shadow:#0000000F_0px_0px_0px_1px_inset] p-3.5 text-left opacity-40">
            <div className="flex items-center justify-center rounded-2xl bg-[#000000D9] shrink-0 size-8">
              <WorkIcon />
            </div>
            <div className="">
              <div className="tracking-[-0.005em] text-[#000000E6] font-sans font-semibold text-sm/4.5">Work</div>
              <div className="text-[#0000008C] font-sans text-[11px]/3.5">Add address</div>
            </div>
          </button>
        )}

        {/* Add place */}
        <button
          type="button"
          onClick={() => onAddPlace("home")}
          className="w-21 flex flex-col items-center justify-center rounded-[18px] gap-1.5 bg-[#0000000A] [box-shadow:#00000014_0px_0px_0px_1px_inset] shrink-0 p-3.5">
          <div className="flex items-center justify-center rounded-[14px] bg-[#0000001A] shrink-0 size-7">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <path d="M12 5V19M5 12H19" stroke="#0A84FF" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </div>
          <div className="tracking-[0.02em] [white-space-collapse:preserve] text-[#1A1A1A] font-sans font-semibold text-[11px]/3.5">
            Add place
          </div>
        </button>
      </div>

      {/* Recent section header — always shown so expanded state has consistent layout */}
      <div className="flex items-center gap-2 my-5">
        <div className="tracking-[0.16em] uppercase text-[#0000008C] font-sans font-semibold text-[11px]/3.5">Recent</div>
        <div className="h-px grow shrink basis-[0%] bg-[#0000001A]" />
      </div>

      {/* Recent rows */}
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
    </Drawer>
  )
}

function quickStats(place: PlaceDetails, me: LatLng | null): string {
  if (!me) return place.address
  const meters = haversineMeters(me, place)
  const miles = meters / 1609.344
  const minutes = Math.round(meters / WALKING_M_PER_S / 60)
  const dist = miles < 0.1 ? `${Math.round(meters * 3.28084)} ft` : miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`
  return `${minutes} min · ${dist}`
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

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <circle cx="12" cy="12" r="9" stroke="#000000D9" strokeWidth="2" fill="none" />
      <path d="M12 7V12L15 14" stroke="#000000D9" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
