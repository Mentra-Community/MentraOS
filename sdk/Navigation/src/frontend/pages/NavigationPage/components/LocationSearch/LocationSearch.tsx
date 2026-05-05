import {useEffect, useMemo, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2, MapPin} from "lucide-react"
import LiquidGlass from "liquid-glass-react"

import {useUser} from "@/backend/hooks/useUser"
import type {LatLng} from "@/backend/lib/geometry/geometry"
import {PlacesSession} from "@/backend/lib/places/places"
import type {PlaceDetails, PlaceSuggestion} from "@/backend/lib/places/places"
import {OrientationCard} from "@/frontend/pages/NavigationPage/components/OrientationCard/OrientationCard"
import type {NavManeuver} from "@mentra/miniapp"

type Props = {
  selected: PlaceDetails | null
  onSelect: (place: PlaceDetails) => void
  onClear: () => void
  disabled?: boolean
  running?: boolean
  me?: LatLng | null
  maneuver?: NavManeuver | null
  routePoints?: LatLng[] | null
}

const DEBOUNCE_MS = 200

export function LocationSearch({selected, onSelect, onClear, disabled, running, me, maneuver, routePoints}: Props) {
  const heading = useUser().heading
  const session = useMemo(() => new PlacesSession(), [])
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // When something is selected, the input shows the chosen place and the
  // dropdown stays closed. Typing again clears the selection.
  useEffect(() => {
    if (selected) {
      setQuery(selected.name || selected.address)
      setOpen(false)
    }
  }, [selected])

  useEffect(() => {
    if (selected || disabled) return
    const trimmed = query.trim()
    if (!trimmed) {
      setSuggestions([])
      setOpen(false)
      return
    }
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setLoading(true)
      setError(null)
      try {
        const results = await session.autocomplete(trimmed, ctrl.signal)
        if (ctrl.signal.aborted) return
        setSuggestions(results)
        setOpen(true)
      } catch (err) {
        if ((err as Error).name === "AbortError") return
        setError((err as Error).message)
        setSuggestions([])
      } finally {
        if (!ctrl.signal.aborted) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, selected, disabled, session])

  async function pick(s: PlaceSuggestion) {
    setOpen(false)
    setLoading(true)
    setError(null)
    // Dismiss the on-screen keyboard.
    inputRef.current?.blur()
    try {
      const details = await session.details(s.placeId)
      session.reset()
      onSelect(details)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  function handleChange(value: string) {
    if (selected) onClear()
    setQuery(value)
  }

  function handleClear() {
    setQuery("")
    setSuggestions([])
    setOpen(false)
    onClear()
  }

  return (
    <div className="relative mt-4 mx-3 flex flex-col">
      <div className="relative flex flex-col">
        {/* Search pill */}
        
        <div className=" flex items-center h-10 rounded-[20px] px-3.5 gap-2.5 bg-[#FFFFFFA6] border border-[#FFFFFF99] [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#0000001A_0px_6px_22px] mr-21 mt-9.5">
          {/* Search icon */}
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
            <circle cx="11" cy="11" r="7" stroke="#0000008C" strokeWidth="2" />
            <path d="M20 20L16 16" stroke="#0000008C" strokeWidth="2" strokeLinecap="round" />
          </svg>

          <input
            ref={inputRef}
            className="grow shrink basis-0 bg-transparent tracking-[-0.012em] text-[#0000008C] font-sans text-[15px] leading-[18px] placeholder-[#0000008C] focus:outline-none focus:ring-0 border-none"
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder={running ? (selected?.name || selected?.address || "Navigating…") : "Where to?"}
            disabled={disabled}
            autoComplete="off"
          />

          {/* Right button: clear (when text entered) or mic */}
          {query && !running ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              disabled={disabled}
              className="w-6.5 h-6.5 flex items-center justify-center shrink-0 rounded-[13px] bg-[#00000014] text-neutral-500 text-base leading-none"
              aria-label="Clear">
              ×
            </button>
          ) : (
            <div className="w-6.5 h-6.5 flex items-center justify-center shrink-0 rounded-[13px] bg-[#00000014]">
              {running ? (
                <MapPin size={14} strokeWidth={2.25} className="text-neutral-800" />
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
                  <rect x="9" y="3" width="6" height="12" rx="3" fill="#1a1a1a" />
                  <path d="M5 11C5 14.866 8.134 18 12 18M12 18C15.866 18 19 14.866 19 11M12 18V21" stroke="#1a1a1a" strokeWidth="2" strokeLinecap="round" />
                </svg>
              )}
            </div>
          )}
        </div>

        {/* Suggestions dropdown */}
        <AnimatePresence>
          {loading || (open && suggestions.length > 0) ? (
            <motion.div
              key="suggestions"
              initial={{opacity: 0, y: -8}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -8}}
              transition={{duration: 0.18, ease: "easeOut"}}
              className="absolute z-10 left-0 right-0 top-12 bg-white/90 [backdrop-filter:blur(20px)] border border-neutral-200 rounded-2xl shadow-lg max-h-72 overflow-auto">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-4 text-neutral-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[13px]">Searching…</span>
                </div>
              ) : (
                <ul>
                  {suggestions.map((s, i) => (
                    <motion.li
                      key={s.placeId}
                      initial={{opacity: 0, y: -4}}
                      animate={{opacity: 1, y: 0}}
                      transition={{duration: 0.15, delay: i * 0.02, ease: "easeOut"}}>
                      <button
                        type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(s)}
                        className="w-full text-left px-4 py-2.5 hover:bg-neutral-100 border-b border-neutral-100 last:border-b-0">
                        <div className="text-[14px] text-neutral-900">{s.mainText}</div>
                        {s.secondaryText ? (
                          <div className="text-[12px] text-neutral-500">{s.secondaryText}</div>
                        ) : null}
                      </button>
                    </motion.li>
                  ))}
                </ul>
              )}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      <AnimatePresence>
        {running ? (
          <motion.div
            key="orientation"
            initial={{opacity: 0, height: 0}}
            animate={{opacity: 1, height: "auto"}}
            exit={{opacity: 0, height: 0}}
            transition={{duration: 0.22, ease: [0.22, 1, 0.36, 1]}}
            style={{overflow: "hidden"}}>
            <OrientationCard me={me ?? null} heading={heading} maneuver={maneuver ?? null} routePoints={routePoints ?? null} />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
