import {useState, useMemo} from "react"

import {TestResult} from "@/App"
import {
  DISPLAY_WIDTH_PX,
  MAX_BLE_CHUNK_SIZE,
  MAX_SAFE_BYTES,
  LATIN_GLYPH_WIDTHS,
  calculateTextWidth,
  calculateByteSize,
} from "@/lib/glyphWidths"

// Re-export for use in this component
const calculatePixelWidth = calculateTextWidth
const MAX_PIXEL_WIDTH = DISPLAY_WIDTH_PX

// Get byte size warning level
function getByteWarningLevel(bytes: number): "ok" | "warn" | "danger" {
  if (bytes <= MAX_BLE_CHUNK_SIZE) return "ok"
  if (bytes <= MAX_SAFE_BYTES) return "warn"
  return "danger"
}

// Get CSS class for byte warning level
function getByteWarningClass(bytes: number): string {
  const level = getByteWarningLevel(bytes)
  if (level === "ok") return "text-green-600"
  if (level === "warn") return "text-amber-600"
  return "text-red-600 font-semibold"
}

// Generate test string of specific character type
function generateTestString(charType: "narrow" | "average" | "wide", targetPixels: number): string {
  const charMap = {
    narrow: "l", // 1px glyph → 4px per char
    average: "a", // 5px glyph → 12px per char
    wide: "m", // 7px glyph → 16px per char
  }

  const char = charMap[charType]
  const glyphWidth = LATIN_GLYPH_WIDTHS[char] ?? 5
  const pixelsPerChar = (glyphWidth + 1) * 2
  const charCount = Math.floor(targetPixels / pixelsPerChar)

  return char.repeat(charCount)
}

// Preset test configurations - organized by category
interface Preset {
  name: string
  text?: string // Direct text to send
  charType?: "narrow" | "average" | "wide" // For generated text
  targetPixels?: number // For generated text
  category: "latin" | "cjk" | "cyrillic" | "arabic" | "mixed" | "symbols" | "verified"
  description?: string
}

