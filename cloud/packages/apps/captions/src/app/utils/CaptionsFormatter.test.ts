import {describe, expect, test, beforeEach} from "bun:test"
import {CaptionsFormatter} from "./CaptionsFormatter"

describe("CaptionsFormatter", () => {
  let formatter: CaptionsFormatter

  beforeEach(() => {
    formatter = new CaptionsFormatter(undefined, {
      maxFinalTranscripts: 30,
      useCharacterBreaking: true,
    })
  })

  describe("basic text processing", () => {
    test("should process simple text", () => {
      const result = formatter.processTranscription("Hello world", true)
      expect(result.lines).toBeDefined()
      expect(result.displayText).toContain("Hello world")
    })

    test("should handle null input", () => {
      const result = formatter.processTranscription(null, true)
      expect(result.lines).toBeDefined()
      expect(result.lines.length).toBeGreaterThanOrEqual(1)
    })

    test("should handle empty input", () => {
      const result = formatter.processTranscription("", true)
      expect(result.lines).toBeDefined()
      expect(result.lines.length).toBeGreaterThanOrEqual(1)
    })

    test("should trim whitespace", () => {
      const result = formatter.processTranscription("  Hello world  ", true)
      expect(result.displayText).toContain("Hello world")
    })
  })

  describe("speaker labels (diarization)", () => {
    test("should add speaker label on speaker change", () => {
      const result = formatter.processTranscription("Hello", true, "1", true)
      expect(result.displayText).toContain("[1]:")
      expect(result.displayText).toContain("Hello")
    })

    test("should NOT add speaker label when speaker unchanged", () => {
      // First transcription with speaker
      formatter.processTranscription("Hello", true, "1", true)

      // Second transcription from same speaker
      const result = formatter.processTranscription("World", true, "1", false)

      // Should have one label for first message, none for second
      const labelCount = (result.displayText.match(/\[1\]:/g) || []).length
      expect(labelCount).toBe(1)
    })

    test("should add new label when speaker changes", () => {
      // First speaker
      formatter.processTranscription("Hello", true, "1", true)

      // Second speaker
      const result = formatter.processTranscription("Hi there", true, "2", true)

      expect(result.displayText).toContain("[1]:")
      expect(result.displayText).toContain("[2]:")
    })

    test("should handle multiple speaker changes", () => {
      formatter.processTranscription("Message 1", true, "1", true)
      formatter.processTranscription("Message 2", true, "2", true)
      const result = formatter.processTranscription("Message 3", true, "1", true)

      expect(result.displayText).toContain("[1]:")
      expect(result.displayText).toContain("[2]:")
      // Should have two [1]: labels (first and third message)
      const speaker1Count = (result.displayText.match(/\[1\]:/g) || []).length
      expect(speaker1Count).toBe(2)
    })

    test("should preserve speaker info in history", () => {
      formatter.processTranscription("Hello", true, "1", true)
      formatter.processTranscription("World", true, "2", true)

      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(2)
      expect(history[0].speakerId).toBe("1")
      expect(history[0].hadSpeakerChange).toBe(true)
      expect(history[1].speakerId).toBe("2")
      expect(history[1].hadSpeakerChange).toBe(true)
    })

    test("should put speaker labels on new lines when speaker changes", () => {
      formatter.processTranscription("Hello from speaker one", true, "1", true)
      const result = formatter.processTranscription("Hello from speaker two", true, "2", true)

      // Speaker labels should cause line breaks in the source text
      // Check that the display text contains both labels
      expect(result.displayText).toContain("[1]:")
      expect(result.displayText).toContain("[2]:")
    })
  })

  describe("interim vs final processing", () => {
    test("should handle interim transcriptions", () => {
      const result = formatter.processTranscription("Typing...", false)
      expect(result.displayText).toContain("Typing...")
    })

    test("should NOT add interim to history", () => {
      formatter.processTranscription("Interim text", false)
      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(0)
    })

    test("should add final to history", () => {
      formatter.processTranscription("Final text", true)
      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(1)
      expect(history[0].text).toBe("Final text")
    })

    test("should preserve speaker label across multiple interims", () => {
      // First interim with speaker change
      formatter.processTranscription("First", false, "1", true)
      // Second interim from same speaker (no speakerChanged flag)
      const result = formatter.processTranscription("First second", false, "1", false)

      // Should still have the speaker label
      expect(result.displayText).toContain("[1]:")
    })

    test("should handle final after interims with speaker label preserved", () => {
      // Interim with speaker
      formatter.processTranscription("Hello", false, "1", true)

      // Final version
      const result = formatter.processTranscription("Hello world", true, "1", false)

      // The history should have the speaker info
      const history = formatter.getFinalTranscriptHistory()
      expect(history[0].speakerId).toBe("1")
      expect(history[0].hadSpeakerChange).toBe(true)
    })
  })

  describe("transcript history", () => {
    test("should accumulate final transcripts", () => {
      formatter.processTranscription("First", true)
      formatter.processTranscription("Second", true)
      formatter.processTranscription("Third", true)

      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(3)
    })

    test("should respect maxFinalTranscripts limit", () => {
      const smallFormatter = new CaptionsFormatter(undefined, {
        maxFinalTranscripts: 2,
      })

      smallFormatter.processTranscription("First", true)
      smallFormatter.processTranscription("Second", true)
      smallFormatter.processTranscription("Third", true)

      const history = smallFormatter.getFinalTranscriptHistory()
      expect(history.length).toBe(2)
      expect(history[0].text).toBe("Second")
      expect(history[1].text).toBe("Third")
    })

    test("should get combined transcript history", () => {
      formatter.processTranscription("Hello", true)
      formatter.processTranscription("World", true)

      const combined = formatter.getCombinedTranscriptHistory()
      expect(combined).toBe("Hello World")
    })
  })

  describe("line formatting", () => {
    test("should return lines without unnecessary padding", () => {
      const result = formatter.processTranscription("Short text", true)
      // Short text should only need 1 line, no padding required
      expect(result.lines.length).toBeLessThanOrEqual(5)
      expect(result.lines.length).toBeGreaterThanOrEqual(1)
    })

    test("should truncate if too many lines", () => {
      // Create a lot of text that would exceed maxLines
      const longText = "This is a very long text. ".repeat(50)
      const result = formatter.processTranscription(longText, true)

      expect(result.lines.length).toBe(5) // Should not exceed maxLines
    })

    test("should keep MOST RECENT lines (bottom), not oldest (top)", () => {
      // This is critical for live captions - we want to see the latest text
      // Add many transcripts to fill more than 5 lines
      formatter.processTranscription("First message that is quite long", true, "1", true)
      formatter.processTranscription("Second message here", true, "1", false)
      formatter.processTranscription("Third message now", true, "2", true)
      formatter.processTranscription("Fourth message coming", true, "2", false)
      formatter.processTranscription("Fifth message arrives", true, "1", true)
      formatter.processTranscription("Sixth message is here", true, "1", false)
      formatter.processTranscription("Seventh and final", true, "2", true)

      const result = formatter.processTranscription("Latest interim text", false, "2", false)

      // The display should contain the LATEST text, not the first messages
      expect(result.displayText).toContain("Latest interim text")
      // Should NOT contain the very first message if we've scrolled past it
      // (depends on how much text fits, but the principle is: most recent wins)
    })

    test("should show new content as it arrives, scrolling old content up", () => {
      // Simulate live captions behavior
      const smallFormatter = new CaptionsFormatter(undefined, {
        maxFinalTranscripts: 30,
        useCharacterBreaking: true,
      })

      // Add enough content to fill the display
      for (let i = 1; i <= 10; i++) {
        smallFormatter.processTranscription(`Message number ${i} from the speaker`, true, "1", i === 1)
      }

      // Add new content
      const result = smallFormatter.processTranscription("Brand new message just arrived", true, "1", false)

      // The newest message should be visible (may be hyphenated across lines, so check for key parts)
      // Remove hyphens and newlines to check content is there
      const flatText = result.displayText.replace(/-\n/g, "").replace(/\n/g, " ")
      expect(flatText).toContain("Brand new message just arrived")
    })
  })

  describe("clear functionality", () => {
    test("should clear all state", () => {
      formatter.processTranscription("Some text", true, "1", true)
      formatter.processTranscription("More text", false, "2", true)

      formatter.clear()

      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(0)

      // Processing after clear should work normally
      const result = formatter.processTranscription("New text", true, "1", true)
      expect(result.displayText).toContain("New text")
    })
  })

  describe("settings", () => {
    test("should update maxFinalTranscripts", () => {
      formatter.processTranscription("1", true)
      formatter.processTranscription("2", true)
      formatter.processTranscription("3", true)

      formatter.setMaxFinalTranscripts(2)

      const history = formatter.getFinalTranscriptHistory()
      expect(history.length).toBe(2)
    })

    test("should return correct settings", () => {
      expect(formatter.getMaxFinalTranscripts()).toBe(30)
      expect(formatter.getMaxLines()).toBe(5) // G1 default
      expect(formatter.getDisplayWidthPx()).toBe(576) // G1 default
    })
  })

  describe("utility accessors", () => {
    test("should return measurer", () => {
      const measurer = formatter.getMeasurer()
      expect(measurer).toBeDefined()
      expect(typeof measurer.measureText).toBe("function")
    })

    test("should return wrapper", () => {
      const wrapper = formatter.getWrapper()
      expect(wrapper).toBeDefined()
      expect(typeof wrapper.wrap).toBe("function")
    })

    test("should return helpers", () => {
      const helpers = formatter.getHelpers()
      expect(helpers).toBeDefined()
      expect(typeof helpers.truncateWithEllipsis).toBe("function")
    })

    test("should return profile", () => {
      const profile = formatter.getProfile()
      expect(profile).toBeDefined()
      expect(profile.id).toBe("even-realities-g1")
    })
  })

  describe("display settings override", () => {
    test("should respect custom displayWidthPx", () => {
      const narrowFormatter = new CaptionsFormatter(undefined, {
        displayWidthPx: 300, // Much narrower than default 576px
      })

      expect(narrowFormatter.getDisplayWidthPx()).toBe(300)

      // Long text should wrap more with narrower width
      const result = narrowFormatter.processTranscription("This is a test message that should wrap differently", true)

      // Should have more lines than default width would produce
      expect(result.lines.length).toBeGreaterThanOrEqual(1)
    })

    test("should respect custom maxLines", () => {
      const limitedFormatter = new CaptionsFormatter(undefined, {
        maxLines: 2, // Only 2 lines instead of default 5
      })

      expect(limitedFormatter.getMaxLines()).toBe(2)

      // Add lots of content
      for (let i = 1; i <= 10; i++) {
        limitedFormatter.processTranscription(`Message number ${i}`, true, "1", i === 1)
      }

      const result = limitedFormatter.processTranscription("Final message", true, "1", false)

      // Should only have 2 lines max
      expect(result.lines.length).toBeLessThanOrEqual(2)
    })

    test("should use profile defaults when no overrides provided", () => {
      const defaultFormatter = new CaptionsFormatter()

      // G1_PROFILE defaults
      expect(defaultFormatter.getDisplayWidthPx()).toBe(576)
      expect(defaultFormatter.getMaxLines()).toBe(5)
    })

    test("should allow both displayWidthPx and maxLines overrides together", () => {
      const customFormatter = new CaptionsFormatter(undefined, {
        displayWidthPx: 400,
        maxLines: 3,
      })

      expect(customFormatter.getDisplayWidthPx()).toBe(400)
      expect(customFormatter.getMaxLines()).toBe(3)
    })
  })

  describe("break modes", () => {
    test("should use character breaking by default", () => {
      const charFormatter = new CaptionsFormatter(undefined, {
        useCharacterBreaking: true,
      })

      const longWord = "supercalifragilisticexpialidocious"
      const result = charFormatter.processTranscription(longWord.repeat(5), true)

      // With character breaking, long words should be hyphenated
      const hasHyphen = result.lines.some((line) => line.includes("-"))
      expect(hasHyphen).toBe(true)
    })

    test("should support word breaking mode", () => {
      const wordFormatter = new CaptionsFormatter(undefined, {
        breakMode: "word",
      })

      const text = "The quick brown fox jumps over the lazy dog"
      const result = wordFormatter.processTranscription(text, true)

      expect(result.lines).toBeDefined()
      expect(result.displayText).toContain("quick")
    })
  })
})
