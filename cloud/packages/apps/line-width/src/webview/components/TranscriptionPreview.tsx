/**
 * TranscriptionPreview Component
 *
 * Shows a preview of diarized transcription text with speaker labels,
 * simulating how it would appear on G1 glasses display.
 */

import {useState, useEffect, useMemo, useCallback} from "react"

import {
  DISPLAY_WIDTH_PX,
  MAX_SAFE_BYTES,
  calculateTextWidth,
  calculateByteSize,
  analyzeText,
} from "@/lib/glyphWidths"
import {wrapText, wrapWithSpeakerLabel, type WrapResult} from "@/lib/textWrapper"
import {
  generateConversation,
  generateRandomText,
  type DiarizedUtterance,
} from "@/lib/randomTextGenerator"

interface TranscriptionPreviewProps {
  onSendToGlasses?: (text: string) => void
}

/**
 * Format speaker label
 */
function formatSpeakerLabel(speaker: number): string {
  return `[${speaker}]:`
}

/**
 * Simulated display line component
 */
function DisplayLine({
  text,
  pixelWidth,
  isOverflow,
}: {
  text: string
  pixelWidth: number
  isOverflow: boolean
}) {
  const widthPercent = (pixelWidth / DISPLAY_WIDTH_PX) * 100

  return (
    <div className="relative">
      <div
        className={`font-mono text-xs leading-tight whitespace-pre ${
          isOverflow ? "text-red-400" : "text-green-400"
        }`}>
        {text || "\u00A0"}
      </div>
      {/* Width indicator bar */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gray-700">
        <div
          className={`h-full ${isOverflow ? "bg-red-500" : "bg-green-500"}`}
          style={{width: `${Math.min(widthPercent, 100)}%`}}
        />
      </div>
    </div>
  )
}

/**
 * Glasses display simulator
 */
function GlassesDisplay({lines, totalBytes}: {lines: WrapResult["lines"]; totalBytes: number}) {
  const isOverBytes = totalBytes > MAX_SAFE_BYTES

  return (
    <div className="bg-black rounded-2xl p-4 border border-gray-700">
      {/* Display header */}
      <div className="flex justify-between items-center mb-2 text-xs text-gray-500">
        <span>G1 Display Preview</span>
        <span className={isOverBytes ? "text-red-500" : "text-gray-500"}>
          {totalBytes}b / {MAX_SAFE_BYTES}b
        </span>
      </div>

      {/* Display area */}
      <div className="space-y-1 min-h-[100px]">
        {lines.length === 0 ? (
          <p className="text-gray-600 text-sm italic">No text to display</p>
        ) : (
          lines.map((line, i) => (
            <DisplayLine
              key={i}
              text={line.text}
              pixelWidth={line.pixelWidth}
              isOverflow={line.pixelWidth > DISPLAY_WIDTH_PX}
            />
          ))
        )}
      </div>

      {/* Display footer */}
      <div className="flex justify-between items-center mt-2 text-xs text-gray-500">
        <span>{lines.length} lines</span>
        <span>576px max width</span>
      </div>
    </div>
  )
}

/**
 * Single utterance display
 */
function UtteranceItem({
  utterance,
  wrapResult,
  isSelected,
  onClick,
}: {
  utterance: DiarizedUtterance
  wrapResult: WrapResult
  isSelected: boolean
  onClick: () => void
}) {
  const speakerColors = [
    "bg-blue-100 text-blue-800",
    "bg-purple-100 text-purple-800",
    "bg-green-100 text-green-800",
    "bg-orange-100 text-orange-800",
  ]

  const colorClass = speakerColors[(utterance.speaker - 1) % speakerColors.length]

  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-xl transition-colors ${
        isSelected ? "bg-[#6DAEA6] bg-opacity-20 border-2 border-[#6DAEA6]" : "bg-white border border-gray-200 hover:bg-gray-50"
      }`}>
      <div className="flex items-start gap-2">
        <span className={`text-xs font-bold px-2 py-0.5 rounded ${colorClass}`}>
          [{utterance.speaker}]
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-800 break-words">{utterance.text}</p>
          <div className="flex gap-3 mt-1 text-xs text-gray-500">
            <span>{wrapResult.totalCharCount} chars</span>
            <span>{wrapResult.totalByteSize}b</span>
            <span>{wrapResult.lines.length} lines</span>
            {wrapResult.truncated && <span className="text-red-500">truncated</span>}
          </div>
        </div>
      </div>
    </button>
  )
}

export function TranscriptionPreview({onSendToGlasses}: TranscriptionPreviewProps) {
  const [utterances, setUtterances] = useState<DiarizedUtterance[]>([])
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [speakerCount, setSpeakerCount] = useState(2)
  const [autoGenerate, setAutoGenerate] = useState(false)
  const [displayMode, setDisplayMode] = useState<"selected" | "all" | "rolling">("selected")

  // Wrap results for all utterances
  const wrapResults = useMemo(() => {
    return utterances.map((u) => wrapWithSpeakerLabel(u.speaker, u.text))
  }, [utterances])

  // Currently displayed wrap result
  const currentDisplay = useMemo((): WrapResult => {
    if (displayMode === "selected" && selectedIndex !== null) {
      return wrapResults[selectedIndex]
    }

    if (displayMode === "all" || displayMode === "rolling") {
      // Combine all utterances into single display
      const allText = utterances.map((u) => `[${u.speaker}]: ${u.text}`).join("\n")
      return wrapText(allText)
    }

    return {
      lines: [],
      totalPixelWidth: 0,
      totalByteSize: 0,
      totalCharCount: 0,
      truncated: false,
      dominantScript: "latin",
    }
  }, [displayMode, selectedIndex, utterances, wrapResults])

  // Generate initial conversation
  useEffect(() => {
    handleGenerateConversation()
  }, [])

  // Auto-generate utterances
  useEffect(() => {
    if (!autoGenerate) return

    const interval = setInterval(() => {
      addUtterance()
    }, 2000)

    return () => clearInterval(interval)
  }, [autoGenerate, speakerCount])

  const handleGenerateConversation = useCallback(() => {
    const newUtterances = generateConversation(5, speakerCount)
    setUtterances(newUtterances)
    setSelectedIndex(0)
  }, [speakerCount])

  const addUtterance = useCallback(() => {
    const speaker = Math.floor(Math.random() * speakerCount) + 1
    const text = generateRandomText({minWords: 3, maxWords: 10})

    setUtterances((prev) => {
      const newUtterances = [...prev, {speaker, text, isFinal: true}]
      // Keep last 10 utterances
      return newUtterances.slice(-10)
    })

    // Auto-select the new utterance
    setSelectedIndex((prev) => (prev !== null ? prev + 1 : 0))
  }, [speakerCount])

  const handleClear = useCallback(() => {
    setUtterances([])
    setSelectedIndex(null)
  }, [])

  const handleSendSelected = useCallback(() => {
    if (selectedIndex === null || !onSendToGlasses) return

    const u = utterances[selectedIndex]
    const text = `[${u.speaker}]: ${u.text}`
    onSendToGlasses(text)
  }, [selectedIndex, utterances, onSendToGlasses])

  const handleSendAll = useCallback(() => {
    if (!onSendToGlasses || utterances.length === 0) return

    const text = utterances.map((u) => `[${u.speaker}]: ${u.text}`).join("\n")
    onSendToGlasses(text)
  }, [utterances, onSendToGlasses])

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      {/* Controls */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
          Transcription Preview
        </h3>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-4">
          {/* Speaker count */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-700">Speakers:</span>
            <div className="flex gap-1">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  onClick={() => setSpeakerCount(n)}
                  className={`w-8 h-8 rounded-lg text-sm font-medium transition-colors ${
                    speakerCount === n
                      ? "bg-[#6DAEA6] text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Display mode */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-700">Display:</span>
            <div className="flex gap-1">
              {[
                {id: "selected", label: "Selected"},
                {id: "all", label: "All"},
                {id: "rolling", label: "Rolling"},
              ].map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => setDisplayMode(mode.id as typeof displayMode)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    displayMode === mode.id
                      ? "bg-[#6DAEA6] text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}>
                  {mode.label}
                </button>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleGenerateConversation}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              Generate New
            </button>
            <button
              onClick={addUtterance}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              + Add Utterance
            </button>
            <button
              onClick={() => setAutoGenerate(!autoGenerate)}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                autoGenerate
                  ? "bg-red-100 text-red-700 hover:bg-red-200"
                  : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}>
              {autoGenerate ? "Stop Auto" : "Auto Generate"}
            </button>
            <button
              onClick={handleClear}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Glasses Display Preview */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Display Preview
          </h3>
          <div className="flex gap-2">
            <button
              onClick={handleSendSelected}
              disabled={selectedIndex === null || !onSendToGlasses}
              className="px-3 py-1.5 bg-[#6DAEA6] text-white rounded-lg text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              Send Selected
            </button>
            <button
              onClick={handleSendAll}
              disabled={utterances.length === 0 || !onSendToGlasses}
              className="px-3 py-1.5 bg-[#6DAEA6] text-white rounded-lg text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed">
              Send All
            </button>
          </div>
        </div>

        <GlassesDisplay lines={currentDisplay.lines} totalBytes={currentDisplay.totalByteSize} />
      </div>

      {/* Utterance List */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
          Utterances ({utterances.length})
        </h3>

        {utterances.length === 0 ? (
          <div className="bg-white rounded-2xl p-6 text-center text-gray-500 border border-gray-200">
            No utterances yet. Click "Generate New" or "Add Utterance" to start.
          </div>
        ) : (
          <div className="space-y-2">
            {utterances.map((utterance, index) => (
              <UtteranceItem
                key={index}
                utterance={utterance}
                wrapResult={wrapResults[index]}
                isSelected={selectedIndex === index}
                onClick={() => setSelectedIndex(index)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Stats */}
      {selectedIndex !== null && wrapResults[selectedIndex] && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Selected Analysis
          </h3>

          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Total chars:</span>
                <span className="ml-2 font-mono">{wrapResults[selectedIndex].totalCharCount}</span>
              </div>
              <div>
                <span className="text-gray-500">Total bytes:</span>
                <span
                  className={`ml-2 font-mono ${
                    wrapResults[selectedIndex].totalByteSize > MAX_SAFE_BYTES
                      ? "text-red-600"
                      : "text-gray-900"
                  }`}>
                  {wrapResults[selectedIndex].totalByteSize}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Lines:</span>
                <span className="ml-2 font-mono">{wrapResults[selectedIndex].lines.length}</span>
              </div>
              <div>
                <span className="text-gray-500">Max width:</span>
                <span className="ml-2 font-mono">{wrapResults[selectedIndex].totalPixelWidth}px</span>
              </div>
              <div>
                <span className="text-gray-500">Script:</span>
                <span className="ml-2 font-mono">{wrapResults[selectedIndex].dominantScript}</span>
              </div>
              <div>
                <span className="text-gray-500">Truncated:</span>
                <span className="ml-2 font-mono">
                  {wrapResults[selectedIndex].truncated ? "Yes" : "No"}
                </span>
              </div>
            </div>

            {/* Line breakdown */}
            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-gray-500">Line breakdown:</span>
              <div className="mt-2 space-y-1">
                {wrapResults[selectedIndex].lines.map((line, i) => (
                  <div key={i} className="flex justify-between text-xs font-mono bg-gray-50 px-2 py-1 rounded">
                    <span className="truncate flex-1">{line.text || "(empty)"}</span>
                    <span className="text-gray-500 ml-2">
                      {line.pixelWidth}px / {line.byteSize}b
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