const PRESETS: Preset[] = [
  // === VERIFIED MAX (576px) ===
  {
    name: "144 × l (verified)",
    text: "l".repeat(144),
    category: "verified",
    description: "Latin narrow: 144 chars = 576px ✓",
  },
  {
    name: "48 × a (verified)",
    text: "a".repeat(48),
    category: "verified",
    description: "Latin average: 48 chars = 576px ✓",
  },
  {
    name: "36 × m (verified)",
    text: "m".repeat(36),
    category: "verified",
    description: "Latin wide: 36 chars = 576px ✓",
  },
  {
    name: "32 × 一 (verified)",
    text: "一".repeat(32),
    category: "verified",
    description: "CJK simple: 32 chars = 576px ✓",
  },
  {
    name: "32 × 的 (verified)",
    text: "的".repeat(32),
    category: "verified",
    description: "CJK common: 32 chars = 576px ✓",
  },
  {
    name: "36 × 國 (verified)",
    text: "國".repeat(36),
    category: "verified",
    description: "CJK complex: 36 chars = 576px ✓",
  },

  // === LATIN MAX TESTS ===
  {
    name: "Latin Narrow Max (144)",
    text: "l".repeat(144),
    category: "latin",
    description: "Test: should fit exactly",
  },
  {
    name: "Latin Narrow +1 (145)",
    text: "l".repeat(145),
    category: "latin",
    description: "Test: should wrap",
  },
  {
    name: "Latin Average Max (48)",
    text: "a".repeat(48),
    category: "latin",
    description: "Test: should fit exactly",
  },
  {
    name: "Latin Average +1 (49)",
    text: "a".repeat(49),
    category: "latin",
    description: "Test: should wrap",
  },
  {
    name: "Latin Wide Max (36)",
    text: "m".repeat(36),
    category: "latin",
    description: "Test: should fit exactly",
  },
  {
    name: "Latin Wide +1 (37)",
    text: "m".repeat(37),
    category: "latin",
    description: "Test: should wrap",
  },

  // === CJK MAX FINDING TESTS ===
  {
    name: "Chinese 一 × 32",
    text: "一".repeat(32),
    category: "cjk",
    description: "Simple stroke - find max",
  },
  {
    name: "Chinese 一 × 33",
    text: "一".repeat(33),
    category: "cjk",
    description: "Simple stroke +1 - should wrap?",
  },
  {
    name: "Chinese 的 × 32",
    text: "的".repeat(32),
    category: "cjk",
    description: "Common char - find max",
  },
  {
    name: "Chinese 的 × 33",
    text: "的".repeat(33),
    category: "cjk",
    description: "Common char +1 - should wrap?",
  },
  {
    name: "Chinese 國 × 36",
    text: "國".repeat(36),
    category: "cjk",
    description: "Complex char - verified max",
  },
  {
    name: "Chinese 國 × 37",
    text: "國".repeat(37),
    category: "cjk",
    description: "Complex char +1 - should wrap",
  },
  {
    name: "Hiragana あ × 32",
    text: "あ".repeat(32),
    category: "cjk",
    description: "Japanese hiragana - find max",
  },
  {
    name: "Hiragana あ × 33",
    text: "あ".repeat(33),
    category: "cjk",
    description: "Japanese hiragana +1 - should wrap?",
  },
  {
    name: "Katakana ア × 32",
    text: "ア".repeat(32),
    category: "cjk",
    description: "Japanese katakana - find max",
  },
  {
    name: "Katakana ア × 33",
    text: "ア".repeat(33),
    category: "cjk",
    description: "Japanese katakana +1 - should wrap?",
  },
  {
    name: "Kanji 日 × 32",
    text: "日".repeat(32),
    category: "cjk",
    description: "Japanese kanji - find max",
  },
  {
    name: "Kanji 日 × 33",
    text: "日".repeat(33),
    category: "cjk",
    description: "Japanese kanji +1 - should wrap?",
  },
  {
    name: "Korean 가 × 32",
    text: "가".repeat(32),
    category: "cjk",
    description: "Korean hangul - find max",
  },
  {
    name: "Korean 가 × 33",
    text: "가".repeat(33),
    category: "cjk",
    description: "Korean hangul +1 - should wrap?",
  },
  {
    name: "Korean 한 × 32",
    text: "한".repeat(32),
    category: "cjk",
    description: "Korean hangul 2 - find max",
  },
  {
    name: "Korean 한 × 33",
    text: "한".repeat(33),
    category: "cjk",
    description: "Korean hangul 2 +1 - should wrap?",
  },

  // === CYRILLIC MAX FINDING ===
  {
    name: "Cyrillic а × 48",
    text: "а".repeat(48),
    category: "cyrillic",
    description: "Russian lowercase - try Latin-like",
  },
  {
    name: "Cyrillic а × 50",
    text: "а".repeat(50),
    category: "cyrillic",
    description: "Russian lowercase - find max",
  },
  {
    name: "Cyrillic а × 55",
    text: "а".repeat(55),
    category: "cyrillic",
    description: "Russian lowercase - find max",
  },
  {
    name: "Cyrillic ш × 36",
    text: "ш".repeat(36),
    category: "cyrillic",
    description: "Russian wide char - try Latin-like",
  },
  {
    name: "Cyrillic ш × 40",
    text: "ш".repeat(40),
    category: "cyrillic",
    description: "Russian wide char - find max",
  },
  {
    name: "Cyrillic Mixed",
    text: "Привет мир это тест кириллицы на очках для проверки",
    category: "cyrillic",
    description: "Mixed Russian text",
  },

  // === ARABIC / HEBREW RTL ===
  {
    name: "Arabic ا × 50",
    text: "ا".repeat(50),
    category: "arabic",
    description: "Arabic alif - narrow char",
  },
  {
    name: "Arabic ا × 60",
    text: "ا".repeat(60),
    category: "arabic",
    description: "Arabic alif - find max",
  },
  {
    name: "Arabic م × 40",
    text: "م".repeat(40),
    category: "arabic",
    description: "Arabic meem - wider char",
  },
  {
    name: "Arabic م × 50",
    text: "م".repeat(50),
    category: "arabic",
    description: "Arabic meem - find max",
  },
  {
    name: "Arabic Text",
    text: "مرحبا بالعالم هذا اختبار للنص العربي على النظارات",
    category: "arabic",
    description: "Arabic sentence - RTL test",
  },
  {
    name: "Hebrew א × 50",
    text: "א".repeat(50),
    category: "arabic",
    description: "Hebrew aleph - find max",
  },
  {
    name: "Hebrew א × 60",
    text: "א".repeat(60),
    category: "arabic",
    description: "Hebrew aleph - find max",
  },
  {
    name: "Hebrew Text",
    text: "שלום עולם זה בדיקה של טקסט עברי על המשקפיים",
    category: "arabic",
    description: "Hebrew sentence - RTL test",
  },

  // === THAI / VIETNAMESE / OTHER ===
  {
    name: "Thai ก × 40",
    text: "ก".repeat(40),
    category: "mixed",
    description: "Thai - find max",
  },
  {
    name: "Thai ก × 50",
    text: "ก".repeat(50),
    category: "mixed",
    description: "Thai - find max",
  },
  {
    name: "Thai Text",
    text: "สวัสดีโลกนี่คือการทดสอบข้อความภาษาไทย",
    category: "mixed",
    description: "Thai sentence",
  },
  {
    name: "Vietnamese",
    text: "Xin chào thế giới đây là bài kiểm tra tiếng Việt",
    category: "mixed",
    description: "Vietnamese with diacritics",
  },
  {
    name: "Greek α × 48",
    text: "α".repeat(48),
    category: "mixed",
    description: "Greek lowercase - find max",
  },
  {
    name: "Greek Text",
    text: "Γειά σου κόσμε αυτό είναι ένα τεστ ελληνικών",
    category: "mixed",
    description: "Greek sentence",
  },
  {
    name: "Hindi Text",
    text: "नमस्ते दुनिया यह हिंदी पाठ का परीक्षण है",
    category: "mixed",
    description: "Hindi Devanagari script",
  },

  // === SYMBOLS & EMOJI ===
  {
    name: "Emoji × 10",
    text: "😀".repeat(10),
    category: "symbols",
    description: "Single emoji repeated - find max",
  },
  {
    name: "Emoji × 15",
    text: "😀".repeat(15),
    category: "symbols",
    description: "Single emoji repeated - find max",
  },
  {
    name: "Emoji × 20",
    text: "😀".repeat(20),
    category: "symbols",
    description: "Single emoji repeated - find max",
  },
  {
    name: "Emoji Various",
    text: "😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍",
    category: "symbols",
    description: "Various emoji - 15 total",
  },
  {
    name: "Emoji + Text",
    text: "Hello 👋 World 🌍 Test 🧪 Done ✅",
    category: "symbols",
    description: "Emoji mixed with Latin",
  },
  {
    name: "Numbers × 60",
    text: "1234567890".repeat(6),
    category: "symbols",
    description: "Numbers - find max",
  },
  {
    name: "Punctuation",
    text: "!@#$%^&*()[]{}|:;<>,.?/".repeat(2),
    category: "symbols",
    description: "Special characters",
  },
]

