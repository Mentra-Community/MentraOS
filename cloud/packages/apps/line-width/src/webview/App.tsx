import {useState, useCallback} from "react"

import {Header} from "./components/Header"
import {Settings} from "./components/Settings"
import {TranscriptionPreview} from "./components/TranscriptionPreview"
import {RandomTester} from "./components/RandomTester"
import {useConnection} from "./hooks/useConnection"
import {useTranscripts} from "./hooks/useTranscripts"
import "./index.css"

export interface TestResult {
  id: string
  testString: string
  charCount: number
  calculatedPixels: number
  byteSize: number
  charType: "narrow" | "average" | "wide" | "mixed"
  sentAt: number
  result?: "single-line" | "wrapped" | "clipped" | "unknown"
}

type AppMode = "presets" | "live" | "simulated" | "random"

// Calculate byte size in UTF-8
function calculateByteSize(text: string): number {
  return new TextEncoder().encode(text).length
}

// Hardware constants
const DISPLAY_WIDTH_PX = 576
const MAX_SAFE_BYTES = 390

/**
 * Display line with width indicator - shows pixel usage per line
 */
function DisplayLine({text, pixelWidth, isOverflow}: {text: string; pixelWidth: number; isOverflow: boolean}) {
  const widthPercent = (pixelWidth / DISPLAY_WIDTH_PX) * 100

  return (
    <div className="relative">
      <div
        className={`font-mono text-xs leading-tight whitespace-pre ${isOverflow ? "text-red-400" : "text-green-400"}`}>
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
 * Glasses display preview - shows how text will appear on G1 glasses
 */
function GlassesDisplayPreview({
  lines,
  totalBytes,
  title = "G1 Display Preview",
}: {
  lines: Array<{text: string; pixelWidth: number}>
  totalBytes: number
  title?: string
}) {
  const isOverBytes = totalBytes > MAX_SAFE_BYTES

  return (
    <div className="bg-black rounded-2xl p-4 border border-gray-700">
      {/* Display header */}
      <div className="flex justify-between items-center mb-2 text-xs text-gray-500">
        <span>{title}</span>
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
 * Live Transcription Mode - shows real transcription with display preview
 */
function LiveTranscriptionMode({onSendToGlasses: _onSendToGlasses}: {onSendToGlasses: (text: string) => void}) {
  const {transcripts, connected, error, displayPreview} = useTranscripts()

  // Convert display preview to lines format
  const previewLines =
    displayPreview?.lines.map((text) => ({
      text,
      pixelWidth: estimatePixelWidth(text),
    })) || []

  const totalBytes = displayPreview ? calculateByteSize(displayPreview.text) : 0

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      {/* Connection Status */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Live Transcription</h3>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
          <div className="flex items-center gap-3">
            <div className={`w-3 h-3 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
            <span className="text-sm text-gray-700">
              {connected ? "Connected - Receiving transcription" : "Waiting for glasses connection..."}
            </span>
          </div>
          {error && <p className="mt-2 text-sm text-amber-600">{error}</p>}
          {!connected && (
            <p className="mt-2 text-xs text-gray-500">
              Connect your glasses and start speaking to see live transcription with display preview.
            </p>
          )}
        </div>
      </div>

      {/* Live Display Preview */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Display Preview {displayPreview?.isFinal ? "(Final)" : "(Interim)"}
          </h3>
        </div>

        <GlassesDisplayPreview lines={previewLines} totalBytes={totalBytes} title="Live G1 Display" />

        {displayPreview && (
          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <h4 className="text-sm font-medium text-gray-700 mb-2">Raw Text</h4>
            <pre className="text-xs font-mono bg-gray-50 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap">
              {displayPreview.text || "(empty)"}
            </pre>
            <div className="flex gap-4 mt-2 text-xs text-gray-500">
              <span>{displayPreview.text.length} chars</span>
              <span>{totalBytes} bytes</span>
              <span>{displayPreview.lines.length} lines</span>
            </div>
          </div>
        )}
      </div>

      {/* Recent Transcripts (condensed) */}
      {transcripts.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Recent Transcripts ({transcripts.length})
          </h3>

          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 max-h-48 overflow-y-auto">
            <div className="space-y-2">
              {transcripts.slice(-10).map((t) => (
                <div key={t.id} className={`text-sm ${t.isFinal ? "text-gray-800" : "text-gray-500 italic"}`}>
                  <span className="font-medium text-[#6DAEA6]">{t.speaker}:</span> {t.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Info */}
      <div className="bg-blue-50 rounded-2xl p-4 border border-blue-100">
        <p className="text-sm text-blue-800">
          <strong>💡 Tip:</strong> This mode shows the actual text being sent to your glasses in real-time. The display
          preview uses the same pixel-width calculations as the glasses firmware.
        </p>
      </div>
    </div>
  )
}

/**
 * Simple pixel width estimator for preview
 * Uses average widths - the actual wrapping is done server-side
 */
function estimatePixelWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const code = char.charCodeAt(0)
    // CJK characters
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // Chinese
      (code >= 0x3040 && code <= 0x30ff) || // Japanese
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      // Korean
      width += 18
    }
    // Narrow Latin
    else if ("lij!|.,':;".includes(char)) {
      width += 4
    }
    // Wide Latin
    else if ("mwMW@".includes(char)) {
      width += 16
    }
    // Average Latin and others
    else {
      width += 12
    }
  }
  return width
}

export function App() {
  const {connected, error} = useConnection()
  const [mode, setMode] = useState<AppMode>("presets")
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [lastSentText, setLastSentText] = useState<string | null>(null)

  const handleSendTest = useCallback(
    async (text: string, charType: "narrow" | "average" | "wide" | "mixed", pixels: number) => {
      const result: TestResult = {
        id: `test-${Date.now()}`,
        testString: text,
        charCount: text.length,
        calculatedPixels: pixels,
        byteSize: calculateByteSize(text),
        charType,
        sentAt: Date.now(),
      }

      setTestResults((prev) => [result, ...prev].slice(0, 20))
      setLastSentText(text)

      try {
        const response = await fetch("/api/send-text", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({text, charType, pixels}),
        })

        if (!response.ok) {
          console.error("[LineWidth] Failed to send:", response.status)
        } else {
          console.log("[LineWidth] Sent test:", {text, charType, pixels})
        }
      } catch (err) {
        console.error("[LineWidth] Error sending test:", err)
      }
    },
    [],
  )

  const handleSendToGlasses = useCallback(async (text: string) => {
    setLastSentText(text)

    try {
      const response = await fetch("/api/send-text", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({text}),
      })

      if (!response.ok) {
        console.error("[LineWidth] Failed to send:", response.status)
      } else {
        console.log("[LineWidth] Sent to glasses:", text.substring(0, 50) + "...")
      }
    } catch (err) {
      console.error("[LineWidth] Error sending:", err)
    }
  }, [])

  const handleMarkResult = useCallback((testId: string, result: "single-line" | "wrapped" | "clipped") => {
    setTestResults((prev) => prev.map((t) => (t.id === testId ? {...t, result} : t)))
  }, [])

  const handleClearResults = useCallback(() => {
    setTestResults([])
    setLastSentText(null)
  }, [])

  return (
    <div className="w-screen h-screen bg-zinc-100 flex flex-col overflow-hidden font-sans">
      {/* Header */}
      <Header connected={connected} error={error} />

      {/* Mode Tabs */}
      <div className="w-full px-4 py-2 bg-white border-b border-gray-200">
        <div className="flex gap-1 flex-wrap">
          <button
            onClick={() => setMode("presets")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "presets" ? "bg-[#6DAEA6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            📋 Presets
          </button>
          <button
            onClick={() => setMode("live")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "live" ? "bg-[#6DAEA6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            🎙️ Live
          </button>
          <button
            onClick={() => setMode("simulated")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "simulated" ? "bg-[#6DAEA6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            💬 Simulated
          </button>
          <button
            onClick={() => setMode("random")}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === "random" ? "bg-[#6DAEA6] text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}>
            🎲 Random
          </button>
        </div>
        <div className="mt-1 text-xs text-gray-500">
          {mode === "presets" && "Test predefined character strings and custom text"}
          {mode === "live" && "View live transcription with display preview"}
          {mode === "simulated" && "Simulate diarized transcription with speaker labels"}
          {mode === "random" && "Generate random text and run batch stress tests"}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-hidden">
        {mode === "presets" && (
          <Settings
            lastSentText={lastSentText}
            testResults={testResults}
            onSendTest={handleSendTest}
            onMarkResult={handleMarkResult}
            onClearResults={handleClearResults}
          />
        )}
        {mode === "live" && <LiveTranscriptionMode onSendToGlasses={handleSendToGlasses} />}
        {mode === "simulated" && <TranscriptionPreview onSendToGlasses={handleSendToGlasses} />}
        {mode === "random" && <RandomTester onSendToGlasses={handleSendToGlasses} />}
      </div>
    </div>
  )
}

export default App
