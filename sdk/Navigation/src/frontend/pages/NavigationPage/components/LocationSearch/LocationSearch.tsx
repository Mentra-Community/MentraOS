import {useEffect, useMemo, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2, MapPin} from "lucide-react"

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
  devFrozen?: boolean
  autoFocus?: boolean
  onSearchingChange?: (searching: boolean) => void
}

const DEBOUNCE_MS = 200

// ---- icons ------------------------------------------------------------------

function PinIconFilled() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" fill="#FFFFFF" />
      <circle cx="12" cy="10" r="3" fill="#1A1A1A" />
    </svg>
  )
}

function PinIconOutline() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" stroke="#000000A6" strokeWidth="1.8" fill="none" />
    </svg>
  )
}

// ---- component --------------------------------------------------------------

export function LocationSearch({selected, onSelect, onClear, disabled, running, me, maneuver, routePoints, devFrozen = false, autoFocus = false, onSearchingChange}: Props) {
  const user = useUser()
  const heading = user.heading
  const session = useMemo(() => new PlacesSession(), [])
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [recentSearches, setRecentSearches] = useState<PlaceDetails[]>([])
  const [open, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (autoFocus) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [autoFocus])

  useEffect(() => {
    onSearchingChange?.(focused && !selected)
  }, [focused, selected, onSearchingChange])

  // When something is selected, the input shows the chosen place and the
  // dropdown stays closed. Typing again clears the selection.
  useEffect(() => {
    if (selected) {
      setQuery(selected.name || selected.address)
      setOpen(false)
    }
  }, [selected])

  // Fetch recent searches whenever the user focuses the empty input
  useEffect(() => {
    if (!focused || query.trim() || selected) return
    user.storage.getRecentSearches().then(setRecentSearches)
  }, [focused, query, selected, user.storage])

  useEffect(() => {
    if (selected || disabled || !focused) return
    const trimmed = query.trim()
    if (!trimmed) {
      setSuggestions([])
      setOpen(false)
      setLoading(false)
      return
    }
    setLoading(true)
    const t = setTimeout(async () => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
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
  }, [query, selected, disabled, focused, session])

  async function pick(s: PlaceSuggestion) {
    setOpen(false)
    setLoading(true)
    setError(null)
    inputRef.current?.blur()
    try {
      const details = await session.details(s.placeId)
      session.reset()
      await user.storage.addRecentSearch(details)
      onSelect(details)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  async function pickRecent(place: PlaceDetails) {
    setOpen(false)
    setFocused(false)
    inputRef.current?.blur()
    await user.storage.addRecentSearch(place)
    onSelect(place)
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

  const isQueryEmpty = !query.trim()

  // Show suggestions overlay whenever focused and no selection
  const showSuggestions = (focused || devFrozen) && !selected

  return (
    <div className="relative mt-4 mx-3 flex flex-col">
      <div className="relative flex flex-col">
        {/* Search pill */}
        <div className=" absolute z-90 flex items-center h-10 rounded-[20px] px-3.5 gap-2.5 bg-[#FFFFFFA6] border border-[#FFFFFF99] [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#0000001A_0px_6px_22px] mr-21 mt-9.5">
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
            onFocus={() => {
              setFocused(true)
              if (suggestions.length > 0) setOpen(true)
            }}
            onBlur={() =>
              setTimeout(() => {
                if (devFrozen) return
                setOpen(false)
                setFocused(false)
              }, 150)
            }
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

        {/* Full-screen results panel — sits below the search pill */}
        <AnimatePresence>
          {showSuggestions ? (
            <motion.div
              key="suggestions"
              initial={{opacity: 0, y: -8}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -8}}
              transition={{duration: 0.15, ease: "easeOut"}}
              className="fixed z-40 inset-x-0 bottom-0 top-0 bg-white overflow-auto pt-30">
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-neutral-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[13px]">Searching…</span>
                </div>
              ) : isQueryEmpty ? (
                // Empty input — show recent searches
                recentSearches.length > 0 ? (
                  <ul>
                    {recentSearches.map((place, i) => {
                      const isFirst = i === 0
                      return (
                        <li key={place.placeId}>
                          <button
                            type="button"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => pickRecent(place)}
                            className="w-full text-left flex items-center gap-3 px-4 hover:bg-[#0000000A] active:bg-[#0000001A] transition-colors border-b border-[#0000000A] last:border-b-0"
                            style={{paddingTop: isFirst ? 14 : 12, paddingBottom: isFirst ? 14 : 12}}>
                            {isFirst ? (
                              <div className="flex items-center justify-center shrink-0 rounded-[18px] bg-[#1A1A1A] size-9">
                                <PinIconFilled />
                              </div>
                            ) : (
                              <div className="flex items-center justify-center shrink-0 size-8">
                                <PinIconOutline />
                              </div>
                            )}
                            <div className="grow shrink basis-0 min-w-0">
                              <div
                                className="truncate font-sans text-[#000000E6]"
                                style={{
                                  fontSize: isFirst ? 16 : 15,
                                  fontWeight: isFirst ? 600 : 500,
                                  lineHeight: isFirst ? "20px" : "18px",
                                  letterSpacing: "-0.012em",
                                }}>
                                {place.name || place.address}
                              </div>
                              <div className="text-[#0000008C] font-sans text-xs leading-4 truncate">{place.address}</div>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <div className="flex items-center justify-center px-3 py-8 text-neutral-400">
                    <span className="text-[13px]">No recent searches</span>
                  </div>
                )
              ) : (
                // Active query — show autocomplete results
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
                        className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-[#0000000A] border-b border-[#0000000A] last:border-b-0">
                        <div className="flex items-center justify-center shrink-0 size-8">
                          <PinIconOutline />
                        </div>
                        <div className="grow shrink basis-0 min-w-0">
                          <div className="text-[15px] font-medium text-[#000000E6] truncate">{s.mainText}</div>
                          {s.secondaryText ? (
                            <div className="text-xs text-[#0000008C] truncate">{s.secondaryText}</div>
                          ) : null}
                        </div>
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
