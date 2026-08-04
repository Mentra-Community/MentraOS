import {useEffect, useRef, useState} from "react"
import {motion} from "motion/react"
import {useRpc} from "@mentra/miniapp/ui"

import "@/shared/channels"
import type {Channels} from "@/shared/channels"
import type {PlaceDetails, PlaceSuggestion, SavedPlace} from "@/shared/types"
import {useNavStore} from "@/ui/store/navStore"
import {registerBackInterceptor, suppressNextRouterPopOnce, clearSuppressNextRouterPop} from "@/ui/router"
import {reverseGeocode} from "@/ui/lib/reverseGeocode"
import {LocationInput} from "./components/LocationInput/LocationInput"
import {SuggestionsList} from "./components/SuggestionsList/SuggestionsList"
import { safeHeadingAddPlaces } from "@/ui/components/SafeHeading/SafeHeading"
import {BackChevronIcon, HomeIconOutline, WorkIconOutline} from "@/ui/components/icons"

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
  const coords = useNavStore((s) => s.coords)
  const autocomplete = useRpc<Channels, "places:autocomplete">("places:autocomplete")
  const details = useRpc<Channels, "places:details">("places:details")

  const presetName = presetType === "home" ? "Home" : presetType === "work" ? "Work" : ""
  const [customName, setCustomName] = useState(presetName)
  const [query, setQuery] = useState("")
  const [selectedPlace, setSelectedPlace] = useState<PlaceDetails | null>(null)
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  // Saved Home / Work entries — populated once on mount. The Name input's
  // dropdown surfaces these so the user can re-pick a slot to *edit* it:
  // selecting "Home" loads the saved Home's address into the location
  // search above, then Save overwrites the existing Home (the storage
  // layer dedupes by `type`). Only shown when `presetType` is unset —
  // the slot-specific entry points (Set Home / Set Work from the
  // IdleDrawer) already know which slot they're targeting, so the
  // dropdown would be redundant noise there.
  const [savedHome, setSavedHome] = useState<SavedPlace | null>(null)
  const [savedWork, setSavedWork] = useState<SavedPlace | null>(null)
  const [nameFocused, setNameFocused] = useState(false)
  // Slot the current save is editing — when the user picks Home/Work
  // from the dropdown, we tag the save with that type so the storage
  // layer replaces the existing slot entry instead of creating a
  // duplicate. Cleared when the user types a different name (they're
  // no longer editing that slot).
  const [editingType, setEditingType] = useState<"home" | "work" | null>(presetType ?? null)

  // ── Two-step back: dismiss search first, then close the page ────
  // While the input is focused OR the suggestions overlay is actually
  // rendered (results in flight), OS back press should blur + collapse
  // the overlay; only a second back (when search isn't active)
  // propagates to the router and pops this page. We push a history
  // entry while search is active and intercept its popstate to close
  // the search instead of letting the router pop the route. Mirrors
  // LocationSearch on NavigationPage.
  //
  // The `suggestions.length > 0` check matches the SuggestionsList
  // render condition (`open && suggestions.length > 0`) — without it,
  // a stray blur (e.g. tap on the page background) would silently
  // drop the history entry 150ms before the user could press back, so
  // back would pop the page even though suggestions were still showing.
  const searchActive = focused || (searchOpen && suggestions.length > 0)
  const searchEntryPushedRef = useRef(false)
  console.log("[AddPlace] render", {
    focused,
    searchOpen,
    suggestionsLen: suggestions.length,
    queryLen: query.length,
    searchActive,
    entryPushed: searchEntryPushedRef.current,
  })
  function closeSearch() {
    console.log("[AddPlace] closeSearch() called", {
      focused,
      searchOpen,
      suggestionsLen: suggestions.length,
    })
    inputRef.current?.blur()
    setFocused(false)
    setSearchOpen(false)
    setSuggestions([])
    popOurEntry()
  }
  // Track the latest state values inside the interceptor without
  // re-registering it on every keystroke / focus change.
  const queryRef = useRef(query)
  queryRef.current = query
  const focusedRef = useRef(focused)
  focusedRef.current = focused
  const searchOpenRef = useRef(searchOpen)
  searchOpenRef.current = searchOpen

  // Push a history entry when search becomes active; drain it when
  // search collapses. The falling edge matters on Android: pressing the
  // system back while the keyboard is open is consumed by the IME (no
  // popstate fires) and only blurs the input. That blur collapses search
  // here without popping our pushed entry — leaving an orphaned
  // `searchDrawer` entry in history. The next back then lands on that
  // stale entry instead of popping the page, so the user gets stranded
  // (extra taps, or the interceptor re-clearing an already-cleared
  // query). Reconciling on the falling edge keeps history depth matched
  // to the visible state, so one back from a collapsed AddPlace pops the
  // page back to navigation.
  //
  // Transient-blur safety: `searchActive` only goes false once `focused`
  // is cleared, which happens inside onBlur's 150ms timeout. That delay
  // already absorbs the momentary WebView blur/refocus during a state
  // update, so draining here won't double-pop.
  useEffect(() => {
    console.log("[AddPlace] searchActive effect", {
      searchActive,
      entryPushed: searchEntryPushedRef.current,
    })
    if (searchActive && !searchEntryPushedRef.current) {
      try {
        history.pushState({searchDrawer: true}, "")
        searchEntryPushedRef.current = true
        console.log("[AddPlace] pushState(searchDrawer) — entry pushed")
      } catch (err) {
        console.warn("[AddPlace] pushState failed:", err)
      }
    } else if (!searchActive && searchEntryPushedRef.current) {
      console.log("[AddPlace] searchActive false — draining orphaned entry")
      popOurEntry()
    }
  }, [searchActive])

  // Explicit cleanup helper for paths that genuinely close search —
  // suggestion pick, blur-driven collapse, etc. Drains our pushed
  // history entry. Used by `pick(...)`, `closeSearch()`, and the
  // searchActive falling-edge effect.
  //
  // We MUST suppress the router pop before calling history.back():
  // the back fires popstate, the router runs our interceptor, and by
  // then `searchEntryPushedRef` is already false — so the interceptor
  // would hit its "no entry, let router pop" branch and pop the *route*,
  // exiting AddPlace. suppressNextRouterPopOnce() tells the router to
  // skip exactly the next stack mutation, so this back only drains our
  // own entry. (Mirrors LocationSearch's programmatic-close path.)
  function popOurEntry() {
    if (!searchEntryPushedRef.current) return
    searchEntryPushedRef.current = false
    console.log("[AddPlace] popOurEntry — suppress + history.back()")
    suppressNextRouterPopOnce()
    try {
      history.back()
    } catch (err) {
      console.warn("[AddPlace] history.back() failed:", err)
      // history.back() never fired popstate, so the suppress flag we set
      // would otherwise leak and swallow the user's next real back.
      // Clear it so the next genuine back press pops the route normally.
      clearSuppressNextRouterPop()
    }
  }

  // Register with the router's interceptor registry instead of adding
  // our own window popstate listener. This avoids the popstate ordering
  // race: events dispatched on window don't honor capture/bubble phase
  // when both listeners are also on window, so listeners fire in
  // registration order — and the router (mounted first) always won,
  // popping the route before we could set the suppress flag.
  useEffect(() => {
    console.log("[AddPlace] back interceptor registered")
    const unregister = registerBackInterceptor(() => {
      console.log("[AddPlace] interceptor called", {
        entryPushed: searchEntryPushedRef.current,
        currentQuery: queryRef.current,
        focused: focusedRef.current,
        searchOpen: searchOpenRef.current,
      })
      // No entry of ours on the stack → this back belongs to the router;
      // let it pop the page back to navigation.
      if (!searchEntryPushedRef.current) {
        console.log("[AddPlace] interceptor — no entry pushed, letting router pop")
        return false
      }
      // Our searchDrawer entry is the one being consumed. The back press
      // means "dismiss search" — collapse the input + suggestions and
      // consume the press so the page stays mounted. A *second* back then
      // finds no entry pushed and pops the page (above). We do NOT clear
      // the query and re-push here: that turned one logical "close
      // search" into two back presses, and on Android the soft keyboard
      // is dismissed by the IME on the first back anyway (which blurs the
      // input and drains this entry via the searchActive falling-edge
      // effect — so this popstate path is the keyboard-already-down case).
      //
      // closeSearch() calls popOurEntry(), but our entry is already being
      // consumed by *this* popstate — so flip the ref to false first to
      // make popOurEntry() a no-op and avoid a spurious second back.
      searchEntryPushedRef.current = false
      console.log("[AddPlace] interceptor — dismissing search, consuming back")
      closeSearch()
      return true
    })
    return () => {
      console.log("[AddPlace] back interceptor unregistered")
      unregister()
    }
  }, [])

  // Hydrate the saved Home / Work slots once on mount so the Name input
  // can offer them as edit shortcuts. Skipped when `presetType` is set —
  // the slot is already chosen, dropdown wouldn't render anyway.
  useEffect(() => {
    if (presetType) return
    mentra
      .request("storage:list-saved", undefined as never)
      .then((all: SavedPlace[]) => {
        setSavedHome(all.find((p) => p.type === "home") ?? null)
        setSavedWork(all.find((p) => p.type === "work") ?? null)
      })
      .catch(() => {})
  }, [presetType])

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
    const t = setTimeout(() => {
      autocomplete({query: trimmed, near: coords ? {lat: coords.lat, lng: coords.lng} : undefined})
        .then((results) => {
          setSuggestions(results)
          setSearchOpen(true)
          setLoading(false)
        })
        .catch((err) => {
          if ((err as Error)?.name === "AbortError") return
          setSuggestions([])
          setLoading(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query, selectedPlace, focused, autocomplete, coords])

  async function pick(s: PlaceSuggestion) {
    setSearchOpen(false)
    setLoading(true)
    inputRef.current?.blur()
    popOurEntry()
    try {
      const place = await details({placeId: s.placeId})
      setSelectedPlace(place)
      setQuery(place.name || place.address)
    } finally {
      setLoading(false)
    }
  }

  // Dropdown pick: load the saved slot's address into the location
  // search above and tag the save with that slot's type so Save
  // overwrites the existing slot entry (storage layer dedupes by type).
  function pickSlot(slot: "home" | "work") {
    const saved = slot === "home" ? savedHome : savedWork
    if (!saved) return
    const label = slot === "home" ? "Home" : "Work"
    setSelectedPlace(saved)
    setQuery(saved.name || saved.address)
    setCustomName(label)
    setEditingType(slot)
    // Close the dropdown + drop focus from the Name input so the
    // keyboard doesn't linger over the now-filled location.
    setNameFocused(false)
    nameInputRef.current?.blur()
    // Clear any in-flight location-search state from before the pick.
    setSearchOpen(false)
    setSuggestions([])
  }

  function useCurrentLocation() {
    if (!coords) return
    const lat = coords.lat
    const lng = coords.lng
    const placeId = `current:${lat},${lng}`
    // Optimistic: select immediately with a coords placeholder so the
    // field fills without waiting on the network. Then reverse-geocode
    // and upgrade to the real street address.
    const initial: PlaceDetails = {
      placeId,
      name: "Current location",
      address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
      lat,
      lng,
      isGeocoding: true,
    }
    setSelectedPlace(initial)
    setQuery(initial.name)
    void reverseGeocode(lat, lng).then((formatted) => {
      // Bail if the user picked something else in the meantime.
      setSelectedPlace((prev) => {
        if (!prev || prev.placeId !== placeId) return prev
        if (!formatted) return {...prev, isGeocoding: false}
        const shortName = formatted.split(",")[0]?.trim() || formatted
        return {...prev, name: shortName, address: formatted, isGeocoding: false}
      })
      if (formatted) {
        const shortName = formatted.split(",")[0]?.trim() || formatted
        setQuery((q) => (q === "Current location" ? shortName : q))
      }
    })
  }

  return (
    <motion.div
      // Slide-in animation on enter. iOS WKWebView doesn't animate a
      // forward history.pushState — only the back-swipe — so we provide
      // the entry visual ourselves. The reverse direction (exit) is
      // handled entirely by iOS's native back-swipe gesture, which
      // animates the snapshot it captured at the moment of pushState
      // (the home map). We deliberately omit `exit` here AND don't wrap
      // the page in AnimatePresence — adding either causes the page to
      // stay mounted long enough for a second motion-driven slide to
      // play on top of the iOS one, producing the "two AddPlace cards
      // sliding" effect.
      initial={{x: "100%"}}
      animate={{x: 0}}
      transition={{type: "spring", stiffness: 300, damping: 34, mass: 0.85}}
      className="[font-synthesis:none] fixed inset-0 z-50 flex flex-col bg-white dark:bg-zinc-950 antialiased overflow-hidden">

      {/* Header */}
      <div className={`flex items-center gap-3 px-4 ${safeHeadingAddPlaces} pb-4`}>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center size-9 rounded-full bg-[#0000000A] dark:bg-[#FFFFFF14] shrink-0">
          <BackChevronIcon />
        </button>
        <div className="text-[32px] tracking-tight leading-none font-sans font-bold text-black dark:text-zinc-50">Add a place</div>
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
            <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] dark:text-zinc-400 text-[11px]/3.5">Name (optional)</div>
          </div>
          <div className="flex items-center rounded-[18px] py-3.5 px-4 [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000014_0px_4px_16px] bg-[#FFFFFFA6] dark:bg-[#161619CC] border border-solid border-[#FFFFFF99] dark:border-[#FFFFFF1A]">
            <input
              ref={nameInputRef}
              className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] dark:text-zinc-50 text-base/5 placeholder-[#0000008C] dark:placeholder-[#FFFFFF8C] focus:outline-none border-none"
              value={customName}
              onChange={(e) => {
                // Auto-capitalize the first letter so "work" → "Work"
                // and "Home" stays "Home". Saved label and slot
                // detection both read this value, so capitalizing
                // here keeps storage + UI consistent.
                const raw = e.target.value
                const next = raw.length > 0 ? raw[0].toUpperCase() + raw.slice(1) : raw
                setCustomName(next)
              }}
              onFocus={() => setNameFocused(true)}
              // 150ms blur delay mirrors LocationInput: lets a tap on a
              // dropdown row register as a click before the dropdown
              // unmounts on blur.
              onBlur={() => setTimeout(() => setNameFocused(false), 150)}
              placeholder={presetName || "Place name"}
              autoComplete="off"
            />
          </div>
          {/* Edit-slot dropdown. Only shown on the generic Add-Place
              flow (no presetType) when the Name input is focused AND
              at least one slot is saved — picking a slot loads its
              address into the location search above so the user can
              edit it. */}
          {!presetType && nameFocused && (savedHome || savedWork) && (
            <div className="mt-2 rounded-[18px] bg-white dark:bg-zinc-900 [box-shadow:#00000014_0px_6px_18px,#0000000A_0px_-3px_6px_-3px] overflow-hidden">
              {savedHome && (
                <button
                  type="button"
                  // onMouseDown fires before the input's blur, so we get
                  // the click even though blur queues the dropdown to
                  // close. Same trick the SuggestionsList uses.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSlot("home")}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-[#0000000A] dark:active:bg-[#FFFFFF0F]">
                  <div className="size-7 rounded-full bg-[#0000000A] dark:bg-[#FFFFFF14] flex items-center justify-center shrink-0">
                    <HomeIconOutline />
                  </div>
                  <div className="grow min-w-0">
                    <div className="font-sans font-semibold text-[#000000E6] dark:text-zinc-50 text-[15px]/4">Home</div>
                    <div className="font-sans text-[#0000008C] dark:text-zinc-400 text-[13px]/4 truncate mt-0.5">{savedHome.address || savedHome.name}</div>
                  </div>
                </button>
              )}
              {savedHome && savedWork && <div className="h-px bg-[#00000014] dark:bg-[#FFFFFF1F] mx-4" />}
              {savedWork && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSlot("work")}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left active:bg-[#0000000A] dark:active:bg-[#FFFFFF0F]">
                  <div className="size-7 rounded-full bg-[#0000000A] dark:bg-[#FFFFFF14] flex items-center justify-center shrink-0">
                    <WorkIconOutline />
                  </div>
                  <div className="grow min-w-0">
                    <div className="font-sans font-semibold text-[#000000E6] dark:text-zinc-50 text-[15px]/4">Work</div>
                    <div className="font-sans text-[#0000008C] dark:text-zinc-400 text-[13px]/4 truncate mt-0.5">{savedWork.address || savedWork.name}</div>
                  </div>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <SuggestionsList open={searchOpen} suggestions={suggestions} onPick={pick} />

      {/* Save button */}
      <div className="absolute bottom-8 inset-x-4">
        <button
          type="button"
          onClick={() => {
            if (!selectedPlace) return
            const trimmedName = customName.trim()
            // Slot is determined by the final label the user chose, not
            // by which preset opened the page. Lets the user start in
            // the "Home" flow and end up saving as "Work" (or vice
            // versa) by renaming the label. Falls back to the explicit
            // editingType (when they picked a slot from the dropdown)
            // so the dedup logic keeps overwriting the right entry.
            const lower = trimmedName.toLowerCase()
            const resolvedType: "home" | "work" | undefined =
              lower === "home" ? "home" : lower === "work" ? "work" : (editingType ?? undefined)
            onSave(selectedPlace, trimmedName, resolvedType)
          }}
          disabled={!selectedPlace}
          className="h-14 w-full flex items-center justify-center rounded-[28px] px-4 [box-shadow:#00000033_0px_6px_22px] bg-[#1A1A1A] dark:bg-zinc-100 disabled:opacity-40 transition-opacity">
          <div className="tracking-[-0.005em] font-sans font-semibold text-white dark:text-zinc-900 text-base/5">Save place</div>
        </button>
      </div>
    </motion.div>
  )
}
