import {useEffect, useRef, useState} from "react"
import {ChevronDown, ChevronUp, Mic, Pause, Play, RotateCcw} from "lucide-react"
import {useColorScheme} from "@mentra/miniapp/ui"

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
  onSetVoiceFollow: (enabled: boolean) => void
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
  onSetVoiceFollow,
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

  // Commit any pending debounced edit before a transport action so playback
  // uses the on-screen draft — and so the background's set-script reset lands
  // BEFORE play/seek rather than firing mid-playback and halting it. No-op on
  // the background when the script is unchanged.
  const flushPending = () => {
    if (debounceRef.current) flush(draft)
  }
  const handlePlay = () => {
    flushPending()
    onPlay()
  }
  const handlePause = () => {
    flushPending()
    onPause()
  }
  const handleRestart = () => {
    flushPending()
    onRestart()
  }
  const handleSeek = (percent: number) => {
    flushPending()
    onSeek(percent)
  }
  const handleNudge = (lines: number) => {
    flushPending()
    onNudge(lines)
  }

  const totalWords = status?.totalWords ?? 0
  const playing = status?.state === "playing"
  // Whether voice is the ACTUAL scroll driver — false when AI Scroll is on but
  // the device has no mic (the engine falls back to timed scroll), so the
  // caption doesn't promise voice-follow that isn't happening.
  const voiceActive = status?.voiceMode ?? settings.voiceFollow
  const progress = drag ?? status?.progress ?? 0
  const totalSec = status?.estimatedTotalSec ?? 0
  const remainingSec = status?.remainingSec ?? totalSec
  const elapsedSec = Math.max(0, totalSec - remainingSec)
  const empty = totalWords === 0

  const stateLabel = empty ? "Add a script" : (STATE_LABEL[status?.state ?? "idle"] ?? "Ready")
  const isDark = useColorScheme() === "dark"

  return (
    <div className="h-full flex flex-col bg-zinc-100 dark:bg-zinc-950">
      {/* Cockpit — preview + transport + scrubber */}
      <div className="shrink-0 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-4 pt-3 pb-4 space-y-3 shadow-sm">
        <GlassesPreview status={status} />

        {/* State + AI Scroll toggle. Play auto-scrolls at the set speed; AI Scroll
            is the explicit opt-in that makes scrolling follow the speaker's voice. */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">{stateLabel}</span>
          <button
            type="button"
            aria-label="AI Scroll — follow my voice"
            aria-pressed={settings.voiceFollow}
            onClick={() => onSetVoiceFollow(!settings.voiceFollow)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors active:scale-95"
            style={
              settings.voiceFollow
                ? {backgroundColor: ACCENT, color: ACCENT_FG}
                : isDark
                  ? {backgroundColor: "#27272A", color: "#A1A1AA"}
                  : {backgroundColor: "#F4F4F5", color: "#3F3F46"}
            }>
            <Mic className="w-3.5 h-3.5" aria-hidden="true" />
            AI Scroll
            <span className="opacity-80">{settings.voiceFollow ? "On" : "Off"}</span>
          </button>
        </div>

        {/* Transport */}
        <div className="flex items-center justify-center gap-5">
          <button
            aria-label="Restart from top"
            onClick={handleRestart}
            disabled={empty}
            className="w-11 h-11 rounded-full bg-zinc-100 dark:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200 disabled:opacity-40 transition-colors">
            <RotateCcw className="w-5 h-5" aria-hidden="true" />
          </button>

          <button
            aria-label={playing ? "Pause" : "Play"}
            onClick={playing ? handlePause : handlePlay}
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
              onClick={() => handleNudge(-1)}
              disabled={empty}
              className="w-11 h-[18px] rounded-t-full bg-zinc-100 dark:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200 disabled:opacity-40 transition-colors">
              <ChevronUp className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              aria-label="Forward one line"
              onClick={() => handleNudge(1)}
              disabled={empty}
              className="w-11 h-[18px] rounded-b-full bg-zinc-100 dark:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700 flex items-center justify-center text-zinc-700 dark:text-zinc-200 disabled:opacity-40 transition-colors">
              <ChevronDown className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* What Play does right now — defuses the "why isn't it moving?" confusion.
            Three states: off, on-with-voice, and on-but-no-mic (timed fallback). */}
        <p className="text-center text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
          {!settings.voiceFollow
            ? `Play auto-scrolls at ${settings.wpm} wpm. Turn on AI Scroll to follow your voice.`
            : voiceActive
              ? "AI Scroll is on — the prompter follows your voice as you speak."
              : `AI Scroll is on, but this device has no mic — Play auto-scrolls at ${settings.wpm} wpm.`}
        </p>

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
              handleSeek(v)
            }}
            onPointerUp={() => setDrag(null)}
            onPointerCancel={() => setDrag(null)}
            aria-label="Scrub through script"
          />
          <div className="flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400 tabular-nums">
            <span>{fmtClock(elapsedSec)}</span>
            <span>−{fmtClock(remainingSec)}</span>
          </div>
        </div>
      </div>

      {/* Script editor */}
      <div className="flex-1 min-h-0 flex flex-col px-4 pt-3 pb-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-semibold text-zinc-700 dark:text-zinc-200">Script</span>
          <span className="text-[11px] font-medium text-zinc-400 dark:text-zinc-500 tabular-nums">
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
          className="selectable-text flex-1 min-h-0 w-full resize-none rounded-2xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 text-[15px] leading-relaxed text-zinc-800 dark:text-zinc-200 shadow-sm outline-none focus:border-emerald-400 dark:focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100 dark:focus:ring-emerald-950 scrollbar-hide"
        />
      </div>
    </div>
  )
}
