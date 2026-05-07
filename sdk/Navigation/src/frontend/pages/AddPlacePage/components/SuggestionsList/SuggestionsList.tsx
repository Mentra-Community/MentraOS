import {AnimatePresence, motion} from "motion/react"
import type {PlaceSuggestion} from "@/backend/lib/places/places"

type Props = {
  open: boolean
  suggestions: PlaceSuggestion[]
  onPick: (s: PlaceSuggestion) => void
}

export function SuggestionsList({open, suggestions, onPick}: Props) {
  return (
    <AnimatePresence>
      {open && suggestions.length > 0 ? (
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
                  onClick={() => onPick(s)}
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
  )
}
