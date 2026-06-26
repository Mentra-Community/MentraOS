import {useState} from "react"
import {AudioWaveform, Pause, Play, Share2, Trash2} from "lucide-react"

import type {RecordingItem} from "../../shared/types"
import {fmtBytes, fmtDuration, fmtWhen} from "../lib/format"

interface Props {
  item: RecordingItem
  playing: boolean
  onPlay: () => void
  onStopPlay: () => void
  onExport: () => void
  onDelete: () => void
}

export function RecordingRow({item, playing, onPlay, onStopPlay, onExport, onDelete}: Props) {
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const khz = item.sampleRate ? `${Math.round(item.sampleRate / 1000)} kHz` : ""
  const meta = [fmtDuration(item.durationMs), fmtBytes(item.bytes), khz].filter(Boolean).join("  ·  ")

  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{background: "var(--surface)", border: "1px solid var(--border)"}}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-3.5 py-3 text-left active:opacity-80">
        <span
          className="grid place-items-center rounded-xl shrink-0"
          style={{
            width: 40,
            height: 40,
            background: playing ? "var(--accent)" : "color-mix(in srgb, var(--accent) 14%, transparent)",
          }}>
          <AudioWaveform
            className="w-5 h-5"
            style={{color: playing ? "var(--accent-fg)" : "var(--accent)"}}
            strokeWidth={2.2}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[15px] font-semibold truncate" style={{color: "var(--text)"}}>
              {fmtWhen(item.createdAt)}
            </span>
            {item.truncated ? (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{background: "var(--rec)", color: "#fff"}}>
                capped
              </span>
            ) : null}
          </div>
          <div className="text-[12px] tabular-nums truncate" style={{color: "var(--text-muted)"}}>
            {meta}
          </div>
        </div>
        <span
          onClick={(e) => {
            e.stopPropagation()
            playing ? onStopPlay() : onPlay()
          }}
          role="button"
          aria-label={playing ? "Stop playback" : "Play"}
          className="grid place-items-center rounded-full shrink-0 active:scale-95 transition-transform"
          style={{width: 38, height: 38, background: "linear-gradient(135deg, var(--accent), var(--accent-2))"}}>
          {playing ? (
            <Pause className="w-4 h-4 text-white" fill="currentColor" strokeWidth={0} />
          ) : (
            <Play className="w-4 h-4 text-white ml-0.5" fill="currentColor" strokeWidth={0} />
          )}
        </span>
      </button>

      {open ? (
        <div className="flex items-stretch gap-2 px-3.5 pb-3 pt-1">
          <RowAction icon={<Share2 className="w-4 h-4" />} label="Export" onClick={onExport} />
          {confirmDelete ? (
            <RowAction icon={<Trash2 className="w-4 h-4" />} label="Confirm delete" danger onClick={onDelete} />
          ) : (
            <RowAction
              icon={<Trash2 className="w-4 h-4" />}
              label="Delete"
              danger
              onClick={() => setConfirmDelete(true)}
            />
          )}
        </div>
      ) : null}
    </div>
  )
}

function RowAction({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[13px] font-semibold active:opacity-80"
      style={{
        background: "var(--surface-2)",
        border: "1px solid var(--border)",
        color: danger ? "var(--rec)" : "var(--text)",
      }}>
      {icon}
      {label}
    </button>
  )
}
