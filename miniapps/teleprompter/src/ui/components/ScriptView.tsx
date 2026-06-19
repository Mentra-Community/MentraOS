import {useEffect, useRef, useState} from "react"
import {ChevronDown, ChevronUp, Gauge, Mic, Pause, Play, RotateCcw} from "lucide-react"

import type {PlaybackStatus, TeleprompterSettings} from "../../shared/types"
import {fmtClock, fmtWords} from "../lib/format"
import {ACCENT, ACCENT_FG} from "../lib/theme"
import {GlassesPreview} from "./GlassesPreview"

interface ScriptViewProps {
  settings: TeleprompterSettings
  status: PlaybackStatus | null
  onSetScript: (script: string) => void
  onPlay: () => void
  onPause: () => void
  onRestart: () => void
  onSeek: (percent: number) => void
  onNudge: (lines: number) => void
}

const STATE_LABEL: Record<string, string> = {
  idle: "Ready",
  playing: "Scrolling",
  paused: "Paused",
  finished: "Finished",
}

export function ScriptView({
  settings,
  status,
  onSetScript,
  onPlay,
  onPause,
  onRestart,
  onSeek,
  onNudge,
}: ScriptViewProps) {
  const [draft, setDraft] = useState(settings.script)
  const focusedRef = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [drag, setDrag] = useState<number | null>(null)

  // Pull external script changes in only when the user isn't editing.
  useEffect(() => {
    if (!focusedRef.current) setDraft(settings.script)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.script])

  const flush = (value: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = null
    onSetScript(value)
  }

  const handleChange = (value: string) => {
    setDraft(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => flush(value), 450)
  }

  const totalWords = status?.totalWords ?? 0
  const playing = status?.state === "playing"
  const voiceMode = status?.voiceMode ?? settings.voiceFollow
  const progress = drag ?? status?.progress ?? 0
  const totalSec = status?.estimatedTotalSec ?? 0
  const remainingSec = status?.remainingSec ?? totalSec
  const elapsedSec = Math.max(0, totalSec - remainingSec)
  const empty = totalWords === 0

  const stateLabel = empty ? "Add a script" : (STATE_LABEL[status?.state ?? "idle"] ?? "Ready")

  return (
    <div className="h-full flex flex-col bg-zinc-100">
      {/* Cockpit — preview + transport + scrubber */}
      <div className="shrink-0 bg-white border-b border-zinc-200 px-4 pt-3 pb-4 space-y-3 shadow-sm">
        <GlassesPreview status={status} />

        {/* State + mode */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-800">{stateLabel}</span>
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
            style={{backgroundColor: voiceMode ? "#DCFCE7" : "#F4F4F5", color: voiceMode ? "#15803D" : "#3F3F46"}}>
            {voiceMode ? (
              <>
                <Mic className="w-3.5 h-3.5" aria-hidden="true" /> Voice-follow
              </>
            ) : (
              <>
                <Gauge className="w-3.5 h-3.5" aria-hidden="true" /> {settings.wpm} wpm
              </>
            )}
          </span>
        </div>

        {/* Transport */}
        <div className="flex items-center justify-center gap-5">
          <button
            aria-label="Restart from top"
            onClick={onRestart}
            disabled={empty}
            className="w-11 h-11 rounded-full bg-zinc-100 active:bg-zinc-200 flex items-center justify-center text-zinc-700 disabled:opacity-40 transition-colors">
            <RotateCcw className="w-5 h-5" aria-hidden="true" />
          </button>

          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={playing ? onPause : onPlay}
            disabled={empty}
            className="w-16 h-16 rounded-full flex items-center justify-center shadow-md active:scale-95 disabled:opacity-40 transition-transform"
            style={{backgroundColor: ACCENT, color: ACCENT_FG}}>
            {playing ? (
              <Pause className="w-7 h-7" fill={ACCENT_FG} aria-hidden="true" />
            ) : (
              <Play className="w-7 h-7 ml-0.5" fill={ACCENT_FG} aria-hidden="true" />
            )}
          </button>

          <div className="flex flex-col gap-1">
            <button
              aria-label="Back one line"
              onClick={() => onNudge(-1)}
              disabled={empty}
              className="w-11 h-[18px] rounded-t-full bg-zinc-100 active:bg-zinc-200 flex items-center justify-center text-zinc-700 disabled:opacity-40 transition-colors">
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              aria-label="Forward one line"
              onClick={() => onNudge(1)}
              disabled={empty}
              className="w-11 h-[18px] rounded-b-full bg-zinc-100 active:bg-zinc-200 flex items-center justify-center text-zinc-700 disabled:opacity-40 transition-colors">
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Scrubber */}
        <div className="space-y-1.5">
          <input
            type="range"
            className="tp-range"
            min={0}
            max={100}
            step={1}
            value={Math.round(progress)}
            disabled={empty}
            onChange={(e) => {
              const v = Number(e.target.value)
              setDrag(v)
              onSeek(v)
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
            aria-label="Scrub through script"
          />
          <div className="flex items-center justify-between text-[11px] font-medium text-zinc-500 tabular-nums">
            <span>{fmtClock(elapsedSec)}</span>
            <span>−{fmtClock(remainingSec)}</span>
          </div>
        </div>
      </div>

      {/* Script editor */}
      <div className="flex-1 min-h-0 flex flex-col px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-zinc-700">Script</span>
          <span className="text-[11px] font-medium text-zinc-400 tabular-nums">
            {fmtWords(totalWords)} · {fmtClock(totalSec)}
          </span>
        </div>
        <textarea
          value={draft}
          onFocus={() => (focusedRef.current = true)}
          onBlur={() => {
            focusedRef.current = false
            flush(draft)
          }}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="Paste or type your script here…"
          spellCheck
          className="selectable-text flex-1 min-h-0 w-full resize-none rounded-2xl border border-zinc-200 bg-white p-4 text-[15px] leading-relaxed text-zinc-800 shadow-sm outline-none focus:border-emerald-400 focus:ring-2 focus:ring-emerald-100 scrollbar-hide"
        />
      </div>
    </div>
  )
}
