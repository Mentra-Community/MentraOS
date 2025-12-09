/**
 * RandomTester Component
 *
 * Generates random text combinations to stress test the wrapping logic
 * with various edge cases, scripts, and character combinations.
 */

import {useState, useCallback, useMemo} from "react"

import {
  DISPLAY_WIDTH_PX,
  MAX_SAFE_BYTES,
  calculateTextWidth,
  calculateByteSize,
  analyzeText,
  type ScriptType,
} from "@/lib/glyphWidths"
import {wrapText, type WrapResult} from "@/lib/textWrapper"
import {
  generateRandomText,
  generateToWidth,
  generateRandomEdgeCase,
  EdgeCases,
  type GeneratorOptions,
} from "@/lib/randomTextGenerator"

interface RandomTesterProps {
  onSendToGlasses?: (text: string) => void
}

/**
 * Display line with width indicator
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
 * Glasses display preview
 */
function GlassesDisplay({lines, totalBytes}: {lines: WrapResult["lines"]; totalBytes: number}) {
  const isOverBytes = totalBytes > MAX_SAFE_BYTES

  return (
    <div className="bg-black rounded-2xl p-4 border border-gray-700">
      <div className="flex justify-between items-center mb-2 text-xs text-gray-500">
        <span>G1 Display Preview</span>
        <span className={isOverBytes ? "text-red-500" : "text-gray-500"}>
          {totalBytes}b / {MAX_SAFE_BYTES}b
        </span>
      </div>

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

      <div className="flex justify-between items-center mt-2 text-xs text-gray-500">
        <span>{lines.length} lines</span>
        <span>576px max width</span>
      </div>
    </div>
  )
}

/**
 * Test result item
 */
interface TestResult {
  id: string
  name: string
  text: string
  wrapResult: WrapResult
  passed: boolean
  timestamp: number
}

function TestResultItem({result, onSelect}: {result: TestResult; onSelect: () => void}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left p-3 rounded-xl transition-colors ${
        result.passed
          ? "bg-green-50 border border-green-200 hover:bg-green-100"
          : "bg-red-50 border border-red-200 hover:bg-red-100"
      }`}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-lg ${result.passed ? "text-green-600" : "text-red-600"}`}>
              {result.passed ? "✓" : "✗"}
            </span>
            <span className="text-sm font-medium text-gray-800">{result.name}</span>
          </div>
          <p className="text-xs text-gray-500 mt-1 truncate font-mono">{result.text}</p>
          <div className="flex gap-3 mt-1 text-xs text-gray-500">
            <span>{result.wrapResult.totalCharCount} chars</span>
            <span>{result.wrapResult.totalByteSize}b</span>
            <span>{result.wrapResult.lines.length} lines</span>
          </div>
        </div>
      </div>
    </button>
  )
}

