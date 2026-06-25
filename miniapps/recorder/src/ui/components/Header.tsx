import {AudioLines, Trash2} from "lucide-react"

import type {Usage} from "../../shared/types"
import {fmtBytes} from "../lib/format"

interface Props {
  usage: Usage
  onClearAll: () => void
}

export function Header({usage, onClearAll}: Props) {
  const used = usage.quotaBytes > 0 ? Math.min(1, usage.bytes / usage.quotaBytes) : 0
  return (
    <div className="px-5 pt-1 pb-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span
            className="grid place-items-center rounded-xl"
            style={{width: 34, height: 34, background: "linear-gradient(135deg, var(--accent), var(--accent-2))"}}>
            <AudioLines className="w-5 h-5 text-white" strokeWidth={2.4} />
          </span>
          <h1 className="text-[22px] font-extrabold tracking-tight" style={{color: "var(--text)"}}>
            Recorder
          </h1>
        </div>
        {usage.count > 0 ? (
          <button
            type="button"
            onClick={onClearAll}
            className="flex items-center gap-1.5 text-[13px] font-semibold px-3 py-1.5 rounded-full active:opacity-80"
            style={{background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text-muted)"}}>
            <Trash2 className="w-3.5 h-3.5" />
            Clear all
          </button>
        ) : null}
      </div>

      <div className="mt-2.5 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{background: "var(--border)"}}>
          <div
            className="h-full rounded-full"
            style={{width: `${used * 100}%`, background: "linear-gradient(90deg, var(--accent), var(--accent-2))"}}
          />
        </div>
        <span className="text-[11px] tabular-nums shrink-0" style={{color: "var(--text-muted)"}}>
          {usage.count} · {fmtBytes(usage.bytes)} / {fmtBytes(usage.quotaBytes)}
        </span>
      </div>
    </div>
  )
}
