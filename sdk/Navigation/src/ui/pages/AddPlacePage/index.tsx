import {useEffect, useRef, useState} from "react"
import {motion} from "motion/react"
import {useRpc} from "@mentra/miniapp/ui"

import "@/shared/channels"
import type {Channels} from "@/shared/channels"
import type {PlaceDetails, PlaceSuggestion} from "@/shared/types"
import {useNavStore} from "@/ui/store/navStore"
import {registerBackInterceptor} from "@/ui/router"
import {reverseGeocode} from "@/ui/lib/reverseGeocode"
import {LocationInput} from "./components/LocationInput/LocationInput"
import {SuggestionsList} from "./components/SuggestionsList/SuggestionsList"
import { safeHeadingAddPlaces } from "@/ui/components/SafeHeading/SafeHeading"

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

  // Rising edge only: push a history entry the first time searchActive
  // becomes true. We deliberately do NOT pop on the falling edge — any
  // transient false (e.g. input briefly loses focus during a state
  // update on Android WebView) would otherwise call history.back() and
  // bubble up to pop the page. Programmatic close paths (suggestion
  // pick, the back interceptor's empty-query branch) call
  // popOurEntry() explicitly when they actually mean to clean up.
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
    }
  }, [searchActive])

  // Explicit cleanup helper for paths that genuinely close search —
  // suggestion pick, etc. Drains our pushed history entry. Used by
  // `pick(...)` below via `closeSearch()`.
  function popOurEntry() {
    if (!searchEntryPushedRef.current) return
    searchEntryPushedRef.current = false
    console.log("[AddPlace] popOurEntry — history.back()")
    try {
      history.back()
    } catch (err) {
      console.warn("[AddPlace] history.back() failed:", err)
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
      if (!searchEntryPushedRef.current) {
        console.log("[AddPlace] interceptor — no entry pushed, letting router pop")
        return false
      }
      searchEntryPushedRef.current = false
      // Case 1: there's a query to clear. Clear it and stay in search.
      if (queryRef.current.trim().length > 0) {
        console.log("[AddPlace] interceptor — query non-empty, clearing query + re-pushing entry")
        setQuery("")
        try {
          history.pushState({searchDrawer: true}, "")
          searchEntryPushedRef.current = true
        } catch (err) {
          console.warn("[AddPlace] re-pushState failed:", err)
        }
        return true
      }
      // Case 2: search has something visible to dismiss (focused input
      // or open suggestions panel). Close it and consume the back.
      if (focusedRef.current || searchOpenRef.current) {
        console.log("[AddPlace] interceptor — empty query, dismissing focus/suggestions")
        closeSearch()
        return true
      }
      // Case 3: there's nothing meaningful to dismiss (the user
      // already blurred the input via keyboard-hide, and we still had
      // a stale history entry). Let the back propagate to the router
      // so the page exits — saves the user a redundant tap.
      console.log("[AddPlace] interceptor — nothing to dismiss, letting router pop")
      return false
    })
    return () => {
      console.log("[AddPlace] back interceptor unregistered")
      unregister()
    }
  }, [])

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
      className="[font-synthesis:none] fixed inset-0 z-50 flex flex-col bg-white antialiased overflow-hidden">

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
