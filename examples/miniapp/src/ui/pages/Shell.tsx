import type {ReactNode} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

/**
 * Page shell: a fixed, full-height column with safe-area padding. The frame
 * itself clips (`overflow-hidden`) — each page owns its own scroll region via
 * an inner `overflow-y-auto` wrapper, so pinned headers/footers stay put.
 * All routes render inside this so the layout stays consistent.
 */
export function Shell({children}: {children: ReactNode}) {
  const {insets} = useSafeArea()
  return (
    <div
      className="flex h-screen flex-col overflow-hidden bg-background text-foreground"
      style={{
        paddingTop: insets.top,
        paddingBottom: insets.bottom,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}>
      {children}
    </div>
  )
}
