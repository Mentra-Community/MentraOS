import {useEffect, useMemo, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2} from "lucide-react"

import {useUser} from "@/backend/hooks/useUser"
import {PlacesSession} from "@/backend/lib/places/places"
import type {PlaceDetails, PlaceSuggestion} from "@/backend/lib/places/places"

type SaveAs = "home" | "work" | "favorite" | "custom"

type Props = {
  initial?: SaveAs
  onSave: (type: SaveAs, place: PlaceDetails, name: string) => void
  onClose: () => void
}

const DEBOUNCE_MS = 200

export function AddPlacePage({initial = "home", onSave, onClose}: Props) {
  const user = useUser()
  const coords = user.coords
  const session = useMemo(() => new PlacesSession(), [])

  const [saveAs, setSaveAs] = useState<SaveAs>(initial)
  const [customName, setCustomName] = useState("")
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

  async function useCurrentLocation() {
    if (!coords) return
    const fake: PlaceDetails = {
      placeId: `current:${coords.lat},${coords.lng}`,
      name: "Current location",
      address: `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`,
      lat: coords.lat,
      lng: coords.lng,
    }
    setSelectedPlace(fake)
    setQuery(fake.name)
  }

  function handleSave() {
    if (!selectedPlace) return
    onSave(saveAs, selectedPlace, customName.trim())
  }

  const canSave = !!selectedPlace

  return (
    <motion.div
      initial={{opacity: 0, y: 24}}
      animate={{opacity: 1, y: 0}}
      exit={{opacity: 0, y: 24}}
      transition={{type: "spring", stiffness: 380, damping: 36}}
      className="[font-synthesis:none] fixed inset-0 z-50 flex flex-col bg-white antialiased overflow-hidden">

      {/* Background gradients */}
      <div className="pointer-events-none absolute -top-25 -right-25 w-90 h-90 rounded-full" style={{backgroundImage: "radial-gradient(circle farthest-corner at 50% 50% in oklab, oklab(0% 0 0 / 6%) 0%, oklab(0% 0 0 / 0%) 70%)"}} />
      <div className="pointer-events-none absolute -bottom-37.5 -left-25 w-100 h-100 rounded-full" style={{backgroundImage: "radial-gradient(circle farthest-corner at 50% 50% in oklab, oklab(73% -0.164 0.105 / 6%) 0%, oklab(73% -0.164 0.105 / 0%) 70%)"}} />

      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-16 pb-4">
        <div className="text-[32px] tracking-[-0.025em] leading-none font-sans font-bold text-black">Add a place</div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-28">

        {/* Location section */}
        <div className="mb-5">
          <div className="pb-2.5 px-1">
            <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Location</div>
          </div>
          <div
            className="flex items-center rounded-[18px] py-3.5 px-4 gap-3 [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000014_0px_4px_16px] bg-[#FFFFFFA6] border border-solid border-[#FFFFFF99]"
            onClick={() => inputRef.current?.focus()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
              <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" stroke="#1A1A1A" strokeWidth="2" fill="none" />
              <circle cx="12" cy="10" r="3" stroke="#1A1A1A" strokeWidth="2" fill="none" />
            </svg>
            <input
              ref={inputRef}
              className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] text-base/5 placeholder-[#0000008C] focus:outline-none border-none"
              value={query}
              onChange={(e) => {
                if (selectedPlace) setSelectedPlace(null)
                setQuery(e.target.value)
              }}
              onFocus={() => {
                setFocused(true)
                if (suggestions.length > 0) setSearchOpen(true)
              }}
              onBlur={() => setTimeout(() => { setSearchOpen(false); setFocused(false) }, 150)}
              placeholder="Search address or place"
              autoComplete="off"
            />
            {loading ? <Loader2 size={16} className="animate-spin text-neutral-400 shrink-0" /> : null}
          </div>

          {/* Current location row */}
          <button
            type="button"
            onClick={useCurrentLocation}
            className="flex items-center py-3 px-1 gap-2.5 w-full text-left">
            <div className="w-5.5 h-5.5 flex items-center justify-center rounded-[11px] shrink-0 bg-[#0000000F]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
                <circle cx="12" cy="12" r="3" fill="#1A1A1A" />
                <circle cx="12" cy="12" r="7" stroke="#1A1A1A" strokeWidth="1.6" />
                <path d="M12 1V4M12 20V23M1 12H4M20 12H23" stroke="#1A1A1A" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div className="tracking-[-0.005em] font-sans font-medium text-[#1A1A1A] text-sm/4.5">Use my current location</div>
          </button>
        </div>

        {/* Save As section */}
        <div className="mb-5">
          <div className="pb-2.5 px-1">
            <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Save as</div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            {(["home", "work", "favorite", "custom"] as const).map((type) => {
              const selected = saveAs === type
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => setSaveAs(type)}
                  className={`aspect-square flex flex-col items-center justify-center rounded-2xl gap-2 p-3 ${selected ? "[box-shadow:#1A1A1A_0px_0px_0px_2px_inset] bg-[#0000000A]" : "[backdrop-filter:blur(20px)] [box-shadow:#00000014_0px_0px_0px_1px_inset] bg-[#FFFFFFA6]"}`}>
                  <div className={`flex items-center justify-center rounded-2xl shrink-0 size-8 ${selected ? "bg-[#1A1A1A]" : "bg-[#0000000F]"}`}>
                    <SaveAsIcon type={type} selected={selected} />
                  </div>
                  <div className={`tracking-[-0.005em] font-sans text-xs/4 capitalize ${selected ? "font-semibold text-[#1A1A1A]" : "font-medium text-[#000000D9]"}`}>
                    {type}
                  </div>
                </button>
              )
            })}
          </div>
        </div>

        {/* Name (optional) section */}
        <div>
          <div className="pb-2.5 px-1">
            <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Name (optional)</div>
          </div>
          <div className="flex items-center rounded-[18px] py-3.5 px-4 [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000014_0px_4px_16px] bg-[#FFFFFFA6] border border-solid border-[#FFFFFF99]">
            <input
              className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] text-base/5 placeholder-[#0000008C] focus:outline-none border-none"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder={saveAs.charAt(0).toUpperCase() + saveAs.slice(1)}
              autoComplete="off"
            />
          </div>
        </div>
      </div>

      {/* Autocomplete overlay */}
      <AnimatePresence>
        {searchOpen && suggestions.length > 0 ? (
          <motion.div
            key="suggestions"
            initial={{opacity: 0, y: -8}}
            animate={{opacity: 1, y: 0}}
            exit={{opacity: 0, y: -8}}
            transition={{duration: 0.15, ease: "easeOut"}}
            className="absolute inset-x-0 top-36 bottom-0 z-10 bg-white overflow-auto pt-4">
            <ul>
              {suggestions.map((s, i) => (
                <motion.li
                  key={s.placeId}
                  initial={{opacity: 0, y: -4}}
                  animate={{opacity: 1, y: 0}}
                  transition={{duration: 0.12, delay: i * 0.02}}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(s)}
                    className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-[#0000000A] border-b border-[#0000000A] last:border-b-0">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
                      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" stroke="#000000A6" strokeWidth="1.8" fill="none" />
                    </svg>
                    <div className="grow min-w-0">
                      <div className="text-[15px] font-medium text-[#000000E6] truncate">{s.mainText}</div>
                      {s.secondaryText ? <div className="text-xs text-[#0000008C] truncate">{s.secondaryText}</div> : null}
                    </div>
                  </button>
                </motion.li>
              ))}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* Save button */}
      <div className="absolute bottom-8 inset-x-4">
        <button
          type="button"
          onClick={handleSave}
          disabled={!canSave}
          className="h-14 w-full flex items-center justify-center rounded-[28px] px-4 [box-shadow:#00000033_0px_6px_22px] bg-[#1A1A1A] disabled:opacity-40 transition-opacity">
          <div className="tracking-[-0.005em] font-sans font-semibold text-white text-base/5">Save place</div>
        </button>
      </div>
    </motion.div>
  )
}

function SaveAsIcon({type, selected}: {type: SaveAs; selected: boolean}) {
  const fill = selected ? "#FFFFFF" : "#000000D9"
  if (type === "home") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M3 12 L12 4 L21 12 L21 20 H14 V14 H10 V20 H3 Z" fill={fill} />
    </svg>
  )
  if (type === "work") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <rect x="3" y="8" width="18" height="13" rx="1.5" fill={fill} />
      <path d="M9 8 V5 H15 V8" stroke={fill} strokeWidth="2" fill="none" />
    </svg>
  )
  if (type === "favorite") return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 21S3 14 3 8.5 6 2 9 2c2 0 3 1 3 3 0-2 1-3 3-3 3 0 6 2 6 6.5S12 21 12 21z" fill={fill} />
    </svg>
  )
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" fill={fill} />
      <circle cx="12" cy="10" r="3" fill={selected ? "#1A1A1A" : "#FFFFFF"} />
    </svg>
  )
}
