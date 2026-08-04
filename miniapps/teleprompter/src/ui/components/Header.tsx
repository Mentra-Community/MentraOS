import {ScrollText} from "lucide-react"

import {HEADER_FROM, HEADER_TO} from "../lib/theme"

interface HeaderProps {
  connected: boolean
}

export function Header({connected}: HeaderProps) {
  return (
    <div
      className="w-full h-[46px] px-6 flex justify-center items-center relative"
      style={{backgroundImage: `linear-gradient(90deg, ${HEADER_FROM}, ${HEADER_TO})`}}>
      <div className="flex justify-center items-center gap-2">
        <ScrollText className="w-5 h-5 text-white" aria-hidden="true" strokeWidth={2.2} />
        <div className="text-center text-lg font-semibold leading-6 text-white">Teleprompter</div>
      </div>
      <div
        className={`absolute right-5 w-2.5 h-2.5 rounded-full transition-colors ${
          connected ? "bg-white" : "bg-white/40"
        }`}
        title={connected ? "Connected" : "Connecting…"}
      />
    </div>
  )
}
