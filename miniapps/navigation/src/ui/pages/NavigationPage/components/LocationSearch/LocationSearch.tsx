import {useEffect, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2} from "lucide-react"
import {useRpc} from "@mentra/miniapp/ui"

import "@/shared/channels"
import type {Channels} from "@/shared/channels"
import type {PlaceDetails, PlaceSuggestion, SavedPlace} from "@/shared/types"
import {useNavStore} from "@/ui/store/navStore"
import {suppressNextRouterPopOnce} from "@/ui/router"
import { safeHeadingSearchPill, safeHeadingSearchResults } from "@/ui/components/SafeHeading/SafeHeading"
import {
  CloseIcon,
  HomeIconFilled,
  PinIconFilled,
  PinIconOutline,
  StarIcon,
  WorkIconFilled,
} from "@/ui/components/icons"

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

// ---- component --------------------------------------------------------------

export function LocationSearch({selected, onSelect, onClear, disabled, devFrozen = false, autoFocus = false, onSearchingChange, refreshKey}: Props) {
  const coords = useNavStore((s) => s.coords)
  const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
  const details = useRpc<Channels, "places:details">("places:details")
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [recentSearches, setRecentSearches] = useState<PlaceDetails[]>([])
  const [savedPlaces, setSavedPlaces] = useState<
    {label: string; place: PlaceDetails; type?: "home" | "work"}[]
  >([])
  const [, setOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const [, setError] = useState<string | null>(null)
  // `open`/`error` are tracked via their setters above; suggestion-list
  // visibility uses the derived `showSuggestions` instead.
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
    mentra
      .request("storage:list-recent", undefined as never)
      .then(setRecentSearches)
      .catch(() => {})
    mentra
      .request("storage:list-saved", undefined as never)
      .then((all: SavedPlace[]) => {
        setSavedPlaces(
          all.map((place) => ({
            label: place.savedName || (place.type === "home" ? "Home" : place.type === "work" ? "Work" : place.name) || place.address,
            place,
            type: place.type,
          })),
        )
      })
      .catch(() => {})
  }, [focused, query, selected, refreshKey])

  // Read coords via a ref inside the effect instead of as a dependency.
  // `coords` ticks on every GPS update (every ~1-2s in the foreground),
  // and including it in the deps re-fires the search every tick — the
  // user sees their suggestions list rebuild itself every couple of
  // seconds while they're not even typing. The location bias only
  // matters at the moment the search is issued, so a ref read at
  // call-time gives the same result without retriggering.
  const coordsRef = useRef(coords)
  useEffect(() => {
    coordsRef.current = coords
  }, [coords])
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
    const t = setTimeout(() => {
      setError(null)
      const c = coordsRef.current
      autocomplete({query: trimmed, near: c ? {lat: c.lat, lng: c.lng} : undefined})
        .then((results) => {
          setSuggestions(results)
          setOpen(true)
          setLoading(false)
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return
          setError((err as Error).message)
          setSuggestions([])
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selected, disabled, focused, autocomplete])

  async function pick(s: PlaceSuggestion) {
    setOpen(false)
    setLoading(true)
    setError(null)
    inputRef.current?.blur()
    try {
      const place = await details({placeId: s.placeId})
      await mentra.request("storage:add-recent", place)
      onSelect(place)
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
    await mentra.request("storage:add-recent", place)
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

  // ── Back-button + tap-to-close coordination ──────────────────────────
  // Android's first back press dismisses the soft keyboard on its own
  // (OS-level, before popstate). To get the second back press to close
  // *only* the search drawer (and leave the underlying map intact), we
  // push a history entry while the drawer is open. The router's
  // popstate handler is told via suppressNextRouterPopOnce() to skip
  // its route-stack mutation when our entry is the one being consumed.
  const searchEntryPushedRef = useRef(false)

  function closeSearch() {
    inputRef.current?.blur()
    setFocused(false)
    setOpen(false)
  }

  useEffect(() => {
    if (showSuggestions && !searchEntryPushedRef.current) {
      try {
        history.pushState({searchDrawer: true}, "")
        searchEntryPushedRef.current = true
      } catch {
        /* WebView may forbid pushState in some sandboxes — degrade
           gracefully: the drawer will simply close on first back. */
      }
    } else if (!showSuggestions && searchEntryPushedRef.current) {
      // Drawer closed programmatically (pick/clear/tap-outside). Pop
      // our entry so history depth matches the drawer state.
      searchEntryPushedRef.current = false
      suppressNextRouterPopOnce()
      try {
        history.back()
      } catch {
        /* ignore */
      }
    }
  }, [showSuggestions])

  useEffect(() => {
    function onPopState() {
      // Only react when *our* entry is the one being consumed.
      if (!searchEntryPushedRef.current) return
      searchEntryPushedRef.current = false
      suppressNextRouterPopOnce()
      closeSearch()
    }
    // Capture phase so the suppress flag is set before the router's
    // bubble-phase listener checks it.
    window.addEventListener("popstate", onPopState, true)
    return () => window.removeEventListener("popstate", onPopState, true)
  }, [])

  function onBackdropMouseDown(e: React.MouseEvent<HTMLElement>) {
    // Only fire when the user taps the panel background itself, not a
    // bubbled click from the input, a suggestion row, or a saved chip.
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    closeSearch()
  }

  return (
    <div className="relative mt-4 mx-3 flex flex-col mr-26">
      <div className="relative flex flex-col">
        {/* Search pill */}
        <div className={`relative z-90 flex items-center h-[52px] rounded-[20px] px-3.5 gap-2.5 bg-[#FFFFFFA6] dark:bg-[#161619CC] border border-[#FFFFFF99] dark:border-[#FFFFFF1A] [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#0000001A_0px_6px_22px] ${safeHeadingSearchPill}`}>
          {/* Search icon */}
          {/* <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
            <circle cx="11" cy="11" r="7" stroke="#0000008C" strokeWidth="2" />
            <path d="M20 20L16 16" stroke="#0000008C" strokeWidth="2" strokeLinecap="round" />
          </svg> */}

          <input
            ref={inputRef}
            className="grow shrink basis-0 min-w-0 bg-transparent font-sans text-[#000000E6] dark:text-zinc-50 text-base/5 placeholder-[#0000008C] dark:placeholder-[#FFFFFF8C] focus:outline-none border-none"
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

          {/* Right button: clear (when text entered). Sits flush inside
              the pill — no own background, just the X glyph. */}
          {query ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              disabled={disabled}
              className="w-6.5 h-6.5 flex items-center justify-center shrink-0 rounded-full bg-[#00000014] dark:bg-[#FFFFFF1F]"
              aria-label="Clear">
              <CloseIcon />
            </button>
          ) : null}
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
              onMouseDown={onBackdropMouseDown}
              // `select-none` + webkit-touch-callout block long-press
              // selection / copy on place names and addresses. The
              // <input> is exempt — browsers always allow selection
              // inside form controls so the user can still edit their
              // query normally.
              className={`fixed z-40 inset-x-0 bottom-0 top-0 bg-white dark:bg-zinc-950 overflow-auto select-none [-webkit-touch-callout:none] [-webkit-user-select:none] ${safeHeadingSearchResults}`}>
              {loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-8 text-neutral-500 dark:text-zinc-400">
                  <Loader2 size={16} className="animate-spin" />
                  <span className="text-[13px]">Searching…</span>
                </div>
              ) : isQueryEmpty ? (
                // Empty input — saved places chips + recent searches
                <>
                  {/* Saved places grid */}
                  {savedPlaces.length > 0 && (
                    <div className="grid grid-cols-4 gap-3 px-4 py-4 border-b border-[#0000000A] dark:border-[#FFFFFF14]">
                      {savedPlaces.map(({label, place, type}) => (
                        <button
                          key={place.placeId + label}
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pickRecent(place)}
                          className="flex flex-col items-center gap-2 rounded-2xl bg-[#F5F5F5] dark:bg-zinc-900 border border-[#0000000A] dark:border-[#FFFFFF14] p-3">
                          <div className="flex items-center justify-center size-10 rounded-xl bg-[#1A1A1A] dark:bg-zinc-700 shrink-0">
                            <SavedPlaceIcon type={type} />
                          </div>
                          <div className="w-full text-center">
                            <div className="text-[#000000E6] dark:text-zinc-50 font-sans font-semibold text-[13px] leading-4 truncate">{label}</div>
                            <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-[11px] leading-3.5 truncate">{place.name || place.address}</div>
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
                            className="w-full text-left flex items-center gap-3 px-4 hover:bg-[#0000000A] dark:hover:bg-[#FFFFFF0F] active:bg-[#0000001A] dark:active:bg-[#FFFFFF1F] transition-colors border-b border-[#0000000A] last:border-b-0"
                            style={{paddingTop: isFirst ? 14 : 12, paddingBottom: isFirst ? 14 : 12}}>
                            {isFirst ? (
                              <div className="flex items-center justify-center shrink-0 rounded-[18px] bg-[#1A1A1A] dark:bg-zinc-700 size-9">
                                <PinIconFilled />
                              </div>
                            ) : (
                              <div className="flex items-center justify-center shrink-0 size-8">
                                <PinIconOutline />
                              </div>
                            )}
                            <div className="grow shrink basis-0 min-w-0">
                              <div
                                className="truncate font-sans text-[#000000E6] dark:text-zinc-50"
                                style={{
                                  fontSize: isFirst ? 16 : 15,
                                  fontWeight: isFirst ? 600 : 500,
                                  lineHeight: isFirst ? "20px" : "18px",
                                  letterSpacing: "-0.012em",
                                }}>
                                {place.name || place.address}
                              </div>
                              <div className="text-[#0000008C] dark:text-zinc-400 font-sans text-xs leading-4 truncate">{place.address}</div>
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                  ) : savedPlaces.length === 0 ? (
                  <div className="flex items-center justify-center px-3 py-8 text-neutral-400 dark:text-zinc-500">
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
                        className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-[#0000000A] dark:hover:bg-[#FFFFFF0F] border-b border-[#0000000A] dark:border-[#FFFFFF14] last:border-b-0">
                        <div className="flex items-center justify-center shrink-0 size-8">
                          <PinIconOutline />
                        </div>
                        <div className="grow shrink basis-0 min-w-0">
                          <div className="text-[15px] font-medium text-[#000000E6] dark:text-zinc-50 truncate">{s.mainText}</div>
                          {s.secondaryText ? (
                            <div className="text-xs text-[#0000008C] dark:text-zinc-400 truncate">{s.secondaryText}</div>
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

/** Resolve the chip icon for a saved place by its tag ("home"/"work"/none). */
function SavedPlaceIcon({type}: {type?: "home" | "work"}) {
  // Saved-place chips sit on a dark surface, so all three variants use
  // the filled-white form. Override the default 16px size to 18px for
  // visual weight inside the larger chip.
  if (type === "home") return <HomeIconFilled size={18} />
  if (type === "work") return <WorkIconFilled size={18} />
  return <StarIcon size={18} color="#FFFFFF" />
}
