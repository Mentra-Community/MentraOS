import {MonitorOff} from "lucide-react"

import type {PlaybackStatus} from "../../shared/types"

interface GlassesPreviewProps {
  status: PlaybackStatus | null
}

/**
 * A faithful little mirror of what's on the lenses: green monochrome text on a
 * dark panel, sized to the glasses' wide aspect. Lines come straight from the
 * background's render window so the preview can't drift from the device.
 */
export function GlassesPreview({status}: GlassesPreviewProps) {
  const lines = status?.visibleLines ?? []
  const hasDisplay = status?.hasDisplay ?? false

  return (
    <div className="relative">
      <div
        className="w-full rounded-2xl bg-[#05130b] border border-emerald-900/60 shadow-inner px-4 py-3 overflow-hidden"
        style={{minHeight: 96}}>
        <div className="flex flex-col justify-center h-full gap-[3px]">
          {lines.length === 0 || lines.every((l) => l.trim() === "") ? (
            <p className="text-emerald-300/40 text-sm font-mono italic text-center py-4">Your script appears here</p>
          ) : (
            lines.map((line, i) => (
              <p
                key={i}
                className="text-[#3ef08a] font-mono text-[13px] leading-snug whitespace-pre-wrap break-words"
                style={{textShadow: "0 0 6px rgba(62,240,138,0.35)"}}>
                {line || " "}
              </p>
            ))
          )}
        </div>
      </div>

      {!hasDisplay && (
        <div className="absolute inset-0 rounded-2xl bg-black/55 backdrop-blur-[1px] flex flex-col items-center justify-center gap-1 text-center px-4">
          <MonitorOff className="w-5 h-5 text-white/80" aria-hidden="true" />
          <span className="text-white text-xs font-medium">Connect display glasses to read</span>
        </div>
      )}
    </div>
  )
}
