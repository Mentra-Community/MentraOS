import {Languages} from "lucide-react"

import {TranslationSettings} from "../hooks/useSettings"
import {getLanguageName, getFlagEmoji} from "../lib/languages"

interface HeaderProps {
  connected: boolean
  appBarBackground: string
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
  appBarBackground,
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
        style={{backgroundColor: appBarBackground}}>
        {/* Title with icon */}
        <div className="flex justify-start items-center gap-2">
          <Languages className="w-6 h-6" color="#FFFFFF" />
          <div className="text-center text-white text-lg font-semibold font-['Red_Hat_Display'] leading-6">
            Translation
          </div>
        </div>
      </div>

      {/* Connection error banner */}
      {error && (
        <div className="w-full px-4 py-2 bg-amber-50 dark:bg-amber-950 border-b border-amber-200 dark:border-amber-900 flex justify-between items-center gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <div className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0" />
            <span className="text-amber-800 dark:text-amber-200 text-sm font-medium truncate">{error}</span>
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
          className="w-full px-3 py-3 bg-white dark:bg-zinc-900 rounded-bl-2xl rounded-br-2xl backdrop-blur-lg hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors flex items-center gap-2 shadow-md">
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
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-r from-white dark:from-zinc-900 to-transparent pointer-events-none z-10" />

                {/* Scrollable chips */}
                <div className="flex items-center gap-3 overflow-x-auto scrollbar-hide">
                  <div className="px-0"></div>
                  <span className="text-sm font-semibold text-gray-700 dark:text-zinc-200 flex-shrink-0">Target</span>
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
                <div className="absolute right-0 top-0 bottom-0 w-1 bg-gradient-to-l from-white dark:from-zinc-900 to-transparent pointer-events-none z-10" />
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
                  className="text-gray-600 dark:text-zinc-300"
                />
              </svg>
            </>
          )}
        </button>
      )}
    </div>
  )
}
