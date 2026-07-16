import {ScrollText, Settings as SettingsGlyph} from "lucide-react"

import {useColorScheme} from "@mentra/miniapp/ui"

import type {HoldHandlers} from "../hooks/useDeveloperMode"
import {ACCENT, ACCENT_FG, ACCENT_TEXT} from "../lib/theme"

export type Tab = "script" | "settings"

const INACTIVE = "#3F3F46"
const INACTIVE_DARK = "#A1A1AA"

/** Inactive icon/label ink for the current host color scheme. */
function useInactiveColor(): string {
  return useColorScheme() === "dark" ? INACTIVE_DARK : INACTIVE
}

interface BottomNavProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  /** Press-and-hold handlers wired to the settings gear to toggle developer mode. */
  settingsHoldHandlers?: HoldHandlers
}

export function BottomNav({activeTab, onTabChange, settingsHoldHandlers}: BottomNavProps) {
  const inactive = useInactiveColor()
  return (
    <div className="w-full h-16 bg-white/85 dark:bg-zinc-900/85 backdrop-blur-lg border-t border-zinc-200 dark:border-zinc-800 flex items-stretch">
      <NavButton
        label="Script"
        active={activeTab === "script"}
        onClick={() => onTabChange("script")}
        icon={
          <ScrollText
            className="w-6 h-6"
            strokeWidth={2}
            color={activeTab === "script" ? ACCENT_FG : inactive}
            opacity={activeTab === "script" ? 1 : 0.65}
          />
        }
      />
      <NavButton
        label="Settings"
        active={activeTab === "settings"}
        onClick={() => onTabChange("settings")}
        holdHandlers={settingsHoldHandlers}
        icon={
          <SettingsGlyph
            className="w-6 h-6"
            strokeWidth={2}
            color={activeTab === "settings" ? ACCENT_FG : inactive}
            opacity={activeTab === "settings" ? 1 : 0.65}
          />
        }
      />
    </div>
  )
}

function NavButton({
  label,
  active,
  onClick,
  icon,
  holdHandlers,
}: {
  label: string
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  holdHandlers?: HoldHandlers
}) {
  const inactive = useInactiveColor()
  return (
    <button
      aria-label={label}
      onClick={onClick}
      onPointerDown={holdHandlers?.onPointerDown}
      onPointerUp={holdHandlers?.onPointerUp}
      onPointerLeave={holdHandlers?.onPointerLeave}
      onPointerCancel={holdHandlers?.onPointerCancel}
      className="flex-1 flex flex-col items-center justify-center gap-1">
      <span
        className="w-12 h-8 rounded-3xl inline-flex justify-center items-center transition-colors"
        style={active ? {backgroundColor: ACCENT} : {backgroundColor: "transparent"}}>
        {icon}
      </span>
      <span
        className="text-[11px] font-medium transition-colors"
        style={{color: active ? ACCENT_TEXT : inactive, opacity: active ? 1 : 0.7}}>
        {label}
      </span>
    </button>
  )
}
