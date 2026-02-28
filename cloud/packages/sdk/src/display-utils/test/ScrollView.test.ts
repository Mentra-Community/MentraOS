import {describe, expect, test, beforeEach} from "bun:test"
import {ScrollView} from "../helpers/ScrollView"
import {TextMeasurer} from "../measurer/TextMeasurer"
import {TextWrapper} from "../wrapper/TextWrapper"
import {G1_PROFILE} from "../profiles/g1"

describe("ScrollView", () => {
  let measurer: TextMeasurer
  let wrapper: TextWrapper
  let scrollView: ScrollView

  beforeEach(() => {
    measurer = new TextMeasurer(G1_PROFILE)
    wrapper = new TextWrapper(measurer, {breakMode: "character"})
    scrollView = new ScrollView(measurer, wrapper)
  })

  describe("constructor", () => {
    test("should create with default viewport size from profile", () => {
      expect(scrollView.getViewportSize()).toBe(5) // G1 maxLines
    })

    test("should accept custom viewport size", () => {
      const customScrollView = new ScrollView(measurer, wrapper, 3)
      expect(customScrollView.getViewportSize()).toBe(3)
    })
  })

  describe("setContent", () => {
    test("should set content and reset scroll to top", () => {
      scrollView.setContent("Line 1\nLine 2\nLine 3")
      expect(scrollView.isAtTop()).toBe(true)
      expect(scrollView.getTotalLines()).toBeGreaterThanOrEqual(3)
    })

    test("should wrap long text into multiple lines", () => {
      const longText = "This is a very long text. ".repeat(50)
      scrollView.setContent(longText)
      expect(scrollView.getTotalLines()).toBeGreaterThan(5)
    })

    test("should reset scroll position when setting new content", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToBottom()
      expect(scrollView.isAtBottom()).toBe(true)

      scrollView.setContent("New content")
      expect(scrollView.isAtTop()).toBe(true)
    })
  })

  describe("appendContent", () => {
    test("should append to existing content", () => {
      scrollView.setContent("Line 1")
      const initialLines = scrollView.getTotalLines()

      scrollView.appendContent("\nLine 2\nLine 3")
      expect(scrollView.getTotalLines()).toBeGreaterThan(initialLines)
    })

    test("should auto-scroll to bottom when already at bottom", () => {
      scrollView.setContent("A\n".repeat(10))
      scrollView.scrollToBottom()
      expect(scrollView.isAtBottom()).toBe(true)

      scrollView.appendContent("\nNew line")
      expect(scrollView.isAtBottom()).toBe(true)
    })

    test("should not auto-scroll when not at bottom", () => {
      scrollView.setContent("A\n".repeat(10))
      scrollView.scrollTo(2)
      const offsetBefore = scrollView.getPosition().offset

      scrollView.appendContent("\nNew line")
      expect(scrollView.getPosition().offset).toBe(offsetBefore)
    })

    test("should respect autoScroll=false", () => {
      scrollView.setContent("A\n".repeat(10))
      scrollView.scrollToBottom()
      const offsetBefore = scrollView.getPosition().offset

      scrollView.appendContent("\nNew line", undefined, false)
      // Offset stays the same even though we were at bottom
      expect(scrollView.getPosition().offset).toBe(offsetBefore)
    })
  })

  describe("getViewport", () => {
    test("should return viewport-sized array", () => {
      scrollView.setContent("Line 1\nLine 2")
      const viewport = scrollView.getViewport()
      expect(viewport.lines.length).toBe(5) // G1 viewport size
    })

    test("should pad with empty lines if content is shorter than viewport", () => {
      scrollView.setContent("Line 1")
      const viewport = scrollView.getViewport()
      expect(viewport.lines.length).toBe(5)
      expect(viewport.lines.filter((l) => l === "").length).toBeGreaterThan(0)
    })

    test("should return correct lines based on scroll offset", () => {
      scrollView.setContent("Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10")

      scrollView.scrollTo(0)
      let viewport = scrollView.getViewport()
      expect(viewport.lines[0]).toContain("Line 1")

      scrollView.scrollTo(3)
      viewport = scrollView.getViewport()
      expect(viewport.lines[0]).toContain("Line 4")
    })

    test("should include position information", () => {
      scrollView.setContent("A\n".repeat(20))
      const viewport = scrollView.getViewport()

      expect(viewport.position).toBeDefined()
      expect(viewport.position.offset).toBe(0)
      expect(viewport.position.totalLines).toBeGreaterThan(5)
      expect(viewport.position.atTop).toBe(true)
    })
  })

  describe("getPosition", () => {
    test("should return correct position at top", () => {
      scrollView.setContent("A\n".repeat(20))
      const position = scrollView.getPosition()

      expect(position.offset).toBe(0)
      expect(position.atTop).toBe(true)
      expect(position.atBottom).toBe(false)
      expect(position.scrollPercent).toBe(0)
    })

    test("should return correct position at bottom", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToBottom()
      const position = scrollView.getPosition()

      expect(position.atTop).toBe(false)
      expect(position.atBottom).toBe(true)
      expect(position.scrollPercent).toBe(100)
    })

    test("should calculate scroll percent correctly", () => {
      scrollView.setContent("A\n".repeat(20))
      const maxOffset = scrollView.getPosition().maxOffset

      scrollView.scrollTo(Math.floor(maxOffset / 2))
      const position = scrollView.getPosition()
      expect(position.scrollPercent).toBeGreaterThanOrEqual(40)
      expect(position.scrollPercent).toBeLessThanOrEqual(60)
    })
  })

  describe("scrollTo", () => {
    test("should scroll to specific offset", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(5)
      expect(scrollView.getPosition().offset).toBe(5)
    })

    test("should clamp to 0 if negative", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(-10)
      expect(scrollView.getPosition().offset).toBe(0)
    })

    test("should clamp to max if too high", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(1000)
      expect(scrollView.isAtBottom()).toBe(true)
    })
  })

  describe("scrollDown / scrollUp", () => {
    test("scrollDown should move down by 1 line by default", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollDown()
      expect(scrollView.getPosition().offset).toBe(1)
    })

    test("scrollDown should move down by specified lines", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollDown(3)
      expect(scrollView.getPosition().offset).toBe(3)
    })

    test("scrollUp should move up by 1 line by default", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(5)
      scrollView.scrollUp()
      expect(scrollView.getPosition().offset).toBe(4)
    })

    test("scrollUp should move up by specified lines", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(5)
      scrollView.scrollUp(3)
      expect(scrollView.getPosition().offset).toBe(2)
    })

    test("scrollUp should not go below 0", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(2)
      scrollView.scrollUp(10)
      expect(scrollView.getPosition().offset).toBe(0)
    })
  })

  describe("pageDown / pageUp", () => {
    test("pageDown should scroll by viewport size", () => {
      scrollView.setContent("A\n".repeat(30))
      scrollView.pageDown()
      expect(scrollView.getPosition().offset).toBe(5) // viewport size
    })

    test("pageUp should scroll by viewport size", () => {
      scrollView.setContent("A\n".repeat(30))
      scrollView.scrollTo(10)
      scrollView.pageUp()
      expect(scrollView.getPosition().offset).toBe(5)
    })
  })

  describe("scrollToTop / scrollToBottom", () => {
    test("scrollToTop should go to offset 0", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(10)
      scrollView.scrollToTop()
      expect(scrollView.getPosition().offset).toBe(0)
      expect(scrollView.isAtTop()).toBe(true)
    })

    test("scrollToBottom should go to max offset", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToBottom()
      expect(scrollView.isAtBottom()).toBe(true)
    })
  })

  describe("scrollToLine", () => {
    test("should scroll to put line at top of viewport", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToLine(5, "top")
      expect(scrollView.getPosition().offset).toBe(5)
    })

    test("should scroll to put line at center of viewport", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToLine(7, "center")
      // With viewport of 5, center offset for line 7 should be 7 - 2 = 5
      expect(scrollView.getPosition().offset).toBe(5)
    })

    test("should scroll to put line at bottom of viewport", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToLine(8, "bottom")
      // With viewport of 5, bottom offset for line 8 should be 8 - 5 + 1 = 4
      expect(scrollView.getPosition().offset).toBe(4)
    })
  })

  describe("scrollToPercent", () => {
    test("should scroll to 0% (top)", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(10)
      scrollView.scrollToPercent(0)
      expect(scrollView.isAtTop()).toBe(true)
    })

    test("should scroll to 100% (bottom)", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToPercent(100)
      expect(scrollView.isAtBottom()).toBe(true)
    })

    test("should scroll to 50% (middle)", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollToPercent(50)
      const position = scrollView.getPosition()
      expect(position.scrollPercent).toBeGreaterThanOrEqual(45)
      expect(position.scrollPercent).toBeLessThanOrEqual(55)
    })
  })

  describe("isScrollable", () => {
    test("should return false when content fits in viewport", () => {
      scrollView.setContent("Line 1\nLine 2")
      expect(scrollView.isScrollable()).toBe(false)
    })

    test("should return true when content exceeds viewport", () => {
      scrollView.setContent("A\n".repeat(20))
      expect(scrollView.isScrollable()).toBe(true)
    })
  })

  describe("getAllLines", () => {
    test("should return all lines, not just visible", () => {
      scrollView.setContent("A\n".repeat(20))
      const allLines = scrollView.getAllLines()
      expect(allLines.length).toBeGreaterThan(5)
    })

    test("should return a copy, not the original array", () => {
      scrollView.setContent("Line 1\nLine 2")
      const allLines = scrollView.getAllLines()
      allLines.push("Modified")
      expect(scrollView.getAllLines().length).not.toBe(allLines.length)
    })
  })

  describe("clear", () => {
    test("should clear all content", () => {
      scrollView.setContent("A\n".repeat(20))
      scrollView.scrollTo(10)

      scrollView.clear()

      expect(scrollView.getTotalLines()).toBe(0)
      expect(scrollView.getPosition().offset).toBe(0)
    })
  })

  describe("utility accessors", () => {
    test("should return measurer", () => {
      expect(scrollView.getMeasurer()).toBe(measurer)
    })

    test("should return wrapper", () => {
      expect(scrollView.getWrapper()).toBe(wrapper)
    })

    test("should return profile", () => {
      expect(scrollView.getProfile()).toBe(G1_PROFILE)
    })
  })

  describe("edge cases", () => {
    test("should handle empty content", () => {
      scrollView.setContent("")
      const viewport = scrollView.getViewport()
      expect(viewport.lines.length).toBe(5)
      expect(scrollView.isScrollable()).toBe(false)
    })

    test("should handle content exactly matching viewport", () => {
      // Create exactly 5 lines
      scrollView.setContent("1\n2\n3\n4\n5")
      expect(scrollView.isScrollable()).toBe(false)
      expect(scrollView.isAtTop()).toBe(true)
      expect(scrollView.isAtBottom()).toBe(true)
    })

    test("should handle viewport size of 1", () => {
      const tinyScrollView = new ScrollView(measurer, wrapper, 1)
      tinyScrollView.setContent("Line 1\nLine 2\nLine 3")

      expect(tinyScrollView.getViewport().lines.length).toBe(1)
      expect(tinyScrollView.isScrollable()).toBe(true)

      tinyScrollView.scrollDown()
      expect(tinyScrollView.getViewport().lines[0]).toContain("Line 2")
    })
  })

  describe("real-world scenarios", () => {
    test("captions-like scrolling behavior", () => {
      // Start with empty
      scrollView.clear()

      // Simulate incoming captions
      scrollView.appendContent("[1]: Hello, how are you?")
      expect(scrollView.isAtBottom()).toBe(true)

      scrollView.appendContent(" I'm doing great!")
      expect(scrollView.isAtBottom()).toBe(true)

      scrollView.appendContent("\n[2]: That's wonderful to hear.")
      expect(scrollView.isAtBottom()).toBe(true)

      // Add lots more content
      for (let i = 0; i < 20; i++) {
        scrollView.appendContent(`\n[${(i % 2) + 1}]: Message ${i}`)
      }

      // Should still be at bottom (auto-scroll)
      expect(scrollView.isAtBottom()).toBe(true)

      // User scrolls up to read history
      scrollView.scrollUp(5)
      expect(scrollView.isAtBottom()).toBe(false)

      // New content arrives but we don't auto-scroll (not at bottom)
      const offsetBefore = scrollView.getPosition().offset
      scrollView.appendContent("\n[1]: New message while scrolled up")
      expect(scrollView.getPosition().offset).toBe(offsetBefore)
    })

    test("teleprompter-like scrolling behavior", () => {
      const longScript = "This is a teleprompter script. ".repeat(100)
      scrollView.setContent(longScript)

      expect(scrollView.isAtTop()).toBe(true)
      expect(scrollView.isScrollable()).toBe(true)

      // Scroll through the script
      while (!scrollView.isAtBottom()) {
        scrollView.scrollDown()
      }

      expect(scrollView.isAtBottom()).toBe(true)

      // Jump back to start
      scrollView.scrollToTop()
      expect(scrollView.isAtTop()).toBe(true)

      // Jump to middle
      scrollView.scrollToPercent(50)
      const position = scrollView.getPosition()
      expect(position.scrollPercent).toBeGreaterThanOrEqual(45)
      expect(position.scrollPercent).toBeLessThanOrEqual(55)
    })
  })
})
