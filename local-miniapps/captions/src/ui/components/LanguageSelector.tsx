import {Search, X, Check} from "lucide-react"
import {useState, useEffect} from "react"

import {AVAILABLE_LANGUAGES, getLanguageName, getFlagEmoji} from "../lib/languages"

interface LanguageSelectorProps {
  currentLanguage: string
  currentHints: string[]
  onSave: (language: string, hints: string[]) => Promise<void>
  onCancel: () => void
}

export function LanguageSelector({currentLanguage, currentHints, onSave, onCancel}: LanguageSelectorProps) {
  const [tempLanguage, setTempLanguage] = useState(currentLanguage)
  const [tempHints, setTempHints] = useState<string[]>(currentHints)
  const [searchQuery, setSearchQuery] = useState("")
  const [saving, setSaving] = useState(false)

  // Reset temp state when props change (though this component will likely be mounted/unmounted)
  useEffect(() => {
    setTempLanguage(currentLanguage)
    setTempHints(currentHints)
    setSearchQuery("")
  }, [currentLanguage, currentHints])

  const handleLanguageClick = (code: string) => {
    if (tempLanguage === code) {
      // Deselecting primary
      if (tempHints.length > 0) {
        // Promote first hint to primary
        const newPrimary = tempHints[0]
        setTempLanguage(newPrimary)
        setTempHints((prev) => prev.slice(1))
      } else {
        // Deselecting the last language - go back to Auto mode
        setTempLanguage("auto")
      }
    } else if (tempHints.includes(code)) {
      // Deselecting hint
      setTempHints((prev) => prev.filter((c) => c !== code))
    } else if (tempLanguage === "auto") {
      // First language selection when in auto mode - set as primary
      setTempLanguage(code)
    } else {
      // Selecting new language (as hint)
      setTempHints((prev) => [...prev, code])
    }
  }

  const isSelected = (code: string) => tempLanguage === code || tempHints.includes(code)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(tempLanguage, tempHints)
    } catch (error) {
      console.error("Failed to save language settings:", error)
    } finally {
      setSaving(false)
    }
  }

  const filteredLanguages = AVAILABLE_LANGUAGES.filter(
    (lang) =>
      lang.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      lang.code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (lang.nativeName && lang.nativeName.toLowerCase().includes(searchQuery.toLowerCase())),
  )

  return (
    <div className="flex flex-col h-full bg-zinc-100">
      {/* Header / Selected Chips */}
      <div className="px-6 py-4 flex flex-col gap-4 shrink-0">
        <div className="flex flex-wrap gap-3">
          {/* Primary Language Chip - only show if not auto */}
          {tempLanguage !== "auto" ? (
            <div className="px-3 py-1.5 bg-[#6DAEA6] rounded-full flex items-center gap-2 shadow-sm">
              <span className="text-lg">{getFlagEmoji(tempLanguage)}</span>
              <span className="text-sm font-semibold text-white font-['Red_Hat_Display']">
                {getLanguageName(tempLanguage)}
              </span>
              <button
                onClick={() => handleLanguageClick(tempLanguage)}
                className="ml-1 p-0.5 rounded-full hover:bg-white/20">
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ) : (
            <div className="px-3 py-1.5 bg-[#6DAEA6] rounded-full flex items-center gap-2 shadow-sm">
              <span className="text-lg">🏳️</span>
              <span className="text-sm font-semibold text-white font-['Red_Hat_Display']">Auto</span>
            </div>
          )}

          {/* Hint Chips */}
          {tempHints.map((code) => (
            <div key={code} className="px-3 py-1.5 bg-[#6DAEA6] rounded-full flex items-center gap-2 shadow-sm">
              <span className="text-lg">{getFlagEmoji(code)}</span>
              <span className="text-sm font-semibold text-white font-['Red_Hat_Display']">{getLanguageName(code)}</span>
              <button onClick={() => handleLanguageClick(code)} className="ml-1 p-0.5 rounded-full hover:bg-white/20">
                <X className="w-3 h-3 text-white" />
              </button>
            </div>
          ))}
        </div>

        {/* Search Bar */}
        <div className="relative">
          <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            placeholder="Search languages"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full py-3 pl-10 pr-4 bg-white rounded-xl text-base text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#6DAEA6]/50 font-['Red_Hat_Display'] shadow-sm"
          />
        </div>
      </div>

      {/* Language List */}
      <div className="flex-1 overflow-y-auto min-h-0 px-6 pb-4">
        <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
          {filteredLanguages.map((lang) => {
            const selected = isSelected(lang.code)
            return (
              <button
                key={lang.code}
                onClick={() => handleLanguageClick(lang.code)}
                className="w-full px-5 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0">
                <div className="flex items-center gap-4">
                  <span className="text-2xl overflow-hidden">{getFlagEmoji(lang.code)}</span>
                  <div className="flex flex-col items-start">
                    <span className="text-base font-bold text-gray-900 font-['Red_Hat_Display']">{lang.name}</span>
                    {lang.nativeName && (
                      <span className="text-sm text-gray-500 font-['Red_Hat_Display']">{lang.nativeName}</span>
                    )}
                  </div>
                </div>
                {selected && <Check className="w-5 h-5 text-[#6DAEA6]" />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-6 bg-zinc-100 shrink-0">
        <div className="flex gap-4">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-3.5 bg-[#6DAEA6] text-white rounded-full font-bold text-lg font-['Red_Hat_Display'] shadow-sm hover:bg-[#5C9A92] transition-colors disabled:opacity-50">
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="flex-1 py-3.5 bg-white text-gray-900 border border-gray-200 rounded-full font-bold text-lg font-['Red_Hat_Display'] shadow-sm hover:bg-gray-50 transition-colors">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
