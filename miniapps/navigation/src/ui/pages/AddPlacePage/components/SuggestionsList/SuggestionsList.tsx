import {AnimatePresence, motion} from "motion/react"
import type {PlaceSuggestion} from "@/shared/types"
import {PinIconOutline} from "@/ui/components/icons"
import {safeSuggestionsTop} from "@/ui/components/SafeHeading/SafeHeading"

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
          className={`absolute inset-x-0 ${safeSuggestionsTop} bottom-0 z-10 bg-white dark:bg-zinc-950 overflow-auto mx-4 pt-4`}>
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
                  className="w-full text-left flex items-center gap-3 px-4 py-3 hover:bg-[#0000000A] dark:hover:bg-[#FFFFFF0F] border-b border-[#0000000A] dark:border-[#FFFFFF14] last:border-b-0">
                  <PinIconOutline />
                  <div className="grow min-w-0">
                    <div className="text-[15px] font-medium text-[#000000E6] dark:text-zinc-50 truncate">{s.mainText}</div>
                    {s.secondaryText ? <div className="text-xs text-[#0000008C] dark:text-zinc-400 truncate">{s.secondaryText}</div> : null}
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
