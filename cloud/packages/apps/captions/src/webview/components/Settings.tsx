import {useState, useEffect} from "react"

import {CaptionSettings} from "@/hooks/useSettings"
import {DisplayPreview} from "@/hooks/useTranscripts"

interface SettingsProps {
  settings: CaptionSettings | null
  displayPreview: DisplayPreview | null
  onUpdateDisplayLines: (lines: number) => Promise<boolean>
  onUpdateDisplayWidth: (width: number) => Promise<boolean>
}

export function Settings({settings, displayPreview, onUpdateDisplayLines, onUpdateDisplayWidth}: SettingsProps) {
  const [displayLines, setDisplayLines] = useState(settings?.displayLines || 3)
  const [displayWidth, setDisplayWidth] = useState(settings?.displayWidth || 1)

  // Sync local state with props when settings change (e.g., from SSE update or initial load)
  useEffect(() => {
    if (settings) {
      setDisplayLines(settings.displayLines)
      setDisplayWidth(settings.displayWidth)
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

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Loading settings...</p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      {/* Preview Section */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Preview</h3>
        <div className="p-4 bg-white rounded-2xl shadow-sm border border-gray-100 min-h-[100px] overflow-x-auto">
          {displayPreview?.text ? (
            <div className="space-y-0.5">
              {displayPreview.lines.map((line, i) => (
                <p
                  key={i}
                  className={`text-xs font-['Red_Hat_Display'] leading-tight whitespace-pre ${
                    displayPreview.isFinal ? "text-gray-800" : "text-gray-500"
                  }`}>
                  {line || "\u00A0"} {/* Non-breaking space for empty lines */}
                </p>
              ))}
            </div>
          ) : (
            <p className="text-gray-400 text-sm font-['Red_Hat_Display'] leading-relaxed italic">
              Captions will appear here
            </p>
          )}
        </div>
      </div>

      {/* Glasses Display Settings */}
      <div className="space-y-4">
        <h2 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Glasses Display Settings</h2>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-6">
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
                className="text-gray-900">
                <path d="M4 8V5a1 1 0 0 1 1-1h3" />
                <path d="M16 4h3a1 1 0 0 1 1 1v3" />
                <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
                <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
              </svg>
              <span className="text-base font-medium text-gray-900 font-['Red_Hat_Display']">Display lines</span>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {[2, 3, 4, 5].map((lines) => (
                <button
                  key={lines}
                  onClick={() => handleDisplayLinesChange(lines)}
                  className={`py-3 rounded-xl text-lg font-medium font-['Red_Hat_Display'] transition-colors ${
                    displayLines === lines ? "text-white shadow-sm" : "bg-gray-50 text-gray-900 hover:bg-gray-100"
                  }`}
                  style={displayLines === lines ? {backgroundColor: "#6DAEA6"} : {}}>
                  {lines}
                </button>
              ))}
            </div>
          </div>

          {/* Divider */}
          <div className="h-px bg-gray-100 w-full" />

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
                className="text-gray-900">
                <path d="M17 8l4 4-4 4" />
                <path d="M7 16l-4-4 4-4" />
                <line x1="3" y1="12" x2="21" y2="12" />
              </svg>
              <span className="text-base font-medium text-gray-900 font-['Red_Hat_Display']">Display Width</span>
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
                    displayWidth === option.value
                      ? "text-white shadow-sm"
                      : "bg-gray-50 text-gray-900 hover:bg-gray-100"
                  }`}
                  style={displayWidth === option.value ? {backgroundColor: "#6DAEA6"} : {}}>
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
