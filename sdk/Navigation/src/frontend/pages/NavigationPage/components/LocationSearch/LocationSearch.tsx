import {useEffect, useMemo, useRef, useState} from "react"
import {AnimatePresence, motion} from "motion/react"
import {Loader2, Search} from "lucide-react"

import {useUser} from "@/backend/hooks/useUser"
import {cardinal} from "@/backend/lib/geometry/geometry"
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
    <div className="relative bg-[#FAF7F0] mt-4 mx-[3px] rounded-2xl min-h-15 flex">
      <div className="flex flex-row p-[5px] flex-1">
        <div className="relative flex-1 mr-21  flex">
          <Search
            size={18}
            strokeWidth={2.25}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-700 pointer-events-none z-10"
          />
          <input
            ref={inputRef}
            className="block w-full h-full pl-10 pr-9 py-2 rounded-[15px] bg-[#f9ecd5] border border-none text-[16px] disabled:bg-neutral-100 focus:outline-none focus:ring-0"
            style={{
              WebkitMaskImage:
                "linear-gradient(to right, black 0%, black 80%, transparent 100%)",
              maskImage: "linear-gradient(to right, black 0%, black 80%, transparent 100%)",
            }}
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={() => suggestions.length > 0 && setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="Search Address"
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

        <div className="absolute right-2 bottom-1 px-2  rounded-full text-neutral-800  font-mono text-[11px]">
          {heading != null ? `${Math.round(heading)}° ${cardinal(heading)}` : "—"}
        </div>

        <AnimatePresence>
          {loading || (open && suggestions.length > 0) ? (
            <motion.div
              key="suggestions"
              initial={{opacity: 0, y: -8}}
              animate={{opacity: 1, y: 0}}
              exit={{opacity: 0, y: -8}}
              transition={{duration: 0.18, ease: "easeOut"}}
              className="absolute z-10 left-0 right-0 mt-15 bg-[#FAF7F0] border border-neutral-200 rounded-lg shadow-lg max-h-72 overflow-auto">
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
                        className="w-full text-left px-3 py-2 hover:bg-neutral-100 border-b border-neutral-100 last:border-b-0">
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
    </div>
  )
}
