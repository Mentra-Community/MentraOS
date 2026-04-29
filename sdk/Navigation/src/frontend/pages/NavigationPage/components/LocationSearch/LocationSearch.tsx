import {useEffect, useMemo, useRef, useState} from "react"

import {PlacesSession} from "@/backend/lib/places/places"
import type {PlaceDetails, PlaceSuggestion} from "@/backend/lib/places/places"

type Props = {
  selected: PlaceDetails | null
  onSelect: (place: PlaceDetails) => void
  onClear: () => void
  disabled?: boolean
}

const DEBOUNCE_MS = 200

export function LocationSearch({selected, onSelect, onClear, disabled}: Props) {
  const session = useMemo(() => new PlacesSession(), [])
  const [query, setQuery] = useState("")
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

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
    <div className="relative mb-2">
      <label className="block text-[12px] text-neutral-600 mb-1">Destination</label>
      <div className="relative">
        <input
          className="block w-full px-3 py-2 pr-9 rounded-lg border border-neutral-300 text-[14px] disabled:bg-neutral-100"
          value={query}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Search for a place or address"
          disabled={disabled}
          autoComplete="off"
        />
        {query ? (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={handleClear}
            disabled={disabled}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-700 text-lg leading-none"
            aria-label="Clear">
            ×
          </button>
        ) : null}
      </div>

      {open && suggestions.length > 0 ? (
        <ul className="absolute z-10 left-0 right-0 mt-1 bg-white border border-neutral-200 rounded-lg shadow-lg max-h-72 overflow-auto">
          {suggestions.map((s) => (
            <li key={s.placeId}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(s)}
                className="w-full text-left px-3 py-2 hover:bg-neutral-100 border-b border-neutral-100 last:border-b-0">
                <div className="text-[14px] text-neutral-900">{s.mainText}</div>
                {s.secondaryText ? (
                  <div className="text-[12px] text-neutral-500">{s.secondaryText}</div>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {loading ? (
        <div className="text-[12px] text-neutral-500 mt-1">searching…</div>
      ) : error ? (
        <div className="text-[12px] text-red-600 mt-1">{error}</div>
      ) : selected ? (
        <div className="text-[12px] text-neutral-500 mt-1 font-mono">
          {selected.lat.toFixed(6)}, {selected.lng.toFixed(6)}
        </div>
      ) : null}
    </div>
  )
}
