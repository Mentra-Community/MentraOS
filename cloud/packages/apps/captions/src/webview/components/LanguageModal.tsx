import {X} from "lucide-react"
import {useState, useEffect} from "react"

import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@/components/ui/select"
import {AVAILABLE_LANGUAGES, getLanguageName, getAvailableHints} from "@/lib/languages"

interface LanguageModalProps {
  currentLanguage: string
  currentHints: string[]
  onSave: (language: string, hints: string[]) => Promise<void>
  trigger: React.ReactNode
}

export function LanguageModal({currentLanguage, currentHints, onSave, trigger}: LanguageModalProps) {
  const [open, setOpen] = useState(false)
  const [tempLanguage, setTempLanguage] = useState(currentLanguage)
  const [tempHints, setTempHints] = useState<string[]>(currentHints)
  const [saving, setSaving] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")

  // Reset temp state when modal opens
  useEffect(() => {
    if (open) {
      setTempLanguage(currentLanguage)
      setTempHints(currentHints)
    }
  }, [open, currentLanguage, currentHints])

  const addHint = (code: string) => {
    if (!tempHints.includes(code)) {
      setTempHints((prev) => [...prev, code])
    }
  }

  const removeHint = (code: string) => {
    setTempHints((prev) => prev.filter((c) => c !== code))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(tempLanguage, tempHints)
      setOpen(false)
    } catch (error) {
      console.error("Failed to save language settings:", error)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setOpen(false)
  }

  const availableHints = getAvailableHints(tempLanguage).filter((lang) => !tempHints.includes(lang.code))

  const filteredHints = searchQuery
    ? availableHints.filter((lang) => lang.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : availableHints

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Language Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          {/* Primary Language */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Primary Language</label>
            <Select value={tempLanguage} onValueChange={setTempLanguage}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="w-full">
                {AVAILABLE_LANGUAGES.map((lang) => (
                  <SelectItem key={lang.code} value={lang.code}>
                    {lang.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Language Hints */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Language Hints (Optional)</label>
            <p className="text-xs text-gray-500">Add languages that might appear in conversation</p>

            {/* Selected hints as chips */}
            {tempHints.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {tempHints.map((code) => (
                  <div
                    key={code}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm bg-green-100 text-green-800 border-2 border-green-500">
                    <span>{getLanguageName(code)}</span>
                    <button
                      onClick={() => removeHint(code)}
                      className="hover:bg-green-200 rounded-full p-0.5 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Searchable dropdown to add hints */}
            <div className="space-y-2">
              <Select
                value=""
                onValueChange={(value) => {
                  addHint(value)
                  setSearchQuery("")
                }}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Add a language hint..." />
                </SelectTrigger>
                <SelectContent className="w-full">
                  <div className="p-2">
                    <input
                      type="text"
                      placeholder="Search languages..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full px-2 py-1 text-sm border rounded"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>
                  {filteredHints.length > 0 ? (
                    filteredHints.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.name}
                      </SelectItem>
                    ))
                  ) : (
                    <div className="px-2 py-4 text-sm text-gray-500 text-center">No languages found</div>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleCancel} disabled={saving}>
            Cancel
          </Button>
          <Button className="bg-black hover:bg-gray-800" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
