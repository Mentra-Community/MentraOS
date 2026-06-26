import {AudioLines, Trash2} from "lucide-react"
import {useCapsuleHeaderStyle} from "@mentra/miniapp/ui"

import type {Usage} from "../../shared/types"
import {fmtBytes} from "../lib/format"

interface Props {
  usage: Usage
  onClearAll: () => void
}

export function Header({usage, onClearAll}: Props) {
  // Aligns the title row with the host's floating capsule menu and pads the
  // right so nothing renders underneath it (top-right corner stays clear).
  const headerStyle = useCapsuleHeaderStyle()
  const used = usage.quotaBytes > 0 ? Math.min(1, usage.bytes / usage.quotaBytes) : 0

  return (
    <div className="shrink-0">
      <div style={headerStyle}>
        <div className="flex items-center gap-2.5">
          <span
            className="grid place-items-center rounded-xl"
            style={{
              width: 34,
              height: 34,
              background: "var(--accent-grad)",
              boxShadow: "0 4px 12px color-mix(in srgb, var(--accent) 36%, transparent)",
            }}>
            <AudioLines className="w-5 h-5 text-white" strokeWidth={2.4} />
          </span>
          <h1 className="text-[22px] font-extrabold tracking-tight" style={{color: "var(--text)"}}>
            Recorder
          </h1>
        </div>
      </div>

      {/* Storage + clear-all, kept below the capsule menu band */}
      {usage.count > 0 ? (
        <div className="px-5 pt-2 pb-2 flex items-center gap-2.5">
          <button
            type="button"
            aria-label="Clear all recordings"
            onClick={onClearAll}
            className="grid place-items-center rounded-full shrink-0 active:opacity-70"
            style={{width: 30, height: 30, color: "var(--text-muted)"}}>
            <Trash2 className="w-4 h-4" />
          </button>
          <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background: "var(--border)"}}>
            <div
              className="h-full rounded-full"
              style={{width: `${used * 100}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))"}}
            />
          </div>
          <span className="text-[11px] tabular-nums shrink-0" style={{color: "var(--text-muted)"}}>
            {usage.count} · {fmtBytes(usage.bytes)}
          </span>
        </div>
      ) : null}
    </div>
  )
}
