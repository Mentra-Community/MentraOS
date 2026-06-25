import {useNavigate} from "react-router-dom"
import {Check, ChevronLeft} from "lucide-react"

import {Shell} from "../components/Shell"
import {cn} from "../lib/cn"
import {useGallery} from "../store/galleryStore"
import type {PhotoSize} from "../../shared/types"

const SIZES: {value: PhotoSize; label: string; hint: string; recommended?: boolean}[] = [
  {value: "low", label: "Low", hint: "Fastest, smallest files"},
  {value: "medium", label: "Medium", hint: "Balanced", recommended: true},
  {value: "high", label: "High", hint: "More detail"},
  {value: "max", label: "Max", hint: "Full sensor resolution"},
]

export default function CameraSettingsScreen() {
  const navigate = useNavigate()
  const {snapshot, setSettings} = useGallery()
  const photoSize = snapshot?.settings?.photoSize

  return (
    <Shell tone="light">
      <div className="flex h-14 shrink-0 items-center gap-3 px-4">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate(-1)}
          className="grid size-10 place-items-center rounded-full bg-surface text-ink transition-colors hover:bg-line">
          <ChevronLeft className="size-5" />
        </button>
        <h1 className="font-display text-[28px] font-bold tracking-[-0.01em] text-ink">Camera</h1>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-10">
        <h2 className="px-1 pt-4 pb-3 font-mono text-[11px] uppercase tracking-[0.1em] text-muted">
          Photo Resolution
        </h2>
        <div className="overflow-hidden rounded-[20px] bg-surface">
          {SIZES.map((s, i) => (
            <button
              key={s.value}
              type="button"
              onClick={() => setSettings({photoSize: s.value})}
              className={cn(
                "flex w-full items-center gap-3 px-5 py-4 text-left transition-colors active:bg-line",
                i !== SIZES.length - 1 && "border-b border-line",
              )}>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[16px] font-semibold text-ink">{s.label}</span>
                <span className="text-[13px] text-muted">{s.hint}</span>
                {s.recommended && (
                  <span className="rounded-full bg-cobalt/10 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.08em] text-cobalt">
                    Recommended
                  </span>
                )}
              </div>
              {photoSize === s.value && <Check className="size-5 shrink-0 text-cobalt" strokeWidth={2.5} />}
            </button>
          ))}
        </div>

        <p className="px-2 pt-5 text-[13px] leading-[1.5] text-muted">
          Higher resolutions capture more detail but use more storage and take longer to transfer from your glasses.
        </p>
      </div>
    </Shell>
  )
}
