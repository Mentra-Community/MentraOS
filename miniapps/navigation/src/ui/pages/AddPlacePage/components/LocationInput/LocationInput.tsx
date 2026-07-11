import type {RefObject} from "react"
import {Loader2} from "lucide-react"
import {CrosshairIcon, PinIconOutlineWithDot} from "@/ui/components/icons"

type Props = {
  inputRef: RefObject<HTMLInputElement | null>
  query: string
  loading: boolean
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
  onCurrentLocation: () => void
}

export function LocationInput({inputRef, query, loading, onChange, onFocus, onBlur, onCurrentLocation}: Props) {
  return (
    <div className="mb-5">
      <div className="pb-2.5 px-1">
        <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] dark:text-zinc-400 text-[11px]/3.5">Location</div>
      </div>
      <div
        className="flex items-center rounded-[18px] py-3.5 px-4 gap-3 [box-shadow:#00000014_0px_6px_10px_-4px,#0000000A_0px_-3px_6px_-3px] bg-white dark:bg-zinc-900"
        onClick={() => inputRef.current?.focus()}>
        <PinIconOutlineWithDot />
        <input
          ref={inputRef}
          className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] dark:text-zinc-50 text-base/5 placeholder-[#0000008C] dark:placeholder-[#FFFFFF8C] focus:outline-none border-none"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Search address or place"
          autoComplete="off"
        />
        {loading ? <Loader2 size={16} className="animate-spin text-neutral-400 dark:text-zinc-500 shrink-0" /> : null}
      </div>

      <button
        type="button"
        onClick={onCurrentLocation}
        className="flex items-center py-3 px-1 gap-2.5 w-full text-left">
        <div className="w-5.5 h-5.5 flex items-center justify-center rounded-[11px] shrink-0 bg-[#0000000F] dark:bg-[#FFFFFF1A]">
          <CrosshairIcon />
        </div>
        <div className="tracking-[-0.005em] font-sans font-medium text-[#1A1A1A] dark:text-zinc-50 text-sm/4.5">Use my current location</div>
      </button>
    </div>
  )
}