export function RandomTester({onSendToGlasses}: RandomTesterProps) {
  const [currentText, setCurrentText] = useState("")
  const [testResults, setTestResults] = useState<TestResult[]>([])
  const [selectedResult, setSelectedResult] = useState<TestResult | null>(null)
  const [isRunningBatch, setIsRunningBatch] = useState(false)
  const [script, setScript] = useState<ScriptType | "mixed_latin" | "all_supported">("latin")
  const [autoRun, setAutoRun] = useState(false)

  // Current text analysis
  const currentWrapResult = useMemo(() => {
    if (!currentText) {
      return {
        lines: [],
        totalPixelWidth: 0,
        totalByteSize: 0,
        totalCharCount: 0,
        truncated: false,
        dominantScript: "latin" as ScriptType,
      }
    }
    return wrapText(currentText)
  }, [currentText])

  const currentAnalysis = useMemo(() => {
    if (!currentText) return null
    return analyzeText(currentText)
  }, [currentText])

  // Generate random text
  const handleGenerate = useCallback(() => {
    const text = generateRandomText({script, minWords: 5, maxWords: 20})
    setCurrentText(text)
  }, [script])

  // Generate to exact width
  const handleGenerateToWidth = useCallback(() => {
    const text = generateToWidth(DISPLAY_WIDTH_PX, script === "mixed_latin" ? "latin" : (script as ScriptType))
    setCurrentText(text)
  }, [script])

  // Generate edge case
  const handleGenerateEdgeCase = useCallback(() => {
    const {name, text} = generateRandomEdgeCase()
    setCurrentText(text)
  }, [])

  // Run single test
  const runTest = useCallback(
    (name: string, text: string): TestResult => {
      const wrapResult = wrapText(text)
      const analysis = analyzeText(text)

      // Test passes if:
      // 1. No line exceeds max width
      // 2. Total bytes don't exceed limit
      // 3. All characters are supported
      const passed =
        wrapResult.lines.every((l) => l.pixelWidth <= DISPLAY_WIDTH_PX) &&
        wrapResult.totalByteSize <= MAX_SAFE_BYTES &&
        analysis.isSupported

      return {
        id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name,
        text,
        wrapResult,
        passed,
        timestamp: Date.now(),
      }
    },
    [],
  )

  // Test current text
  const handleTestCurrent = useCallback(() => {
    if (!currentText) return

    const result = runTest("Custom Text", currentText)
    setTestResults((prev) => [result, ...prev].slice(0, 50))
    setSelectedResult(result)
  }, [currentText, runTest])

  // Run batch tests
  const handleRunBatch = useCallback(async () => {
    setIsRunningBatch(true)

    const tests: {name: string; text: string}[] = [
      // Edge cases
      {name: "All Narrow (144)", text: EdgeCases.allNarrow(144)},
      {name: "All Wide (36)", text: EdgeCases.allWide(36)},
      {name: "Exact Width", text: EdgeCases.exactWidth()},
      {name: "One Pixel Over", text: EdgeCases.onePixelOver()},
      {name: "Long Word", text: EdgeCases.longUnbreakableWord()},
      {name: "Many Short Words", text: EdgeCases.manyShortWords()},
      {name: "Alternating Widths", text: EdgeCases.alternatingWidths()},
      {name: "Numbers Only", text: EdgeCases.numbersOnly()},
      {name: "Heavy Punctuation", text: EdgeCases.heavyPunctuation()},
      {name: "CJK Max Safe", text: EdgeCases.cjkMaxSafe()},
      {name: "Korean Max Safe", text: EdgeCases.koreanMaxSafe()},
      {name: "Multiple Spaces", text: EdgeCases.multipleSpaces()},
      {name: "Near Byte Limit", text: EdgeCases.nearByteLimit()},

      // Random Latin
      {name: "Random Latin 1", text: generateRandomText({script: "latin", minWords: 5, maxWords: 15})},
      {name: "Random Latin 2", text: generateRandomText({script: "latin", minWords: 10, maxWords: 25})},
      {name: "Random Latin 3", text: generateRandomText({script: "latin", minWords: 3, maxWords: 8})},

      // Random CJK
      {name: "Random Chinese", text: generateRandomText({script: "chinese", minWords: 5, maxWords: 15})},
      {name: "Random Japanese", text: generateRandomText({script: "japanese_hiragana", minWords: 5, maxWords: 15})},
      {name: "Random Korean", text: generateRandomText({script: "korean", minWords: 5, maxWords: 15})},

      // Width tests
      {name: "Latin Full Width", text: generateToWidth(DISPLAY_WIDTH_PX, "latin")},
      {name: "Chinese Full Width", text: generateToWidth(DISPLAY_WIDTH_PX, "chinese")},
      {name: "Korean Full Width", text: generateToWidth(DISPLAY_WIDTH_PX, "korean")},
    ]

    const results: TestResult[] = []

    for (const test of tests) {
      const result = runTest(test.name, test.text)
      results.push(result)

      // Small delay for visual feedback
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    setTestResults((prev) => [...results, ...prev].slice(0, 100))
    setIsRunningBatch(false)
  }, [runTest])

  // Clear results
  const handleClear = useCallback(() => {
    setTestResults([])
    setSelectedResult(null)
  }, [])

  // Send to glasses
  const handleSend = useCallback(() => {
    if (onSendToGlasses && currentText) {
      onSendToGlasses(currentText)
    }
  }, [onSendToGlasses, currentText])

  // Stats
  const stats = useMemo(() => {
    const total = testResults.length
    const passed = testResults.filter((r) => r.passed).length
    const failed = total - passed
    return {total, passed, failed, passRate: total > 0 ? ((passed / total) * 100).toFixed(1) : "0"}
  }, [testResults])

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      {/* Generator Controls */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
          Random Text Generator
        </h3>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-4">
          {/* Script selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Script Type</label>
            <div className="flex flex-wrap gap-1">
              {[
                {id: "latin", label: "Latin"},
                {id: "mixed_latin", label: "Mixed Latin"},
                {id: "chinese", label: "Chinese"},
                {id: "japanese_hiragana", label: "Japanese"},
                {id: "korean", label: "Korean"},
                {id: "cyrillic", label: "Cyrillic"},
              ].map((s) => (
                <button
                  key={s.id}
                  onClick={() => setScript(s.id as typeof script)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    script === s.id
                      ? "bg-[#6DAEA6] text-white"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                  }`}>
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex flex-wrap gap-2">
            <button
              onClick={handleGenerate}
              className="px-3 py-2 bg-[#6DAEA6] text-white rounded-lg text-sm font-medium hover:bg-opacity-90 transition-colors">
              Generate Random
            </button>
            <button
              onClick={handleGenerateToWidth}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              Generate Full Width
            </button>
            <button
              onClick={handleGenerateEdgeCase}
              className="px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors">
              Random Edge Case
            </button>
          </div>

          {/* Current text input */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Current Text</label>
            <textarea
              value={currentText}
              onChange={(e) => setCurrentText(e.target.value)}
              placeholder="Generated text will appear here, or type your own..."
              className="w-full p-3 bg-gray-50 rounded-xl text-sm resize-none h-24 border-none focus:ring-2 focus:ring-[#6DAEA6] font-mono"
            />
            {currentAnalysis && (
              <div className="flex flex-wrap gap-3 text-xs text-gray-500">
                <span>{currentAnalysis.charCount} chars</span>
                <span>{currentAnalysis.pixelWidth}px</span>
                <span
                  className={currentAnalysis.exceedsByteLimit ? "text-red-600 font-semibold" : ""}>
                  {currentAnalysis.byteSize}b
                </span>
                <span>{currentAnalysis.dominantScript}</span>
                {!currentAnalysis.isSupported && (
                  <span className="text-red-600">
                    Unsupported: {currentAnalysis.unsupportedChars.join(", ")}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Test buttons */}
          <div className="flex gap-2">
            <button
              onClick={handleTestCurrent}
              disabled={!currentText}
              className="px-3 py-2 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Test Current
            </button>
            <button
              onClick={handleSend}
              disabled={!currentText || !onSendToGlasses}
              className="px-3 py-2 bg-[#6DAEA6] text-white rounded-lg text-sm font-medium hover:bg-opacity-90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Send to Glasses
            </button>
          </div>
        </div>
      </div>

      {/* Display Preview */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
          Display Preview
        </h3>
        <GlassesDisplay lines={currentWrapResult.lines} totalBytes={currentWrapResult.totalByteSize} />
      </div>

      {/* Batch Testing */}
      <div className="space-y-3">
        <div className="flex justify-between items-center">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Batch Testing
          </h3>
          {stats.total > 0 && (
            <div className="text-xs text-gray-500">
              <span className="text-green-600">{stats.passed} passed</span>
              {" / "}
              <span className="text-red-600">{stats.failed} failed</span>
              {" ("}
              {stats.passRate}%)
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-4">
          <div className="flex gap-2">
            <button
              onClick={handleRunBatch}
              disabled={isRunningBatch}
              className="px-4 py-2 bg-purple-500 text-white rounded-lg text-sm font-medium hover:bg-purple-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {isRunningBatch ? "Running..." : "Run All Tests"}
            </button>
            <button
              onClick={handleClear}
              disabled={testResults.length === 0}
              className="px-4 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm font-medium text-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              Clear Results
            </button>
          </div>

          {/* Progress indicator */}
          {isRunningBatch && (
            <div className="flex items-center gap-2 text-sm text-gray-600">
              <div className="w-4 h-4 border-2 border-purple-500 border-t-transparent rounded-full animate-spin" />
              Running batch tests...
            </div>
          )}
        </div>
      </div>

      {/* Test Results */}
      {testResults.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Test Results ({testResults.length})
          </h3>

          <div className="space-y-2 max-h-96 overflow-y-auto">
            {testResults.map((result) => (
              <TestResultItem
                key={result.id}
                result={result}
                onSelect={() => {
                  setSelectedResult(result)
                  setCurrentText(result.text)
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Selected Result Details */}
      {selectedResult && (
        <div className="space-y-3">
          <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">
            Selected Test Details
          </h3>

          <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
            <div className="flex items-center gap-2 mb-3">
              <span
                className={`text-2xl ${selectedResult.passed ? "text-green-600" : "text-red-600"}`}>
                {selectedResult.passed ? "✓" : "✗"}
              </span>
              <span className="font-medium">{selectedResult.name}</span>
            </div>

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-gray-500">Characters:</span>
                <span className="ml-2 font-mono">{selectedResult.wrapResult.totalCharCount}</span>
              </div>
              <div>
                <span className="text-gray-500">Bytes:</span>
                <span
                  className={`ml-2 font-mono ${
                    selectedResult.wrapResult.totalByteSize > MAX_SAFE_BYTES
                      ? "text-red-600"
                      : "text-gray-900"
                  }`}>
                  {selectedResult.wrapResult.totalByteSize}
                </span>
              </div>
              <div>
                <span className="text-gray-500">Lines:</span>
                <span className="ml-2 font-mono">{selectedResult.wrapResult.lines.length}</span>
              </div>
              <div>
                <span className="text-gray-500">Max Width:</span>
                <span
                  className={`ml-2 font-mono ${
                    selectedResult.wrapResult.totalPixelWidth > DISPLAY_WIDTH_PX
                      ? "text-red-600"
                      : "text-gray-900"
                  }`}>
                  {selectedResult.wrapResult.totalPixelWidth}px
                </span>
              </div>
            </div>

            {/* Line breakdown */}
            <div className="mt-4 pt-4 border-t border-gray-100">
              <span className="text-sm text-gray-500">Line breakdown:</span>
              <div className="mt-2 space-y-1">
                {selectedResult.wrapResult.lines.map((line, i) => (
                  <div
                    key={i}
                    className={`flex justify-between text-xs font-mono px-2 py-1 rounded ${
                      line.pixelWidth > DISPLAY_WIDTH_PX ? "bg-red-50" : "bg-gray-50"
                    }`}>
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
