import {useState} from "react"
import {AlignLeft, Loader2, MessageSquare, Mic, Pause, Play, Square, Trash2, Volume2} from "lucide-react"

import type {RecorderStatus} from "../../shared/types"
import {fmtDateTime, fmtTimer} from "../lib/format"
import {Waveform} from "./Waveform"

interface Props {
  status: RecorderStatus
  levels: number[]
  transcript: string
  transcriptLang: string
  paused: boolean
  stopping: boolean
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onCancel: () => void
}

type View = "audio" | "transcript"

/** "en-US" → "English (US)". */
function langLabel(code: string): string {
  if (!code) return ""
  try {
    const [base, region] = code.split("-")
    const name = new Intl.DisplayNames(undefined, {type: "language"}).of(base) ?? base
    return region ? `${name} (${region.toUpperCase()})` : name
  } catch {
    return code
  }
}

/** Full-screen capture view: waveform / live transcript, timer, pause + stop. */
export function RecordingScreen({
  status,
  levels,
  transcript,
  transcriptLang,
  paused,
  stopping,
  onPause,
  onResume,
  onStop,
  onCancel,
}: Props) {
  const [view, setView] = useState<View>("audio")
  // Capture start comes from the background (stable across pause + reopen), not
  // when this screen mounted.
  const startedAt = status.startedAt
  const speaking = !paused && !stopping && status.level > 0.06

  return (
    <div className="flex flex-col min-h-0 flex-1 px-4 pb-5">
      {/* Date + discard */}
      <div className="flex items-center justify-between py-2">
        <span className="text-[14px]" style={{color: "var(--text-muted)"}}>
          {fmtDateTime(startedAt)}
        </span>
        <button
          type="button"
          aria-label="Discard recording"
          onClick={onCancel}
          disabled={stopping}
          className="grid place-items-center rounded-full active:opacity-70 disabled:opacity-40"
          style={{width: 36, height: 36, color: "var(--text)"}}>
          <Trash2 className="w-5 h-5" />
        </button>
      </div>

      {/* Panel: waveform or transcript */}
      <div
        className="relative flex flex-col min-h-0 flex-1 rounded-3xl p-4"
        style={{background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "var(--shadow-card)"}}>
        {view === "audio" ? (
          <>
            <div className="flex items-center justify-center gap-1.5 pt-2 pb-4">
              <MessageSquare className="w-4 h-4" style={{color: speaking ? "var(--green)" : "var(--text-muted)"}} />
              <span
                className="text-[15px] font-semibold"
                style={{color: speaking ? "var(--green)" : "var(--text-muted)"}}>
                {stopping ? "Saving…" : paused ? "Paused" : speaking ? "Speech" : "Listening…"}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              <Waveform levels={levels} paused={paused || stopping} />
            </div>
          </>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide pt-1">
            {transcript ? (
              <>
                <p className="text-[15px] leading-relaxed" style={{color: "var(--text)"}}>
                  {transcript}
                </p>
                {transcriptLang ? (
                  <div className="flex items-center gap-1.5 mt-3 text-[13px]" style={{color: "var(--text-muted)"}}>
                    <span
                      className="inline-block rounded-full"
                      style={{width: 7, height: 7, background: "var(--green)"}}
                    />
                    {langLabel(transcriptLang)}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="h-full grid place-items-center text-center px-4">
                <p className="text-[14px]" style={{color: "var(--text-muted)"}}>
                  {stopping ? "Saving recording…" : paused ? "Paused" : "Listening for speech…"}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Audio / Transcript toggle */}
      <div className="flex items-center justify-center gap-6 mt-4">
        <TogglePill
          active={view === "audio"}
          disabled={stopping}
          onClick={() => setView("audio")}
          icon={<Volume2 className="w-4 h-4" />}
          label="Audio"
        />
        <TogglePill
          active={view === "transcript"}
          disabled={stopping}
          onClick={() => setView("transcript")}
          icon={<AlignLeft className="w-4 h-4" />}
          label="Transcript"
        />
      </div>

      {/* Timer */}
      <div className="flex items-center justify-center gap-3 mt-4">
        <span
          className={`inline-block rounded-full ${paused || stopping ? "" : "rec-pulse"}`}
          style={{width: 14, height: 14, background: "var(--rec)", opacity: paused || stopping ? 0.4 : 1}}
        />
        <span className="text-[44px] font-light leading-none tabular-nums" style={{color: "var(--text)"}}>
          {fmtTimer(status.ms)}
        </span>
      </div>

      {/* Controls */}
      <div className="flex gap-3 mt-5">
        <button
          type="button"
          onClick={paused ? onResume : onPause}
          disabled={stopping}
          className="flex-1 h-14 flex items-center justify-center gap-2 rounded-full text-[16px] font-semibold press active:opacity-80 disabled:opacity-40"
          style={{background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)"}}>
          {paused ? (
            <Play className="w-5 h-5" fill="currentColor" strokeWidth={0} />
          ) : (
            <Pause className="w-5 h-5" fill="currentColor" strokeWidth={0} />
          )}
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="flex-1 h-14 flex items-center justify-center gap-2 rounded-full text-[16px] font-semibold text-white press disabled:opacity-70"
          style={{background: "var(--rec-grad)", boxShadow: "var(--shadow-fab)"}}>
          {stopping ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Square className="w-4 h-4" fill="currentColor" strokeWidth={0} />
          )}
          {stopping ? "Saving…" : "Stop"}
        </button>
      </div>

      <p className="flex items-center justify-center gap-1.5 mt-3 text-[12px]" style={{color: "var(--text-muted)"}}>
        <Mic className="w-3 h-3" />
        Glasses mic
      </p>
    </div>
  )
}

function TogglePill({
  active,
  disabled,
  onClick,
  icon,
  label,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 h-9 px-4 rounded-full text-[15px] font-semibold press active:opacity-80 disabled:opacity-40"
      style={
        active
          ? {background: "color-mix(in srgb, var(--amber) 16%, transparent)", color: "var(--amber)"}
          : {color: "var(--text-muted)", paddingLeft: 10, paddingRight: 10}
      }>
      {icon}
      {label}
    </button>
  )
}
