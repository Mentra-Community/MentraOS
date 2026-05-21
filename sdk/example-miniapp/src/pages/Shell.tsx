import type {ReactNode} from "react"
import {useSafeArea} from "@mentra/miniapp/react"

/**
 * Page shell: applies safe-area padding around a scrollable content area.
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