// Get presets by category
function getPresetsByCategory(category: Preset["category"]): Preset[] {
  return PRESETS.filter((p) => p.category === category)
}

const PRESET_CATEGORIES: Array<{id: Preset["category"]; name: string}> = [
  {id: "verified", name: "✓ Verified (576px)"},
  {id: "latin", name: "Latin"},
  {id: "cjk", name: "CJK (中日韓)"},
  {id: "cyrillic", name: "Cyrillic"},
  {id: "arabic", name: "Arabic/Hebrew"},
  {id: "mixed", name: "Mixed Scripts"},
  {id: "symbols", name: "Symbols/Emoji"},
]

// Helper function to get result badge class
function getResultBadgeClass(result: string): string {
  if (result === "single-line") return "bg-green-100 text-green-700"
  if (result === "wrapped") return "bg-amber-100 text-amber-700"
  return "bg-red-100 text-red-700"
}

interface SettingsProps {
  lastSentText: string | null
  testResults: TestResult[]
  onSendTest: (text: string, charType: "narrow" | "average" | "wide" | "mixed", pixels: number) => void
  onMarkResult: (testId: string, result: "single-line" | "wrapped" | "clipped") => void
  onClearResults: () => void
}

export function Settings({lastSentText, testResults, onSendTest, onMarkResult, onClearResults}: SettingsProps) {
  const [customText, setCustomText] = useState("")
  const [targetPixels, setTargetPixels] = useState(MAX_PIXEL_WIDTH)
  const [selectedCharType, setSelectedCharType] = useState<"narrow" | "average" | "wide">("average")
  const [selectedCategory, setSelectedCategory] = useState<Preset["category"]>("verified")

  const customTextPixels = useMemo(() => calculatePixelWidth(customText), [customText])
  const customTextBytes = useMemo(() => calculateByteSize(customText), [customText])

  const generatedText = useMemo(
    () => generateTestString(selectedCharType, targetPixels),
    [selectedCharType, targetPixels],
  )
  const generatedPixels = useMemo(() => calculatePixelWidth(generatedText), [generatedText])

  const handleSendGenerated = () => {
    onSendTest(generatedText, selectedCharType, generatedPixels)
  }

  const handleSendCustom = () => {
    if (customText.trim()) {
      onSendTest(customText, "mixed", customTextPixels)
    }
  }

  const handlePreset = (preset: Preset) => {
    let text: string
    let charType: "narrow" | "average" | "wide" | "mixed"

    if (preset.text) {
      // Direct text preset
      text = preset.text
      charType = "mixed"
    } else if (preset.charType && preset.targetPixels) {
      // Generated text preset
      text = generateTestString(preset.charType, preset.targetPixels)
      charType = preset.charType
    } else {
      return
    }

    const pixels = calculatePixelWidth(text)
    onSendTest(text, charType, pixels)
  }

  const categoryPresets = useMemo(() => getPresetsByCategory(selectedCategory), [selectedCategory])

  return (
    <div className="h-full overflow-y-auto px-4 py-6 space-y-6 bg-zinc-100">
      {/* Preview Section */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Preview (Last Sent)</h3>
        <div className="p-4 bg-black rounded-2xl shadow-sm border border-gray-700 min-h-[60px] overflow-x-auto">
          {lastSentText ? (
            <p className="text-green-400 text-xs font-mono leading-tight whitespace-pre">{lastSentText}</p>
          ) : (
            <p className="text-gray-500 text-sm font-['Red_Hat_Display'] italic">No text sent yet</p>
          )}
        </div>
        {lastSentText && (
          <div className="flex flex-wrap gap-4 text-xs text-gray-600">
            <span>Chars: {lastSentText.length}</span>
            <span>Pixels: {calculatePixelWidth(lastSentText)}px</span>
            <span className={getByteWarningClass(calculateByteSize(lastSentText))}>
              Bytes: {calculateByteSize(lastSentText)}{" "}
              {calculateByteSize(lastSentText) > MAX_BLE_CHUNK_SIZE &&
                `(${Math.ceil(calculateByteSize(lastSentText) / MAX_BLE_CHUNK_SIZE)} chunks)`}
            </span>
          </div>
        )}
      </div>

      {/* Character Test Presets */}
      <div className="space-y-3">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Character Test Presets</h3>

        {/* Category Tabs */}
        <div className="flex gap-1 overflow-x-auto pb-2">
          {PRESET_CATEGORIES.map((cat) => (
            <button
              key={cat.id}
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                selectedCategory === cat.id
                  ? "bg-[#6DAEA6] text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50 border border-gray-200"
              }`}>
              {cat.name}
            </button>
          ))}
        </div>

        {/* Presets for selected category */}
        <div className="grid grid-cols-1 gap-2">
          {categoryPresets.map((preset) => (
            <button
              key={preset.name}
              onClick={() => handlePreset(preset)}
              className="py-2 px-3 bg-white rounded-xl text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors border border-gray-200 text-left">
              <div className="flex justify-between items-center">
                <span>{preset.name}</span>
                {preset.text && (
                  <span className="text-xs text-gray-400">
                    {preset.text.length} chars · {calculateByteSize(preset.text)}b
                  </span>
                )}
              </div>
              {preset.description && <p className="text-xs text-gray-400 mt-0.5">{preset.description}</p>}
              {preset.text && <p className="text-xs text-gray-500 mt-1 truncate font-mono">{preset.text}</p>}
            </button>
          ))}
        </div>
      </div>

      {/* Test String Generator */}
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Generate Test String</h3>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-4">
          {/* Character Type */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Character Type</label>
            <div className="grid grid-cols-3 gap-2">
              {(["narrow", "average", "wide"] as const).map((type) => (
                <button
                  key={type}
                  onClick={() => setSelectedCharType(type)}
                  className={`py-2 rounded-xl text-sm font-medium transition-colors ${
                    selectedCharType === type ? "text-white" : "bg-gray-50 text-gray-900 hover:bg-gray-100"
                  }`}
                  style={selectedCharType === type ? {backgroundColor: "#6DAEA6"} : {}}>
                  {type.charAt(0).toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-500">
              {selectedCharType === "narrow" && "Using 'l' (1px glyph → 4px per char)"}
              {selectedCharType === "average" && "Using 'a' (5px glyph → 12px per char)"}
              {selectedCharType === "wide" && "Using 'm' (7px glyph → 16px per char)"}
            </p>
          </div>

          {/* Target Pixels */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Target Pixel Width: {targetPixels}px</label>
            <input
              type="range"
              min="100"
              max="700"
              value={targetPixels}
              onChange={(e) => setTargetPixels(parseInt(e.target.value))}
              className="w-full accent-[#6DAEA6]"
            />
            <div className="flex justify-between text-xs text-gray-500">
              <span>100px</span>
              <span>576px (hardware max)</span>
              <span>700px</span>
            </div>
          </div>

          {/* Generated Preview */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-700">Generated String</label>
            <div className="p-3 bg-gray-50 rounded-xl font-mono text-xs break-all max-h-20 overflow-y-auto">
              {generatedText || "—"}
            </div>
            <div className="flex justify-between text-xs text-gray-500">
              <span>{generatedText.length} chars</span>
              <span>{generatedPixels}px actual</span>
            </div>
          </div>

          {/* Send Button */}
          <button
            onClick={handleSendGenerated}
            className="w-full py-3 rounded-xl text-white font-semibold text-base transition-colors"
            style={{backgroundColor: "#6DAEA6"}}>
            Send to Glasses
          </button>
        </div>
      </div>

      {/* Custom Text */}
      <div className="space-y-4">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Custom Text</h3>

        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-4">
          <textarea
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            placeholder="Enter custom text to test..."
            className="w-full p-3 bg-gray-50 rounded-xl text-sm resize-none h-20 border-none focus:ring-2 focus:ring-[#6DAEA6]"
          />
          <div className="flex justify-between text-xs text-gray-500">
            <span>{customText.length} chars</span>
            <span>{customTextPixels}px</span>
            <span className={getByteWarningClass(customTextBytes)}>{customTextBytes} bytes</span>
          </div>
          {customTextBytes > MAX_BLE_CHUNK_SIZE && customTextBytes <= MAX_SAFE_BYTES && (
            <div className="text-xs text-amber-600 bg-amber-50 px-2 py-1 rounded">
              ⚠️ {Math.ceil(customTextBytes / MAX_BLE_CHUNK_SIZE)} BLE chunks needed (176 bytes max per chunk)
            </div>
          )}
          {customTextBytes > MAX_SAFE_BYTES && (
            <div className="text-xs text-red-600 bg-red-50 px-2 py-1 rounded font-semibold">
              🚨 {customTextBytes}b exceeds safe limit ({MAX_SAFE_BYTES}b) - will likely crash glasses!
            </div>
          )}
          <button
            onClick={handleSendCustom}
            disabled={!customText.trim()}
            className="w-full py-3 rounded-xl text-white font-semibold text-base transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{backgroundColor: "#6DAEA6"}}>
            Send Custom Text
          </button>
        </div>
      </div>

      {/* Test Results */}
      {testResults.length > 0 && (
        <div className="space-y-3">
          <div className="flex justify-between items-center">
            <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">Test Results</h3>
            <button onClick={onClearResults} className="text-sm text-red-500 hover:text-red-600">
              Clear All
            </button>
          </div>

          <div className="space-y-2">
            {testResults.map((result) => (
              <div key={result.id} className="bg-white rounded-xl p-3 shadow-sm border border-gray-100">
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <span className="text-xs font-medium text-gray-500 uppercase">{result.charType}</span>
                    <p className="text-sm text-gray-800">
                      {result.charCount} chars · {result.calculatedPixels}px ·{" "}
                      <span className={getByteWarningClass(result.byteSize)}>{result.byteSize}b</span>
                    </p>
                  </div>
                  {result.result && (
                    <span
                      className={`text-xs px-2 py-1 rounded-full font-medium ${getResultBadgeClass(result.result)}`}>
                      {result.result}
                    </span>
                  )}
                </div>

                {!result.result && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => onMarkResult(result.id, "single-line")}
                      className="flex-1 py-1.5 text-xs font-medium bg-green-50 text-green-700 rounded-lg hover:bg-green-100">
                      ✓ Single Line
                    </button>
                    <button
                      onClick={() => onMarkResult(result.id, "wrapped")}
                      className="flex-1 py-1.5 text-xs font-medium bg-amber-50 text-amber-700 rounded-lg hover:bg-amber-100">
                      ↩ Wrapped
                    </button>
                    <button
                      onClick={() => onMarkResult(result.id, "clipped")}
                      className="flex-1 py-1.5 text-xs font-medium bg-red-50 text-red-700 rounded-lg hover:bg-red-100">
                      ✂ Clipped
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Info Section */}
      <div className="space-y-3 pb-6">
        <h3 className="text-base font-semibold text-gray-900 font-['Red_Hat_Display']">G1 Display Specs</h3>
        <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 space-y-3 text-sm text-gray-600">
          <div className="flex items-center gap-2 text-green-700 bg-green-50 px-3 py-2 rounded-lg">
            <span className="font-semibold">✓ Hardware Max Width: 576px</span>
          </div>
          <div className="flex items-center gap-2 text-amber-700 bg-amber-50 px-3 py-2 rounded-lg">
            <span className="font-semibold">⚠️ BLE Chunk: 176 bytes | Safe Max: 390 bytes</span>
          </div>

          <div>
            <strong>✅ Supported Scripts:</strong>
            <table className="mt-1 text-xs w-full">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 text-left">Script</th>
                  <th className="py-1 text-right">px/char</th>
                  <th className="py-1 text-right">Max/Line</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Latin narrow (l, i)</td>
                  <td className="py-1 text-right">4px</td>
                  <td className="py-1 text-right font-mono">144</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Latin average (a, e)</td>
                  <td className="py-1 text-right">12px</td>
                  <td className="py-1 text-right font-mono">48</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Latin wide (m, w)</td>
                  <td className="py-1 text-right">16px</td>
                  <td className="py-1 text-right font-mono">36</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Numbers (0-9)</td>
                  <td className="py-1 text-right">~12px</td>
                  <td className="py-1 text-right font-mono">49</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Punctuation (!@#)</td>
                  <td className="py-1 text-right">~8.5px</td>
                  <td className="py-1 text-right font-mono">68</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Chinese/Japanese</td>
                  <td className="py-1 text-right">18px</td>
                  <td className="py-1 text-right font-mono">32</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Korean Hangul</td>
                  <td className="py-1 text-right">24px</td>
                  <td className="py-1 text-right font-mono">24</td>
                </tr>
                <tr>
                  <td className="py-1">Cyrillic (Russian)</td>
                  <td className="py-1 text-right">18px</td>
                  <td className="py-1 text-right font-mono">32</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <strong>❌ Not Supported:</strong>
            <p className="text-xs text-red-600 mt-1">Arabic, Hebrew, Thai, Emoji, Mixed scripts</p>
          </div>

          <div className="text-xs text-gray-400 mt-2 space-y-1">
            <p>⚠️ CJK safe limit: 26 chars/line × 5 lines = 390 bytes</p>
            <p>⚠️ Korean safe limit: 22 chars/line × 5 lines = 330 bytes</p>
          </div>
        </div>
      </div>
    </div>
  )
}
