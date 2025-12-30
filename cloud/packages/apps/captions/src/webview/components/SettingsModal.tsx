import {useState, useEffect} from "react"
import {Button} from "@/components/ui/button"
import {Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger} from "@/components/ui/dialog"

interface SettingsModalProps {
  currentLines: number
  currentWidth: number
  onSave: (lines: number, width: number) => Promise<void>
  trigger: React.ReactNode
}

export function SettingsModal({currentLines, currentWidth, onSave, trigger}: SettingsModalProps) {
  const [open, setOpen] = useState(false)
  const [lines, setLines] = useState(currentLines)
  const [width, setWidth] = useState(currentWidth)
  const [saving, setSaving] = useState(false)

  // Reset temp state when modal opens
  useEffect(() => {
    if (open) {
      setLines(currentLines)
      setWidth(currentWidth)
    }
  }, [open, currentLines, currentWidth])

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(lines, width)
      setOpen(false)
    } catch (error) {
      console.error("Failed to save settings:", error)
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Glasses Display Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Display Lines */}
          <div className="space-y-3">
            <label className="text-sm font-medium">Display Lines</label>
            <div className="flex gap-3">
              {[2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  onClick={() => setLines(n)}
                  className={`flex-1 py-2 px-4 rounded-md border-2 text-sm font-medium transition-colors ${
                    lines === n
                      ? "border-black bg-black text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"
                  }`}>
                  {n}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500">Number of text lines on glasses</p>
          </div>

          {/* Display Width */}
          <div className="space-y-3">
            <label className="text-sm font-medium">Display Width</label>
            <div className="flex flex-col gap-2">
              {[
                {value: 30, label: "Narrow (30)"},
                {value: 45, label: "Medium (45)"},
                {value: 60, label: "Wide (60)"},
              ].map((option) => (
                <button
                  key={option.value}
                  onClick={() => setWidth(option.value)}
                  className={`py-2 px-4 rounded-md border-2 text-sm font-medium transition-colors ${
                    width === option.value
                      ? "border-black bg-black text-white"
                      : "border-gray-300 bg-white text-gray-700 hover:border-gray-400"
                  }`}>
                  {option.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500">Characters per line</p>
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
