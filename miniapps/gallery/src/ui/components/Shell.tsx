import type {ReactNode} from "react"
import {useSafeArea} from "@mentra/miniapp/ui"

import {cn} from "../lib/cn"

/** Safe-area shell. `light` is the editorial white surface; `dark` is the
 *  full-screen near-black viewer. */
export function Shell({
  children,
  tone = "light",
}: {
  children?: ReactNode
  tone?: "light" | "dark"
}) {
  const {insets} = useSafeArea()
  return (
    <div
      className={cn(
        "relative flex h-screen flex-col overflow-hidden",
        tone === "dark" ? "bg-night text-white" : "bg-ground text-ink",
      )}
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
