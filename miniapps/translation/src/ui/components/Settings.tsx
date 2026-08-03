import {useState, useEffect} from "react"

import {TranslationSettings} from "../hooks/useSettings"
import {DisplayPreview} from "../hooks/useTranslations"

interface SettingsProps {
  settings: TranslationSettings | null
  displayPreview: DisplayPreview | null
  accentColor?: string
  accentForeground?: string
  onUpdateDisplayLines: (lines: number) => Promise<boolean>
  onUpdateDisplayWidth: (width: number) => Promise<boolean>
  onUpdateWordBreaking: (enabled: boolean) => Promise<boolean>
  onUpdateShowOriginalText: (enabled: boolean) => Promise<boolean>
  onUpdateGlassesDisplayMode: (mode: "translation" | "both") => Promise<boolean>
}

export function Settings({
  settings,
  displayPreview,
  accentColor = "#2089F3",
  accentForeground = "#FFFFFF",
  onUpdateDisplayLines,
  onUpdateDisplayWidth,
  onUpdateWordBreaking,
  onUpdateShowOriginalText,
  onUpdateGlassesDisplayMode,
}: SettingsProps) {
  const [displayLines, setDisplayLines] = useState(settings?.displayLines || 3)
  const [displayWidth, setDisplayWidth] = useState(settings?.displayWidth || 1)
  const [wordBreaking, setWordBreaking] = useState(settings?.wordBreaking ?? false)
  const [showOriginalText, setShowOriginalText] = useState(settings?.showOriginalText ?? true)
  const [glassesDisplayMode, setGlassesDisplayMode] = useState<"translation" | "both">(
    settings?.glassesDisplayMode ?? "translation",
  )

  // Sync local state with props when settings change (e.g., from SSE update or initial load)
  useEffect(() => {
    if (settings) {
      setDisplayLines(settings.displayLines)
      setDisplayWidth(settings.displayWidth)
      setWordBreaking(settings.wordBreaking)
      setShowOriginalText(settings.showOriginalText ?? true)
      setGlassesDisplayMode(settings.glassesDisplayMode ?? "translation")
    }
  }, [settings])

  const handleDisplayLinesChange = async (lines: number) => {
    setDisplayLines(lines) // Optimistic update
    const success = await onUpdateDisplayLines(lines)
    if (!success) {
      // Revert on failure
      setDisplayLines(settings?.displayLines || 3)
    }
  }

  const handleDisplayWidthChange = async (width: number) => {
    setDisplayWidth(width) // Optimistic update
    const success = await onUpdateDisplayWidth(width)
    if (!success) {
      // Revert on failure
      setDisplayWidth(settings?.displayWidth || 1)
    }
  }

  const handleWordBreakingChange = async (enabled: boolean) => {
    setWordBreaking(enabled) // Optimistic update
    const success = await onUpdateWordBreaking(enabled)
    if (!success) {
      // Revert on failure
      setWordBreaking(settings?.wordBreaking ?? false)
    }
  }

  const handleShowOriginalTextChange = async (enabled: boolean) => {
    setShowOriginalText(enabled) // Optimistic update
    const success = await onUpdateShowOriginalText(enabled)
    if (!success) {
      // Revert on failure
      setShowOriginalText(settings?.showOriginalText ?? true)
    }
  }

  const handleGlassesDisplayModeChange = async (mode: "translation" | "both") => {
    setGlassesDisplayMode(mode) // Optimistic update
    const success = await onUpdateGlassesDisplayMode(mode)
    if (!success) {
      // Revert on failure
      setGlassesDisplayMode(settings?.glassesDisplayMode ?? "translation")
    }
  }

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 dark:text-zinc-400">Loading settings...</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100 dark:bg-zinc-950">
      {/* Preview Section */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Preview</h3>
        <div className="p-4 bg-white dark:bg-zinc-900 rounded-2xl shadow-sm border border-gray-100 dark:border-zinc-800 min-h-[100px] overflow-x-auto">
          {displayPreview?.text ? (
            <div className="space-y-0.5">
              {displayPreview.lines.map((line, i) => (
                <p
                  key={i}
                  className={`text-xs font-['Red_Hat_Display'] leading-tight whitespace-pre ${
                    displayPreview.isFinal ? "text-gray-800 dark:text-zinc-200" : "text-gray-500 dark:text-zinc-400"
                  }`}>
                  {line || "\u00A0"} {/* Non-breaking space for empty lines */}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 dark:text-zinc-500 text-sm font-['Red_Hat_Display'] leading-relaxed italic">
              Translation will appear here
            </p>
          )}
        </div>
      </div>

      {/* Glasses Display Settings */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Glasses Display Settings</h2>

        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-zinc-800 space-y-6">
          {/* Display Lines */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-900 dark:text-zinc-50">
                <path d="M4 8V5a1 1 0 0 1 1-1h3" />
                <path d="M16 4h3a1 1 0 0 1 1 1v3" />
                <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
                <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
              </svg>
              <span className="text-base font-medium text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Display lines</span>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {[2, 3, 4, 5].map((lines) => (
                <button
                  key={lines}
                  onClick={() => handleDisplayLinesChange(lines)}
                  className={`py-3 rounded-xl text-lg font-medium font-['Red_Hat_Display'] transition-colors ${
                    displayLines === lines ? "shadow-sm" : "bg-gray-50 text-gray-900 hover:bg-gray-100 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                  style={displayLines === lines ? {backgroundColor: accentColor, color: accentForeground} : {}}>
                  {lines}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="h-px bg-gray-100 dark:bg-zinc-800 w-full" />

          {/* Display Width */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-900 dark:text-zinc-50">
                <path d="M17 8l4 4-4 4" />
                <path d="M7 16l-4-4 4-4" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
              <span className="text-base font-medium text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Display Width</span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                {value: 0, label: "Narrow"},
                {value: 1, label: "Medium"},
                {value: 2, label: "Wide"},
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleDisplayWidthChange(option.value)}
                  className={`py-3 rounded-xl text-base font-medium font-['Red_Hat_Display'] transition-colors ${
                    displayWidth === option.value ? "shadow-sm" : "bg-gray-50 text-gray-900 hover:bg-gray-100 dark:bg-zinc-800 dark:text-zinc-50 dark:hover:bg-zinc-700"
                  }`}
                  style={displayWidth === option.value ? {backgroundColor: accentColor, color: accentForeground} : {}}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="h-px bg-gray-100 dark:bg-zinc-800 w-full" />

          {/* Word Breaking */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-900 dark:text-zinc-50">
                <path d="M4 7h16" />
                <path d="M4 12h10" />
                <path d="M4 17h13" />
                <path d="M18 14l2 2-2 2" />
              </svg>
              <span className="text-base font-medium text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Word Breaking</span>
            </div>

            <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-zinc-800 rounded-xl">
              <div className="flex-1 pr-4">
                <p className="text-sm text-gray-700 dark:text-zinc-200 font-['Red_Hat_Display']">
                  {wordBreaking
                    ? "Break words with hyphens to fill each line completely"
                    : "Keep words whole, break only at spaces"}
                </p>
              </div>
              <button
                onClick={() => handleWordBreakingChange(!wordBreaking)}
                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                  wordBreaking ? "" : "bg-gray-300 dark:bg-zinc-600"
                }`}
                style={wordBreaking ? {backgroundColor: accentColor} : {}}
                role="switch"
                aria-checked={wordBreaking}>
                <span
                  className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                    wordBreaking ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          </div>

          {/* Glasses Display Content */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                className="text-gray-900 dark:text-zinc-50">
                <path d="M3 9h18" />
                <path d="M3 15h18" />
                <rect x="3" y="4" width="18" height="16" rx="2" />
              </svg>
              <span className="text-base font-medium text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Display content</span>
            </div>

            <div className="flex gap-2">
              {(
                [
                  {mode: "translation", label: "Translation only"},
                  {mode: "both", label: "Translation + transcription"},
                ] as const
              ).map(({mode, label}) => (
                <button
                  key={mode}
                  onClick={() => handleGlassesDisplayModeChange(mode)}
                  className={`flex-1 px-3 py-2 rounded-xl text-sm font-medium font-['Red_Hat_Display'] transition-colors ${
                    glassesDisplayMode === mode ? "" : "bg-gray-100 text-gray-600 dark:bg-zinc-800 dark:text-zinc-300"
                  }`}
                  style={glassesDisplayMode === mode ? {backgroundColor: accentColor, color: accentForeground} : {}}>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Phone List Settings */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Translation List</h2>

        <div className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-zinc-800 space-y-3">
          <div className="flex items-center gap-3">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-gray-900 dark:text-zinc-50">
              <path d="m5 8 6 6" />
              <path d="m4 14 6-6 2-3" />
              <path d="M2 5h12" />
              <path d="M7 2h1" />
              <path d="m22 22-5-10-5 10" />
              <path d="M14 18h6" />
            </svg>
            <span className="text-base font-medium text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display']">Show original language</span>
          </div>

          <div className="flex items-center justify-between p-3 bg-gray-50 dark:bg-zinc-800 rounded-xl">
            <div className="flex-1 pr-4">
              <p className="text-sm text-gray-700 dark:text-zinc-200 font-['Red_Hat_Display']">
                {showOriginalText
                  ? "Each card shows what was said, plus the translation"
                  : "Each card shows the translation only"}
              </p>
            </div>
            <button
              onClick={() => handleShowOriginalTextChange(!showOriginalText)}
              className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                showOriginalText ? "" : "bg-gray-300 dark:bg-zinc-600"
              }`}
              style={showOriginalText ? {backgroundColor: accentColor} : {}}
              role="switch"
              aria-checked={showOriginalText}>
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition-transform ${
                  showOriginalText ? "translate-x-6" : "translate-x-1"
                }`}
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
