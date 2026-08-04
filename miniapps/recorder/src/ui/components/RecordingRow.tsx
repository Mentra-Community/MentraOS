import {useState} from "react"
import {ChevronDown, FileText, Pause, Play, Share2, Trash2} from "lucide-react"

import type {RecordingItem} from "../../shared/types"
import {fmtDuration, fmtRelative} from "../lib/format"

interface Props {
  item: RecordingItem
  playing: boolean
  posMs: number
  unavailable: boolean
  onPlay: () => void
  onStopPlay: () => void
  onExport: () => void
  onExportTranscript: () => void
  onDelete: () => void
}

/** One recording: green play disc, transcript-derived title, a live scrubber
 * that tracks playback, and an expandable panel with the transcript + share
 * actions. */
export function RecordingRow({
  item,
  playing,
  posMs,
  unavailable,
  onPlay,
  onStopPlay,
  onExport,
  onExportTranscript,
  onDelete,
}: Props) {
  const [open, setOpen] = useState(false)
  const hasTranscript = !!item.transcript?.trim()
  // Live progress while this row is the one playing back.
  const progress = playing && item.durationMs > 0 ? Math.min(1, posMs / item.durationMs) : 0
  const elapsed = playing ? Math.min(posMs, item.durationMs) : 0

  return (
    <div className="rounded-2xl overflow-hidden elev" style={{background: "var(--surface)", border: "1px solid var(--border)"}}>
      <div className="flex items-start gap-3 p-3.5">
        <button
          type="button"
          aria-label={playing ? "Stop playback" : "Play"}
          onClick={playing ? onStopPlay : onPlay}
          className="grid place-items-center rounded-full shrink-0 press"
          style={{
            width: 46,
            height: 46,
            background: "var(--green-grad)",
            boxShadow: playing
              ? "0 0 0 4px color-mix(in srgb, var(--green) 22%, transparent), 0 4px 12px rgba(34,197,94,0.34)"
              : "0 4px 12px rgba(34,197,94,0.28)",
          }}>
          {playing ? (
            <Pause className="w-5 h-5 text-white" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="w-5 h-5 text-white ml-0.5" fill="currentColor" strokeWidth={0} />
          )}
        </button>

        <button type="button" onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-left active:opacity-80">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold truncate" style={{color: "var(--text)"}}>
              {item.title ?? item.name}
            </span>
            {item.truncated ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0" style={{background: "var(--rec)", color: "#fff"}}>
                capped
              </span>
            ) : null}
            <ChevronDown
              className="w-4 h-4 ml-auto shrink-0 transition-transform duration-300"
              style={{color: "var(--text-muted)", transform: open ? "rotate(180deg)" : "none"}}
            />
          </div>
          <div className="text-[12px] truncate mt-0.5" style={{color: "var(--text-muted)"}}>
            {fmtRelative(item.createdAt)}
          </div>
          <div className="mt-2.5">
            <div className="h-1 w-full rounded-full overflow-hidden" style={{background: "var(--border)"}}>
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(progress * 100, playing ? 2 : 0)}%`,
                  background: "var(--green-grad)",
                  transition: "width 0.18s linear",
                }}
              />
            </div>
            <div className="mt-1.5 flex justify-between text-[11px] tabular-nums" style={{color: "var(--text-muted)"}}>
              {unavailable ? (
                <span className="font-semibold not-italic" style={{color: "var(--rec)"}}>
                  Audio unavailable
                </span>
              ) : (
                <span style={{color: playing ? "var(--green)" : "var(--text-muted)"}}>{fmtDuration(elapsed)}</span>
              )}
              <span>{fmtDuration(item.durationMs)}</span>
            </div>
          </div>
        </button>

        <button
          type="button"
          aria-label="Delete recording"
          onClick={onDelete}
          className="grid place-items-center rounded-full shrink-0 active:opacity-70 -mr-1 press"
          style={{width: 32, height: 32, color: "var(--text-muted)"}}>
          <Trash2 className="w-[18px] h-[18px]" />
        </button>
      </div>

      {/* Smooth height-animated disclosure. */}
      <div className={`expander ${open ? "open" : ""}`}>
        <div className="expander-inner">
          <div className="px-3.5 pb-3.5 pt-0.5">
            <div className="h-px w-full mb-3" style={{background: "var(--border)"}} />
            {hasTranscript ? (
              <p className="text-[13px] leading-relaxed mb-3 max-h-40 overflow-y-auto scrollbar-hide" style={{color: "var(--text-muted)"}}>
                {item.transcript}
              </p>
            ) : (
              <p className="text-[12px] mb-3" style={{color: "var(--text-muted)"}}>
                No transcript for this recording.
              </p>
            )}
            <div className="flex gap-2">
              <RowAction icon={<Share2 className="w-4 h-4" />} label="Share audio" onClick={onExport} />
              {hasTranscript ? (
                <RowAction icon={<FileText className="w-4 h-4" />} label="Share transcript" onClick={onExportTranscript} />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function RowAction({icon, label, onClick}: {icon: React.ReactNode; label: string; onClick: () => void}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-semibold press active:opacity-80"
      style={{background: "var(--surface-2)", color: "var(--text)"}}>
      {icon}
      {label}
    </button>
  )
}
