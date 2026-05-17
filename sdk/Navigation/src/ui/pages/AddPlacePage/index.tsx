import {useEffect, useMemo, useRef, useState} from "react"
import {motion} from "motion/react"

import {useUser} from "@/backend/hooks/useUser"
import {PlacesSession} from "@/backend/lib/places/places"
import type {PlaceDetails, PlaceSuggestion} from "@/backend/lib/places/places"
import {LocationInput} from "./components/LocationInput/LocationInput"
import {SuggestionsList} from "./components/SuggestionsList/SuggestionsList"
import { safeHeadingAddPlaces } from "@/frontend/components/SafeHeading/SafeHeading"

type Props = {
  /**
   * Optional preset that prefills the name field and tags the saved
   * place so the IdleDrawer can find it under its Home/Work
   * quick-access slot. Passed through to `onSave` unchanged.
   */
  presetType?: "home" | "work"
  onSave: (place: PlaceDetails, name: string, type?: "home" | "work") => void
  onClose: () => void
}

const DEBOUNCE_MS = 200

export function AddPlacePage({presetType, onSave, onClose}: Props) {
  const user = useUser()
  const coords = user.coords
  const session = useMemo(() => new PlacesSession(), [])

  const presetName = presetType === "home" ? "Home" : presetType === "work" ? "Work" : ""
  const [customName, setCustomName] = useState(presetName)
  const [query, setQuery] = useState("")
  const [selectedPlace, setSelectedPlace] = useState<PlaceDetails | null>(null)
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (selectedPlace || !focused) return
    const trimmed = query.trim()
    if (!trimmed) {
      setSuggestions([])
      setSearchOpen(false)
      setLoading(false)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      try {
        const results = await session.autocomplete(trimmed, ctrl.signal)
        if (ctrl.signal.aborted) return
        setSuggestions(results)
        setSearchOpen(true)
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        setSuggestions([])
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, selectedPlace, focused, session])

  async function pick(s: PlaceSuggestion) {
    setSearchOpen(false)
    setLoading(true)
    inputRef.current?.blur()
    try {
      const details = await session.details(s.placeId)
      session.reset()
      setSelectedPlace(details)
      setQuery(details.name || details.address)
    } finally {
      setLoading(false)
    }
  }

  function useCurrentLocation() {
    if (!coords) return
    const place: PlaceDetails = {
      placeId: `current:${coords.lat},${coords.lng}`,
      name: "Current location",
      address: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
      lat: coords.lat,
      lng: coords.lng,
    }
    setSelectedPlace(place)
    setQuery(place.name)
  }

  return (
    <motion.div
      initial={{x: "100%"}}
      animate={{x: 0}}
      exit={{opacity: 0}}
      transition={{type: "spring", stiffness: 300, damping: 34, mass: 0.85}}
      className="[font-synthesis:none] fixed inset-0 z-50 flex flex-col bg-white antialiased overflow-hidden">

      {/* Background gradients */}
      <div className="pointer-events-none absolute -top-25 -right-25 w-90 h-90 rounded-full" style={{backgroundImage: "radial-gradient(circle farthest-corner at 50% 50% in oklab, oklab(0% 0 0 / 6%) 0%, oklab(0% 0 0 / 0%) 70%)"}} />
      <div className="pointer-events-none absolute -bottom-37.5 -left-25 w-100 h-100 rounded-full" style={{backgroundImage: "radial-gradient(circle farthest-corner at 50% 50% in oklab, oklab(73% -0.164 0.105 / 6%) 0%, oklab(73% -0.164 0.105 / 0%) 70%)"}} />

      {/* Header */}
      <div className={`flex items-center gap-3 px-4 ${safeHeadingAddPlaces} pb-4`}>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center size-9 rounded-full bg-[#0000000A] shrink-0">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M15 19L8 12L15 5" stroke="#1A1A1A" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="text-[32px] tracking-tight leading-none font-sans font-bold text-black">Add a place</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-28">
        <LocationInput
          inputRef={inputRef}
          query={query}
          loading={loading}
          onChange={(v) => { if (selectedPlace) setSelectedPlace(null); setQuery(v) }}
          onFocus={() => { setFocused(true); if (suggestions.length > 0) setSearchOpen(true) }}
          onBlur={() => setTimeout(() => { setSearchOpen(false); setFocused(false) }, 150)}
          onCurrentLocation={useCurrentLocation}
        />
        {/* Name (optional) */}
        <div className="mt-5">
          <div className="pb-2.5 px-1">
            <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Name (optional)</div>
          </div>
          <div className="flex items-center rounded-[18px] py-3.5 px-4 [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000014_0px_4px_16px] bg-[#FFFFFFA6] border border-solid border-[#FFFFFF99]">
            <input
              className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] text-base/5 placeholder-[#0000008C] focus:outline-none border-none"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={presetName || "Place name"}
              autoComplete="off"
            />
          </div>
        </div>
      </div>

      <SuggestionsList open={searchOpen} suggestions={suggestions} onPick={pick} />

      {/* Save button */}
      <div className="absolute bottom-8 inset-x-4">
        <button
          type="button"
          onClick={() => selectedPlace && onSave(selectedPlace, customName.trim(), presetType)}
          disabled={!selectedPlace}
          className="h-14 w-full flex items-center justify-center rounded-[28px] px-4 [box-shadow:#00000033_0px_6px_22px] bg-[#1A1A1A] disabled:opacity-40 transition-opacity">
          <div className="tracking-[-0.005em] font-sans font-semibold text-white text-base/5">Save place</div>
        </button>
      </div>
    </motion.div>
  )
}
