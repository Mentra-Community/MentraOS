import {describe, it, expect, beforeEach} from "bun:test"
import {TranscriptProcessor, TranscriptHistoryEntry} from "./TranscriptProcessor"
import {
  isCJKCharacter,
  isFullWidthCharacter,
  getCharWidth,
  getTextVisualWidth,
  getVisualWidthForSetting,
  VisualWidthSettings,
} from "./visualWidth"

// ============================================
// Visual Width Utilities Tests
// ============================================

describe("visualWidth utilities", () => {
  describe("isCJKCharacter", () => {
    it("should identify Chinese characters", () => {
      expect(isCJKCharacter("中")).toBe(true)
      expect(isCJKCharacter("国")).toBe(true)
      expect(isCJKCharacter("你")).toBe(true)
      expect(isCJKCharacter("好")).toBe(true)
    })

    it("should identify Japanese Hiragana", () => {
      expect(isCJKCharacter("あ")).toBe(true)
      expect(isCJKCharacter("い")).toBe(true)
      expect(isCJKCharacter("う")).toBe(true)
    })

    it("should identify Japanese Katakana", () => {
      expect(isCJKCharacter("ア")).toBe(true)
      expect(isCJKCharacter("イ")).toBe(true)
      expect(isCJKCharacter("ウ")).toBe(true)
    })

    it("should identify Korean Hangul", () => {
      expect(isCJKCharacter("한")).toBe(true)
      expect(isCJKCharacter("글")).toBe(true)
    })

    it("should NOT identify Latin characters as CJK", () => {
      expect(isCJKCharacter("a")).toBe(false)
      expect(isCJKCharacter("Z")).toBe(false)
      expect(isCJKCharacter("1")).toBe(false)
      expect(isCJKCharacter(" ")).toBe(false)
      expect(isCJKCharacter(".")).toBe(false)
    })
  })

  describe("getCharWidth", () => {
    it("should return 2.0 for CJK characters", () => {
      expect(getCharWidth("中")).toBe(2.0)
      expect(getCharWidth("あ")).toBe(2.0)
      expect(getCharWidth("한")).toBe(2.0)
    })

    it("should return 1.0 for Latin characters", () => {
      expect(getCharWidth("a")).toBe(1.0)
      expect(getCharWidth("Z")).toBe(1.0)
      expect(getCharWidth("1")).toBe(1.0)
      expect(getCharWidth(" ")).toBe(1.0)
    })

    it("should return 0 for empty string", () => {
      expect(getCharWidth("")).toBe(0)
    })
  })

  describe("getTextVisualWidth", () => {
    it("should calculate width for Latin text", () => {
      expect(getTextVisualWidth("hello")).toBe(5.0)
      expect(getTextVisualWidth("Hello World")).toBe(11.0)
    })

    it("should calculate width for Chinese text", () => {
      expect(getTextVisualWidth("你好")).toBe(4.0) // 2 chars * 2.0
      expect(getTextVisualWidth("中国")).toBe(4.0)
    })

    it("should calculate width for mixed text", () => {
      // "hello你好" = 5 Latin (5.0) + 2 Chinese (4.0) = 9.0
      expect(getTextVisualWidth("hello你好")).toBe(9.0)

      // "Hi 中国 test" = 2 + 1 + 4 + 1 + 4 = 12.0
      expect(getTextVisualWidth("Hi 中国 test")).toBe(12.0)
    })

    it("should return 0 for empty string", () => {
      expect(getTextVisualWidth("")).toBe(0)
    })
  })

  describe("getVisualWidthForSetting", () => {
    it("should convert numeric settings", () => {
      expect(getVisualWidthForSetting(0)).toBe(VisualWidthSettings.narrow)
      expect(getVisualWidthForSetting(1)).toBe(VisualWidthSettings.medium)
      expect(getVisualWidthForSetting(2)).toBe(VisualWidthSettings.wide)
    })

    it("should convert string settings", () => {
      expect(getVisualWidthForSetting("narrow")).toBe(VisualWidthSettings.narrow)
      expect(getVisualWidthForSetting("medium")).toBe(VisualWidthSettings.medium)
      expect(getVisualWidthForSetting("wide")).toBe(VisualWidthSettings.wide)
    })

    it("should handle case-insensitive strings", () => {
      expect(getVisualWidthForSetting("NARROW")).toBe(VisualWidthSettings.narrow)
      expect(getVisualWidthForSetting("Medium")).toBe(VisualWidthSettings.medium)
    })

    it("should pass through already-converted values", () => {
      expect(getVisualWidthForSetting(44)).toBe(44)
      expect(getVisualWidthForSetting(30)).toBe(30)
    })
  })
})

