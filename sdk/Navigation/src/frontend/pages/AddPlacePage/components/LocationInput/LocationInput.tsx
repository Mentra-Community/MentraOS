import type {RefObject} from "react"
import {Loader2} from "lucide-react"

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
        <div className="tracking-[0.16em] uppercase font-sans font-semibold text-[#0000008C] text-[11px]/3.5">Location</div>
      </div>
      <div
        className="flex items-center rounded-[18px] py-3.5 px-4 gap-3 [backdrop-filter:blur(30px)_saturate(180%)] [box-shadow:#FFFFFF80_0px_1px_0px_inset,#00000014_0px_4px_16px] bg-[#FFFFFFA6] border border-solid border-[#FFFFFF99]"
        onClick={() => inputRef.current?.focus()}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
          <path d="M12 2C7.58 2 4 5.58 4 10c0 6 8 12 8 12s8-6 8-12C20 5.58 16.42 2 12 2z" stroke="#1A1A1A" strokeWidth="2" fill="none" />
          <circle cx="12" cy="10" r="3" stroke="#1A1A1A" strokeWidth="2" fill="none" />
        </svg>
        <input
          ref={inputRef}
          className="grow shrink basis-0 bg-transparent font-sans text-[#000000E6] text-base/5 placeholder-[#0000008C] focus:outline-none border-none"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlur}
          placeholder="Search address or place"
          autoComplete="off"
        />
        {loading ? <Loader2 size={16} className="animate-spin text-neutral-400 shrink-0" /> : null}
      </div>

      <button
        type="button"
        onClick={onCurrentLocation}
        className="flex items-center py-3 px-1 gap-2.5 w-full text-left">
        <div className="w-5.5 h-5.5 flex items-center justify-center rounded-[11px] shrink-0 bg-[#0000000F]">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{flexShrink: 0}}>
            <circle cx="12" cy="12" r="3" fill="#1A1A1A" />
            <circle cx="12" cy="12" r="7" stroke="#1A1A1A" strokeWidth="1.6" />
            <path d="M12 1V4M12 20V23M1 12H4M20 12H23" stroke="#1A1A1A" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
        <div className="tracking-[-0.005em] font-sans font-medium text-[#1A1A1A] text-sm/4.5">Use my current location</div>
      </button>
    </div>
  )
}
