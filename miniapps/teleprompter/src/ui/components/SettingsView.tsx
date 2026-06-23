import {AlignLeft, Gauge, Mic, Repeat, Rows3, Timer} from "lucide-react"

import type {LineWidth, TeleprompterSettings} from "../../shared/types"
import {ACCENT, ACCENT_FG} from "../lib/theme"

interface SettingsViewProps {
  settings: TeleprompterSettings
  onSetWpm: (wpm: number) => void
  onSetLines: (lines: number) => void
  onSetWidth: (width: LineWidth) => void
  onSetVoiceFollow: (enabled: boolean) => void
  onSetAutoRestart: (enabled: boolean) => void
  onSetShowTimecode: (enabled: boolean) => void
}

export function SettingsView({
  settings,
  onSetWpm,
  onSetLines,
  onSetWidth,
  onSetVoiceFollow,
  onSetAutoRestart,
  onSetShowTimecode,
}: SettingsViewProps) {
  return (
    <div className="h-full overflow-y-auto px-4 py-5 space-y-5 bg-zinc-100 scrollbar-hide">
      {/* Scrolling */}
      <Section title="Scrolling">
        <ToggleRow
          icon={<Mic className="w-5 h-5" />}
          label="Voice-follow"
          description="The prompter listens and advances as you speak. Turn off for a steady timed scroll."
          checked={settings.voiceFollow}
          onChange={onSetVoiceFollow}
        />
        <Divider />
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Gauge className="w-5 h-5 text-zinc-900" />
            <span className="text-base font-medium text-zinc-900">Scroll speed</span>
            <span className="ml-auto text-sm font-semibold tabular-nums" style={{color: ACCENT}}>
              {settings.wpm} wpm
            </span>
          </div>
          <input
            type="range"
            className="tp-range"
            min={60}
            max={300}
            step={5}
            value={settings.wpm}
            onChange={(e) => onSetWpm(Number(e.target.value))}
            aria-label="Scroll speed in words per minute"
          />
          <p className="text-xs text-zinc-500">
            {settings.voiceFollow
              ? "Used to estimate total time. Pace is set by your voice."
              : "Words per minute for timed scrolling."}
          </p>
        </div>
      </Section>

      {/* Glasses display */}
      <Section title="Glasses display">
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Rows3 className="w-5 h-5 text-zinc-900" />
            <span className="text-base font-medium text-zinc-900">Lines on screen</span>
          </div>
          <Segmented
            options={[2, 3, 4, 5].map((n) => ({value: n, label: String(n)}))}
            value={settings.numberOfLines}
            onChange={(v) => onSetLines(v)}
          />
        </div>
        <Divider />
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <AlignLeft className="w-5 h-5 text-zinc-900" />
            <span className="text-base font-medium text-zinc-900">Line width</span>
          </div>
          <Segmented
            options={[
              {value: 0, label: "Narrow"},
              {value: 1, label: "Medium"},
              {value: 2, label: "Wide"},
            ]}
            value={settings.lineWidth}
            onChange={(v) => onSetWidth(v as LineWidth)}
          />
        </div>
      </Section>

      {/* Behavior */}
      <Section title="Behavior">
        <ToggleRow
          icon={<Repeat className="w-5 h-5" />}
          label="Auto-restart"
          description="Loop back to the top automatically when you reach the end."
          checked={settings.autoRestart}
          onChange={onSetAutoRestart}
        />
        <Divider />
        <ToggleRow
          icon={<Timer className="w-5 h-5" />}
          label="Show time on glasses"
          description="Add a m:ss progress line beneath your script on the display."
          checked={settings.showTimecode}
          onChange={onSetShowTimecode}
        />
      </Section>
    </div>
  )
}

// ── Building blocks ─────────────────────────────────────────────────────────

function Section({title, children}: {title: string; children: React.ReactNode}) {
  return (
    <div className="space-y-3">
      <h2 className="text-xs font-bold uppercase tracking-wide text-zinc-400 px-1">{title}</h2>
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-zinc-100 space-y-4">{children}</div>
    </div>
  )
}

function Divider() {
  return <div className="h-px bg-zinc-100 w-full" />
}

function ToggleRow({
  icon,
  label,
  description,
  checked,
  onChange,
}: {
  icon: React.ReactNode
  label: string
  description: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-zinc-900 mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-base font-medium text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500 mt-0.5 leading-snug">{description}</p>
      </div>
      <Switch checked={checked} onChange={onChange} label={label} />
    </div>
  )
}

function Switch({checked, onChange, label}: {checked: boolean; onChange: (v: boolean) => void; label: string}) {
  return (
    <button
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors ${
        checked ? "" : "bg-zinc-300"
      }`}
      style={checked ? {backgroundColor: ACCENT} : {}}>
      <span
        className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-6" : "translate-x-1"
        }`}
      />
    </button>
  )
}

function Segmented<T extends number>({
  options,
  value,
  onChange,
}: {
  options: Array<{value: T; label: string}>
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="grid gap-2" style={{gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`}}>
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`py-2.5 rounded-xl text-sm font-semibold transition-colors ${
              active ? "shadow-sm" : "bg-zinc-50 text-zinc-900 active:bg-zinc-100"
            }`}
            style={active ? {backgroundColor: ACCENT, color: ACCENT_FG} : {}}>
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