// ============================================
// TranscriptProcessor Tests
// ============================================

describe("TranscriptProcessor", () => {
  let processor: TranscriptProcessor

  beforeEach(() => {
    // Create processor with 44 visual width, 5 lines, 10 max history
    processor = new TranscriptProcessor(44, 5, 10)
  })

  describe("basic text processing", () => {
    it("should process simple Latin text", () => {
      const result = processor.processString("Hello world", true)
      expect(result).toContain("Hello world")
    })

    it("should process Chinese text", () => {
      const result = processor.processString("你好世界", true)
      expect(result).toContain("你好世界")
    })

    it("should process mixed text", () => {
      const result = processor.processString("Hello 你好 World", true)
      expect(result).toContain("Hello 你好 World")
    })

    it("should handle null input", () => {
      const result = processor.processString(null, true)
      // Should not throw, should return lines (possibly empty)
      expect(typeof result).toBe("string")
    })

    it("should handle empty input", () => {
      const result = processor.processString("", true)
      expect(typeof result).toBe("string")
    })
  })

  describe("line wrapping", () => {
    it("should wrap long Latin text", () => {
      const longText = "This is a very long sentence that should be wrapped across multiple lines on the display"
      const result = processor.processString(longText, true)
      const lines = result.split("\n").filter((l) => l.trim() !== "")
      expect(lines.length).toBeGreaterThan(1)
    })

    it("should wrap long Chinese text", () => {
      // Create text that exceeds visual width (44 / 2 = 22 Chinese chars max per line)
      const longChinese = "这是一个非常长的中文句子需要被换行显示在眼镜上面"
      const result = processor.processString(longChinese, true)
      const lines = result.split("\n").filter((l) => l.trim() !== "")
      expect(lines.length).toBeGreaterThan(1)
    })

    it("should respect maxLines limit", () => {
      // Add many transcripts to exceed maxLines
      for (let i = 0; i < 20; i++) {
        processor.processString(`Sentence number ${i} is here`, true)
      }
      const result = processor.getCurrentDisplay()
      const lines = result.split("\n")
      expect(lines.length).toBe(5) // maxLines = 5
    })
  })

  describe("transcript history", () => {
    it("should accumulate final transcripts", () => {
      processor.processString("First sentence.", true)
      processor.processString("Second sentence.", true)
      processor.processString("Third sentence.", true)

      const history = processor.getFinalTranscriptHistory()
      expect(history.length).toBe(3)
      expect(history[0].text).toBe("First sentence.")
      expect(history[1].text).toBe("Second sentence.")
      expect(history[2].text).toBe("Third sentence.")
    })

    it("should not add interim transcripts to history", () => {
      processor.processString("Interim text", false)
      processor.processString("More interim", false)

      const history = processor.getFinalTranscriptHistory()
      expect(history.length).toBe(0)
    })

    it("should respect maxFinalTranscripts limit", () => {
      // Processor created with maxFinalTranscripts = 10
      for (let i = 0; i < 15; i++) {
        processor.processString(`Sentence ${i}`, true)
      }

      const history = processor.getFinalTranscriptHistory()
      expect(history.length).toBe(10)
      // Should have the most recent 10
      expect(history[0].text).toBe("Sentence 5")
      expect(history[9].text).toBe("Sentence 14")
    })
  })

  describe("speaker labels (diarization)", () => {
    it("should add speaker label on speaker change", () => {
      processor.processString("Hello from speaker one", true, "1", true)
      const result = processor.getCurrentDisplay()
      expect(result).toContain("[1]:")
    })

    it("should NOT add speaker label when speaker unchanged", () => {
      processor.processString("First message", true, "1", true)
      processor.processString("Second message same speaker", true, "1", false)

      const result = processor.getCurrentDisplay()
      // Should have [1]: only once (for the first message)
      const matches = result.match(/\[1\]:/g)
      expect(matches?.length).toBe(1)
    })

    it("should add new label when speaker changes", () => {
      processor.processString("Speaker one talking", true, "1", true)
      processor.processString("Speaker two talking", true, "2", true)

      const result = processor.getCurrentDisplay()
      expect(result).toContain("[1]:")
      expect(result).toContain("[2]:")
    })

    it("should handle multiple speaker changes", () => {
      processor.processString("One", true, "1", true)
      processor.processString("Two", true, "2", true)
      processor.processString("One again", true, "1", true)
      processor.processString("Two again", true, "2", true)

      const result = processor.getCurrentDisplay()
      // Should have 4 speaker labels total
      const matches1 = result.match(/\[1\]:/g)
      const matches2 = result.match(/\[2\]:/g)
      expect(matches1?.length).toBe(2)
      expect(matches2?.length).toBe(2)
    })

    it("should preserve speaker info in history", () => {
      processor.processString("Hello", true, "1", true)
      processor.processString("Hi there", true, "2", true)

      const history = processor.getFinalTranscriptHistory()
      expect(history[0].speakerId).toBe("1")
      expect(history[0].hadSpeakerChange).toBe(true)
      expect(history[1].speakerId).toBe("2")
      expect(history[1].hadSpeakerChange).toBe(true)
    })

    it("should NOT show label when speakerChanged is false", () => {
      // When DisplayManager passes speakerChanged=false, no label should appear
      // This happens when the same speaker continues talking
      processor.processString("Just me talking", true, "1", false)
      processor.processString("Still just me", true, "1", false)

      const result = processor.getCurrentDisplay()
      expect(result).not.toContain("[1]:")
    })

    it("should show label for first speaker when speakerChanged is true", () => {
      // DisplayManager sets speakerChanged=true for the first speaker
      // (because speaker changed from undefined to "1")
      // This is the expected behavior - first speaker gets a label
      processor.processString("First speaker starts", true, "1", true)

      const result = processor.getCurrentDisplay()
      expect(result).toContain("[1]:")
    })

    it("should handle speaker labels with interim text", () => {
      processor.processString("Final from one", true, "1", true)
      const interimResult = processor.processString("Interim from two", false, "2", true)

      // Interim should show the speaker label
      expect(interimResult).toContain("[2]:")
    })

    it("should preserve speaker label across multiple interims from same speaker", () => {
      // This tests the real-world scenario where DisplayManager passes speakerChanged=true
      // only on the FIRST interim from a new speaker, then speakerChanged=false for subsequent interims

      // Final from speaker 1
      processor.processString("Hello there", true, "1", true)

      // First interim from speaker 2 - speakerChanged=true
      const interim1 = processor.processString("Hi", false, "2", true)
      expect(interim1).toContain("[1]:")
      expect(interim1).toContain("[2]:")
      expect(interim1).toContain("Hi")

      // Second interim from speaker 2 - speakerChanged=false (same speaker as last call)
      // BUG FIX: The [2]: label should STILL appear because we're tracking partial speaker state
      const interim2 = processor.processString("Hi there", false, "2", false)
      expect(interim2).toContain("[1]:")
      expect(interim2).toContain("[2]:")  // This was the bug - label was disappearing!
      expect(interim2).toContain("Hi there")

      // Third interim from speaker 2 - still speakerChanged=false
      const interim3 = processor.processString("Hi there friend", false, "2", false)
      expect(interim3).toContain("[1]:")
      expect(interim3).toContain("[2]:")  // Label should persist
      expect(interim3).toContain("Hi there friend")
    })

    it("should handle final after interims with speaker label preserved", () => {
      // Final from speaker 1
      processor.processString("Hello", true, "1", true)

      // Interims from speaker 2
      processor.processString("Hi", false, "2", true)
      processor.processString("Hi there", false, "2", false)

      // Final from speaker 2 - speakerChanged might be false from DisplayManager's perspective
      // but the label should still be in history from the initial speaker change
      const finalResult = processor.processString("Hi there friend", true, "2", false)

      const history = processor.getFinalTranscriptHistory()
      expect(history.length).toBe(2)
      expect(history[0].speakerId).toBe("1")
      expect(history[0].hadSpeakerChange).toBe(true)
      expect(history[1].speakerId).toBe("2")
      expect(history[1].hadSpeakerChange).toBe(true)  // Should be true because interims tracked it

      expect(finalResult).toContain("[1]:")
      expect(finalResult).toContain("[2]:")
    })

    it("should put speaker labels on new lines when speaker changes", () => {
      processor.processString("Hello from speaker one", true, "1", true)
      processor.processString("Hi from speaker two", true, "2", true)

      const result = processor.getCurrentDisplay()
      const lines = result.split("\n").filter((l) => l.trim() !== "")

      // Each speaker should start on their own line
      expect(lines[0]).toContain("[1]:")
      expect(lines[0]).toContain("Hello from speaker one")

      // Speaker 2 should be on a separate line
      const speaker2Line = lines.find((l) => l.includes("[2]:"))
      expect(speaker2Line).toBeDefined()
      expect(speaker2Line).toContain("Hi from speaker two")

      // The [2]: should NOT be on the same line as [1]:
      expect(lines[0]).not.toContain("[2]:")
    })

    it("should keep same speaker text together without extra speaker labels", () => {
      processor.processString("Hi", true, "1", true)
      processor.processString("there", true, "1", false)

      const result = processor.getCurrentDisplay()

      // Both messages from same speaker should be in the result
      expect(result).toContain("Hi")
      expect(result).toContain("there")

      // Should only have one [1]: label (not two)
      const matches = result.match(/\[1\]:/g)
      expect(matches?.length).toBe(1)
    })
  })

  describe("clear functionality", () => {
    it("should clear all state", () => {
      processor.processString("Some text", true, "1", true)
      processor.processString("More text", true, "2", true)

      processor.clear()

      expect(processor.getFinalTranscriptHistory().length).toBe(0)
      expect(processor.getCurrentDisplay()).toBe("")
      expect(processor.getLastUserTranscript()).toBe("")
    })
  })

  describe("visual width settings", () => {
    it("should wrap text based on visual width not character count", () => {
      // Create processor with narrow width (30 visual units)
      const narrowProcessor = new TranscriptProcessor(30, 5, 10)

      // 30 visual units = 30 Latin chars OR 15 Chinese chars
      const latinText = "a".repeat(35) // 35 chars, should wrap
      const result = narrowProcessor.processString(latinText, true)
      const lines = result.split("\n").filter((l) => l.trim() !== "")
      expect(lines.length).toBeGreaterThan(1)
    })

    it("should fit more Latin than Chinese in same visual width", () => {
      const testProcessor = new TranscriptProcessor(44, 5, 10)

      // 44 visual units should fit ~44 Latin chars
      const latin44 = "a".repeat(44)
      const latinResult = testProcessor.processString(latin44, true)
      const latinLines = latinResult.split("\n").filter((l) => l.trim() !== "")

      testProcessor.clear()

      // 44 visual units should fit ~22 Chinese chars (44/2)
      const chinese22 = "中".repeat(22)
      const chineseResult = testProcessor.processString(chinese22, true)
      const chineseLines = chineseResult.split("\n").filter((l) => l.trim() !== "")

      // Both should fit in 1 line
      expect(latinLines.length).toBe(1)
      expect(chineseLines.length).toBe(1)
    })
  })
})
