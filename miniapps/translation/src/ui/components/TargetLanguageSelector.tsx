import {Check, Search} from "lucide-react"
import type {CSSProperties} from "react"
import {useEffect, useState} from "react"

import {TARGET_LANGUAGES, getFlagEmoji} from "../lib/languages"

interface TargetLanguageSelectorProps {
  currentTargetLanguage: string
  accentColor?: string
  accentForeground?: string
  onSave: (targetLanguage: string) => Promise<void>
  onCancel: () => void
}

export function TargetLanguageSelector({
  currentTargetLanguage,
  accentColor = "#2089F3",
  accentForeground = "#FFFFFF",
  onSave,
  onCancel,
}: TargetLanguageSelectorProps) {
  const [targetLanguage, setTargetLanguage] = useState(currentTargetLanguage)
  const [searchQuery, setSearchQuery] = useState("")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setTargetLanguage(currentTargetLanguage)
    setSearchQuery("")
  }, [currentTargetLanguage])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(targetLanguage)
    } catch (error) {
      console.error("Failed to save target language:", error)
    } finally {
      setSaving(false)
    }
  }

  const filteredLanguages = TARGET_LANGUAGES.filter(
    (lang) =>
      lang.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lang.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (lang.nativeName && lang.nativeName.toLowerCase().includes(searchQuery.toLowerCase())),
  )

  return (
    <div className="flex flex-col h-full bg-zinc-100 dark:bg-zinc-950">
      <div className="px-6 py-4 flex flex-col gap-4 shrink-0">
        <div className="flex items-center gap-3">
          <div
            className="px-3 py-1.5 rounded-full flex items-center gap-2 shadow-sm"
            style={{backgroundColor: accentColor, color: accentForeground}}>
            <span className="text-lg">{getFlagEmoji(targetLanguage)}</span>
            <span className="text-sm font-semibold font-['Red_Hat_Display']">
              {TARGET_LANGUAGES.find((lang) => lang.code === targetLanguage)?.name ?? targetLanguage}
            </span>
          </div>
          <span className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Any source language</span>
        </div>

        <div className="relative">
          <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400 dark:text-zinc-500" />
          </div>
          <input
            type="text"
            placeholder="Search target language"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full py-3 pl-10 pr-4 bg-white dark:bg-zinc-900 rounded-xl text-base text-gray-900 dark:text-zinc-50 placeholder-gray-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-2 font-['Red_Hat_Display'] shadow-sm"
            style={{"--tw-ring-color": `${accentColor}80`} as CSSProperties}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
        <div className="bg-white dark:bg-zinc-900 rounded-2xl shadow-sm overflow-hidden">
          {filteredLanguages.map((lang) => {
            const selected = targetLanguage === lang.code
            return (
              <button
                key={lang.code}
                onClick={() => setTargetLanguage(lang.code)}
                className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors border-b border-gray-100 dark:border-zinc-800 last:border-0">
                <div className="flex items-center gap-4 min-w-0">
                  <span className="text-2xl overflow-hidden flex-shrink-0">{getFlagEmoji(lang.code)}</span>
                  <div className="flex flex-col items-start min-w-0">
                    <span className="text-base font-bold text-gray-900 dark:text-zinc-50 font-['Red_Hat_Display'] truncate">
                      {lang.name}
                    </span>
                    {lang.nativeName && (
                      <span className="text-sm text-gray-500 dark:text-zinc-400 font-['Red_Hat_Display'] truncate">
                        {lang.nativeName}
                      </span>
                    )}
                  </div>
                </div>
                {selected && <Check className="w-5 h-5 flex-shrink-0" style={{color: accentColor}} />}
              </button>
            )
          })}
        </div>
      </div>

      <div className="p-6 bg-zinc-100 dark:bg-zinc-950 shrink-0">
        <div className="flex gap-4">
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex-1 py-3.5 bg-white dark:bg-zinc-900 text-gray-900 dark:text-zinc-50 border border-gray-200 dark:border-zinc-700 rounded-full font-bold text-lg font-['Red_Hat_Display'] shadow-sm hover:bg-gray-50 dark:hover:bg-zinc-800 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-3.5 rounded-full font-bold text-lg font-['Red_Hat_Display'] shadow-sm transition-colors disabled:opacity-50"
            style={{backgroundColor: accentColor, color: accentForeground}}>
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  )
}
