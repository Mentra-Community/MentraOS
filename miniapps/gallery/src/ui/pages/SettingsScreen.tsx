import {useState} from "react"
import {useNavigate} from "react-router-dom"
import {ChevronLeft, ChevronRight} from "lucide-react"

import {Shell} from "../components/Shell"
import {cn} from "../lib/cn"
import {formatUsage} from "../lib/format"
import {useGallery} from "../store/galleryStore"

export default function SettingsScreen() {
  const navigate = useNavigate()
  const {snapshot, setSettings, clear} = useGallery()
  const settings = snapshot?.settings
  const items = snapshot?.photos ?? []
  const isVid = (p: {mimeType?: string; durationMs?: number}) =>
    Boolean(p.mimeType?.startsWith("video/")) || (p.durationMs ?? 0) > 0
  const photoCount = items.filter((p) => !isVid(p)).length
  const videoCount = items.filter(isVid).length
  const used = snapshot?.usage?.bytes ?? 0

  const [confirmClear, setConfirmClear] = useState(false)

  return (
    <Shell tone="light">
      <Header title="Settings" onBack={() => navigate(-1)} />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        {/* Camera Settings nav */}
        <button
          type="button"
          onClick={() => navigate("/settings/camera")}
          className="mt-2 flex w-full items-center justify-between rounded-[20px] bg-surface px-5 py-4 text-left transition-colors active:bg-line">
          <span className="text-[16px] font-semibold text-ink">Camera Settings</span>
          <span className="grid size-8 place-items-center rounded-full bg-ground text-ink">
            <ChevronRight className="size-5" />
          </span>
        </button>

        {/* Automatic sync */}
        <SectionLabel>Automatic Sync</SectionLabel>
        <div className="rounded-[20px] bg-surface px-5 py-4">
          <div className="flex items-center gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-[16px] font-semibold text-ink">Save to Camera Roll</div>
              <div className="mt-0.5 text-[13px] leading-[1.4] text-muted">
                Automatically save captured photos to your phone's camera roll
              </div>
            </div>
            <Toggle
              value={settings?.saveToCameraRoll ?? true}
              onChange={(v) => setSettings({saveToCameraRoll: v})}
            />
          </div>
        </div>

        {/* Storage info */}
        <SectionLabel>Storage Info</SectionLabel>
        <div className="overflow-hidden rounded-[20px] bg-surface">
          <StatRow label="Photos on Phone" value={String(photoCount)} />
          <StatRow label="Videos on Phone" value={String(videoCount)} />
          <StatRow label="Photos on Mentra Live" value="—" />
          <StatRow label="Videos on Mentra Live" value="—" />
          <StatRow label="Phone Storage Used" value={used ? formatUsage(used) : "0 B"} last />
        </div>

        {/* Delete all */}
        <button
          type="button"
          disabled={photoCount === 0}
          onClick={() => {
            if (!confirmClear) {
              setConfirmClear(true)
              window.setTimeout(() => setConfirmClear(false), 3000)
              return
            }
            clear()
            setConfirmClear(false)
          }}
          className={cn(
            "mt-7 flex w-full items-center justify-between rounded-[20px] px-5 py-4 text-left transition-colors",
            photoCount === 0 ? "bg-surface text-muted" : confirmClear ? "bg-red-600 text-white" : "bg-surface text-red-600",
          )}>
          <span className="text-[16px] font-semibold">{confirmClear ? "Tap again to confirm" : "Delete All Photos"}</span>
          <ChevronRight className="size-5 opacity-60" />
        </button>
      </div>
    </Shell>
  )
}

function Header({title, onBack}: {title: string; onBack: () => void}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-3 px-4">
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        className="grid size-10 place-items-center rounded-full bg-surface text-ink transition-colors hover:bg-line">
        <ChevronLeft className="size-5" />
      </button>
      <h1 className="font-display text-[28px] font-bold tracking-[-0.01em] text-ink">{title}</h1>
    </div>
  )
}

function SectionLabel({children}: {children: React.ReactNode}) {
  return (
    <h2 className="px-1 pt-7 pb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">{children}</h2>
  )
}

function StatRow({label, value, last}: {label: string; value: string; last?: boolean}) {
  return (
    <div className={cn("flex items-center justify-between px-5 py-3.5", !last && "border-b border-line")}>
      <span className="text-[15px] font-medium text-ink">{label}</span>
      <span className="font-mono text-[14px] text-muted">{value}</span>
    </div>
  )
}

function Toggle({value, onChange}: {value: boolean; onChange: (v: boolean) => void}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors", value ? "bg-cobalt" : "bg-line")}>
      <span
        className={cn(
          "absolute top-0.5 size-6 rounded-full bg-white shadow transition-transform",
          value ? "translate-x-[22px]" : "translate-x-0.5",
        )}
      />
    </button>
  )
}
