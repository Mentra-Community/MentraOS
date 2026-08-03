import {Languages, Settings as SettingsGlyph} from "lucide-react"
import {useColorScheme} from "@mentra/miniapp/ui"

import type {HoldHandlers} from "../hooks/useDeveloperMode"

interface BottomNavProps {
  activeTab?: "translation" | "settings"
  onTabChange?: (tab: "translation" | "settings") => void
  accentColor?: string
  accentForeground?: string
  /** Press-and-hold handlers wired to the settings gear to toggle developer mode. */
  settingsHoldHandlers?: HoldHandlers
}

export function BottomNav({
  activeTab = "translation",
  onTabChange,
  accentColor = "#2089F3",
  settingsHoldHandlers,
}: BottomNavProps) {
  const activeIconColor = readableIconColor(accentColor)
  // Inactive ink flips with the host color scheme (icons take a color prop,
  // so Tailwind dark: variants can't reach them).
  const inactiveIconColor = useColorScheme() === "dark" ? "#A1A1AA" : "#3F3F46"

  return (
    <div className="w-full flex flex-col">
      {/* Bottom navigation */}
      <div className="w-full h-14 py-3 bg-white/80 dark:bg-zinc-900/80 rounded-tl-2xl rounded-tr-2xl backdrop-blur-lg flex flex-col justify-start items-center gap-2.5 overflow-hidden">
        <div className="w-full flex justify-center items-end">
          {/* Translation tab */}
          <div className="flex-1 inline-flex flex-col justify-start items-center gap-1">
            <button
              aria-label="Translation"
              onClick={() => onTabChange?.("translation")}
              className="w-12 h-7 p-2 rounded-3xl inline-flex justify-center items-center gap-2 transition-colors"
              style={activeTab === "translation" ? {backgroundColor: accentColor} : {backgroundColor: "transparent"}}>
              <Languages
                aria-hidden="true"
                className="w-6 h-6"
                strokeWidth={2}
                color={activeTab === "translation" ? activeIconColor : inactiveIconColor}
                opacity={activeTab === "translation" ? 1 : 0.65}
              />
            </button>
          </div>

          {/* Settings tab */}
          <div className="flex-1 inline-flex flex-col justify-start items-center gap-1">
            <button
              aria-label="Settings"
              onClick={() => onTabChange?.("settings")}
              onPointerDown={settingsHoldHandlers?.onPointerDown}
              onPointerUp={settingsHoldHandlers?.onPointerUp}
              onPointerLeave={settingsHoldHandlers?.onPointerLeave}
              onPointerCancel={settingsHoldHandlers?.onPointerCancel}
              className="w-12 h-7 p-2 rounded-3xl inline-flex justify-center items-center gap-2 transition-colors"
              style={activeTab === "settings" ? {backgroundColor: accentColor} : {backgroundColor: "transparent"}}>
              <SettingsGlyph
                aria-hidden="true"
                className="w-6 h-6"
                strokeWidth={2}
                color={activeTab === "settings" ? activeIconColor : inactiveIconColor}
                opacity={activeTab === "settings" ? 1 : 0.65}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function readableIconColor(background: string): string {
  const hex = background.replace("#", "")
  if (!/^[\da-f]{6}$/i.test(hex)) return "#FFFFFF"

  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  const luminance = 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b)

  return luminance > 0.42 ? "#18181B" : "#FFFFFF"
}

function linearize(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}
