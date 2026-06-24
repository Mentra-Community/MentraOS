import {Mic, Square} from "lucide-react"

import type {RecorderStatus} from "../../shared/types"
import {fmtDuration} from "../lib/format"
import {LevelMeter} from "./LevelMeter"

interface Props {
  status: RecorderStatus | null
  hasMic: boolean
  onStart: () => void
  onStop: () => void
}

/** The primary record / stop control, with a live timer + level meter. */
export function RecordButton({status, hasMic, onStart, onStop}: Props) {
  const recording = status !== null

  return (
    <div className="flex flex-col items-center gap-4 py-6 select-none">
      <div className="h-6 flex items-center">
        {recording ? (
          <div className="flex items-center gap-2 text-[15px] font-semibold" style={{color: "var(--rec)"}}>
            <span className="rec-pulse inline-block w-2.5 h-2.5 rounded-full" style={{background: "var(--rec)"}} />
            <span className="tabular-nums">{fmtDuration(status!.ms)}</span>
          </div>
        ) : (
          <span className="text-[13px]" style={{color: "var(--text-muted)"}}>
            {hasMic ? "Tap to record from your glasses" : "No microphone on the connected glasses"}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={recording ? onStop : onStart}
        disabled={!recording && !hasMic}
        aria-label={recording ? "Stop recording" : "Start recording"}
        className="relative grid place-items-center rounded-full transition-transform active:scale-95 disabled:opacity-40"
        style={{
          width: 92,
          height: 92,
          background: recording ? "var(--surface)" : "linear-gradient(135deg, var(--accent), var(--accent-2))",
          border: recording ? `3px solid var(--rec)` : "none",
          boxShadow: recording ? "none" : "0 8px 24px rgba(244,81,30,0.35)",
        }}>
        {recording ? (
          <Square className="w-7 h-7" style={{color: "var(--rec)"}} fill="currentColor" strokeWidth={0} />
        ) : (
          <Mic className="w-9 h-9 text-white" strokeWidth={2.2} />
        )}
      </button>

      <div className="h-8 w-56">{recording ? <LevelMeter level={status!.level} /> : null}</div>
    </div>
  )
}
