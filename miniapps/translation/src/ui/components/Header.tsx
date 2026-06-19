import {Languages} from "lucide-react"

import {TranslationSettings} from "../hooks/useSettings"
import {getLanguageName, getFlagEmoji} from "../lib/languages"

/**
 * The fake app bar's surface — a light neutral that matches the chrome below
 * it, with near-black title text. Exported so the App root can paint the
 * top safe-area inset the same color, making the status-bar area blend into
 * the app bar instead of showing the blue cloud-status gradient.
 */
export const APP_BAR_BACKGROUND = "#F4F4F5"
export const APP_BAR_FOREGROUND = "#18181B"

interface HeaderProps {
  connected: boolean
  accentColor: string
  accentForeground: string
  error: string | null
  settings: TranslationSettings | null
  onToggleTargetLanguageSelector: () => void
  onReconnect: () => void
  isTargetLanguageSelectorOpen?: boolean
}

export function Header({
  connected,
  accentColor,
  accentForeground,
  error,
  settings,
  onToggleTargetLanguageSelector,
  onReconnect,
  isTargetLanguageSelectorOpen = false,
}: HeaderProps) {
  return (
    <div className="w-full flex flex-col">
      {/* Top header bar */}
      <div
        className="w-full h-[46px] px-6 backdrop-blur-lg flex justify-center items-center"
        style={{background: APP_BAR_BACKGROUND}}>
        {/* Title with icon */}
        <div className="flex justify-start items-center gap-2">
          <Languages className="w-6 h-6" color={APP_BAR_FOREGROUND} />
          <div
            className="text-center text-lg font-semibold font-['Red_Hat_Display'] leading-6"
            style={{color: APP_BAR_FOREGROUND}}>
            Translation
          </div>
        </div>
      </div>

      {/* Connection error banner */}
      {error && (
        <div className="w-full px-4 py-2 bg-amber-50 border-b border-amber-200 flex justify-between items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
            <span className="text-amber-800 text-sm font-medium truncate">{error}</span>
          </div>
          <button
            onClick={onReconnect}
            className="px-3 py-1 bg-amber-500 hover:bg-amber-600 text-white text-sm font-medium rounded-full flex-shrink-0 transition-colors">
            Retry
          </button>
        </div>
      )}

      {/* Target language selector bar with chips - hidden when selector is open */}
      {!isTargetLanguageSelectorOpen && (
        <button
          onClick={onToggleTargetLanguageSelector}
          className="w-full px-3 py-3 bg-white rounded-bl-2xl rounded-br-2xl backdrop-blur-lg hover:bg-gray-50 transition-colors flex items-center gap-2 shadow-md">
          {settings && (
            <>
              {/* Connection status indicator - before all chips */}
              <div
                className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors ${
                  connected ? "bg-green-500" : "bg-red-500"
                }`}
                style={connected ? {backgroundColor: accentColor} : {}}
                title={connected ? "Connected" : "Disconnected"}
              />

              {/* Scrollable chips container with fade-out edges */}
              <div className="relative flex-1 min-w-0">
                {/* Left fade gradient */}
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-r from-white to-transparent pointer-events-none z-10" />

                {/* Scrollable chips */}
                <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
                  <div className="px-0"></div>
                  <span className="text-sm font-semibold text-gray-700 flex-shrink-0">Target</span>
                  <div
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full flex-shrink-0"
                    style={{backgroundColor: accentColor, color: accentForeground}}>
                    <span className="text-base">{getFlagEmoji(settings.targetLanguage)}</span>
                    <span className="text-sm font-semibold font-['Red_Hat_Display']">
                      {getLanguageName(settings.targetLanguage)}
                    </span>
                  </div>
                  <div className="px-0"></div>
                </div>

                {/* Right fade gradient */}
                <div className="absolute right-0 top-0 bottom-0 w-1 bg-gradient-to-l from-white to-transparent pointer-events-none z-10" />
              </div>

              {/* Dropdown arrow - fixed at right edge, always visible */}
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
                className="flex-shrink-0">
                <path
                  d="M6 9L12 15L18 9"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-gray-600"
                />
              </svg>
            </>
          )}
        </button>
      )}
    </div>
  )
}
