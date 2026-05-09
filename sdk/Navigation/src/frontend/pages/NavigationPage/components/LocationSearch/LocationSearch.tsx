import {useEffect, useMemo, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2} from "lucide-react"

import {useUser} from "@/backend/hooks/useUser"
import {PlacesSession} from "@/backend/lib/places/places"
import type {PlaceDetails, PlaceSuggestion} from "@/backend/lib/places/places"
import { SafeHeading, safeHeadingSearchPill, safeHeadingSearchResults } from "@/frontend/components/SafeHeading/SafeHeading"

type Props = {
  selected: PlaceDetails | null
  onSelect: (place: PlaceDetails) => void
  onClear: () => void
  disabled?: boolean
  devFrozen?: boolean
  autoFocus?: boolean
  onSearchingChange?: (searching: boolean) => void
  refreshKey?: number
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

export function LocationSearch({selected, onSelect, onClear, disabled, devFrozen = false, autoFocus = false, onSearchingChange, refreshKey}: Props) {
  const user = useUser()
  const session = useMemo(() => new PlacesSession(), [])
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [recentSearches, setRecentSearches] = useState<PlaceDetails[]>([])
  const [savedPlaces, setSavedPlaces] = useState<{label: string; icon: "home" | "work" | "favorite" | "custom"; place: PlaceDetails}[]>([])
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

  // Fetch recent searches + saved places whenever the user focuses the empty input
  useEffect(() => {
    if (!focused || query.trim() || selected) return
    user.storage.getRecentSearches().then(setRecentSearches)
    user.storage.getAllSavedPlaces().then((all) => {
      setSavedPlaces(
        all.map(({type, place}) => ({
          label: place.savedName || (type.charAt(0).toUpperCase() + type.slice(1)),
          icon: type,
          place,
        }))
      )
    })
  }, [focused, query, selected, user.storage, refreshKey])

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
        <div className={`absolute z-90 flex items-center h-[52px] rounded-[20px] px-3.5 gap-2.5 bg-[#FFFFFFA6] border border-[#FFFFFF99] [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#0000001A_0px_6px_22px] left-0 right-22 ${safeHeadingSearchPill}`}>
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
            placeholder="Where to?"
            disabled={disabled}
            autoComplete="off"
          />

          {/* Right button: clear (when text entered) or mic */}
          {query ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              disabled={disabled}
              className="w-6.5 h-6.5 flex items-center justify-center shrink-0 rounded-[13px] bg-[#00000014]"
              aria-label="Clear">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M1 1L9 9M9 1L1 9" stroke="#737373" strokeWidth="1.75" strokeLinecap="round"/>
              </svg>
            </button>
          ) : (
            null
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
              className={`fixed z-40 inset-x-0 bottom-0 top-0 bg-white overflow-auto ${safeHeadingSearchResults}`}>
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-neutral-500">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[13px]">Searching…</span>
                </div>
              ) : isQueryEmpty ? (
                // Empty input — saved places chips + recent searches
                <>
                  {/* Saved places grid */}
                  {savedPlaces.length > 0 && (
                    <div className="grid grid-cols-4 gap-3 px-4 py-4 border-b border-[#0000000A]">
                      {savedPlaces.map(({label, icon, place}) => (
                        <button
                          key={place.placeId + label}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pickRecent(place)}
                          className="flex flex-col items-center gap-2 rounded-2xl bg-[#F5F5F5] border border-[#0000000A] p-3">
                          <div className="flex items-center justify-center size-10 rounded-xl bg-[#1A1A1A] shrink-0">
                            <SavedPlaceIcon type={icon} />
                          </div>
                          <div className="w-full text-center">
                            <div className="text-[#000000E6] font-sans font-semibold text-[13px] leading-4 truncate">{label}</div>
                            <div className="text-[#0000008C] font-sans text-[11px] leading-3.5 truncate">{place.name || place.address}</div>
                          </div>
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Recent searches */}
                  {recentSearches.length > 0 ? (
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
                  ) : savedPlaces.length === 0 ? (
                  <div className="flex items-center justify-center px-3 py-8 text-neutral-400">
                    <span className="text-[13px]">No recent searches</span>
                  </div>
                  ) : null}
                </>
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

    </div>
  )
}

function SavedPlaceIcon({type}: {type: "home" | "work" | "favorite" | "custom"}) {
  if (type === "home") return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 12 L12 4 L21 12 L21 20 H14 V14 H10 V20 H3 Z" fill="#FFFFFF" />
    </svg>
  )
  if (type === "work") return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="3" y="8" width="18" height="13" rx="1.5" fill="#FFFFFF" />
      <path d="M9 8 V5 H15 V8" stroke="#FFFFFF" strokeWidth="2" fill="none" />
    </svg>
  )
  if (type === "favorite") return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="#FFFFFF" />
    </svg>
  )
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" fill="#FFFFFF" />
      <circle cx="12" cy="10" r="3" fill="#1A1A1A" />
    </svg>
  )
}
