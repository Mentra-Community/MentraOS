import {AudioLines} from "lucide-react"
import {useCapsuleHeaderStyle} from "@mentra/miniapp/ui"

export function Header() {
  // Aligns the title row with the host's floating capsule menu and pads the
  // right so nothing renders underneath it (top-right corner stays clear).
  const headerStyle = useCapsuleHeaderStyle()

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
    </div>
  )
}
